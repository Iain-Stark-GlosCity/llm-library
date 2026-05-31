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

// operation value → the underlying handler that performs it.
const OPERATIONS: Record<string, (input: unknown) => Promise<DomainEnvelope>> = {
  ingest: ingestTool.handler,
  register_source: registerSourceTool.handler,
  update_page: updateTool.handler,
  update_schema: updateSchemaTool.handler,
  deprecate_page: deprecatePageTool.handler
}

// Union of every field used by the underlying operations. Per-operation requirements
// (e.g. content ≤50k for update_page vs ≤200k for ingest) are enforced authoritatively
// by the delegated handlers; this schema is only a client hint, per the transport contract.
const inputSchema = {
  type: 'object',
  properties: {
    operation: {
      type: 'string',
      enum: ['ingest', 'register_source', 'update_page', 'update_schema', 'deprecate_page'],
      description:
        'Which write to perform. "ingest": store+chunk+embed a raw source (needs title, content, ' +
        'source_type). "register_source": register a citable source by metadata only (needs source_id, ' +
        'title). "update_page": create/update a curated wiki page (needs filename, title, content, ' +
        'page_type, domain, confidence, tags, summary). "update_schema": write a per-domain schema ' +
        '(needs domain, schema). "deprecate_page": retire a page (needs filename, reason).'
    },

    // shared / ingest / register_source
    title: { type: 'string', maxLength: 120 },
    content: { type: 'string', maxLength: 200_000 },
    source_type: { type: 'string', enum: ['primary', 'secondary', 'derived'] },
    source_url: { type: 'string' },
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
    sources: { type: 'array', items: { type: 'string' } },
    related: { type: 'array', items: { type: 'string' } },

    // update_schema
    schema: { type: 'object' },

    // deprecate_page
    reason: { type: 'string', maxLength: 500 },

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
    'per-domain schema), or "deprecate_page" (retire a page). Consolidates the former ingest / ' +
    'register_source / update / update_schema / deprecate_page tools.',
  inputSchema,
  handler: (input) => toEnvelope(() => writeImpl(input))
}
