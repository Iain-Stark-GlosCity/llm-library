// library_query — hybrid retrieval over curated wiki pages (default) and/or raw chunks.
// Dense + sparse vectors fused by Qdrant RRF. Mechanical gap detection from manifest.
// See CLAUDE.md "library_query".

import { randomUUID } from 'crypto'
import { DomainEnvelope, DomainException, ToolDefinition, ok, toEnvelope } from '../types'
import { getWikiContainer, getRawContainer, readBlob } from '../storage/blobs'
import { readManifest } from '../storage/manifest'
import { appendLog } from '../storage/log'
import { ensureCollection, hybridQuery, QdrantHit } from '../storage/qdrant'
import { embed } from '../embed/openai'
import { chunkText } from '../embed/chunk'
import { sparseVector, STOPWORDS } from '../embed/sparse'
import { stripFrontmatter } from './shared'

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

async function detectGaps(question: string, libraryId: string): Promise<string[]> {
  const { manifest } = await readManifest(libraryId)
  const known = new Set<string>()
  const add = (s: string) => {
    for (const w of (s || '').toLowerCase().split(/[^a-z0-9]+/)) if (w) known.add(w)
  }
  for (const p of manifest.pages) {
    add(p.title)
    add(p.domain)
    for (const t of p.tags || []) add(t)
  }
  const seen = new Set<string>()
  const gaps: string[] = []
  for (const w of question.toLowerCase().split(/[^a-z0-9]+/)) {
    if (w.length >= 4 && !STOPWORDS.has(w) && !known.has(w) && !seen.has(w)) {
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
  const scope: 'wiki' | 'raw' | 'both' = ['wiki', 'raw', 'both'].includes(a.scope) ? a.scope : 'wiki'
  const minConfidence = ['high', 'medium', 'low', 'unverified'].includes(a.min_confidence)
    ? a.min_confidence
    : 'low'
  const includeDeprecated = a.include_deprecated === true
  const libraryId = typeof a.library_id === 'string' && a.library_id ? a.library_id : 'default'

  const warnings: string[] = []
  const question: string = a.question

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

  // Fetch content from blob storage for each result.
  const wiki = await getWikiContainer()
  const raw = await getRawContainer()
  const results: unknown[] = []
  for (const h of top) {
    const p = h.payload
    if (p.record_type === 'wiki_page') {
      const blob = await readBlob(wiki, `pages/${p.filename}`)
      results.push({
        type: 'wiki_page',
        kind: 'curated', // maintained knowledge record
        filename: p.filename,
        title: p.title,
        content: blob ? stripFrontmatter(blob.content) : '',
        confidence: p.confidence,
        status: p.status,
        domain: p.domain,
        score: h.score
      })
    } else {
      const blob = await readBlob(raw, p.source_id)
      const chunk = blob ? chunkText(blob.content)[p.chunk_index] ?? '' : ''
      results.push({
        type: 'raw_chunk',
        kind: 'raw_evidence', // unverified source material, not maintained knowledge
        source_id: p.source_id,
        chunk_index: p.chunk_index,
        title: p.title,
        content: chunk,
        domain: p.domain,
        score: h.score
      })
    }
  }

  const gaps = await detectGaps(question, libraryId)
  const queryId = randomUUID()

  const log = await appendLog({
    ts: new Date().toISOString(),
    tool: 'library_query',
    action: `query "${question.slice(0, 60)}" (${results.length} results, scope ${scope})`,
    query_id: queryId,
    scores: top.map((h) => h.score)
  })
  if (!log.ok) warnings.push('log_append_failed')

  return ok({ results, gaps, query_id: queryId }, warnings)
}

export const queryTool: ToolDefinition = {
  name: 'library_query',
  description:
    'Retrieve curated wiki pages (default) or raw source chunks by hybrid semantic + ' +
    'keyword search. Supports domain/confidence filtering and reports mechanical gaps ' +
    '(question terms not found in the catalogue).',
  inputSchema,
  handler: (input) => toEnvelope(() => queryImpl(input))
}
