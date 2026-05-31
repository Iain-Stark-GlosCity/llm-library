// library_deprecate_page — controlled cleanup path for retiring curated pages without
// physically deleting history. Marks the page deprecated in the blob, manifest, and
// vector payload so default queries stop returning it.

import { DomainEnvelope, DomainException, ToolDefinition, ok, toEnvelope } from '../types'
import { getWikiContainer, readBlob, writeBlob, conditionalWrite } from '../storage/blobs'
import { readManifest, writeManifest } from '../storage/manifest'
import { regenerateIndex } from '../storage/index'
import { appendLog } from '../storage/log'
import { ensureCollection, setPayload } from '../storage/qdrant'
import { wikiPagePointId } from '../embed/ids'

const FILENAME_RE = /^[a-z0-9][a-z0-9-]*\.md$/

const inputSchema = {
  type: 'object',
  properties: {
    filename: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]*\\.md$', maxLength: 80 },
    reason: { type: 'string', maxLength: 500 },
    library_id: { type: 'string' }
  },
  required: ['filename', 'reason'],
  additionalProperties: false
}

function replaceOrInsertFrontmatterLine(content: string, key: string, value: string): string {
  if (!content.startsWith('---')) return content
  const end = content.indexOf('\n---', 3)
  if (end < 0) return content
  const frontmatter = content.slice(0, end)
  const rest = content.slice(end)
  const line = `${key}: ${value}`
  const re = new RegExp(`^${key}:\\s*.*$`, 'm')
  if (re.test(frontmatter)) return content.replace(re, line)
  return `${frontmatter}\n${line}${rest}`
}

async function deprecatePageImpl(input: unknown): Promise<DomainEnvelope> {
  const a = (input ?? {}) as Record<string, any>
  if (typeof a.filename !== 'string' || !FILENAME_RE.test(a.filename) || a.filename.length > 80) {
    throw new DomainException('VALIDATION_ERROR', 'filename must match ^[a-z0-9][a-z0-9-]*\\.md$ and be ≤80 chars')
  }
  if (typeof a.reason !== 'string' || !a.reason.trim() || a.reason.length > 500) {
    throw new DomainException('VALIDATION_ERROR', 'reason is required and must be 1–500 characters')
  }

  const filename: string = a.filename
  const reason: string = a.reason.trim()
  const libraryId = typeof a.library_id === 'string' && a.library_id ? a.library_id : 'default'
  const nowIso = new Date().toISOString()
  const warnings: string[] = []

  const { manifest, etag } = await readManifest(libraryId)
  const idx = manifest.pages.findIndex((p) => p.filename === filename)
  if (idx < 0) throw new DomainException('NOT_FOUND', `page not found in manifest: ${filename}`)

  const wiki = await getWikiContainer()
  const pagePath = `pages/${filename}`
  const existing = await readBlob(wiki, pagePath)
  if (!existing) throw new DomainException('NOT_FOUND', `page blob not found: ${filename}`)

  let updatedContent = replaceOrInsertFrontmatterLine(existing.content, 'status', 'deprecated')
  updatedContent = replaceOrInsertFrontmatterLine(updatedContent, 'updated', nowIso)
  updatedContent = `${updatedContent.trimEnd()}\n\n<!-- deprecated: ${reason.replace(/-->/g, '--&gt;')} -->\n`

  const write = await conditionalWrite(wiki, pagePath, updatedContent, existing.etag, 'text/markdown; charset=utf-8')
  if (write.conflict) throw new DomainException('CONFLICT', `ETag conflict writing ${filename}; caller should retry`)
  if (!write.success) throw new DomainException('STORAGE_ERROR', `Failed to write ${filename}`)

  const slug = filename.replace(/\.md$/, '')
  const safeTs = nowIso.replace(/:/g, '-')
  const previousVersionPath = `history/${slug}/${safeTs}.md`
  try {
    await writeBlob(wiki, previousVersionPath, existing.content)
  } catch {
    warnings.push('history_write_failed')
  }

  manifest.pages[idx] = { ...manifest.pages[idx], status: 'deprecated', updated: nowIso }
  const mw = await writeManifest(manifest, etag)
  let manifestUpdated = false
  let indexUpdated = false
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

  let vector_payload_updated = false
  try {
    await ensureCollection()
    await setPayload([wikiPagePointId(libraryId, filename)], { status: 'deprecated', updated: nowIso })
    vector_payload_updated = true
  } catch (err) {
    warnings.push('vector_payload_update_failed', (err as Error).message)
  }

  const log = await appendLog({
    ts: nowIso,
    tool: 'library_deprecate_page',
    action: `deprecate ${filename}: ${reason}`,
    filename,
    library_id: libraryId
  })
  if (!log.ok) warnings.push('log_append_failed')

  return ok({ filename, status: 'deprecated', previous_version_path: previousVersionPath, manifest_updated: manifestUpdated, index_updated: indexUpdated, vector_payload_updated }, warnings)
}

export const deprecatePageTool: ToolDefinition = {
  name: 'library_deprecate_page',
  description:
    'Retire a curated page by marking it deprecated in the page blob, manifest, and vector payload. ' +
    'Use this cleanup path for obsolete or test pages; deprecated pages are excluded from default queries.',
  inputSchema,
  handler: (input) => toEnvelope(() => deprecatePageImpl(input))
}
