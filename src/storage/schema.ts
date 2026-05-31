// Per-domain schema files in the library-schemas container, stored as
// {domain}.schema.json. A schema is optional: domains without one inherit the global
// doctrine from library_instructions. Domains with one extend it. See the
// "Synthesis Pages and Per-Domain Schema" design.

import { getSchemaContainer, readBlob, writeBlob, listBlobs } from './blobs'

const SUFFIX = '.schema.json'

// All fields optional except `domain`. Kept loose on purpose — the schema is advisory
// metadata an agent layers on top of the global doctrine, not an enforced contract.
export interface DomainSchema {
  domain: string
  display_name?: string
  description?: string
  valid_source_types?: string[]
  source_examples?: string[]
  required_page_fields?: string[]
  page_type_allowlist?: string[]
  review_after_max_days?: Record<string, number>
  maintenance_notes?: string
  audience?: string
  [key: string]: unknown
}

function blobName(domain: string): string {
  return `${domain}${SUFFIX}`
}

export async function readSchema(domain: string): Promise<DomainSchema | null> {
  const container = await getSchemaContainer()
  const res = await readBlob(container, blobName(domain))
  if (!res) return null
  return JSON.parse(res.content) as DomainSchema
}

export async function writeSchema(domain: string, schema: DomainSchema): Promise<void> {
  const container = await getSchemaContainer()
  await writeBlob(
    container,
    blobName(domain),
    JSON.stringify(schema, null, 2),
    'application/json; charset=utf-8'
  )
}

// Domains that currently have a schema file (used by lint's missing_schema check).
export async function listSchemaDomains(): Promise<Set<string>> {
  const container = await getSchemaContainer()
  const names = await listBlobs(container, '')
  const domains = new Set<string>()
  for (const n of names) {
    if (n.endsWith(SUFFIX)) domains.add(n.slice(0, -SUFFIX.length))
  }
  return domains
}
