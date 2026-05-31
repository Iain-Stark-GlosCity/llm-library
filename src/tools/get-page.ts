// library_get_page — fetch a single curated page by filename. Read-only. Returns the
// manifest metadata, the full markdown (frontmatter + body), and the body alone.

import { DomainEnvelope, DomainException, ToolDefinition, ok, toEnvelope } from '../types'
import { getWikiContainer, readBlob } from '../storage/blobs'
import { readManifest } from '../storage/manifest'
import { stripFrontmatter } from './shared'

const FILENAME_RE = /^[a-z0-9][a-z0-9-]*\.md$/

const inputSchema = {
  type: 'object',
  properties: {
    filename: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]*\\.md$', maxLength: 80 },
    library_id: { type: 'string' }
  },
  required: ['filename'],
  additionalProperties: false
}

async function getPageImpl(input: unknown): Promise<DomainEnvelope> {
  const a = (input ?? {}) as Record<string, any>
  if (typeof a.filename !== 'string' || !FILENAME_RE.test(a.filename) || a.filename.length > 80) {
    throw new DomainException('VALIDATION_ERROR', 'filename must match ^[a-z0-9][a-z0-9-]*\\.md$ and be ≤80 chars')
  }
  const filename: string = a.filename
  const libraryId = typeof a.library_id === 'string' && a.library_id ? a.library_id : 'default'

  const wiki = await getWikiContainer()
  const blob = await readBlob(wiki, `pages/${filename}`)
  if (!blob) {
    throw new DomainException('NOT_FOUND', `page not found: ${filename}`)
  }

  const { manifest } = await readManifest(libraryId)
  const entry = manifest.pages.find((p) => p.filename === filename)

  return ok({
    filename,
    metadata: entry ?? null,
    content: blob.content,
    body: stripFrontmatter(blob.content)
  })
}

export const getPageTool: ToolDefinition = {
  name: 'library_get_page',
  description:
    'Fetch a single curated wiki page by filename. Returns its manifest metadata, the ' +
    'full markdown (frontmatter + body), and the body alone. Read-only.',
  inputSchema,
  handler: (input) => toEnvelope(() => getPageImpl(input))
}
