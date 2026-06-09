// library_write operation: set_provenance — patch provenance fields (upstream_id,
// source_url) on a source that already exists in raw_manifest.json, without
// re-ingesting it. This is the migration/repair path for Challenge B: existing
// snapshots that lack an upstream identity (no source_url) cannot be grouped for
// supersession detection, and lint flags them as source_missing_upstream_id. This
// operation lets the librarian assign that identity retroactively.
//
// Metadata-only: no blob, no vectors, no re-embed. ETag-aware.

import { DomainEnvelope, DomainException, ToolDefinition, ok, toEnvelope } from '../types'
import { readRawManifest, writeRawManifest } from '../storage/raw-manifest'
import { appendLog } from '../storage/log'
import { resolveLibraryId } from './shared'

const inputSchema = {
  type: 'object',
  properties: {
    source_id: { type: 'string', maxLength: 200 },
    upstream_id: { type: 'string', maxLength: 200 },
    source_url: { type: 'string', maxLength: 2048 },
    upstream_owner: { type: 'string', maxLength: 200 },
    library_id: { type: 'string' }
  },
  required: ['source_id'],
  additionalProperties: false
}

async function setProvenanceImpl(input: unknown): Promise<DomainEnvelope> {
  const a = (input ?? {}) as Record<string, any>

  if (typeof a.source_id !== 'string' || !a.source_id) {
    throw new DomainException('VALIDATION_ERROR', 'source_id is required')
  }
  const hasUpstreamId = typeof a.upstream_id === 'string'
  const hasSourceUrl = typeof a.source_url === 'string'
  const hasUpstreamOwner = typeof a.upstream_owner === 'string'
  if (!hasUpstreamId && !hasSourceUrl && !hasUpstreamOwner) {
    throw new DomainException('VALIDATION_ERROR', 'provide at least one of upstream_id, source_url, or upstream_owner to set')
  }

  const sourceId: string = a.source_id
  const libraryId = resolveLibraryId(a)
  const warnings: string[] = []

  const { manifest, etag } = await readRawManifest(libraryId)
  const entry = manifest.sources.find((s) => s.source_id === sourceId)
  if (!entry) {
    throw new DomainException('NOT_FOUND', `source not found in raw_manifest: ${sourceId}`)
  }

  if (hasUpstreamId) entry.upstream_id = a.upstream_id
  if (hasSourceUrl) entry.source_url = a.source_url
  if (hasUpstreamOwner) entry.upstream_owner = a.upstream_owner

  const w = await writeRawManifest(manifest, etag)
  if (w.conflict) throw new DomainException('CONFLICT', 'raw_manifest.json changed concurrently; retry')
  if (!w.success) throw new DomainException('STORAGE_ERROR', 'failed to write raw_manifest.json')

  const log = await appendLog({
    ts: new Date().toISOString(),
    tool: 'library_write',
    action: `set_provenance ${sourceId}`,
    source_id: sourceId,
    library_id: libraryId
  })
  if (!log.ok) warnings.push('log_append_failed')

  return ok(
    {
      source_id: sourceId,
      upstream_id: entry.upstream_id ?? '',
      source_url: entry.source_url ?? '',
      upstream_owner: entry.upstream_owner ?? '',
      provenance_updated: true
    },
    warnings
  )
}

export const setProvenanceTool: ToolDefinition = {
  name: 'library_set_provenance',
  description:
    'Set provenance (upstream_id and/or source_url) on an existing raw_manifest source ' +
    'without re-ingesting it. Use this to give older snapshots a stable upstream identity ' +
    'so supersession (stale-cache) detection can group them — the repair path for ' +
    'source_missing_upstream_id lint findings. Metadata-only; ETag-aware.',
  inputSchema,
  handler: (input) => toEnvelope(() => setProvenanceImpl(input))
}
