// library_update_schema — write {domain}.schema.json to library-schemas. No versioning
// in v1: the prior schema is overwritten (recoverable via blob soft-delete if enabled).

import { DomainEnvelope, DomainException, ToolDefinition, ok, toEnvelope } from '../types'
import { writeSchema, DomainSchema } from '../storage/schema'
import { appendLog } from '../storage/log'

// Matches a domain slug used as a blob filename segment.
const DOMAIN_RE = /^[a-z0-9][a-z0-9-]*$/

const inputSchema = {
  type: 'object',
  properties: {
    domain: { type: 'string', maxLength: 80 },
    schema: { type: 'object' }
  },
  required: ['domain', 'schema'],
  additionalProperties: false
}

async function updateSchemaImpl(input: unknown): Promise<DomainEnvelope> {
  const a = (input ?? {}) as Record<string, any>
  if (typeof a.domain !== 'string' || a.domain.length > 80 || !DOMAIN_RE.test(a.domain)) {
    throw new DomainException('VALIDATION_ERROR', 'domain must match ^[a-z0-9][a-z0-9-]*$ and be ≤80 chars')
  }
  if (a.schema === null || typeof a.schema !== 'object' || Array.isArray(a.schema)) {
    throw new DomainException('VALIDATION_ERROR', 'schema must be a JSON object')
  }
  const domain: string = a.domain

  // Keep the stored schema's domain field consistent with the file it lives in.
  const schema: DomainSchema = { ...(a.schema as Record<string, unknown>), domain }

  const warnings: string[] = []
  await writeSchema(domain, schema)

  const log = await appendLog({
    ts: new Date().toISOString(),
    tool: 'library_update_schema',
    action: `update schema ${domain}`,
    domain
  })
  if (!log.ok) warnings.push('log_append_failed')

  return ok({ domain, schema_updated: true }, warnings)
}

export const updateSchemaTool: ToolDefinition = {
  name: 'library_update_schema',
  description:
    'Create or overwrite the per-domain schema ({domain}.schema.json). Fields beyond ' +
    'domain are optional advisory metadata (valid source types, page-type allowlist, ' +
    'required fields, review windows, maintenance notes, audience). Overwrites the prior schema.',
  inputSchema,
  handler: (input) => toEnvelope(() => updateSchemaImpl(input))
}
