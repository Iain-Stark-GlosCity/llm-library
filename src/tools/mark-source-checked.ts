// library_write operation: mark_source_checked — record an upstream revalidation
// result for an existing raw_manifest source without re-ingesting it. This is the
// metadata-only repair path for active_page_cites_unchecked_source lint findings.

import { DomainEnvelope, DomainException, ToolDefinition, ok, toEnvelope } from '../types'
import { readRawManifest, writeRawManifest } from '../storage/raw-manifest'
import { appendLog } from '../storage/log'

type UpstreamStatus = 'current' | 'superseded' | 'unavailable' | 'unknown'
type CheckMethod = 'manual' | 'web_fetch' | 'legislation_api' | 'system'

const UPSTREAM_STATUSES = new Set<UpstreamStatus>([
  'current',
  'superseded',
  'unavailable',
  'unknown'
])
const CHECK_METHODS = new Set<CheckMethod>(['manual', 'web_fetch', 'legislation_api', 'system'])

const inputSchema = {
  type: 'object',
  properties: {
    source_id: { type: 'string', maxLength: 200 },
    upstream_status: {
      type: 'string',
      enum: ['current', 'superseded', 'unavailable', 'unknown']
    },
    last_upstream_check: { type: 'string', description: 'ISO datetime; defaults to current UTC server time.' },
    checked_by: { type: 'string', maxLength: 120 },
    check_method: { type: 'string', enum: ['manual', 'web_fetch', 'legislation_api', 'system'] },
    notes: { type: 'string', maxLength: 1000 },
    library_id: { type: 'string' }
  },
  required: ['source_id', 'upstream_status'],
  additionalProperties: false
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new DomainException('VALIDATION_ERROR', `${field} is required`)
  }
  return value
}

function parseCheckTime(value: unknown): string {
  if (value === undefined) return new Date().toISOString()
  if (typeof value !== 'string' || value.length === 0 || Number.isNaN(Date.parse(value))) {
    throw new DomainException('VALIDATION_ERROR', 'last_upstream_check must be a parseable ISO datetime when provided')
  }
  return new Date(value).toISOString()
}

async function markSourceCheckedImpl(input: unknown): Promise<DomainEnvelope> {
  const a = (input ?? {}) as Record<string, any>

  const sourceId = requireNonEmptyString(a.source_id, 'source_id')
  const upstreamStatus = requireNonEmptyString(a.upstream_status, 'upstream_status')
  if (!UPSTREAM_STATUSES.has(upstreamStatus as UpstreamStatus)) {
    throw new DomainException(
      'VALIDATION_ERROR',
      'upstream_status must be one of: current | superseded | unavailable | unknown'
    )
  }

  const checkMethod = typeof a.check_method === 'string' && a.check_method ? a.check_method : 'manual'
  if (!CHECK_METHODS.has(checkMethod as CheckMethod)) {
    throw new DomainException(
      'VALIDATION_ERROR',
      'check_method must be one of: manual | web_fetch | legislation_api | system'
    )
  }

  const lastUpstreamCheck = parseCheckTime(a.last_upstream_check)
  const checkedBy = typeof a.checked_by === 'string' && a.checked_by ? a.checked_by : 'unknown'
  const notes = typeof a.notes === 'string' ? a.notes : ''
  const libraryId = typeof a.library_id === 'string' && a.library_id ? a.library_id : 'default'
  const warnings: string[] = []

  const { manifest, etag } = await readRawManifest(libraryId)
  const entry = manifest.sources.find((s) => s.source_id === sourceId)
  if (!entry) {
    throw new DomainException('NOT_FOUND', `source not found in raw_manifest: ${sourceId}`)
  }

  entry.last_upstream_check = lastUpstreamCheck
  entry.upstream_status = upstreamStatus as UpstreamStatus
  entry.checked_by = checkedBy
  entry.check_method = checkMethod as CheckMethod
  entry.revalidation_notes = notes

  const w = await writeRawManifest(manifest, etag)
  if (w.conflict) throw new DomainException('CONFLICT', 'raw_manifest.json changed concurrently; retry')
  if (!w.success) throw new DomainException('STORAGE_ERROR', 'failed to write raw_manifest.json')

  const log = await appendLog({
    ts: new Date().toISOString(),
    tool: 'library_write',
    action: `mark_source_checked ${sourceId} ${upstreamStatus}`,
    source_id: sourceId,
    library_id: libraryId
  })
  if (!log.ok) warnings.push('log_append_failed')

  return ok(
    {
      source_id: sourceId,
      last_upstream_check: lastUpstreamCheck,
      upstream_status: upstreamStatus,
      updated: true
    },
    warnings
  )
}

export const markSourceCheckedTool: ToolDefinition = {
  name: 'library_mark_source_checked',
  description:
    'Record upstream revalidation metadata on an existing raw_manifest source without ' +
    're-ingesting it. Use through library_write (operation: mark_source_checked) to clear ' +
    'active_page_cites_unchecked_source when a cited source has been checked against upstream.',
  inputSchema,
  handler: (input) => toEnvelope(() => markSourceCheckedImpl(input))
}
