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
import { renderFrontmatter, extractCreated } from './shared'

const FILENAME_RE = /^[a-z0-9][a-z0-9-]*\.md$/

const inputSchema = {
  type: 'object',
  properties: {
    filename: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]*\\.md$', maxLength: 80 },
    title: { type: 'string', maxLength: 120 },
    content: { type: 'string', maxLength: 50_000 },
    page_type: { type: 'string', enum: ['concept', 'source', 'synthesis', 'contradiction'] },
    domain: { type: 'string' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low', 'unverified'] },
    tags: { type: 'array', items: { type: 'string' }, maxItems: 10 },
    summary: { type: 'string', maxLength: 200 },
    status: { type: 'string', enum: ['draft', 'active', 'deprecated'] },
    review_after: { type: 'string' },
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
  if (typeof a.domain !== 'string' || !a.domain) {
    throw new DomainException('VALIDATION_ERROR', 'domain is required')
  }
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
  const domain: string = a.domain
  const confidence: string = a.confidence
  const summary: string = a.summary
  const reviewAfter: string | undefined = typeof a.review_after === 'string' ? a.review_after : undefined
  if (a.sources !== undefined && (!Array.isArray(a.sources) || !a.sources.every((s: unknown) => typeof s === 'string'))) {
    throw new DomainException('VALIDATION_ERROR', 'sources must be an array of strings')
  }
  if (a.related !== undefined && (!Array.isArray(a.related) || !a.related.every((r: unknown) => typeof r === 'string'))) {
    throw new DomainException('VALIDATION_ERROR', 'related must be an array of strings')
  }
  const sources: string[] = a.sources ?? []
  const related: string[] = a.related ?? []
  const libraryId: string = typeof a.library_id === 'string' && a.library_id ? a.library_id : 'default'

  const warnings: string[] = []
  const nowIso = new Date().toISOString()

  // 2. Validate sources against raw_manifest.json (warn, do not fail).
  const { manifest: rawManifest } = await readRawManifest(libraryId)
  const knownSources = new Set(rawManifest.sources.map((s) => s.source_id))
  for (const s of sources) if (!knownSources.has(s)) warnings.push(`unknown_source:${s}`)

  // 3. Read existing page; preserve created; capture ETag.
  const wiki = await getWikiContainer()
  const pagePath = `pages/${filename}`
  const existing = await readBlob(wiki, pagePath)
  let created = nowIso
  let previousVersionPath: string | undefined

  // 4. History copy before overwrite.
  if (existing) {
    const ec = extractCreated(existing.content)
    if (ec) created = ec
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

  // 5–6. Compose full page and write with ETag conditional. This is the critical write.
  const frontmatter = renderFrontmatter({
    title,
    type: pageType,
    domain,
    confidence,
    status,
    summary,
    tags,
    sources,
    related,
    review_after: reviewAfter,
    created,
    updated: nowIso
  })
  const fullPage = `${frontmatter}\n\n${content}\n`

  const w = await conditionalWrite(wiki, pagePath, fullPage, existing?.etag ?? null, 'text/markdown; charset=utf-8')
  if (w.conflict) throw new DomainException('CONFLICT', `ETag conflict writing ${filename}; caller should retry`)
  if (!w.success) throw new DomainException('STORAGE_ERROR', `Failed to write ${filename}`)

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
      domain,
      confidence,
      status,
      summary,
      tags,
      sources,
      related,
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
