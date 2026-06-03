// library_register_source — register a citable source by metadata, without a full raw
// ingest. Writes a metadata-only entry (kind: 'registered', indexed: false) into
// raw_manifest.json so library_update's source validation passes and citations resolve.
// No blob is stored and no vectors are created; lint skips the indexing check for these.

import { DomainEnvelope, DomainException, ToolDefinition, ok, toEnvelope } from '../types'
import { readRawManifest, writeRawManifest, SourceEntry } from '../storage/raw-manifest'
import { appendLog } from '../storage/log'

// Friendly ids are allowed (e.g. "claude-build-13"), as well as the ingest id form
// "2026/05/slug-hash.md". Keep it to safe path/identifier characters.
const SOURCE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._\-/]*$/

const inputSchema = {
  type: 'object',
  properties: {
    source_id: { type: 'string', maxLength: 200 },
    title: { type: 'string', maxLength: 120 },
    source_type: { type: 'string', enum: ['primary', 'secondary', 'derived'] },
    domain: { type: 'string' },
    source_url: { type: 'string' },
    upstream_id: { type: 'string' },
    library_id: { type: 'string' }
  },
  required: ['source_id', 'title'],
  additionalProperties: false
}

async function registerSourceImpl(input: unknown): Promise<DomainEnvelope> {
  const a = (input ?? {}) as Record<string, any>

  if (typeof a.source_id !== 'string' || a.source_id.length === 0 || a.source_id.length > 200 || !SOURCE_ID_RE.test(a.source_id)) {
    throw new DomainException('VALIDATION_ERROR', 'source_id is required and must be a safe identifier ([A-Za-z0-9] then [A-Za-z0-9._-/])')
  }
  if (typeof a.title !== 'string' || a.title.length === 0 || a.title.length > 120) {
    throw new DomainException('VALIDATION_ERROR', 'title is required and must be 1–120 characters')
  }
  if (a.source_type !== undefined && !['primary', 'secondary', 'derived'].includes(a.source_type)) {
    throw new DomainException('VALIDATION_ERROR', 'source_type must be primary | secondary | derived')
  }
  const sourceId: string = a.source_id
  const title: string = a.title
  const sourceType: string = a.source_type ?? 'derived'
  const domain: string = typeof a.domain === 'string' ? a.domain : ''
  const sourceUrl: string = typeof a.source_url === 'string' ? a.source_url : ''
  const upstreamId: string = typeof a.upstream_id === 'string' ? a.upstream_id : ''
  const libraryId: string = typeof a.library_id === 'string' && a.library_id ? a.library_id : 'default'

  const warnings: string[] = []
  const { manifest, etag } = await readRawManifest(libraryId)
  const existing = manifest.sources.find((s) => s.source_id === sourceId)

  // Never clobber a real ingested source (it has a blob + vectors) with a metadata stub.
  if (existing && existing.kind !== 'registered') {
    return ok(
      { source_id: sourceId, registered: false, already_exists: true, kind: existing.kind ?? 'ingested' },
      ['source_already_ingested']
    )
  }

  const entry: SourceEntry = {
    source_id: sourceId,
    title,
    source_type: sourceType,
    domain,
    source_url: sourceUrl,
    ...(upstreamId ? { upstream_id: upstreamId } : {}),
    created: existing?.created ?? new Date().toISOString(),
    chunks_indexed: 0,
    embedding_status: 'ok',
    kind: 'registered',
    indexed: false
  }
  if (existing) {
    manifest.sources = manifest.sources.map((s) => (s.source_id === sourceId ? entry : s))
  } else {
    manifest.sources.push(entry)
  }

  const w = await writeRawManifest(manifest, etag)
  if (w.conflict) throw new DomainException('CONFLICT', 'raw_manifest.json changed concurrently; retry')
  if (!w.success) throw new DomainException('STORAGE_ERROR', 'failed to write raw_manifest.json')

  const log = await appendLog({
    ts: new Date().toISOString(),
    tool: 'library_register_source',
    action: `register source ${sourceId}`,
    source_id: sourceId,
    library_id: libraryId
  })
  if (!log.ok) warnings.push('log_append_failed')

  return ok({ source_id: sourceId, registered: true, updated: Boolean(existing), kind: 'registered' }, warnings)
}

export const registerSourceTool: ToolDefinition = {
  name: 'library_register_source',
  description:
    'Register a citable source by metadata only (no raw ingest, no vectors). Use this to ' +
    'create a stable source_id (e.g. "claude-build-13") that curated pages can cite in ' +
    'sources[] and inline [source: ...] markers. For full-text retrieval, use library_ingest instead.',
  inputSchema,
  handler: (input) => toEnvelope(() => registerSourceImpl(input))
}
