// library_lint — read-only mechanical health checks over the wiki. No prose
// interpretation, no mutation. Each issue carries a suggested_fix hint. See CLAUDE.md.

import { DomainEnvelope, ToolDefinition, ok, toEnvelope } from '../types'
import { getWikiContainer, readBlob, listBlobs } from '../storage/blobs'
import { readManifest } from '../storage/manifest'
import { readRawManifest } from '../storage/raw-manifest'
import { listSchemaDomains, readSchema } from '../storage/schema'
import { scrollPoints } from '../storage/qdrant'
import { daysSince, inlineSourceIds } from './shared'
import { computeSourceFreshness } from './freshness'
import { isOperationalUse, isPageRole } from './governance'

interface LintIssue {
  type: string
  code?: string
  filename?: string
  page?: string
  source_id?: string
  domain?: string
  description: string
  detail?: string
  level?: 'error' | 'warning' | 'info'
  severity: 'error' | 'warning' | 'info'
  suggested_fix?: string
}

const inputSchema = {
  type: 'object',
  properties: {
    domain: { type: 'string' },
    library_id: { type: 'string' }
  },
  additionalProperties: false
}

async function lintImpl(input: unknown): Promise<DomainEnvelope> {
  const a = (input ?? {}) as Record<string, any>
  const domainFilter = typeof a.domain === 'string' && a.domain ? a.domain : undefined
  const libraryId = typeof a.library_id === 'string' && a.library_id ? a.library_id : 'default'

  const { manifest } = await readManifest(libraryId)
  const { manifest: rawManifest } = await readRawManifest(libraryId)
  const wiki = await getWikiContainer()
  const pageBlobNames = await listBlobs(wiki, 'pages/')
  const pageFiles = new Set(pageBlobNames.map((n) => n.replace(/^pages\//, '')))

  // Qdrant payload updated timestamps for stale_embedding.
  const qdrantUpdated = new Map<string, string>()
  const points = await scrollPoints({
    must: [
      { key: 'record_type', match: { value: 'wiki_page' } },
      { key: 'library_id', match: { value: libraryId } }
    ]
  })
  for (const pt of points) {
    if (pt.payload?.filename) qdrantUpdated.set(pt.payload.filename, pt.payload.updated)
  }

  const pages = manifest.pages.filter((p) => !domainFilter || p.domain === domainFilter)
  const knownSources = new Set(rawManifest.sources.map((s) => s.source_id))
  const allFilenames = new Set(manifest.pages.map((p) => p.filename))

  // Inbound related[] links from all active pages (for orphan detection).
  const inbound = new Set<string>()
  for (const p of manifest.pages) {
    if (p.status === 'active') for (const r of p.related || []) inbound.add(r)
  }

  const issues: LintIssue[] = []

  for (const p of pages) {
    for (const r of p.related || []) {
      if (!allFilenames.has(r)) {
        issues.push({
          type: 'broken_reference',
          page: p.filename,
          description: `related[] references missing page "${r}"`,
          severity: 'error',
          suggested_fix: `Create ${r} via library_update, or remove "${r}" from this page's related[].`
        })
      }
    }
    if (p.confidence === 'unverified' && daysSince(p.updated) > 30) {
      issues.push({
        type: 'unverified_stale',
        page: p.filename,
        description: `unverified and not updated in ${Math.floor(daysSince(p.updated))} days`,
        severity: 'warning',
        suggested_fix: 'Review the page, add/confirm sources, and raise confidence — or deprecate it.'
      })
    }
    const qd = qdrantUpdated.get(p.filename)
    if (qd !== undefined && qd !== p.updated) {
      issues.push({
        type: 'stale_embedding',
        page: p.filename,
        description: `manifest updated ${p.updated} != Qdrant updated ${qd}`,
        severity: 'warning',
        suggested_fix: 'Re-run library_update on this page to re-embed and resync the vector.'
      })
    }
    if (!pageFiles.has(p.filename)) {
      issues.push({
        type: 'index_entry_missing_page',
        page: p.filename,
        description: 'manifest entry has no corresponding page blob',
        severity: 'error',
        suggested_fix: 'Re-run library_update to recreate the page blob, or remove the stale manifest entry.'
      })
    }
  }

  for (const p of pages) {
    const pageSources = p.sources || []
    const unknownSources = pageSources.filter((sourceId) => !knownSources.has(sourceId))
    for (const sourceId of unknownSources) {
      issues.push({
        type: 'unknown_source_metadata',
        page: p.filename,
        source_id: sourceId,
        description: `sources[] references unknown source_id "${sourceId}"`,
        severity: 'error',
        suggested_fix: `Register ${sourceId} with library_register_source, ingest it with library_ingest, or remove it from sources[].`
      })
    }
    if (p.status === 'active' && pageSources.length === 0) {
      issues.push({
        type: 'missing_source_metadata',
        page: p.filename,
        description: 'active page has empty or absent sources[]',
        severity: 'error',
        suggested_fix: 'Add at least one source_id to sources[] (register it first with library_register_source if needed).'
      })
    }
    if (p.confidence === 'high' && pageSources.length === 0) {
      issues.push({
        type: 'high_confidence_without_sources',
        page: p.filename,
        description: 'high-confidence page has no source support in sources[]',
        severity: 'error',
        suggested_fix: 'Add source support or lower confidence.'
      })
    }
    if (p.status === 'active' && (!p.reviewed_by || !p.reviewed_at)) {
      issues.push({
        type: 'active_missing_review_metadata',
        page: p.filename,
        description: 'active page is missing reviewed_by or reviewed_at metadata',
        severity: 'error',
        suggested_fix: 'Re-run library_update with reviewed_by and reviewed_at after review.'
      })
    }
    if (p.reviewed_at && Number.isNaN(Date.parse(p.reviewed_at))) {
      issues.push({
        type: 'invalid_reviewed_at',
        page: p.filename,
        description: `reviewed_at is not parseable as a date: ${p.reviewed_at}`,
        severity: 'error',
        suggested_fix: 'Use an ISO date or timestamp for reviewed_at.'
      })
    }
    if (p.type === 'synthesis' && !p.review_after) {
      issues.push({
        type: 'synthesis_missing_review_after',
        page: p.filename,
        description: 'synthesis page is missing review_after metadata',
        severity: 'error',
        suggested_fix: 'Re-run library_update with review_after set to an ISO date.'
      })
    }
    if ((p.type === 'concept' || p.type === 'synthesis') && p.status === 'active' && !inbound.has(p.filename)) {
      issues.push({
        type: 'orphan_page',
        page: p.filename,
        description: 'no inbound related[] links from other active pages',
        severity: 'info',
        suggested_fix: `Add "${p.filename}" to the related[] of a connected page (e.g. the overview).`
      })
    }
  }

  // Content-fetch checks: inline source integrity (active/high confidence) and open_contradiction.
  for (const p of pages) {
    const needsBody = p.status === 'active' || p.confidence === 'high' || p.type === 'contradiction'
    if (!needsBody) continue
    const blob = await readBlob(wiki, `pages/${p.filename}`)
    const body = blob?.content ?? ''
    const inlineSources = inlineSourceIds(body)
    const metadataSources = new Set(p.sources || [])
    if (p.status === 'active' && inlineSources.length === 0) {
      issues.push({
        type: 'inline_citation_missing',
        page: p.filename,
        description: 'active page body contains no [source: ...] citation',
        severity: 'error',
        suggested_fix: 'Add at least one inline [source: <source_id>] marker in the body.'
      })
    }
    if (p.confidence === 'high' && inlineSources.length === 0) {
      issues.push({
        type: 'high_confidence_without_inline_citation',
        page: p.filename,
        description: 'high-confidence page body contains no inline [source: ...] citation',
        severity: 'error',
        suggested_fix: 'Add inline citation support or lower confidence.'
      })
    }
    for (const sourceId of inlineSources) {
      if (!knownSources.has(sourceId)) {
        issues.push({
          type: 'unknown_inline_source',
          page: p.filename,
          source_id: sourceId,
          description: `inline citation references unknown source_id "${sourceId}"`,
          severity: 'error',
          suggested_fix: `Register ${sourceId} with library_register_source, ingest it with library_ingest, or remove the citation.`
        })
      }
      if (!metadataSources.has(sourceId)) {
        issues.push({
          type: 'inline_source_missing_from_metadata',
          page: p.filename,
          source_id: sourceId,
          description: `inline citation "${sourceId}" is not present in sources[]`,
          severity: 'error',
          suggested_fix: `Add ${sourceId} to sources[] or remove the inline citation.`
        })
      }
    }
    if (p.confidence === 'high') {
      const inlineSet = new Set(inlineSources)
      for (const sourceId of p.sources || []) {
        if (!inlineSet.has(sourceId)) {
          issues.push({
            type: 'high_confidence_source_not_cited_inline',
            page: p.filename,
            source_id: sourceId,
            description: `high-confidence sources[] entry "${sourceId}" is not cited inline`,
            severity: 'error',
            suggested_fix: `Add an inline [source: ${sourceId}] marker near the supported claim, or lower confidence.`
          })
        }
      }
    }
    if (p.type === 'contradiction' && !/resolution:/i.test(body)) {
      issues.push({
        type: 'open_contradiction',
        page: p.filename,
        description: 'contradiction page body has no "resolution:"',
        severity: 'error',
        suggested_fix: 'Document how the contradiction is resolved with a "resolution:" line in the body.'
      })
    }
  }

  // Source indexing health. Registered (metadata-only) sources are exempt — they are
  // citation anchors with no blob/vectors by design.
  for (const s of rawManifest.sources) {
    if (domainFilter && s.domain !== domainFilter) continue
    if (s.kind === 'registered' || s.indexed === false) continue
    if (s.embedding_status === 'failed' || s.chunks_indexed === 0) {
      issues.push({
        type: 'source_not_indexed',
        source_id: s.source_id,
        description: `source not indexed (embedding_status ${s.embedding_status}, chunks_indexed ${s.chunks_indexed})`,
        severity: 'error',
        suggested_fix: 'Re-ingest the source via library_ingest, or remove the stale raw_manifest entry.'
      })
    }
  }

  // Cache currency (Challenge B). Mechanically flag active pages built on stale
  // snapshots: a cited snapshot that a newer ingest has superseded, a snapshot aged
  // past a per-domain threshold, or a cited snapshot with no upstream identity (so
  // supersession cannot be detected at all). Confidence and currency are independent —
  // a high-confidence page can cite a superseded snapshot. The librarian decides
  // whether to re-curate.
  const freshness = computeSourceFreshness(rawManifest.sources)
  const sourceById = new Map(rawManifest.sources.map((s) => [s.source_id, s]))
  // Per-domain schema cache: snapshot-age threshold + whether the domain has opted into
  // the governance guard-rail checks. Loaded once per distinct active-page domain.
  const domainSchema = new Map<string, { maxAge?: number; governanceRequired: boolean }>()
  const schemaFor = async (domain: string) => {
    if (!domainSchema.has(domain)) {
      const schema = await readSchema(domain).catch(() => null)
      const raw = schema?.max_snapshot_age_days
      domainSchema.set(domain, {
        maxAge: typeof raw === 'number' && raw > 0 ? raw : undefined,
        governanceRequired: schema?.governance_required === true
      })
    }
    return domainSchema.get(domain)!
  }
  for (const p of pages) {
    if (p.status !== 'active') continue
    const { maxAge: threshold, governanceRequired } = await schemaFor(p.domain)

    // Safety invariant — ALWAYS checked, regardless of governance adoption. A page may never
    // authorise an operational mode; update_page rejects it at write time, so this only fires
    // on legacy or hand-edited data, and it must not be hidden behind the opt-in.
    const allowed = p.allowed_use || []
    const operational = allowed.filter((u) => isOperationalUse(u))
    if (operational.length > 0) {
      issues.push({
        type: 'operational_use_not_permitted',
        page: p.filename,
        description: `allowed_use includes operational mode(s) ${operational.join(', ')} — the library must not authorise operational actions`,
        severity: 'error',
        suggested_fix: 'Remove operational modes from allowed_use; operational actions belong to deterministic systems.'
      })
    }

    // Remaining governance guard rails are opt-in per domain (schema.governance_required).
    if (governanceRequired) {
      if (allowed.includes('public_guidance') && !p.last_source_check) {
        issues.push({
          type: 'public_guidance_without_last_source_check',
          page: p.filename,
          description: 'page permits public_guidance but has no last_source_check',
          severity: 'warning',
          suggested_fix: 'Verify the page against its sources and set last_source_check, or remove public_guidance from allowed_use.'
        })
      }
      if (allowed.includes('decision_support') && !p.business_consequence_if_stale) {
        issues.push({
          type: 'decision_support_without_stale_risk',
          page: p.filename,
          description: 'page permits decision_support but does not declare business_consequence_if_stale',
          severity: 'warning',
          suggested_fix: 'Set business_consequence_if_stale (low|medium|high), or remove decision_support from allowed_use.'
        })
      }
      if (p.business_consequence_if_stale === 'high' && !p.invalidation_policy) {
        issues.push({
          type: 'high_risk_page_without_invalidation_policy',
          page: p.filename,
          description: 'high stale-consequence page has no invalidation_policy',
          severity: 'warning',
          suggested_fix: 'Document an invalidation_policy describing when this page must be re-checked or retired.'
        })
      }
    }


    // Strict governance assurance pass for governed domains. These issue codes are
    // stable for automation and intentionally duplicate some older structural checks
    // under governed_* names so callers can audit governance completeness directly.
    if (governanceRequired) {
      const pushGov = (code: string, severity: 'error' | 'warning' | 'info', detail: string, suggested_fix: string, source_id?: string) => {
        issues.push({
          type: code,
          code,
          page: p.filename,
          filename: p.filename,
          ...(source_id ? { source_id } : {}),
          description: detail,
          severity,
          suggested_fix
        })
      }
      const decisionEligible = (p.allowed_use || []).includes('decision_support') && !(p.prohibited_use || []).includes('decision_support')
      if (!p.page_role) pushGov('governed_page_missing_page_role', 'warning', 'governed active page has no page_role metadata', 'Infer and set page_role via patch_page_metadata or migrate_governance.')
      else if (!isPageRole(p.page_role)) pushGov('governed_page_invalid_page_role', 'warning', `page_role is not recognised: ${p.page_role}`, 'Set page_role to a supported governance role.')
      if (!Array.isArray(p.allowed_use) || p.allowed_use.length === 0) pushGov('governed_page_missing_allowed_use', 'warning', 'governed active page is missing allowed_use', 'Apply the page_role default policy or set allowed_use explicitly.')
      if (!Array.isArray(p.prohibited_use) || p.prohibited_use.length === 0) pushGov('governed_page_missing_prohibited_use', 'warning', 'governed active page is missing prohibited_use', 'Apply the page_role default policy or set prohibited_use explicitly; operational modes should remain prohibited.')
      if (!p.business_consequence_if_stale) pushGov('governed_page_missing_stale_risk', 'warning', 'governed active page is missing business_consequence_if_stale', 'Set business_consequence_if_stale to low, medium, or high.')
      if (!p.invalidation_policy) pushGov('governed_page_missing_invalidation_policy', 'warning', 'governed active page is missing invalidation_policy', 'Add an invalidation policy explaining when the page must be re-checked or retired.')
      if (!p.last_source_check) pushGov('governed_page_missing_last_source_check', decisionEligible ? 'warning' : 'info', 'governed active page is missing last_source_check', 'Verify the page against cited sources and set last_source_check.')
      if (!p.review_after) pushGov('governed_page_missing_review_after', 'warning', 'governed active page is missing review_after', 'Set review_after to the next required review date.')
      if (!p.reviewed_by || !p.reviewed_at) pushGov('governed_page_missing_review_metadata', 'warning', 'governed active page is missing reviewed_by or reviewed_at', 'Set reviewed_by and reviewed_at after review.')
      if ((p.sources || []).length === 0) pushGov('governed_page_missing_source_metadata', 'error', 'governed active page has no sources[] metadata', 'Add at least one registered source_id to sources[].')

      const blob = await readBlob(wiki, `pages/${p.filename}`)
      const body = blob?.content ?? ''
      const inlineSources = inlineSourceIds(body)
      const inlineSet = new Set(inlineSources)
      const metadataSet = new Set(p.sources || [])
      if (inlineSources.length === 0) pushGov('governed_page_missing_inline_citation', 'error', 'governed active page body contains no inline [source: ...] citation', 'Add inline [source: <source_id>] markers near supported claims.')
      for (const sourceId of inlineSources) {
        if (!metadataSet.has(sourceId)) pushGov('governed_page_cites_source_not_in_metadata', 'error', `inline citation ${sourceId} is not listed in sources[]`, `Add ${sourceId} to sources[] or remove the inline citation.`, sourceId)
      }
      for (const sourceId of p.sources || []) {
        if (!inlineSet.has(sourceId)) pushGov('governed_page_metadata_source_not_cited', 'error', `sources[] entry ${sourceId} is not cited inline`, `Add an inline [source: ${sourceId}] marker or remove the metadata entry.`, sourceId)
        const src = sourceById.get(sourceId)
        if (!src) continue
        if (!src.source_url && !src.upstream_id) pushGov('governed_page_source_missing_upstream_identity', 'error', `source ${sourceId} has neither source_url nor upstream_id`, 'Set source_url or upstream_id via set_provenance/register_source.', sourceId)
        if (!src.upstream_owner) pushGov('governed_page_source_missing_upstream_owner', 'warning', `source ${sourceId} has no upstream_owner`, 'Set upstream_owner on the source metadata.', sourceId)
        if (!src.last_upstream_check) pushGov('governed_page_source_unchecked', decisionEligible ? 'warning' : 'info', `source ${sourceId} has no last_upstream_check`, 'Run mark_source_checked after verifying the upstream source.', sourceId)
        if (!src.upstream_status || src.upstream_status === 'unknown') pushGov('governed_page_source_unknown_status', decisionEligible ? 'warning' : 'info', `source ${sourceId} has unknown upstream_status`, 'Run mark_source_checked with current/superseded/unavailable after verification.', sourceId)
      }
    }

    for (const sourceId of p.sources || []) {
      const f = freshness.get(sourceId)
      if (!f) continue // registered or unknown source: not a snapshot

      // Currency-of-cited-source checks (governance-gated): unchecked since ingest, or
      // marked changed upstream by revalidation (Phase 2).
      if (governanceRequired) {
        const src = sourceById.get(sourceId)
        if (src?.upstream_status === 'changed') {
          issues.push({
            type: 'active_page_cites_stale_source',
            page: p.filename,
            source_id: sourceId,
            description: `cited source "${sourceId}" is marked upstream_status: changed`,
            severity: 'error',
            suggested_fix: 'Re-ingest the upstream source and update this page to cite the fresh snapshot.'
          })
        } else if (src?.upstream_status === 'superseded') {
          issues.push({
            type: 'active_page_cites_superseded_source',
            page: p.filename,
            source_id: sourceId,
            description: `cited source "${sourceId}" is marked upstream_status: superseded`,
            severity: 'warning',
            suggested_fix: 'Update this page to cite the current upstream snapshot, or document why the superseded source remains intentionally pinned.'
          })
        } else if (!src?.last_upstream_check || src?.upstream_status === 'unknown') {
          const reason = !src?.last_upstream_check
            ? 'no last_upstream_check'
            : 'upstream_status is unknown'
          issues.push({
            type: 'active_page_cites_unchecked_source',
            page: p.filename,
            source_id: sourceId,
            description: `cited source "${sourceId}" has not been confirmed current against upstream (${reason})`,
            severity: 'info',
            suggested_fix: 'Run upstream revalidation on the source with library_write (operation: mark_source_checked).'
          })
        }
      }

      if (f.superseded_by.length > 0) {
        const newest = f.superseded_by[f.superseded_by.length - 1]
        issues.push({
          type: 'cites_superseded_source',
          page: p.filename,
          source_id: sourceId,
          description: `cites snapshot "${sourceId}" but a newer snapshot "${newest}" of the same upstream exists`,
          severity: 'warning',
          suggested_fix: `Re-read ${newest} and update this page to cite it, or confirm the older snapshot is intentionally pinned.`
        })
      }
      if (!f.groupable) {
        issues.push({
          type: 'source_missing_upstream_id',
          page: p.filename,
          source_id: sourceId,
          description: `cited snapshot "${sourceId}" has no upstream identity (no upstream_id or source_url); supersession cannot be detected`,
          severity: 'info',
          suggested_fix: `Set an upstream identity with library_write (operation: set_provenance, source_id: ${sourceId}).`
        })
      }
      if (threshold !== undefined && f.age_days > threshold) {
        issues.push({
          type: 'snapshot_aged',
          page: p.filename,
          source_id: sourceId,
          description: `cited snapshot "${sourceId}" is ${f.age_days} days old (domain threshold ${threshold})`,
          severity: 'info',
          suggested_fix: 'Re-fetch and re-ingest the source, then update the page to cite the fresh snapshot.'
        })
      }
    }
  }

  // Per-domain checks: synthesis coverage/freshness and schema presence. Computed over
  // active pages grouped by domain (respecting the optional domainFilter).
  const schemaDomains = await listSchemaDomains()
  const activeByDomain = new Map<string, typeof manifest.pages>()
  for (const p of pages) {
    if (p.status !== 'active') continue
    if (!activeByDomain.has(p.domain)) activeByDomain.set(p.domain, [])
    activeByDomain.get(p.domain)!.push(p)
  }

  for (const [domain, domainPages] of activeByDomain) {
    const synthesis = domainPages.filter((p) => p.type === 'synthesis')

    // governance_not_adopted — the domain serves enough active pages to be consumed under a
    // real intended_use, but has not opted into the governance layer. This matters because
    // query-time use-gating runs regardless of opt-in: consumers can be refused (e.g.
    // no_last_source_check) while lint shows nothing. Surfacing the adoption gap keeps the
    // "enforcement on, detection off" state visible rather than silent.
    if (domainPages.length >= 3 && !(await schemaFor(domain)).governanceRequired) {
      issues.push({
        type: 'governance_not_adopted',
        domain,
        description: `domain "${domain}" has ${domainPages.length} active pages but has not set governance_required; query use-gating still applies, so consumers may be refused without lint explaining why`,
        severity: 'info',
        suggested_fix: `Set governance_required: true (and max_snapshot_age_days) in ${domain}.schema.json to surface the per-page governance issues, then backfill the flagged metadata.`
      })
    }

    // missing_synthesis — 3+ active pages in a domain but no synthesis page.
    if (domainPages.length >= 3 && synthesis.length === 0) {
      issues.push({
        type: 'missing_synthesis',
        domain,
        description: `domain "${domain}" has ${domainPages.length} active pages and no synthesis page`,
        severity: 'warning',
        suggested_fix: `Create ${domain}-synthesis.md via library_update with page_type: synthesis.`
      })
    }

    // stale_synthesis — synthesis page whose review_after date has passed.
    for (const s of synthesis) {
      if (s.review_after && daysSince(s.review_after) > 0) {
        issues.push({
          type: 'stale_synthesis',
          page: s.filename,
          domain,
          description: `synthesis review_after ${s.review_after} has passed`,
          severity: 'info',
          suggested_fix: 'Re-read the domain pages and update the synthesis, then set a new review_after.'
        })
      }
    }

    // missing_schema — 5+ active pages in a domain but no schema file.
    if (domainPages.length >= 5 && !schemaDomains.has(domain)) {
      issues.push({
        type: 'missing_schema',
        domain,
        description: `domain "${domain}" has ${domainPages.length} active pages and no schema file`,
        severity: 'info',
        suggested_fix: `Create ${domain}.schema.json via library_update_schema.`
      })
    }
  }

  const normalizedIssues = issues.map((i) => ({
    ...i,
    code: i.code ?? i.type,
    filename: i.filename ?? i.page,
    level: i.level ?? i.severity,
    detail: i.detail ?? i.description
  }))
  return ok({ issues: normalizedIssues, issue_count: normalizedIssues.length }, [])
}

export const lintTool: ToolDefinition = {
  name: 'library_lint',
  description:
    'Read-only structural health check of the wiki: orphan pages, missing/broken ' +
    'references, missing citations, open contradictions, stale embeddings, unindexed ' +
    'sources, and manifest/blob drift. Each issue includes a suggested_fix.',
  inputSchema,
  handler: (input) => toEnvelope(() => lintImpl(input))
}
