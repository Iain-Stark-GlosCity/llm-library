// library_ingest — store a raw source, chunk, embed, update raw_manifest.json.
// Does not touch the wiki. Does not infer contradictions or confidence.
// See CLAUDE.md "library_ingest".

import { DomainEnvelope, DomainException, ToolDefinition, ok, toEnvelope } from '../types'
import { getRawContainer, writeBlob } from '../storage/blobs'
import { readRawManifest, writeRawManifest } from '../storage/raw-manifest'
import { appendLog } from '../storage/log'
import { ensureCollection, upsertPoints, QdrantPoint } from '../storage/qdrant'
import { embed } from '../embed/openai'
import { chunkText } from '../embed/chunk'
import { rawChunkPointId } from '../embed/ids'
import { sparseVector } from '../embed/sparse'
import { getConfig } from '../config'
import { sha256, slugify, resolveLibraryId, assertValidDomain } from './shared'

const inputSchema = {
  type: 'object',
  properties: {
    title: { type: 'string', maxLength: 120 },
    content: { type: 'string', maxLength: 200_000 },
    source_type: { type: 'string', enum: ['primary', 'secondary', 'derived'] },
    source_url: { type: 'string' },
    upstream_id: { type: 'string' },
    upstream_owner: { type: 'string' },
    domain: { type: 'string' },
    library_id: { type: 'string' }
  },
  required: ['title', 'content', 'source_type'],
  additionalProperties: false
}

async function ingestImpl(input: unknown): Promise<DomainEnvelope> {
  const a = (input ?? {}) as Record<string, any>

  // 1. Validate.
  if (typeof a.title !== 'string' || a.title.length === 0 || a.title.length > 120) {
    throw new DomainException('VALIDATION_ERROR', 'title is required and must be 1–120 characters')
  }
  if (typeof a.content !== 'string' || a.content.length === 0) {
    throw new DomainException('VALIDATION_ERROR', 'content is required')
  }
  if (a.content.length > 200_000) {
    throw new DomainException('VALIDATION_ERROR', 'content exceeds 200,000 characters')
  }
  if (!['primary', 'secondary', 'derived'].includes(a.source_type)) {
    throw new DomainException('VALIDATION_ERROR', 'source_type must be primary | secondary | derived')
  }
  const title: string = a.title
  const content: string = a.content
  const sourceType: string = a.source_type
  const sourceUrl: string = typeof a.source_url === 'string' ? a.source_url : ''
  const upstreamId: string = typeof a.upstream_id === 'string' ? a.upstream_id : ''
  const upstreamOwner: string = typeof a.upstream_owner === 'string' ? a.upstream_owner : ''
  // Validate domain when provided (optional here, unlike library_update). Without this,
  // raw chunks could carry a domain string the wiki layer rejects, and Qdrant domain
  // filters would silently never match them.
  const domain: string = typeof a.domain === 'string' && a.domain ? assertValidDomain(a.domain) : ''
  const libraryId = resolveLibraryId(a)

  const warnings: string[] = []
  const now = new Date()
  const hash = sha256(content)
  const yyyy = now.getUTCFullYear()
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0')
  const sourceId = `${yyyy}/${mm}/${slugify(title)}-${hash.slice(0, 8)}.md`
  const rawBlobPath = `${getConfig().rawContainer}/${sourceId}`

  // 2. Collision check against raw_manifest.json.
  const { manifest: rawManifest, etag: rawEtag } = await readRawManifest(libraryId)
  const existing = rawManifest.sources.find((s) => s.source_id === sourceId)
  if (existing) {
    if (existing.content_hash === hash) {
      return ok(
        {
          source_id: sourceId,
          duplicate: true,
          chunks_indexed: existing.chunks_indexed,
          raw_blob_path: rawBlobPath,
          embedding_status: existing.embedding_status,
          raw_manifest_updated: false,
          embedded: existing.embedding_status === 'ok',
          log_entry: `duplicate ${sourceId}`
        },
        warnings
      )
    }
    throw new DomainException('CONFLICT', `source_id ${sourceId} already exists with different content`)
  }

  // 3. Critical write: store raw content.
  const rawContainer = await getRawContainer()
  await writeBlob(rawContainer, sourceId, content)

  // 4–6. Chunk, embed (batch), sparse, upsert. Failures here are warnings only.
  const chunks = chunkText(content)
  let chunksIndexed = 0
  let embeddingStatus: 'ok' | 'failed' = 'ok'
  let embedded = false
  try {
    await ensureCollection()
    const vectors = await embed(chunks)
    const points: QdrantPoint[] = chunks.map((chunk, i) => ({
      id: rawChunkPointId(libraryId, sourceId, i),
      vector: { default: vectors[i], text: sparseVector(chunk) },
      payload: {
        record_type: 'raw_chunk',
        library_id: libraryId,
        source_id: sourceId,
        chunk_index: i,
        domain,
        source_type: sourceType,
        title
      }
    }))
    await upsertPoints(points)
    chunksIndexed = chunks.length
    embedded = true
  } catch (err) {
    embeddingStatus = 'failed'
    warnings.push(`embedding_failed: ${(err as Error).message}`)
  }

  // 7. Update raw_manifest.json (ETag-aware). Never fail after the critical write.
  let rawManifestUpdated = false
  rawManifest.sources.push({
    source_id: sourceId,
    title,
    source_type: sourceType,
    domain,
    source_url: sourceUrl,
    ...(upstreamId ? { upstream_id: upstreamId } : {}),
    ...(upstreamOwner ? { upstream_owner: upstreamOwner } : {}),
    created: now.toISOString(),
    chunks_indexed: chunksIndexed,
    embedding_status: embeddingStatus,
    content_hash: hash,
    kind: 'ingested',
    indexed: embeddingStatus === 'ok'
  })
  try {
    const w = await writeRawManifest(rawManifest, rawEtag)
    if (w.conflict) warnings.push('raw_manifest_conflict', 'source_blob_written')
    else if (!w.success) warnings.push('raw_manifest_write_failed')
    else rawManifestUpdated = true
  } catch {
    warnings.push('raw_manifest_write_failed')
  }

  // 8. Log (warning only on failure).
  const logEntry = `ingest ${sourceId} (${chunksIndexed} chunks, embedding ${embeddingStatus})`
  const log = await appendLog({
    ts: now.toISOString(),
    tool: 'library_ingest',
    action: logEntry,
    source_id: sourceId,
    library_id: libraryId
  })
  if (!log.ok) warnings.push('log_append_failed')

  return ok(
    {
      source_id: sourceId,
      chunks_indexed: chunksIndexed,
      raw_blob_path: rawBlobPath,
      embedding_status: embeddingStatus,
      raw_manifest_updated: rawManifestUpdated,
      embedded,
      log_entry: logEntry
    },
    warnings
  )
}

export const ingestTool: ToolDefinition = {
  name: 'library_ingest',
  description:
    'Store a raw source document: chunk it, embed the chunks (dense + sparse) into ' +
    'Qdrant, and register it in raw_manifest.json. Does not create or modify wiki pages.',
  inputSchema,
  handler: (input) => toEnvelope(() => ingestImpl(input))
}
