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
    'High confidence requires source support, inline citations, and review.',
    'Contradictions should be represented, not smoothed away.',
    'Deprecated material should not be used by default.',
    'Normal agents run in read-only mode; mutating tools require librarian/editor mode.'
  ],

  librarian_workflow: [
    '0. Get the domain schema (library_info resource: schema) to learn domain-specific rules; inherit the global doctrine if none.',
    '1. Ingest the raw source (library_write operation: ingest) or register it (library_write operation: register_source).',
    '2. Query raw evidence and existing curated pages (library_query), scoped to the known domain by default.',
    '3. Decide whether the source adds, changes, or contradicts current knowledge.',
    '4. Update the concept page(s) (library_write operation: update_page) with sources[] and related[] links.',
    '5. Update or create the domain synthesis page if the domain now has 3+ active pages or the synthesis is stale.',
    '6. Run library_lint.',
    '7. Repair metadata, links, and citations flagged by lint.',
    '8. Re-query to confirm the knowledge can be found.'
  ],

  tool_roles: {
    library_ping: 'Liveness check (dependency-light).',
    library_info:
      'Read-only inspection. Pick a resource: "instructions" (this doctrine), "schema" ' +
      '(per-domain schema layered on this doctrine), "pages" (curated catalogue from ' +
      'manifest.json), "page" (a single curated page by filename).',
    library_query:
      'Hybrid retrieval over curated pages (default) and/or raw chunks. Requires domain ' +
      'by default; set allow_cross_domain only for deliberate discovery.',
    library_write:
      'The only mutating tool (librarian mode only). Pick an operation: "ingest" (store + ' +
      'chunk + embed raw source), "register_source" (register a citable source by metadata), ' +
      '"update_page" (the only curated wiki write path), "update_schema" (create/overwrite a ' +
      'per-domain schema), "deprecate_page" (soft-retire a page — preferred), "delete_blob" ' +
      '(irreversibly hard-delete a stale Azure object — blob, vector, AND registry entry in ' +
      'manifest.json/raw_manifest.json; use only when soft-retirement is not enough, e.g. ' +
      'lint-flagged orphans or dead raw sources), "set_provenance" (assign upstream_id/source_url ' +
      'to an existing source so stale-cache supersession detection can group its snapshots).',
    library_lint: 'Mechanical health checks over the wiki.'
  },

  synthesis_pages: {
    what: 'A synthesis page represents the current best understanding of a whole domain — what we know taken together, key relationships, open questions, and unresolved contradictions. It is not a summary of concept pages.',
    convention: '{domain}-synthesis.md, page_type: synthesis.',
    rules: 'Always status: active (never draft), at least one source, and review_after is required (they go stale faster than concept pages). related[] should link the domain’s active concept pages.'
  },

  citation_convention: {
    rule: 'Every active page must have sources[] metadata, reviewed_by/reviewed_at metadata, AND at least one inline [source: ...] marker in the body.',
    syntax: '[source: <source_id>]',
    example: '[source: claude-build-13]',
    note: 'Cited source_ids must exist in raw_manifest.json and be listed in sources[] — ingest or register them first.'
  },

  status_model:
    'library_write (operation: update_page) defaults new pages to status: draft. Promote to active ' +
    'deliberately, once the page has sources, inline citations, and reviewed_by/reviewed_at metadata. ' +
    'Use library_write (operation: deprecate_page) or status: deprecated to retire a page; deprecated pages are excluded from default queries. ' +
    'Prefer soft-retirement (deprecate) — it keeps history. When an object must physically go (lint-flagged orphans, abandoned history, dead raw sources), library_write (operation: delete_blob) hard-deletes the blob and, by default, also purges its vector and removes its registry entry (manifest.json/raw_manifest.json) so no phantom metadata is left for lint to report; it is irreversible and refuses to touch registry/log blobs without force.',

  currency_model:
    'This library is an index and cache over snapshots of external sources — not a system of record. ' +
    'A raw source is a point-in-time snapshot; its source_id embeds the content hash, so re-ingesting a ' +
    'changed upstream document creates a NEW source_id while older snapshots remain. A page that cites an ' +
    'older source_id is pinned to that snapshot. Confidence and currency are independent axes: a ' +
    'high-confidence page can cite a superseded snapshot. library_query returns a per-result freshness ' +
    'block (stalest cited snapshot age, whether a newer snapshot exists) alongside confidence. library_lint ' +
    'flags cites_superseded_source (a newer snapshot of the same upstream exists), snapshot_aged (older than ' +
    'a domain schema max_snapshot_age_days), and source_missing_upstream_id (no upstream identity, so ' +
    'supersession cannot be detected). Snapshots are grouped by upstream_id, falling back to source_url; set ' +
    'one with library_write (operation: set_provenance) to make a source groupable. The librarian decides ' +
    'whether stale cache warrants re-ingesting the source and re-curating the page.',

  modes:
    'Default LIBRARY_MCP_MODE is read_only, exposing only the read tools: library_ping, library_info, library_query, and library_lint. Set LIBRARY_MCP_MODE=librarian to additionally expose the mutating library_write tool (operations: ingest, register_source, update_page, update_schema, deprecate_page, delete_blob, set_provenance).'
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
