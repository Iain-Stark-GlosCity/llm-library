import { DomainEnvelope, DomainException, ToolDefinition, ok, toEnvelope } from '../types'
import { getWikiContainer, readBlob, conditionalWrite } from '../storage/blobs'
import { readManifest, writeManifest, PageEntry, PageRole } from '../storage/manifest'
import { readRawManifest, writeRawManifest } from '../storage/raw-manifest'
import { readSchema } from '../storage/schema'
import { appendLog } from '../storage/log'
import { regenerateIndex } from '../storage/index'
import { renderFrontmatter, stripFrontmatter } from './shared'
import { GOVERNANCE_POLICY_VERSION, PAGE_ROLE_DEFAULTS, INVALIDATION_POLICY_DEFAULTS, inferPageRole } from './governance'

const inputSchema = {
  type: 'object',
  properties: {
    domain: { type: 'string' },
    dry_run: { type: 'boolean' },
    force: { type: 'boolean' },
    manual_accept_current: { type: 'boolean' },
    migrated_by: { type: 'string' },
    library_id: { type: 'string' }
  },
  required: ['domain'],
  additionalProperties: false
}

function inferUpstreamId(sourceUrl: string): string | null {
  try {
    const u = new URL(sourceUrl)
    if (u.hostname === 'www.legislation.gov.uk' || u.hostname === 'legislation.gov.uk') {
      return `legislation.gov.uk${u.pathname.replace(/\/contents$/, '')}`
    }
  } catch {}
  if (/council-tax-schema-rebuild-statutory-spine-v3-0-0/i.test(sourceUrl)) return 'council-tax-rebuild/statutory-spine-v3.0.0'
  return null
}

async function migrateGovernanceImpl(input: unknown): Promise<DomainEnvelope> {
  const a = (input ?? {}) as Record<string, any>
  if (typeof a.domain !== 'string' || !a.domain) throw new DomainException('VALIDATION_ERROR', 'domain is required')
  const domain: string = a.domain
  const dryRun = a.dry_run !== false
  const force = a.force === true
  const manualAcceptCurrent = a.manual_accept_current === true
  const migratedBy = typeof a.migrated_by === 'string' && a.migrated_by ? a.migrated_by : 'library-mcp-governance-migration'
  const libraryId: string = typeof a.library_id === 'string' && a.library_id ? a.library_id : 'default'
  const schema = await readSchema(domain).catch(() => null)
  if (schema?.governance_required !== true) throw new DomainException('VALIDATION_ERROR', `domain ${domain} does not have governance_required: true`)

  const [{ manifest, etag }, { manifest: rawManifest, etag: rawEtag }] = await Promise.all([readManifest(libraryId), readRawManifest(libraryId)])
  const wiki = await getWikiContainer()
  const active = manifest.pages.filter((p) => p.domain === domain && p.status === 'active')
  const plannedPagePatches: any[] = []
  const plannedSourcePatches: any[] = []
  const touchedSources = new Set<string>()

  for (const p of active) {
    const existing = await readBlob(wiki, `pages/${p.filename}`)
    const body = existing?.content ? stripFrontmatter(existing.content) : ''
    const inferred = p.page_role || inferPageRole(p, body)
    const defaults = PAGE_ROLE_DEFAULTS[inferred]
    const fields: string[] = []
    const patch: Partial<PageEntry> = {}
    const set = (key: keyof PageEntry, value: any) => {
      if (force || (p as any)[key] === undefined || (Array.isArray((p as any)[key]) && (p as any)[key].length === 0)) {
        ;(patch as any)[key] = value
        fields.push(String(key))
      }
    }
    if (!p.page_role || force) set('page_role', inferred)
    if (defaults) {
      set('allowed_use', defaults.allowed_use)
      set('prohibited_use', defaults.prohibited_use)
      set('business_consequence_if_stale', defaults.business_consequence_if_stale)
    }
    const policy = INVALIDATION_POLICY_DEFAULTS[inferred]
    if (policy) set('invalidation_policy', policy)
    set('governance_migrated_at', new Date().toISOString())
    set('governance_migrated_by', migratedBy)
    set('governance_policy_version', GOVERNANCE_POLICY_VERSION)
    if (!p.page_role || force) set('governance_role_inferred', true)
    if (fields.length > 0) plannedPagePatches.push({ filename: p.filename, current_page_role: p.page_role ?? null, inferred_page_role: inferred, fields_to_patch: fields, patch })
    for (const id of p.sources || []) touchedSources.add(id)
  }

  for (const id of touchedSources) {
    const src = rawManifest.sources.find((s) => s.source_id === id)
    if (!src) continue
    const missing: string[] = []
    const patch: Record<string, unknown> = {}
    if (!src.upstream_id) {
      const inferred = inferUpstreamId(src.source_url || id)
      if (inferred) { patch.upstream_id = inferred; missing.push('upstream_id') }
    }
    if (!src.upstream_owner) missing.push('upstream_owner')
    if (!src.last_upstream_check) missing.push('last_upstream_check')
    if (!src.upstream_status) missing.push('upstream_status')
    if (manualAcceptCurrent && !src.upstream_status) patch.upstream_status = 'current'
    if (manualAcceptCurrent && !src.last_upstream_check) patch.last_upstream_check = new Date().toISOString()
    if (missing.length > 0 || Object.keys(patch).length > 0) plannedSourcePatches.push({ source_id: id, missing, suggested_action: 'mark_source_checked', safe_to_auto_mark: manualAcceptCurrent, patch })
  }

  const report = {
    domain,
    dry_run: dryRun,
    pages_scanned: active.length,
    pages_to_patch: plannedPagePatches.length,
    sources_scanned: touchedSources.size,
    sources_missing_checks: plannedSourcePatches.filter((p) => p.missing.includes('last_upstream_check') || p.missing.includes('upstream_status')).length,
    planned_page_patches: plannedPagePatches,
    planned_source_patches: plannedSourcePatches
  }
  if (dryRun) return ok(report, [])

  const nowIso = new Date().toISOString()
  for (const planned of plannedPagePatches) {
    const idx = manifest.pages.findIndex((p) => p.filename === planned.filename)
    if (idx < 0) continue
    const cur = manifest.pages[idx]
    const next: PageEntry = { ...cur, ...planned.patch, updated: nowIso }
    const existing = await readBlob(wiki, `pages/${cur.filename}`)
    if (existing) {
      const fm = renderFrontmatter({ ...next, type: next.type, created: cur.created, updated: nowIso })
      const full = `${fm}\n\n${stripFrontmatter(existing.content)}${existing.content.endsWith('\n') ? '' : '\n'}`
      const w = await conditionalWrite(wiki, `pages/${cur.filename}`, full, existing.etag, 'text/markdown; charset=utf-8')
      if (w.conflict) throw new DomainException('CONFLICT', `ETag conflict writing ${cur.filename}; caller should retry`)
      if (!w.success) throw new DomainException('STORAGE_ERROR', `Failed to write ${cur.filename}`)
    }
    manifest.pages[idx] = next
  }
  for (const planned of plannedSourcePatches) {
    const src = rawManifest.sources.find((s) => s.source_id === planned.source_id)
    if (src) Object.assign(src, planned.patch)
  }
  const mw = await writeManifest(manifest, etag)
  if (!mw.success || mw.conflict) throw new DomainException(mw.conflict ? 'CONFLICT' : 'STORAGE_ERROR', 'failed to write manifest')
  await regenerateIndex(manifest).catch(() => undefined)
  const rw = await writeRawManifest(rawManifest, rawEtag)
  if (!rw.success || rw.conflict) throw new DomainException(rw.conflict ? 'CONFLICT' : 'STORAGE_ERROR', 'failed to write raw manifest')
  const log = await appendLog({ ts: nowIso, tool: 'library_write', action: `migrate_governance ${domain}`, library_id: libraryId, pages_to_patch: plannedPagePatches.length, sources_to_patch: plannedSourcePatches.length })
  return ok({ ...report, dry_run: false, audit_logged: log.ok }, log.ok ? [] : ['log_append_failed'])
}

export const migrateGovernanceTool: ToolDefinition = {
  name: 'library_migrate_governance',
  description: 'Dry-run or apply page_role/default-governance/source-provenance migration for a governed domain.',
  inputSchema,
  handler: (input) => toEnvelope(() => migrateGovernanceImpl(input))
}
