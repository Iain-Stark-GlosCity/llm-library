// library_get_schema — return the per-domain schema if one exists. Read-only.
// Domains without a schema inherit the global doctrine; this tool reports that via a
// schema_found: false flag so an agent knows to fall back to library_instructions.

import { DomainEnvelope, DomainException, ToolDefinition, ok, toEnvelope } from '../types'
import { readSchema } from '../storage/schema'

const inputSchema = {
  type: 'object',
  properties: {
    domain: { type: 'string' }
  },
  required: ['domain'],
  additionalProperties: false
}

async function getSchemaImpl(input: unknown): Promise<DomainEnvelope> {
  const a = (input ?? {}) as Record<string, any>
  if (typeof a.domain !== 'string' || !a.domain) {
    throw new DomainException('VALIDATION_ERROR', 'domain is required')
  }
  const domain: string = a.domain

  const schema = await readSchema(domain)
  if (!schema) {
    return ok({
      domain,
      schema_found: false,
      schema: null,
      note: 'No domain schema. Inherit the global doctrine from library_instructions.'
    })
  }
  return ok({ domain, schema_found: true, schema })
}

export const getSchemaTool: ToolDefinition = {
  name: 'library_get_schema',
  description:
    'Return the per-domain schema (valid sources, page-type allowlist, required fields, ' +
    'review windows, maintenance notes, audience) layered on top of the global doctrine. ' +
    'Reports schema_found: false when a domain has no schema and should inherit the ' +
    'global doctrine from library_instructions. Read-only.',
  inputSchema,
  handler: (input) => toEnvelope(() => getSchemaImpl(input))
}
