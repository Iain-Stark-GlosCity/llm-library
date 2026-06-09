// library_query — hybrid retrieval over curated wiki pages (default) and/or raw chunks.
// Dense + sparse vectors fused by Qdrant RRF. Mechanical gap detection from manifest and returned results.
// See CLAUDE.md "library_query".

import { randomUUID } from 'crypto'
import { DomainEnvelope, DomainException, ToolDefinition, ok, toEnvelope } from '../types'
import { getWikiContainer, getRawContainer, readBlob } from '../storage/blobs'
import { readManifest, PageEntry } from '../storage/manifest'
import { readRawManifest, SourceEntry } from '../storage/raw-manifest'
import { appendLog } from '../storage/log'
import { computeSourceFreshness, computePageFreshness, SourceFreshness } from './freshness'
import { ALL_USE_MODES, isUseMode, isOperationalUse, evaluateUse } from './governance'
import { ensureCollection, hybridQuery, QdrantHit } from '../storage/qdrant'
import { embed } from '../embed/openai'
import { chunkText } from '../embed/chunk'
import { sparseVector, STOPWORDS } from '../embed/sparse'
import { stripFrontmatter, resolveLibraryId } from './shared'

const GAP_QUERY_WORDS = new Set([
  'about',
  'find',
  'get',
  'look',
  'lookup',
  'retrieve',
  'say',
  'search',
  'show',
  'tell'
])
const GAP_STOPWORDS = new Set([...STOPWORDS, ...GAP_QUERY_WORDS])

const CONFIDENCE_ORDER = ['unverified', 'low', 'medium', 'high']

const inputSchema = {
  type: 'object',
  properties: {
    question: { type: 'string' },
    top_k: { type: 'integer', minimum: 1, maximum: 20 },
    domain: { type: 'string' },
    scope: { type: 'string', enum: ['wiki', 'raw', 'both'] },
    min_confidence: { type: 'string', enum: ['high', 'medium', 'low', 'unverified'] },
    include_deprecated: { type: 'boolean' },
    allow_cross_domain: { type: 'boolean' },
    intended_use: { type: 'string', enum: [...ALL_USE_MODES] },
    library_id: { type: 'string' }
  },
  required: ['question'],
  additionalProperties: false
}

function buildFilter(opts: {
  recordType: 'wiki_page' | 'raw_chunk'
  libraryId: string
  domain?: string
  allowedConfidence?: string[]
  excludeDeprecated?: boolean
}): unknown {
  const must: unknown[] = [
    { key: 'library_id', match: { value: opts.libraryId } },
    { key: 'record_type', match: { value: opts.recordType } }
  ]
  if (opts.domain) must.push({ key: 'domain', match: { value: opts.domain } })
  if (opts.allowedConfidence) must.push({ key: 'confidence', match: { any: opts.allowedConfidence } })
  const filter: any = { must }
  if (opts.excludeDeprecated) filter.must_not = [{ key: 'status', match: { value: 'deprecated' } }]
  return filter
}

function gapTokens(text: string): string[] {
  const tokens: string[] = []
  const normalized = text.toLowerCase()

  // Treat hyphenated identifiers as one informational gap candidate instead of
  // reporting each component as an independent missing concept. This keeps
  // canary-style ids such as `find-canary-alpha-20260531` intact while still
  // tokenizing ordinary prose mechanically.
  for (const match of normalized.matchAll(/[a-z0-9]+(?:-[a-z0-9]+)*|[a-z0-9]+/g)) {
    const token = match[0]
    if (token.length >= 4 && !GAP_STOPWORDS.has(token)) tokens.push(token)
  }

  return tokens
}

function knownGapTokens(text: string): string[] {
  const tokens = gapTokens(text)
  const expanded = new Set(tokens)

  // Catalogue fields may spell an identifier with spaces or punctuation while a
  // query uses hyphens (or vice versa). Add a compact hyphenated form for each
  // field so the mechanical check is less brittle for safe identifiers.
  const parts = (text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((part) => part.length > 0 && !GAP_STOPWORDS.has(part))
  if (parts.length > 1) expanded.add(parts.join('-'))

  return [...expanded]
}

function addGapEvidenceTokens(known: Set<string>, text: string): void {
  for (const w of knownGapTokens(text || '')) known.add(w)

  // Returned bodies and metadata are stronger evidence than the catalogue. Also
  // add component tokens so a query for `canary alpha` is satisfied by a body
  // containing `smoke-test-canary-alpha-20260531`.
  for (const part of (text || '').toLowerCase().split(/[^a-z0-9]+/)) {
    if (part.length >= 4 && !GAP_STOPWORDS.has(part)) known.add(part)
  }
}

interface GapResultEvidence {
  content?: string
  title?: string
  filename?: string
  tags?: string[]
  source_id?: string
}

function detectGaps(
  question: string,
  manifestPages: Pick<PageEntry, 'title' | 'domain' | 'tags'>[],
  resultEvidence: GapResultEvidence[] = []
): string[] {
  const known = new Set<string>()
  const add = (s: string) => addGapEvidenceTokens(known, s)
  for (const p of manifestPages) {
    add(p.title)
    add(p.domain)
    for (const t of p.tags || []) add(t)
  }
  for (const result of resultEvidence) {
    add(result.content || '')
    add(result.title || '')
    add(result.filename || '')
    add(result.source_id || '')
    for (const tag of result.tags || []) add(tag)
  }

  const seen = new Set<string>()
  const gaps: string[] = []
  for (const w of gapTokens(question)) {
    if (!known.has(w) && !seen.has(w)) {
      seen.add(w)
      gaps.push(w)
    }
  }
  return gaps
}

async function queryImpl(input: unknown): Promise<DomainEnvelope> {
  const a = (input ?? {}) as Record<string, any>

  if (typeof a.question !== 'string' || !a.question.trim()) {
    throw new DomainException('VALIDATION_ERROR', 'question is required')
  }
  let topK = typeof a.top_k === 'number' ? Math.floor(a.top_k) : 5
  if (topK < 1) topK = 1
  if (topK > 20) topK = 20
  const domain = typeof a.domain === 'string' && a.domain ? a.domain : undefined
  const allowCrossDomain = a.allow_cross_domain === true
  if (!domain && !allowCrossDomain) {
    throw new DomainException('VALIDATION_ERROR', 'domain is required by default; set allow_cross_domain: true for deliberate cross-domain discovery')
  }
  const scope: 'wiki' | 'raw' | 'both' = ['wiki', 'raw', 'both'].includes(a.scope) ? a.scope : 'wiki'
  const minConfidence = ['high', 'medium', 'low', 'unverified'].includes(a.min_confidence)
    ? a.min_confidence
    : 'low'
  const includeDeprecated = a.include_deprecated === true
  const libraryId = resolveLibraryId(a)

  // Answer mode (C). When the caller declares intended_use, results carry a per-result
  // use_permitted decision; an OPERATIONAL intent is blocked outright — the library is
  // never the basis for formal/live/payment/enforcement actions, so it withholds content.
  let intendedUse: string | undefined
  if (a.intended_use !== undefined) {
    if (typeof a.intended_use !== 'string' || !isUseMode(a.intended_use)) {
      throw new DomainException('VALIDATION_ERROR', `intended_use must be one of: ${ALL_USE_MODES.join(', ')}`)
    }
    intendedUse = a.intended_use
  }

  const warnings: string[] = []
  if (allowCrossDomain) warnings.push('cross_domain_query')
  if (scope !== 'wiki') warnings.push(`non_default_scope:${scope}`)
  const question: string = a.question

  if (intendedUse && isOperationalUse(intendedUse)) {
    const queryId = randomUUID()
    const log = await appendLog({
      ts: new Date().toISOString(),
      tool: 'library_query',
      action: `refused operational intended_use "${intendedUse}"`,
      query_id: queryId
    })
    if (!log.ok) warnings.push('log_append_failed')
    warnings.push('operational_use_refused')
    return ok(
      {
        results: [],
        gaps: [],
        query_id: queryId,
        use_decision: {
          intended_use: intendedUse,
          mode: 'operational',
          permitted: false,
          reason: 'Operational actions require deterministic systems with proper controls; curated knowledge must not be their basis. Content withheld.'
        }
      },
      warnings
    )
  }

  await ensureCollection()
  const dense = (await embed(question))[0]
  const sparse = sparseVector(question)
  const allowedConfidence = CONFIDENCE_ORDER.slice(CONFIDENCE_ORDER.indexOf(minConfidence))
  const prefetch = topK * 2

  let hits: QdrantHit[] = []
  if (scope === 'wiki' || scope === 'both') {
    const filter = buildFilter({
      recordType: 'wiki_page',
      libraryId,
      domain,
      allowedConfidence,
      excludeDeprecated: !includeDeprecated
    })
    hits = hits.concat(await hybridQuery({ dense, sparse, filter, limit: prefetch }))
  }
  if (scope === 'raw' || scope === 'both') {
    const filter = buildFilter({ recordType: 'raw_chunk', libraryId, domain })
    hits = hits.concat(await hybridQuery({ dense, sparse, filter, limit: prefetch }))
  }

  hits.sort((x, y) => y.score - x.score)

  // Deduplicate: wiki by filename, raw by source_id + chunk_index.
  const seen = new Set<string>()
  const deduped: QdrantHit[] = []
  for (const h of hits) {
    const p = h.payload
    const key =
      p.record_type === 'wiki_page'
        ? `wiki:${p.filename}`
        : `raw:${p.source_id}:${p.chunk_index}`
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(h)
  }
  const top = deduped.slice(0, topK)

  // Governed-answer envelope. Each curated result carries provenance (cited sources with
  // owner/url/capture date, page review + permitted-use governance) and a currency
  // (freshness) signal independent of confidence. All read from manifest + raw_manifest;
  // governance metadata never lives in the vector. The manifest is read once here and
  // shared with gap detection below.
  const wantWiki = scope === 'wiki' || scope === 'both'
  const { manifest } = await readManifest(libraryId)
  const pageEntries = new Map<string, PageEntry>()
  const sourceMeta = new Map<string, SourceEntry>()
  let sourceFreshness = new Map<string, SourceFreshness>()
  if (wantWiki) {
    for (const pg of manifest.pages) pageEntries.set(pg.filename, pg)
    const { manifest: rawManifest } = await readRawManifest(libraryId)
    for (const s of rawManifest.sources) sourceMeta.set(s.source_id, s)
    sourceFreshness = computeSourceFreshness(rawManifest.sources)
  }

  // Build the provenance block for one curated page from its manifest entry.
  const provenanceFor = (entry: PageEntry | undefined) => {
    const citedIds = entry?.sources || []
    return {
      reviewed_by: entry?.reviewed_by ?? null,
      reviewed_at: entry?.reviewed_at ?? null,
      review_after: entry?.review_after ?? null,
      last_source_check: entry?.last_source_check ?? null,
      allowed_use: entry?.allowed_use ?? [],
      prohibited_use: entry?.prohibited_use ?? [],
      business_consequence_if_stale: entry?.business_consequence_if_stale ?? null,
      page_role: entry?.page_role ?? null,
      invalidation_policy: entry?.invalidation_policy ?? null,
      sources: citedIds.map((id) => {
        const s = sourceMeta.get(id)
        return {
          source_id: id,
          source_url: s?.source_url ?? null,
          upstream_owner: s?.upstream_owner ?? null,
          captured_at: s?.created ?? null,
          upstream_status: s?.upstream_status ?? 'unknown',
          last_upstream_check: s?.last_upstream_check ?? null
        }
      })
    }
  }

  // Fetch content from blob storage for each result — in parallel; results stay in
  // score order because Promise.all preserves input order.
  const wiki = await getWikiContainer()
  const raw = await getRawContainer()
  const blobs = await Promise.all(
    top.map((h) =>
      h.payload.record_type === 'wiki_page'
        ? readBlob(wiki, `pages/${h.payload.filename}`)
        : readBlob(raw, h.payload.source_id)
    )
  )
  const results: unknown[] = []
  const gapEvidence: GapResultEvidence[] = []
  let usePermittedCount = 0
  for (let i = 0; i < top.length; i++) {
    const h = top[i]
    const blob = blobs[i]
    const p = h.payload
    if (p.record_type === 'wiki_page') {
      const entry = pageEntries.get(p.filename)
      const freshness = computePageFreshness(entry?.sources || [], sourceFreshness)
      const result: Record<string, unknown> = {
        type: 'wiki_page',
        kind: 'curated', // maintained knowledge record
        filename: p.filename,
        title: p.title,
        content: blob ? stripFrontmatter(blob.content) : '',
        confidence: p.confidence,
        status: p.status,
        domain: p.domain,
        tags: Array.isArray(p.tags) ? p.tags : [],
        freshness,
        provenance: provenanceFor(entry),
        score: h.score
      }
      if (intendedUse) {
        const d = evaluateUse(intendedUse, {
          allowed_use: entry?.allowed_use,
          prohibited_use: entry?.prohibited_use,
          last_source_check: entry?.last_source_check ?? null,
          business_consequence_if_stale: entry?.business_consequence_if_stale ?? null,
          invalidation_policy: entry?.invalidation_policy ?? null,
          status: entry?.status ?? null,
          page_role: entry?.page_role ?? null,
          sources: (entry?.sources || []).map((id) => sourceMeta.get(id)).filter((s): s is SourceEntry => Boolean(s)),
          superseded: freshness.superseded
        })
        result.use_permitted = d.permitted
        result.use_notes = d.notes
        if (d.permitted) usePermittedCount++
      }
      results.push(result)
      gapEvidence.push({
        content: result.content as string,
        title: result.title as string,
        filename: result.filename as string,
        tags: Array.isArray(p.tags) ? p.tags : []
      })
    } else {
      const chunk = blob ? chunkText(blob.content)[p.chunk_index] ?? '' : ''
      const result: Record<string, unknown> = {
        type: 'raw_chunk',
        kind: 'raw_evidence', // unverified source material, not maintained knowledge
        source_id: p.source_id,
        chunk_index: p.chunk_index,
        title: p.title,
        content: chunk,
        domain: p.domain,
        score: h.score
      }
      if (intendedUse) {
        // Raw evidence is not governed knowledge — usable for analysis only.
        const permitted = intendedUse === 'analysis'
        result.use_permitted = permitted
        result.use_notes = permitted ? [] : ['raw_evidence_not_governed']
        if (permitted) usePermittedCount++
      }
      results.push(result)
      gapEvidence.push({
        content: result.content as string,
        title: result.title as string,
        source_id: result.source_id as string
      })
    }
  }

  const gaps = detectGaps(question, manifest.pages, gapEvidence)
  const queryId = randomUUID()

  const log = await appendLog({
    ts: new Date().toISOString(),
    tool: 'library_query',
    action: `query "${question.slice(0, 60)}" (${results.length} results, scope ${scope})`,
    query_id: queryId,
    scores: top.map((h) => h.score)
  })
  if (!log.ok) warnings.push('log_append_failed')

  const useDecision = intendedUse
    ? {
        intended_use: intendedUse,
        mode: 'supported',
        permitted_count: usePermittedCount,
        flagged_count: results.length - usePermittedCount
      }
    : undefined

  return ok({ results, gaps, query_id: queryId, ...(useDecision ? { use_decision: useDecision } : {}) }, warnings)
}

export const queryTool: ToolDefinition = {
  name: 'library_query',
  description:
    'Retrieve curated wiki pages (default) or raw source chunks by hybrid semantic + ' +
    'keyword search. Supports domain/confidence filtering and reports mechanical gaps. ' +
    'Each curated result carries confidence, a freshness (currency) signal, and a ' +
    'provenance block. Optionally declare intended_use (analysis | drafting | ' +
    'staff_guidance | public_guidance | decision_support) to get a per-result ' +
    'use_permitted decision with increasing guard rails; operational intents ' +
    '(formal_decision | live_account_action | payment_action | enforcement_action) are ' +
    'refused and content is withheld.',
  inputSchema,
  handler: (input) => toEnvelope(() => queryImpl(input))
}
