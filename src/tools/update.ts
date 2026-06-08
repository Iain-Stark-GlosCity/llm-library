// library_update — the only curated wiki write path. Generates frontmatter
// deterministically, versions the previous page into history/, upserts the wiki_page
// vector, and regenerates manifest.json + index.md. Returns ok:true once the page is
// written, regardless of secondary-state failures. See CLAUDE.md "library_update".

import { DomainEnvelope, DomainException, ToolDefinition, ok, toEnvelope } from '../types'
import { getWikiContainer, readBlob, writeBlob, conditionalWrite } from '../storage/blobs'
import { readManifest, writeManifest, PageEntry } from '../storage/manifest'
import { regenerateIndex } from '../storage/index'
import { readRawManifest } from '../storage/raw-manifest'
import { appendLog } from '../storage/log'
import { ensureCollection, upsertPoints, QdrantPoint } from '../storage/qdrant'
import { embed } from '../embed/openai'
import { wikiPagePointId } from '../embed/ids'
import { sparseVector } from '../embed/sparse'
import { renderFrontmatter, extractCreated, inlineSourceIds, assertValidDomain } from './shared'
import { isUseMode, isOperationalUse, isPageRole, PAGE_ROLES } from './governance'

const FILENAME_RE = /^[a-z0-9][a-z0-9-]*\.md$/

const inputSchema = {
  type: 'object',
  properties: {
    filename: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]*\\.md$', maxLength: 80 },
    title: { type: 'string', maxLength: 120 },
    content: { type: 'string', maxLength: 50_000 },
    page_type: { type: 'string', enum: ['concept', 'source', 'synthesis', 'contradiction'] },
    page_role: { type: 'string', enum: [...PAGE_ROLES] },
    domain: { type: 'string' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low', 'unverified'] },
    tags: { type: 'array', items: { type: 'string' }, maxItems: 10 },
    summary: { type: 'string', maxLength: 200 },
    status: { type: 'string', enum: ['draft', 'active', 'deprecated'] },
    review_after: { type: 'string' },
    reviewed_by: { type: 'string', maxLength: 120 },
    reviewed_at: { type: 'string' },
    allowed_use: { type: 'array', items: { type: 'string' } },
    prohibited_use: { type: 'array', items: { type: 'string' } },
    last_source_check: { type: 'string' },
    business_consequence_if_stale: { type: 'string', enum: ['low', 'medium', 'high'] },
    invalidation_policy: { type: 'string', maxLength: 500 },
    sources: { type: 'array', items: { type: 'string' } },
    related: { type: 'array', items: { type: 'string' } },
    library_id: { type: 'string' }
  },
  required: ['filename', 'title', 'content', 'page_type', 'domain', 'confidence', 'tags', 'summary'],
  additionalProperties: false
}

async function updateImpl(input: unknown): Promise<DomainEnvelope> {
  const a = (input ?? {}) as Record<string, any>

  // 1. Validate.
  if (typeof a.filename !== 'string' || a.filename.length > 80 || !FILENAME_RE.test(a.filename)) {
    throw new DomainException('VALIDATION_ERROR', 'filename must match ^[a-z0-9][a-z0-9-]*\\.md$ and be ≤80 chars')
  }
  if (typeof a.title !== 'string' || a.title.length === 0 || a.title.length > 120) {
    throw new DomainException('VALIDATION_ERROR', 'title is required and must be 1–120 characters')
  }
  if (typeof a.content !== 'string') {
    throw new DomainException('VALIDATION_ERROR', 'content is required (markdown body only, no frontmatter)')
  }
  if (a.content.length > 50_000) {
    throw new DomainException('VALIDATION_ERROR', 'content exceeds 50,000 characters')
  }
  if (!['concept', 'source', 'synthesis', 'contradiction'].includes(a.page_type)) {
    throw new DomainException('VALIDATION_ERROR', 'page_type must be concept | source | synthesis | contradiction')
  }
  assertValidDomain(a.domain)
  if (!['high', 'medium', 'low', 'unverified'].includes(a.confidence)) {
    throw new DomainException('VALIDATION_ERROR', 'confidence must be high | medium | low | unverified')
  }
  if (!Array.isArray(a.tags) || !a.tags.every((t: unknown) => typeof t === 'string')) {
    throw new DomainException('VALIDATION_ERROR', 'tags is required and must be an array of strings')
  }
  const tags: string[] = a.tags
  if (tags.length > 10) {
    throw new DomainException('VALIDATION_ERROR', 'a maximum of 10 tags is allowed')
  }
  if (typeof a.summary !== 'string' || a.summary.length === 0 || a.summary.length > 200) {
    throw new DomainException('VALIDATION_ERROR', 'summary is required and must be 1–200 characters')
  }
  // Default to draft: a page is only promoted to active deliberately, once it has
  // sources and has been reviewed. This keeps unreviewed writes out of default queries.
  const status: string = a.status ?? 'draft'
  if (!['draft', 'active', 'deprecated'].includes(status)) {
    throw new DomainException('VALIDATION_ERROR', 'status must be draft | active | deprecated')
  }

  const filename: string = a.filename
  const title: string = a.title
  const content: string = a.content
  const pageType: string = a.page_type
  const pageRole = typeof a.page_role === 'string' ? a.page_role as any : undefined
  if (pageRole && !isPageRole(pageRole)) throw new DomainException('VALIDATION_ERROR', `page_role must be one of: ${PAGE_ROLES.join(', ')}`)
  const domain: string = a.domain
  const confidence: string = a.confidence
  const summary: string = a.summary
  const reviewAfter: string | undefined = typeof a.review_after === 'string' ? a.review_after : undefined
  const reviewedBy: string | undefined = typeof a.reviewed_by === 'string' && a.reviewed_by ? a.reviewed_by : undefined
  const reviewedAt: string | undefined = typeof a.reviewed_at === 'string' && a.reviewed_at ? a.reviewed_at : undefined
  if (a.sources !== undefined && (!Array.isArray(a.sources) || !a.sources.every((s: unknown) => typeof s === 'string'))) {
    throw new DomainException('VALIDATION_ERROR', 'sources must be an array of strings')
  }
  if (a.related !== undefined && (!Array.isArray(a.related) || !a.related.every((r: unknown) => typeof r === 'string'))) {
    throw new DomainException('VALIDATION_ERROR', 'related must be an array of strings')
  }
  const sources: string[] = a.sources ?? []
  const related: string[] = a.related ?? []
  const libraryId: string = typeof a.library_id === 'string' && a.library_id ? a.library_id : 'default'

  if (reviewAfter && Number.isNaN(Date.parse(reviewAfter))) {
    throw new DomainException('VALIDATION_ERROR', 'review_after must be an ISO date or timestamp')
  }
  if (reviewedAt && Number.isNaN(Date.parse(reviewedAt))) {
    throw new DomainException('VALIDATION_ERROR', 'reviewed_at must be an ISO date or timestamp')
  }

  // Governance metadata (all optional). allowed_use must be supported modes only — a page
  // may never authorise an operational mode (formal/live/payment/enforcement); those belong
  // to deterministic operational systems, not cached knowledge.
  if (a.allowed_use !== undefined && (!Array.isArray(a.allowed_use) || !a.allowed_use.every((u: unknown) => typeof u === 'string'))) {
    throw new DomainException('VALIDATION_ERROR', 'allowed_use must be an array of strings')
  }
  if (a.prohibited_use !== undefined && (!Array.isArray(a.prohibited_use) || !a.prohibited_use.every((u: unknown) => typeof u === 'string'))) {
    throw new DomainException('VALIDATION_ERROR', 'prohibited_use must be an array of strings')
  }
  const allowedUse: string[] = a.allowed_use ?? []
  const prohibitedUse: string[] = a.prohibited_use ?? []
  for (const u of [...allowedUse, ...prohibitedUse]) {
    if (!isUseMode(u)) throw new DomainException('VALIDATION_ERROR', `unknown use mode: ${u}`)
  }
  const selfAuthorisedOperational = allowedUse.filter((u) => isOperationalUse(u))
  if (selfAuthorisedOperational.length > 0) {
    throw new DomainException('VALIDATION_ERROR', `allowed_use may not include operational modes (${selfAuthorisedOperational.join(', ')}); operational actions belong to deterministic systems, not curated knowledge`)
  }
  const lastSourceCheck: string | undefined = typeof a.last_source_check === 'string' && a.last_source_check ? a.last_source_check : undefined
  if (lastSourceCheck && Number.isNaN(Date.parse(lastSourceCheck))) {
    throw new DomainException('VALIDATION_ERROR', 'last_source_check must be an ISO date or timestamp')
  }
  const businessConsequenceIfStale: string | undefined = typeof a.business_consequence_if_stale === 'string' && a.business_consequence_if_stale ? a.business_consequence_if_stale : undefined
  if (businessConsequenceIfStale && !['low', 'medium', 'high'].includes(businessConsequenceIfStale)) {
    throw new DomainException('VALIDATION_ERROR', 'business_consequence_if_stale must be low | medium | high')
  }
  const invalidationPolicy: string | undefined = typeof a.invalidation_policy === 'string' && a.invalidation_policy ? a.invalidation_policy : undefined

  const warnings: string[] = []
  const nowIso = new Date().toISOString()

  // 2. Validate source/citation integrity before any durable write. Source IDs that
  // appear in either sources[] or inline [source: ...] markers must already exist in
  // raw_manifest.json (via library_ingest or library_register_source). Active and
  // high-confidence pages additionally require explicit review metadata and citations.
  const { manifest: rawManifest } = await readRawManifest(libraryId)
  const knownSources = new Set(rawManifest.sources.map((s) => s.source_id))
  const sourceSet = new Set(sources)
  const inlineSources = inlineSourceIds(content)
  const inlineSourceSet = new Set(inlineSources)

  const unknownMetadataSources = sources.filter((s) => !knownSources.has(s))
  if (unknownMetadataSources.length > 0) {
    throw new DomainException('VALIDATION_ERROR', `sources[] contains unknown source_id(s): ${unknownMetadataSources.join(', ')}`)
  }
  const unknownInlineSources = inlineSources.filter((s) => !knownSources.has(s))
  if (unknownInlineSources.length > 0) {
    throw new DomainException('VALIDATION_ERROR', `inline citations reference unknown source_id(s): ${unknownInlineSources.join(', ')}`)
  }
  const inlineNotInMetadata = inlineSources.filter((s) => !sourceSet.has(s))
  if (inlineNotInMetadata.length > 0) {
    throw new DomainException('VALIDATION_ERROR', `inline citations must be listed in sources[]: ${inlineNotInMetadata.join(', ')}`)
  }
  const metadataNotInline = sources.filter((s) => !inlineSourceSet.has(s))
  if ((status === 'active' || confidence === 'high') && sources.length === 0) {
    throw new DomainException('VALIDATION_ERROR', `${status === 'active' ? 'active' : 'high-confidence'} pages require at least one source_id in sources[]`)
  }
  if ((status === 'active' || confidence === 'high') && inlineSources.length === 0) {
    throw new DomainException('VALIDATION_ERROR', `${status === 'active' ? 'active' : 'high-confidence'} pages require at least one inline [source: <source_id>] marker`)
  }
  if (confidence === 'high' && metadataNotInline.length > 0) {
    throw new DomainException('VALIDATION_ERROR', `high-confidence pages require every sources[] ID to be cited inline: ${metadataNotInline.join(', ')}`)
  }
  if (status === 'active' && (!reviewedBy || !reviewedAt)) {
    throw new DomainException('VALIDATION_ERROR', 'active pages require reviewed_by and reviewed_at metadata')
  }

  // Synthesis pages represent the current best understanding of a domain. They carry
  // stricter conventions than concept pages: always active, always sourced, always
  // reviewable. See the synthesis design.
  if (pageType === 'synthesis') {
    if (status !== 'active') {
      throw new DomainException('VALIDATION_ERROR', 'synthesis pages must have status: active (never draft)')
    }
    if (!reviewAfter) {
      throw new DomainException('VALIDATION_ERROR', 'synthesis pages require review_after (ISO date)')
    }
  }

  // 3. Read existing page; preserve created; capture ETag.
  const wiki = await getWikiContainer()
  const pagePath = `pages/${filename}`
  const existing = await readBlob(wiki, pagePath)
  let created = nowIso
  let previousVersionPath: string | undefined
  if (existing) {
    const ec = extractCreated(existing.content)
    if (ec) created = ec
  }

  // 4–6. Compose full page and write with ETag conditional. This is the critical write.
  // History is written after the conditional page write succeeds; otherwise an ETag
  // conflict would leave a misleading archived version for an update that did not land.
  const frontmatter = renderFrontmatter({
    title,
    type: pageType,
    page_role: pageRole,
    domain,
    confidence,
    status,
    summary,
    tags,
    sources,
    related,
    review_after: reviewAfter,
    reviewed_by: reviewedBy,
    reviewed_at: reviewedAt,
    allowed_use: allowedUse,
    prohibited_use: prohibitedUse,
    last_source_check: lastSourceCheck,
    business_consequence_if_stale: businessConsequenceIfStale,
    invalidation_policy: invalidationPolicy,
    created,
    updated: nowIso
  })
  const fullPage = `${frontmatter}\n\n${content}\n`

  const w = await conditionalWrite(wiki, pagePath, fullPage, existing?.etag ?? null, 'text/markdown; charset=utf-8')
  if (w.conflict) throw new DomainException('CONFLICT', `ETag conflict writing ${filename}; caller should retry`)
  if (!w.success) throw new DomainException('STORAGE_ERROR', `Failed to write ${filename}`)

  if (existing) {
    const slug = filename.replace(/\.md$/, '')
    const safeTs = nowIso.replace(/:/g, '-')
    const histPath = `history/${slug}/${safeTs}.md`
    try {
      await writeBlob(wiki, histPath, existing.content)
      previousVersionPath = histPath
    } catch {
      warnings.push('history_write_failed')
    }
  }

  // 7. Embed + upsert wiki_page vector. Failure = warning only.
  let embedded = false
  let embeddingStatus: 'ok' | 'failed' = 'ok'
  try {
    await ensureCollection()
    const [vec] = await embed(`${title}\n${summary}\n\n${content}`)
    const point: QdrantPoint = {
      id: wikiPagePointId(libraryId, filename),
      vector: { default: vec, text: sparseVector(`${title} ${summary} ${content}`) },
      payload: {
        record_type: 'wiki_page',
        library_id: libraryId,
        filename,
        title,
        type: pageType,
        domain,
        confidence,
        tags,
        status,
        updated: nowIso
      }
    }
    await upsertPoints([point])
    embedded = true
  } catch (err) {
    embeddingStatus = 'failed'
    warnings.push('embedding_failed', (err as Error).message)
  }

  // 8–9. Update manifest.json then regenerate index.md. ETag-aware; warnings only.
  let manifestUpdated = false
  let indexUpdated = false
  try {
    const { manifest, etag } = await readManifest(libraryId)
    const entry: PageEntry = {
      filename,
      title,
      type: pageType,
      page_role: pageRole,
      domain,
      confidence,
      status,
      summary,
      tags,
      sources,
      related,
      review_after: reviewAfter,
      reviewed_by: reviewedBy,
      reviewed_at: reviewedAt,
      ...(allowedUse.length ? { allowed_use: allowedUse } : {}),
      ...(prohibitedUse.length ? { prohibited_use: prohibitedUse } : {}),
      ...(lastSourceCheck ? { last_source_check: lastSourceCheck } : {}),
      ...(businessConsequenceIfStale ? { business_consequence_if_stale: businessConsequenceIfStale } : {}),
      ...(invalidationPolicy ? { invalidation_policy: invalidationPolicy } : {}),
      created,
      updated: nowIso,
      embedding_status: embeddingStatus
    }
    const idx = manifest.pages.findIndex((p) => p.filename === filename)
    if (idx >= 0) manifest.pages[idx] = entry
    else manifest.pages.push(entry)

    const mw = await writeManifest(manifest, etag)
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
  } catch {
    warnings.push('manifest_write_failed')
  }

  // 10. Log (warning only on failure).
  const log = await appendLog({
    ts: nowIso,
    tool: 'library_update',
    action: `update ${filename} (${existing ? 'revised' : 'new'})`,
    filename,
    library_id: libraryId
  })
  if (!log.ok) warnings.push('log_append_failed')

  return ok(
    {
      filename,
      previous_version_path: previousVersionPath,
      manifest_updated: manifestUpdated,
      index_updated: indexUpdated,
      embedded,
      embedding_status: embeddingStatus
    },
    warnings
  )
}

export const updateTool: ToolDefinition = {
  name: 'library_update',
  description:
    'Create or update a curated wiki page. Frontmatter is generated from the structured ' +
    'inputs (content is body-only). The previous version is archived to history/, the ' +
    'page is re-embedded, and manifest.json + index.md are regenerated.',
  inputSchema,
  handler: (input) => toEnvelope(() => updateImpl(input))
}
