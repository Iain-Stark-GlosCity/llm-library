// library_instructions — read-only operating doctrine. Lets any agent self-orient:
// what the library is, the authority model, the librarian workflow, tool roles, and
// the citation convention. No storage access.

import { ToolDefinition, ok } from '../types'

const DOCTRINE = {
  what_this_is:
    'The LLM Library is a derived, governed knowledge layer that sits between systems of ' +
    'record and the AI channels that consume it. It is not ordinary RAG and not only a ' +
    'deterministic MCP tool. RAG retrieves evidence. MCP returns tools. This layer maintains ' +
    'curated, versioned, source-linked pages an agent can query as reusable memory. It is ' +
    'analysis by default, and governed interpretation only where ownership, source currency, ' +
    'review, and permitted use are explicit. It is never a system of record or a source of truth.',

  layer_model: {
    note: 'Keep these five concerns separate. The library is the last row — it must not be mistaken for the first two.',
    system_of_record: 'Authoritative origin of a fact. External (legislation.gov.uk, a revenues system, an approved policy doc). Never this app.',
    source_of_truth: 'The system of record as of now. External; only knowable by re-reading upstream.',
    system_of_operation: 'Where action happens (revenues platform, case system, payment system). Needs deterministic controls.',
    system_of_analysis: 'Where patterns are explored (reporting, query logs, gap analysis).',
    llm_library: 'Derived governed knowledge layer: source-linked, AI-consumable pages supporting interpretation, guidance, and analysis — a governed cache, not the record.'
  },

  authority_model: [
    'Raw source material is a point-in-time snapshot of an external system of record — evidence, not truth.',
    'Curated pages are governed interpretation: derived cache entries, not the record.',
    'Vector search is an access path, not the knowledge itself.',
    'Query results are not automatically true — weigh confidence AND currency, which are independent.',
    'High confidence requires source support, inline citations, and review; it does not imply the source is current.',
    'Contradictions should be represented, not smoothed away.',
    'Deprecated material should not be used by default.',
    'The library declares and warns on permitted use; it cannot enforce it. Operational actions (formal decisions, live account/payment/enforcement actions) belong to deterministic operational systems, never to cached knowledge.',
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

  governance_model: {
    permitted_use:
      'Pages may declare allowed_use / prohibited_use from a fixed vocabulary. The library SUPPORTS analysis, drafting, staff_guidance, public_guidance, decision_support — with increasing guard rails. It must NEVER authorise operational modes (formal_decision, live_account_action, payment_action, enforcement_action); update_page rejects them in allowed_use. The library declares and warns on use; the consuming channel enforces it.',
    answer_envelope:
      'library_query returns, per curated result: confidence (extraction quality), a freshness/currency block (stalest cited snapshot age, whether a newer snapshot exists), and a provenance block (cited source_ids with source_url, upstream_owner, capture date, upstream_status; plus the page review and permitted-use governance). Confidence and currency are independent axes.',
    page_governance_fields:
      'allowed_use, prohibited_use (permitted-use vocabulary); last_source_check (when the curator last verified the page against its sources); business_consequence_if_stale (low|medium|high); invalidation_policy (when to re-check or retire). All optional.',
    source_provenance_fields:
      'upstream_owner (who owns the authoritative source); upstream_id (grouping identity); last_upstream_check / upstream_status (set by upstream revalidation). Set provenance on existing sources with library_write (operation: set_provenance).',
    opt_in:
      'The governance guard-rail lint checks (permitted-use, stale-risk, source currency) only apply to domains whose schema sets governance_required: true. Adopt governance per domain (controlled pilot), not all at once.'
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
