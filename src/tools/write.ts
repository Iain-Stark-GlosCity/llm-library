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
import { markSourceCheckedTool } from './mark-source-checked'
import { migrateGovernanceTool } from './migrate-governance'
import { reconcileVectorsTool } from './reconcile-vectors'

// operation value → the underlying handler that performs it.
const OPERATIONS: Record<string, (input: unknown) => Promise<DomainEnvelope>> = {
  ingest: ingestTool.handler,
  register_source: registerSourceTool.handler,
  update_page: updateTool.handler,
  patch_page_metadata: patchMetadataTool.handler,
  update_schema: updateSchemaTool.handler,
  deprecate_page: deprecatePageTool.handler,
  delete_blob: deleteBlobTool.handler,
  set_provenance: setProvenanceTool.handler,
  mark_source_checked: markSourceCheckedTool.handler,
  migrate_governance: migrateGovernanceTool.handler,
  reconcile_vectors: reconcileVectorsTool.handler
}

// Single source of truth for the accepted operations. The visible inputSchema enum and
// the published tool_versions manifest both derive from this, so the contract the client
// sees can never drift from what the runtime actually dispatches (writeImpl validates
// against the same OPERATIONS map). Add an operation in ONE place — the map above.
export const WRITE_OPERATIONS: string[] = Object.keys(OPERATIONS)

// Union of every field used by the underlying operations. Per-operation requirements
// (e.g. content ≤50k for update_page vs ≤200k for ingest) are enforced authoritatively
// by the delegated handlers; this schema is only a client hint, per the transport contract.
const inputSchema = {
  type: 'object',
  properties: {
    operation: {
      type: 'string',
      enum: WRITE_OPERATIONS,
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
        'stale-cache supersession grouping. "mark_source_checked": record upstream revalidation ' +
        'status on an existing source (needs source_id, upstream_status). "migrate_governance": dry-run or apply governed-domain metadata migration. ' +
        '"reconcile_vectors": reconcile the active wiki vector collection to the manifest for a ' +
        'domain (needs domain; dry_run defaults true). mode: payload_only | reembed_stale | full_rebuild; ' +
        'delete_orphans / delete_duplicates / include_deprecated control cleanup of stray vectors.'
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
    page_role: { type: 'string', enum: ['statutory_extraction', 'local_policy', 'local_policy_placeholder', 'index', 'checklist', 'operational_model', 'validation_contract', 'synthesis', 'rule_slot', 'rule_family', 'compiler_grade_rule', 'contradiction', 'unknown'] },
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
    last_upstream_check: { type: 'string' },
    upstream_status: { type: 'string', enum: ['current', 'superseded', 'unavailable', 'unknown'] },
    checked_by: { type: 'string', maxLength: 120 },
    check_method: { type: 'string', enum: ['manual', 'web_fetch', 'legislation_api', 'system'] },
    notes: { type: 'string', maxLength: 1000 },
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
    dry_run: { type: 'boolean' },

    // reconcile_vectors
    mode: { type: 'string', enum: ['payload_only', 'reembed_stale', 'full_rebuild'] },
    delete_orphans: { type: 'boolean' },
    delete_duplicates: { type: 'boolean' },
    include_deprecated: { type: 'boolean' },
    manual_accept_current: { type: 'boolean' },
    migrated_by: { type: 'string' },

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
    '"set_provenance" (assign upstream_id/source_url to an existing source for stale-cache ' +
    'supersession grouping), "mark_source_checked" (record upstream revalidation status ' +
    'on an existing source), or "reconcile_vectors" (reconcile the active wiki vector ' +
    'collection back to the manifest for a domain — dry_run by default).',
  inputSchema,
  handler: (input) => toEnvelope(() => writeImpl(input))
}
