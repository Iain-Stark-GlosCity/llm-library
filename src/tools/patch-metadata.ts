// library_write (operation: patch_page_metadata) — a lightweight governance/review
// metadata patch for an existing curated page. Unlike update_page it does NOT re-chunk,
// re-embed, or archive a history version: it only rewrites the page frontmatter + the
// manifest entry and syncs the Qdrant payload `updated` so stale_embedding stays honest.
//
// Why it exists: rolling governance metadata (last_source_check, allowed_use,
// reviewed_by/at, business_consequence_if_stale, invalidation_policy, review_after) across
// a whole domain via update_page would mean a full re-embed + history snapshot per page —
// untenable at estate scale. The patchable fields are exactly those that are neither
// embedded (title/summary/content) nor part of the Qdrant filter payload, so skipping the
// re-embed is safe. Identity and content-bearing fields (title/type/domain/confidence/
// status/summary/tags/sources/related/content) are deliberately NOT patchable here — those
// still go through update_page (or deprecate_page) so their integrity gates always run.

import { DomainEnvelope, DomainException, ToolDefinition, ok, toEnvelope } from '../types'
import { getWikiContainer, readBlob, conditionalWrite } from '../storage/blobs'
import { readManifest, writeManifest, PageEntry } from '../storage/manifest'
import { regenerateIndex } from '../storage/index'
import { appendLog } from '../storage/log'
import { ensureCollection, setPayload } from '../storage/qdrant'
import { wikiPagePointId } from '../embed/ids'
import { renderFrontmatter, stripFrontmatter } from './shared'
import { isUseMode, isOperationalUse } from './governance'

const FILENAME_RE = /^[a-z0-9][a-z0-9-]*\.md$/

// The only fields this operation may change — governance + review metadata.
const PATCHABLE = [
  'reviewed_by',
  'reviewed_at',
  'review_after',
  'last_source_check',
  'allowed_use',
  'prohibited_use',
  'business_consequence_if_stale',
  'invalidation_policy'
] as const

const inputSchema = {
  type: 'object',
  properties: {
    filename: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]*\\.md$', maxLength: 80 },
    reviewed_by: { type: 'string', maxLength: 120 },
    reviewed_at: { type: 'string' },
    review_after: { type: 'string' },
    last_source_check: { type: 'string' },
    allowed_use: { type: 'array', items: { type: 'string' } },
    prohibited_use: { type: 'array', items: { type: 'string' } },
    business_consequence_if_stale: { type: 'string', enum: ['low', 'medium', 'high'] },
    invalidation_policy: { type: 'string', maxLength: 500 },
    library_id: { type: 'string' }
  },
  required: ['filename'],
  additionalProperties: false
}

function isoOrThrow(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new DomainException('VALIDATION_ERROR', `${field} must be a string`)
  // Empty string is the explicit "clear this field" signal.
  if (value === '') return ''
  if (Number.isNaN(Date.parse(value))) throw new DomainException('VALIDATION_ERROR', `${field} must be an ISO date or timestamp`)
  return value
}

function stringArrayOrThrow(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
    throw new DomainException('VALIDATION_ERROR', `${field} must be an array of strings`)
  }
  return value as string[]
}

async function patchMetadataImpl(input: unknown): Promise<DomainEnvelope> {
  const a = (input ?? {}) as Record<string, any>

  if (typeof a.filename !== 'string' || a.filename.length > 80 || !FILENAME_RE.test(a.filename)) {
    throw new DomainException('VALIDATION_ERROR', 'filename must match ^[a-z0-9][a-z0-9-]*\\.md$ and be ≤80 chars')
  }
  const filename: string = a.filename
  const libraryId: string = typeof a.library_id === 'string' && a.library_id ? a.library_id : 'default'

  const provided = PATCHABLE.filter((k) => a[k] !== undefined)
  if (provided.length === 0) {
    throw new DomainException('VALIDATION_ERROR', `nothing to patch — provide at least one of: ${PATCHABLE.join(', ')}`)
  }

  // Validate each provided field (mirrors update_page's rules so the patch path can never
  // introduce state update_page would have rejected).
  const reviewedBy = a.reviewed_by !== undefined ? (typeof a.reviewed_by === 'string' ? a.reviewed_by : (() => { throw new DomainException('VALIDATION_ERROR', 'reviewed_by must be a string') })()) : undefined
  const reviewedAt = isoOrThrow(a.reviewed_at, 'reviewed_at')
  const reviewAfter = isoOrThrow(a.review_after, 'review_after')
  const lastSourceCheck = isoOrThrow(a.last_source_check, 'last_source_check')
  const allowedUse = stringArrayOrThrow(a.allowed_use, 'allowed_use')
  const prohibitedUse = stringArrayOrThrow(a.prohibited_use, 'prohibited_use')
  for (const u of [...(allowedUse ?? []), ...(prohibitedUse ?? [])]) {
    if (!isUseMode(u)) throw new DomainException('VALIDATION_ERROR', `unknown use mode: ${u}`)
  }
  if (allowedUse) {
    const op = allowedUse.filter((u) => isOperationalUse(u))
    if (op.length > 0) {
      throw new DomainException('VALIDATION_ERROR', `allowed_use may not include operational modes (${op.join(', ')}); operational actions belong to deterministic systems, not curated knowledge`)
    }
  }
  let businessConsequence: string | undefined
  if (a.business_consequence_if_stale !== undefined) {
    if (a.business_consequence_if_stale !== '' && !['low', 'medium', 'high'].includes(a.business_consequence_if_stale)) {
      throw new DomainException('VALIDATION_ERROR', 'business_consequence_if_stale must be low | medium | high')
    }
    businessConsequence = a.business_consequence_if_stale
  }
  const invalidationPolicy = a.invalidation_policy !== undefined
    ? (typeof a.invalidation_policy === 'string' ? a.invalidation_policy : (() => { throw new DomainException('VALIDATION_ERROR', 'invalidation_policy must be a string') })())
    : undefined

  const warnings: string[] = []
  const nowIso = new Date().toISOString()

  // Locate the page in the manifest (the authoritative metadata record) and on disk.
  const { manifest, etag: manifestEtag } = await readManifest(libraryId)
  const idx = manifest.pages.findIndex((p) => p.filename === filename)
  if (idx < 0) {
    throw new DomainException('NOT_FOUND', `no manifest entry for "${filename}"`)
  }
  const wiki = await getWikiContainer()
  const existing = await readBlob(wiki, `pages/${filename}`)
  if (!existing) {
    throw new DomainException('NOT_FOUND', `page blob pages/${filename} is missing (run library_lint → index_entry_missing_page)`)
  }

  // Merge: start from the current entry, overlay only the provided fields. An empty string
  // (scalars) or empty array clears the field; anything else sets it.
  const cur = manifest.pages[idx]
  const next: PageEntry = { ...cur }
  const setScalar = (key: keyof PageEntry, val: string | undefined) => {
    if (val === undefined) return
    if (val === '') delete (next as any)[key]
    else (next as any)[key] = val
  }
  const setArray = (key: keyof PageEntry, val: string[] | undefined) => {
    if (val === undefined) return
    if (val.length === 0) delete (next as any)[key]
    else (next as any)[key] = val
  }
  setScalar('reviewed_by', reviewedBy)
  setScalar('reviewed_at', reviewedAt)
  setScalar('review_after', reviewAfter)
  setScalar('last_source_check', lastSourceCheck)
  setArray('allowed_use', allowedUse)
  setArray('prohibited_use', prohibitedUse)
  setScalar('business_consequence_if_stale', businessConsequence)
  setScalar('invalidation_policy', invalidationPolicy)
  next.updated = nowIso

  // Rebuild the page frontmatter from the merged entry (content body preserved verbatim).
  const frontmatter = renderFrontmatter({
    title: next.title,
    type: next.type,
    domain: next.domain,
    confidence: next.confidence,
    status: next.status,
    summary: next.summary,
    tags: next.tags || [],
    sources: next.sources || [],
    related: next.related || [],
    review_after: next.review_after,
    reviewed_by: next.reviewed_by,
    reviewed_at: next.reviewed_at,
    allowed_use: next.allowed_use,
    prohibited_use: next.prohibited_use,
    last_source_check: next.last_source_check,
    business_consequence_if_stale: next.business_consequence_if_stale,
    invalidation_policy: next.invalidation_policy,
    created: cur.created,
    updated: nowIso
  })
  const body = stripFrontmatter(existing.content)
  const fullPage = `${frontmatter}\n\n${body}${body.endsWith('\n') ? '' : '\n'}`

  // Critical write — the page blob. ETag-conditional; no history copy (metadata-only patch).
  const w = await conditionalWrite(wiki, `pages/${filename}`, fullPage, existing.etag, 'text/markdown; charset=utf-8')
  if (w.conflict) throw new DomainException('CONFLICT', `ETag conflict writing ${filename}; caller should retry`)
  if (!w.success) throw new DomainException('STORAGE_ERROR', `Failed to write ${filename}`)

  // Manifest + index (warnings only after the critical write).
  let manifestUpdated = false
  let indexUpdated = false
  manifest.pages[idx] = next
  const mw = await writeManifest(manifest, manifestEtag)
  if (mw.conflict) warnings.push('manifest_conflict')
  else if (!mw.success) warnings.push('manifest_write_failed')
  else {
    manifestUpdated = true
    try {
      const iw = await regenerateIndex(manifest)
      if (iw.conflict) warnings.push('index_conflict')
      else if (!iw.success) warnings.push('index_write_failed')
      else indexUpdated = true
    } catch {
      warnings.push('index_write_failed')
    }
  }

  // Keep the Qdrant payload `updated` in step so library_lint does not read this as a
  // stale_embedding (the vector itself is unchanged — none of the patched fields are
  // embedded or in the filter payload).
  let payloadSynced = false
  try {
    await ensureCollection()
    await setPayload([wikiPagePointId(libraryId, filename)], { updated: nowIso })
    payloadSynced = true
  } catch (err) {
    warnings.push('payload_sync_failed', (err as Error).message)
  }

  const log = await appendLog({
    ts: nowIso,
    tool: 'library_write',
    action: `patch_page_metadata ${filename} (${provided.join(', ')})`,
    filename,
    library_id: libraryId
  })
  if (!log.ok) warnings.push('log_append_failed')

  return ok(
    {
      filename,
      patched_fields: provided,
      manifest_updated: manifestUpdated,
      index_updated: indexUpdated,
      payload_synced: payloadSynced,
      re_embedded: false
    },
    warnings
  )
}

export const patchMetadataTool: ToolDefinition = {
  name: 'library_patch_page_metadata',
  description:
    'Lightweight governance/review metadata patch for an existing page: reviewed_by/at, ' +
    'review_after, last_source_check, allowed_use/prohibited_use, business_consequence_if_stale, ' +
    'invalidation_policy. Does NOT re-embed or archive history (the patched fields are neither ' +
    'embedded nor part of the vector filter). Use update_page for content/identity changes.',
  inputSchema,
  handler: (input) => toEnvelope(() => patchMetadataImpl(input))
}
