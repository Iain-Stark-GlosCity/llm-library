// library_instructions — read-only operating doctrine. Lets any agent self-orient:
// what the library is, the authority model, the librarian workflow, tool roles, and
// the citation convention. No storage access.

import { ToolDefinition, ok } from '../types'

const DOCTRINE = {
  what_this_is:
    'The LLM Library is a knowledge extension layer for AI agents. It is not ordinary ' +
    'RAG and not only a deterministic MCP tool. RAG retrieves evidence. MCP returns ' +
    'tools. This layer maintains knowledge: curated, versioned, source-linked pages an ' +
    'agent can query as reusable memory.',

  authority_model: [
    'Raw source material is evidence, not knowledge.',
    'Curated pages are the maintained knowledge records.',
    'Vector search is an access path, not the knowledge itself.',
    'Query results are not automatically true — weigh confidence and sources.',
    'High confidence requires source support and review.',
    'Contradictions should be represented, not smoothed away.',
    'Deprecated material should not be used by default.'
  ],

  librarian_workflow: [
    '0. Get the domain schema (library_get_schema) to learn domain-specific rules; inherit the global doctrine if none.',
    '1. Ingest the raw source (library_ingest) or register it (library_register_source).',
    '2. Query raw evidence and existing curated pages (library_query).',
    '3. Decide whether the source adds, changes, or contradicts current knowledge.',
    '4. Update the concept page(s) (library_update) with sources[] and related[] links.',
    '5. Update or create the domain synthesis page if the domain now has 3+ active pages or the synthesis is stale.',
    '6. Run library_lint.',
    '7. Repair metadata, links, and citations flagged by lint.',
    '8. Re-query to confirm the knowledge can be found.'
  ],

  tool_roles: {
    library_ping: 'Liveness check.',
    library_instructions: 'This operating doctrine.',
    library_get_schema: 'Read the per-domain schema layered on top of this doctrine.',
    library_list_pages: 'List the curated catalogue (from manifest.json).',
    library_get_page: 'Fetch a single curated page by filename.',
    library_query: 'Hybrid retrieval over curated pages (default) and/or raw chunks.',
    library_ingest: 'Store raw source material: chunk, embed, index.',
    library_register_source: 'Register a citable source by metadata, without a full ingest.',
    library_update: 'Create or update a curated wiki page (the only curated write path).',
    library_update_schema: 'Create or overwrite a per-domain schema file.',
    library_lint: 'Mechanical health checks over the wiki.'
  },

  synthesis_pages: {
    what: 'A synthesis page represents the current best understanding of a whole domain — what we know taken together, key relationships, open questions, and unresolved contradictions. It is not a summary of concept pages.',
    convention: '{domain}-synthesis.md, page_type: synthesis.',
    rules: 'Always status: active (never draft), at least one source, and review_after is required (they go stale faster than concept pages). related[] should link the domain’s active concept pages.'
  },

  citation_convention: {
    rule: 'Every active page must have sources[] metadata AND at least one inline [source: ...] marker in the body.',
    syntax: '[source: <source_id>]',
    example: '[source: claude-build-13]',
    note: 'Cited source_ids should exist in raw_manifest.json — ingest or register them first.'
  },

  status_model:
    'library_update defaults new pages to status: draft. Promote to active deliberately, ' +
    'once the page has sources and has been reviewed. Use deprecated to retire a page; ' +
    'deprecated pages are excluded from default queries.'
}

const inputSchema = {
  type: 'object',
  properties: {},
  additionalProperties: false
}

export const instructionsTool: ToolDefinition = {
  name: 'library_instructions',
  description:
    'Return the library operating doctrine: what the library is, the authority model, ' +
    'the librarian workflow, tool roles, and the citation convention. Call this first ' +
    'to self-orient. Read-only, takes no input.',
  inputSchema,
  handler: async () => ok(DOCTRINE)
}
