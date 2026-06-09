// library_list_pages — list the curated catalogue from manifest.json. Read-only.
// Optional domain/status filters. This is the cheap "what's in the library" call.

import { DomainEnvelope, DomainException, ToolDefinition, ok, toEnvelope } from '../types'
import { readManifest } from '../storage/manifest'
import { resolveLibraryId } from './shared'

const inputSchema = {
  type: 'object',
  properties: {
    domain: { type: 'string' },
    status: { type: 'string', enum: ['draft', 'active', 'deprecated'] },
    library_id: { type: 'string' }
  },
  additionalProperties: false
}

async function listPagesImpl(input: unknown): Promise<DomainEnvelope> {
  const a = (input ?? {}) as Record<string, any>
  const domain = typeof a.domain === 'string' && a.domain ? a.domain : undefined
  const status = a.status
  if (status !== undefined && !['draft', 'active', 'deprecated'].includes(status)) {
    throw new DomainException('VALIDATION_ERROR', 'status must be draft | active | deprecated')
  }
  const libraryId = resolveLibraryId(a)

  const { manifest } = await readManifest(libraryId)
  const pages = manifest.pages
    .filter((p) => !domain || p.domain === domain)
    .filter((p) => !status || p.status === status)
    .map((p) => ({
      filename: p.filename,
      title: p.title,
      type: p.type,
      domain: p.domain,
      confidence: p.confidence,
      status: p.status,
      summary: p.summary,
      tags: p.tags,
      sources: p.sources,
      related: p.related,
      updated: p.updated
    }))

  return ok({ pages, count: pages.length, library_id: libraryId })
}

export const listPagesTool: ToolDefinition = {
  name: 'library_list_pages',
  description:
    'List curated wiki pages from the catalogue (manifest.json), with optional domain ' +
    'and status filters. Returns page metadata (title, type, domain, confidence, status, ' +
    'summary, tags, sources, related). Read-only.',
  inputSchema,
  handler: (input) => toEnvelope(() => listPagesImpl(input))
}
