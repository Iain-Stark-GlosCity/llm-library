// library_write — consolidated mutating facade. One MCP tool with an `operation`
// discriminator, replacing the former standalone library_ingest, library_register_source,
// library_update, library_update_schema, and library_deprecate_page tools.
//
// Nothing is lost: each operation delegates to the original tool's handler, so the
// validation, write semantics, and partial-failure behaviour are identical — only the
// exposed tool count shrinks. This tool is only listed in librarian mode.

import { DomainEnvelope, DomainException, ToolDefinition, toEnvelope } from '../types'
import { ingestTool } from './ingest'
import { registerSourceTool } from './register-source'
import { updateTool } from './update'
import { updateSchemaTool } from './update-schema'
import { deprecatePageTool } from './deprecate-page'
import { deleteBlobTool } from './delete-blob'
import { setProvenanceTool } from './set-provenance'
import { patchMetadataTool } from './patch-metadata'

// operation value → the underlying handler that performs it.
const OPERATIONS: Record<string, (input: unknown) => Promise<DomainEnvelope>> = {
  ingest: ingestTool.handler,
  register_source: registerSourceTool.handler,
  update_page: updateTool.handler,
  patch_page_metadata: patchMetadataTool.handler,
  update_schema: updateSchemaTool.handler,
  deprecate_page: deprecatePageTool.handler,
  delete_blob: deleteBlobTool.handler,
  set_provenance: setProvenanceTool.handler
}

// Union of every field used by the underlying operations. Per-operation requirements
// (e.g. content ≤50k for update_page vs ≤200k for ingest) are enforced authoritatively
// by the delegated handlers; this schema is only a client hint, per the transport contract.
const inputSchema = {
  type: 'object',
  properties: {
    operation: {
      type: 'string',
      enum: ['ingest', 'register_source', 'update_page', 'patch_page_metadata', 'update_schema', 'deprecate_page', 'delete_blob', 'set_provenance'],
      description:
        'Which write to perform. "ingest": store+chunk+embed a raw source (needs title, content, ' +
        'source_type). "register_source": register a citable source by metadata only (needs source_id, ' +
        'title). "update_page": create/update a curated wiki page (needs filename, title, content, ' +
        'page_type, domain, confidence, tags, summary). "patch_page_metadata": lightweight ' +
        'governance/review metadata patch on an existing page (reviewed_by/at, last_source_check, ' +
        'allowed_use, business_consequence_if_stale, invalidation_policy) with no re-embed or history. ' +
        '"update_schema": write a per-domain schema ' +
        '(needs domain, schema). "deprecate_page": soft-retire a page (needs filename, reason). ' +
        '"delete_blob": hard-delete a stale object from Azure — blob + vector + registry entry ' +
        '(needs container, blob_path, reason) — the irreversible cleanup escape hatch. ' +
        '"set_provenance": set upstream_id/source_url on an existing source (needs source_id) for ' +
        'stale-cache supersession grouping.'
    },

    // shared / ingest / register_source
    title: { type: 'string', maxLength: 120 },
    content: { type: 'string', maxLength: 200_000 },
    source_type: { type: 'string', enum: ['primary', 'secondary', 'derived'] },
    source_url: { type: 'string' },
    upstream_id: { type: 'string', maxLength: 200 },
    upstream_owner: { type: 'string', maxLength: 200 },
    source_id: { type: 'string', maxLength: 200 },
    domain: { type: 'string' },

    // update_page
    filename: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]*\\.md$', maxLength: 80 },
    page_type: { type: 'string', enum: ['concept', 'source', 'synthesis', 'contradiction'] },
    confidence: { type: 'string', enum: ['high', 'medium', 'low', 'unverified'] },
    tags: { type: 'array', items: { type: 'string' }, maxItems: 10 },
    summary: { type: 'string', maxLength: 200 },
    status: { type: 'string', enum: ['draft', 'active', 'deprecated'] },
    review_after: { type: 'string' },
    reviewed_by: { type: 'string', maxLength: 120 },
    reviewed_at: { type: 'string' },
    allowed_use: { type: 'array', items: { type: 'string' } },
    prohibited_use: { type: 'array', items: { type: 'string' } },
    last_source_check: { type: 'string' },
    business_consequence_if_stale: { type: 'string', enum: ['low', 'medium', 'high'] },
    invalidation_policy: { type: 'string', maxLength: 500 },
    sources: { type: 'array', items: { type: 'string' } },
    related: { type: 'array', items: { type: 'string' } },

    // update_schema
    schema: { type: 'object' },

    // deprecate_page + delete_blob
    reason: { type: 'string', maxLength: 500 },

    // delete_blob
    container: { type: 'string', enum: ['wiki', 'raw', 'schema'] },
    blob_path: { type: 'string', maxLength: 1024 },
    purge_vector: { type: 'boolean' },
    purge_manifest: { type: 'boolean' },
    force: { type: 'boolean' },

    library_id: { type: 'string' }
  },
  required: ['operation'],
  additionalProperties: false
}

async function writeImpl(input: unknown): Promise<DomainEnvelope> {
  const a = (input ?? {}) as Record<string, any>
  const operation = a.operation
  if (typeof operation !== 'string' || !(operation in OPERATIONS)) {
    throw new DomainException(
      'VALIDATION_ERROR',
      `operation is required and must be one of: ${Object.keys(OPERATIONS).join(' | ')}`
    )
  }
  // The underlying handlers read their own named fields and ignore the extra
  // `operation` discriminator, so the raw arguments can be passed through verbatim.
  return OPERATIONS[operation](a)
}

export const writeTool: ToolDefinition = {
  name: 'library_write',
  description:
    'Mutating library operations (librarian mode only). Set `operation` to choose the write: ' +
    '"ingest" (store + chunk + embed a raw source), "register_source" (register a citable source ' +
    'by metadata only), "update_page" (the only curated wiki write path), "update_schema" (write a ' +
    'per-domain schema), "deprecate_page" (soft-retire a page), "delete_blob" (hard-delete a ' +
    'stale Azure object — blob, vector, and registry entry — the irreversible cleanup escape hatch), ' +
    'or "set_provenance" (assign upstream_id/source_url to an existing source for stale-cache ' +
    'supersession grouping).',
  inputSchema,
  handler: (input) => toEnvelope(() => writeImpl(input))
}
