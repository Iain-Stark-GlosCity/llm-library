// library_info — consolidated read-only inspection facade. One MCP tool with a
// `resource` discriminator, replacing the former standalone library_instructions,
// library_get_schema, library_list_pages, and library_get_page tools.
//
// Nothing is lost: each resource delegates to the original tool's handler, so the
// validation and behaviour are identical — only the exposed tool count shrinks.

import { DomainEnvelope, DomainException, ToolDefinition, toEnvelope } from '../types'
import { instructionsTool } from './instructions'
import { getSchemaTool } from './get-schema'
import { listPagesTool } from './list-pages'
import { getPageTool } from './get-page'

// resource value → the underlying handler that fulfils it.
const RESOURCES: Record<string, (input: unknown) => Promise<DomainEnvelope>> = {
  instructions: instructionsTool.handler,
  schema: getSchemaTool.handler,
  pages: listPagesTool.handler,
  page: getPageTool.handler
}

const inputSchema = {
  type: 'object',
  properties: {
    resource: {
      type: 'string',
      enum: ['instructions', 'schema', 'pages', 'page'],
      description:
        'Which read-only resource to fetch. "instructions": operating doctrine (no other ' +
        'input). "schema": per-domain schema (requires domain). "pages": curated catalogue ' +
        '(optional domain/status filters). "page": a single page (requires filename).'
    },
    domain: { type: 'string', description: 'Required for resource "schema"; optional filter for "pages".' },
    status: {
      type: 'string',
      enum: ['draft', 'active', 'deprecated'],
      description: 'Optional filter for resource "pages".'
    },
    filename: {
      type: 'string',
      pattern: '^[a-z0-9][a-z0-9-]*\\.md$',
      maxLength: 80,
      description: 'Required for resource "page".'
    },
    library_id: { type: 'string' }
  },
  required: ['resource'],
  additionalProperties: false
}

async function infoImpl(input: unknown): Promise<DomainEnvelope> {
  const a = (input ?? {}) as Record<string, any>
  const resource = a.resource
  if (typeof resource !== 'string' || !(resource in RESOURCES)) {
    throw new DomainException(
      'VALIDATION_ERROR',
      `resource is required and must be one of: ${Object.keys(RESOURCES).join(' | ')}`
    )
  }
  // The underlying handlers read their own named fields and ignore the extra
  // `resource` discriminator, so the raw arguments can be passed through verbatim.
  return RESOURCES[resource](a)
}

export const infoTool: ToolDefinition = {
  name: 'library_info',
  description:
    'Read-only library inspection. Set `resource` to choose what to fetch: "instructions" ' +
    '(operating doctrine — call first to self-orient), "schema" (per-domain schema; needs ' +
    'domain), "pages" (curated catalogue; optional domain/status filters), or "page" (a single ' +
    'page by filename). Consolidates the former instructions / get_schema / list_pages / ' +
    'get_page tools.',
  inputSchema,
  handler: (input) => toEnvelope(() => infoImpl(input))
}
