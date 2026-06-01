// library_write operation: delete_blob — the librarian's hard-delete escape hatch.
//
// The rest of the system is append/version-only: library_write (update_page) archives
// the prior version to history/ and deprecate_page soft-retires a page. Nothing removes
// bytes from Azure. This operation does: it deletes a single stale blob directly, for
// when lint surfaces orphaned pages, abandoned history, or dead raw sources that should
// physically go away.
//
// Safety rails, because this is irreversible:
//   - Structural registries and logs (manifest.json, index.md, log.*, raw_manifest.json)
//     are refused unless force: true.
//   - Path traversal ("..", absolute paths) is rejected.
//   - By default the matching Qdrant vector(s) are purged too (purge_vector), so a
//     deleted page/source cannot resurface in queries with empty content. Set
//     purge_vector: false to delete only the blob.
//   - Deletion is idempotent: a missing blob returns deleted: false with a warning, not
//     an error.

import { ContainerClient } from '@azure/storage-blob'
import { DomainEnvelope, DomainException, ToolDefinition, ok, toEnvelope } from '../types'
import { getWikiContainer, getRawContainer, getSchemaContainer, deleteBlob } from '../storage/blobs'
import { readRawManifest } from '../storage/raw-manifest'
import { appendLog } from '../storage/log'
import { ensureCollection, deletePoints } from '../storage/qdrant'
import { wikiPagePointId, rawChunkPointId } from '../embed/ids'

const CONTAINERS = ['wiki', 'raw', 'schema'] as const
type ContainerName = (typeof CONTAINERS)[number]

// Registries and logs that must never be deleted by accident. force: true overrides.
const PROTECTED: Record<ContainerName, Set<string>> = {
  wiki: new Set(['manifest.json', 'index.md', 'log.md', 'log.jsonl']),
  raw: new Set(['raw_manifest.json']),
  schema: new Set<string>()
}

const inputSchema = {
  type: 'object',
  properties: {
    container: { type: 'string', enum: ['wiki', 'raw', 'schema'] },
    blob_path: { type: 'string', maxLength: 1024 },
    reason: { type: 'string', maxLength: 500 },
    purge_vector: { type: 'boolean' },
    force: { type: 'boolean' },
    library_id: { type: 'string' }
  },
  required: ['container', 'blob_path', 'reason'],
  additionalProperties: false
}

async function containerClientFor(name: ContainerName): Promise<ContainerClient> {
  if (name === 'wiki') return getWikiContainer()
  if (name === 'raw') return getRawContainer()
  return getSchemaContainer()
}

async function deleteBlobImpl(input: unknown): Promise<DomainEnvelope> {
  const a = (input ?? {}) as Record<string, any>

  const container = a.container
  if (typeof container !== 'string' || !CONTAINERS.includes(container as ContainerName)) {
    throw new DomainException('VALIDATION_ERROR', `container is required and must be one of: ${CONTAINERS.join(' | ')}`)
  }
  if (typeof a.blob_path !== 'string' || !a.blob_path.trim() || a.blob_path.length > 1024) {
    throw new DomainException('VALIDATION_ERROR', 'blob_path is required and must be 1–1024 characters')
  }
  const blobPath: string = a.blob_path.trim()
  // Reject traversal / absolute paths so a delete can never escape the container layout.
  if (blobPath.startsWith('/') || blobPath.split('/').some((seg) => seg === '..')) {
    throw new DomainException('VALIDATION_ERROR', 'blob_path must be a relative path without ".." segments')
  }
  if (typeof a.reason !== 'string' || !a.reason.trim() || a.reason.length > 500) {
    throw new DomainException('VALIDATION_ERROR', 'reason is required and must be 1–500 characters')
  }
  const reason: string = a.reason.trim()
  const purgeVector = a.purge_vector !== false // default true
  const force = a.force === true
  const libraryId = typeof a.library_id === 'string' && a.library_id ? a.library_id : 'default'
  const containerName = container as ContainerName

  if (PROTECTED[containerName].has(blobPath) && !force) {
    throw new DomainException(
      'VALIDATION_ERROR',
      `"${blobPath}" is a protected registry/log blob; deleting it would corrupt the library. Pass force: true only if you are certain.`
    )
  }

  const warnings: string[] = []
  const client = await containerClientFor(containerName)

  const existed = await deleteBlob(client, blobPath)
  if (!existed) warnings.push('blob_not_found')

  // Purge the matching vector(s) so a deleted page/source cannot surface in queries.
  let vectorPurged = false
  let vectorPointsDeleted = 0
  if (purgeVector) {
    try {
      if (containerName === 'wiki' && blobPath.startsWith('pages/') && blobPath.endsWith('.md')) {
        const filename = blobPath.slice('pages/'.length)
        await ensureCollection()
        await deletePoints([wikiPagePointId(libraryId, filename)])
        vectorPurged = true
        vectorPointsDeleted = 1
      } else if (containerName === 'raw') {
        // The raw blob_path is the source_id. Delete every chunk point for it; the chunk
        // count comes from raw_manifest.json (chunks_indexed at ingest time).
        const { manifest } = await readRawManifest(libraryId)
        const src = manifest.sources.find((s) => s.source_id === blobPath)
        if (src && src.chunks_indexed > 0) {
          const ids = Array.from({ length: src.chunks_indexed }, (_, i) => rawChunkPointId(libraryId, blobPath, i))
          await ensureCollection()
          await deletePoints(ids)
          vectorPurged = true
          vectorPointsDeleted = ids.length
        } else {
          warnings.push('no_vector_association')
        }
      } else {
        // history/ copies and schema files have no associated vectors.
        warnings.push('no_vector_association')
      }
    } catch (err) {
      warnings.push('vector_purge_failed', (err as Error).message)
    }
  }

  const log = await appendLog({
    ts: new Date().toISOString(),
    tool: 'library_write',
    action: `delete_blob ${containerName}/${blobPath}: ${reason}`,
    container: containerName,
    blob_path: blobPath,
    library_id: libraryId
  })
  if (!log.ok) warnings.push('log_append_failed')

  return ok(
    {
      container: containerName,
      blob_path: blobPath,
      deleted: existed,
      existed,
      vector_purged: vectorPurged,
      vector_points_deleted: vectorPointsDeleted
    },
    warnings
  )
}

export const deleteBlobTool: ToolDefinition = {
  name: 'library_delete_blob',
  description:
    'Hard-delete a single stale blob from Azure (librarian cleanup escape hatch). Requires ' +
    'container (wiki | raw | schema), blob_path, and reason. By default also purges the ' +
    'matching Qdrant vector(s) (purge_vector); set purge_vector: false to delete only the blob. ' +
    'Refuses to delete structural registry/log blobs unless force: true. Idempotent.',
  inputSchema,
  handler: (input) => toEnvelope(() => deleteBlobImpl(input))
}
