// library_lint — read-only mechanical health checks over the wiki. No prose
// interpretation, no mutation. Each issue carries a suggested_fix hint. See CLAUDE.md.

import { DomainEnvelope, ToolDefinition, ok, toEnvelope } from '../types'
import { getWikiContainer, readBlob, listBlobs } from '../storage/blobs'
import { readManifest } from '../storage/manifest'
import { readRawManifest } from '../storage/raw-manifest'
import { listSchemaDomains } from '../storage/schema'
import { scrollPoints } from '../storage/qdrant'
import { daysSince } from './shared'

interface LintIssue {
  type: string
  page?: string
  source_id?: string
  domain?: string
  description: string
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
    if (p.status !== 'active') continue
    if (!p.sources || p.sources.length === 0) {
      issues.push({
        type: 'missing_source_metadata',
        page: p.filename,
        description: 'active page has empty or absent sources[]',
        severity: 'warning',
        suggested_fix: 'Add at least one source_id to sources[] (register it first with library_register_source if needed).'
      })
    }
    if ((p.type === 'concept' || p.type === 'synthesis') && !inbound.has(p.filename)) {
      issues.push({
        type: 'orphan_page',
        page: p.filename,
        description: 'no inbound related[] links from other active pages',
        severity: 'info',
        suggested_fix: `Add "${p.filename}" to the related[] of a connected page (e.g. the overview).`
      })
    }
  }

  // Content-fetch checks: inline_citation_missing (active) and open_contradiction.
  for (const p of pages) {
    const needsBody = p.status === 'active' || p.type === 'contradiction'
    if (!needsBody) continue
    const blob = await readBlob(wiki, `pages/${p.filename}`)
    const body = blob?.content ?? ''
    if (p.status === 'active' && !/\[source:[^\]]*\]/.test(body)) {
      issues.push({
        type: 'inline_citation_missing',
        page: p.filename,
        description: 'page body contains no [source: ...] citation',
        severity: 'info',
        suggested_fix: 'Add at least one inline [source: <source_id>] marker in the body.'
      })
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

  return ok({ issues, issue_count: issues.length }, [])
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
