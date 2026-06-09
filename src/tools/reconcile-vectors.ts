// library_write operation: reconcile_vectors — admin-only vector-database hygiene.
//
// Principle: the manifest is the AUTHORITY for active curated pages; Qdrant is an
// index/cache. This operation reconciles the active wiki_page vector collection back to
// the manifest after metadata/content migrations, so no orphan vectors, duplicate
// vectors, stale payloads, wrong-domain vectors, or stale embeddings linger.
//
// It NEVER touches raw sources, history copies, schemas, rules, RDF maps, or logs (other
// than appending its own audit log). The only writes it performs are to wiki_page vectors
// in Qdrant. It does not delete or rewrite blobs, and it does not mutate the manifest —
// it only reads it. dry_run defaults to true: an apply run must be requested explicitly.
//
// Deterministic identity. Like every other wiki write path (library_update,
// patch_page_metadata, delete_blob), the active vector for a page is keyed by the stable
// UUIDv5 wikiPagePointId(library_id, filename). That is what guarantees ONE active vector
// per active page and makes re-running idempotent: a reembed upserts the same id, a
// payload sync patches the same id. (The build instruction sketched a
// sha256("wiki:{domain}:{filename}") id, but using a different scheme here would create a
// second vector that update_page never writes, defeating the very deduplication this tool
// exists to enforce — so we reuse the existing deterministic id and store domain +
// content_hash in the payload instead, which satisfies the same "one active vector per
// page" guarantee.)

import { DomainEnvelope, DomainException, ToolDefinition, ok, toEnvelope } from '../types'
import { getConfig } from '../config'
import { getWikiContainer, readBlob, writeBlob } from '../storage/blobs'
import { readManifest, PageEntry } from '../storage/manifest'
import { appendLog } from '../storage/log'
import { ensureCollection, scrollPoints, upsertPoints, setPayload, deletePoints, QdrantHit, QdrantPoint } from '../storage/qdrant'
import { embed } from '../embed/openai'
import { wikiPagePointId } from '../embed/ids'
import { sparseVector } from '../embed/sparse'
import { sha256, stripFrontmatter, assertValidDomain } from './shared'

type Mode = 'payload_only' | 'reembed_stale' | 'full_rebuild'
const MODES: Mode[] = ['payload_only', 'reembed_stale', 'full_rebuild']

// Buckets every active page / vector is classified into. See the build instruction.
type Bucket =
  | 'current_and_synced'
  | 'stale_embedding'
  | 'missing_vector'
  | 'wrong_domain_vector'
  | 'bad_payload_vector'
  | 'embedding_model_mismatch'
  | 'blob_missing'

const inputSchema = {
  type: 'object',
  properties: {
    domain: { type: 'string' },
    dry_run: { type: 'boolean' },
    mode: { type: 'string', enum: [...MODES] },
    delete_orphans: { type: 'boolean' },
    delete_duplicates: { type: 'boolean' },
    include_deprecated: { type: 'boolean' },
    force: { type: 'boolean' },
    library_id: { type: 'string' }
  },
  required: ['domain'],
  additionalProperties: false
}

// Payload fields a healthy wiki_page vector must carry to be queryable/filterable.
function payloadComplete(p: Record<string, any> | undefined): boolean {
  return !!p &&
    p.record_type === 'wiki_page' &&
    typeof p.library_id === 'string' &&
    typeof p.filename === 'string' &&
    typeof p.domain === 'string' &&
    typeof p.confidence === 'string' &&
    typeof p.status === 'string' &&
    p.updated !== undefined &&
    p.title !== undefined &&
    p.type !== undefined
}

// The text update.ts embeds for a page, reconstructed from the manifest entry + body.
function embeddingInput(page: PageEntry, body: string): string {
  return `${page.title}\n${page.summary}\n\n${body}`
}
function sparseInput(page: PageEntry, body: string): string {
  return `${page.title} ${page.summary} ${body}`
}

// Full payload for an upsert (reembed). Mirrors update.ts's payload plus governance
// metadata, content_hash and embedding provenance. updated is pinned to the MANIFEST
// value so library_lint's stale_embedding check (payload.updated === manifest.updated)
// reads clean after reconciliation.
function fullPayload(page: PageEntry, libraryId: string, contentHash: string, embeddedAt: string, model: string): Record<string, unknown> {
  const p: Record<string, unknown> = {
    record_type: 'wiki_page',
    library_id: libraryId,
    filename: page.filename,
    title: page.title,
    type: page.type,
    domain: page.domain,
    confidence: page.confidence,
    tags: page.tags || [],
    status: page.status,
    updated: page.updated,
    manifest_updated: page.updated,
    sources: page.sources || [],
    related: page.related || [],
    content_hash: contentHash,
    embedded_at: embeddedAt,
    embedding_model: model,
    embedding_dimensions: 1536
  }
  if (page.page_role) p.page_role = page.page_role
  if (page.allowed_use) p.allowed_use = page.allowed_use
  if (page.prohibited_use) p.prohibited_use = page.prohibited_use
  if (page.business_consequence_if_stale) p.business_consequence_if_stale = page.business_consequence_if_stale
  if (page.invalidation_policy) p.invalidation_policy = page.invalidation_policy
  if (page.last_source_check) p.last_source_check = page.last_source_check
  if (page.reviewed_by) p.reviewed_by = page.reviewed_by
  if (page.reviewed_at) p.reviewed_at = page.reviewed_at
  if (page.review_after) p.review_after = page.review_after
  return p
}

// Payload patch for setPayload (payload_only / metadata-stale). Same fields minus the
// embedding provenance, since no embedding happened. Qdrant setPayload merges keys.
function syncPayload(page: PageEntry, libraryId: string, contentHash: string): Record<string, unknown> {
  const p = fullPayload(page, libraryId, contentHash, '', getConfig().embeddingModel)
  delete p.embedded_at
  delete p.embedding_model
  delete p.embedding_dimensions
  return p
}

interface ActiveRecord {
  page: PageEntry
  det: string
  bucket: Bucket
  contentHash: string
  body: string
  oldContentHash?: string
  dupes: string[] // non-deterministic duplicate vector ids for this filename
}

interface DeleteTarget {
  vector_id: string
  filename: string
  reason: string
}

async function classify(libraryId: string, domain: string) {
  const { manifest } = await readManifest(libraryId)
  const pages = manifest.pages.filter((p) => p.domain === domain)
  const active = pages.filter((p) => p.status === 'active')
  const deprecated = pages.filter((p) => p.status === 'deprecated')
  const manifestFilenames = new Set(manifest.pages.map((p) => p.filename))
  const model = getConfig().embeddingModel
  const wiki = await getWikiContainer()

  await ensureCollection()
  // Scroll ALL wiki_page vectors for the library (no domain filter) so wrong-domain
  // vectors and orphans are visible — a domain-filtered scroll would hide exactly those.
  const vectors = await scrollPoints({
    must: [
      { key: 'record_type', match: { value: 'wiki_page' } },
      { key: 'library_id', match: { value: libraryId } }
    ]
  })
  const byFilename = new Map<string, QdrantHit[]>()
  for (const v of vectors) {
    const fn = v.payload?.filename
    if (typeof fn === 'string') {
      if (!byFilename.has(fn)) byFilename.set(fn, [])
      byFilename.get(fn)!.push(v)
    }
  }

  const records: ActiveRecord[] = []
  for (const page of active) {
    const det = wikiPagePointId(libraryId, page.filename)
    const hits = byFilename.get(page.filename) ?? []
    const canonical = hits.find((h) => String(h.id) === det)
    const dupes = hits.filter((h) => String(h.id) !== det).map((h) => String(h.id))

    const blob = await readBlob(wiki, `pages/${page.filename}`)
    if (!blob) {
      records.push({ page, det, bucket: 'blob_missing', contentHash: '', body: '', dupes })
      continue
    }
    const body = stripFrontmatter(blob.content)
    const contentHash = sha256(embeddingInput(page, body))

    let bucket: Bucket
    if (!canonical) {
      // No vector under the deterministic id (collection may still hold dupes to clean up).
      bucket = 'missing_vector'
    } else {
      const p = canonical.payload
      const modelBad =
        (p.embedding_model !== undefined && p.embedding_model !== model) ||
        (p.embedding_dimensions !== undefined && p.embedding_dimensions !== 1536)
      if (modelBad) bucket = 'embedding_model_mismatch'
      else if (p.domain !== page.domain) bucket = 'wrong_domain_vector'
      else if (!payloadComplete(p)) bucket = 'bad_payload_vector'
      else {
        const contentChanged =
          p.content_hash !== undefined ? p.content_hash !== contentHash : p.updated !== page.updated
        if (contentChanged) bucket = 'stale_embedding'
        else if (p.updated !== page.updated || p.status !== page.status || p.confidence !== page.confidence) bucket = 'stale_embedding'
        else bucket = 'current_and_synced'
      }
    }
    records.push({
      page,
      det,
      bucket,
      contentHash,
      body,
      oldContentHash: canonical?.payload?.content_hash,
      dupes
    })
  }

  // Orphans: vectors whose filename has no manifest entry at all, scoped to this domain
  // by the vector's own payload domain (so a per-domain run never touches another domain).
  const orphanTargets: DeleteTarget[] = []
  for (const [fn, hits] of byFilename) {
    if (!manifestFilenames.has(fn)) {
      for (const h of hits) {
        if (h.payload?.domain === domain) {
          orphanTargets.push({ vector_id: String(h.id), filename: fn, reason: 'orphan_no_manifest_entry' })
        }
      }
    }
  }

  // Deprecated pages still carry a vector (update_page upserts them). Unless the caller
  // opts in with include_deprecated, those are removed from the active collection.
  const deprecatedTargets: DeleteTarget[] = []
  for (const page of deprecated) {
    for (const h of byFilename.get(page.filename) ?? []) {
      deprecatedTargets.push({ vector_id: String(h.id), filename: page.filename, reason: 'deprecated_page_vector' })
    }
  }

  // Duplicates: any non-deterministic vector sharing an active page's filename.
  const duplicateTargets: DeleteTarget[] = []
  for (const r of records) {
    for (const id of r.dupes) {
      duplicateTargets.push({ vector_id: id, filename: r.page.filename, reason: 'duplicate_non_deterministic_vector' })
    }
  }

  // Domain-scoped vector count for reporting (the full scroll spans all domains so
  // wrong-domain vectors and orphans remain visible above).
  const vectorsInDomain = vectors.filter((v) => v.payload?.domain === domain).length

  return {
    pagesInManifest: pages.length,
    activeCount: active.length,
    vectorsInCollection: vectorsInDomain,
    records,
    orphanTargets,
    deprecatedTargets,
    duplicateTargets
  }
}

interface PlanItem { filename: string; reason: string }

// Resolve the per-mode action plan from the classification.
function buildPlan(
  c: Awaited<ReturnType<typeof classify>>,
  mode: Mode,
  deleteOrphans: boolean,
  deleteDuplicates: boolean,
  includeDeprecated: boolean
) {
  const reembed: ActiveRecord[] = []
  const payloadSync: ActiveRecord[] = []
  const skipped: PlanItem[] = []
  const blobMissing: PlanItem[] = []
  const counts = {
    current_and_synced: 0,
    stale_embedding: 0,
    missing_vector: 0,
    orphan_vector: c.orphanTargets.length,
    duplicate_vector: c.duplicateTargets.length,
    deprecated_page_vector: c.deprecatedTargets.length,
    wrong_domain_vector: 0,
    bad_payload_vector: 0,
    embedding_model_mismatch: 0
  }

  for (const r of c.records) {
    switch (r.bucket) {
      case 'blob_missing':
        blobMissing.push({ filename: r.page.filename, reason: 'page_blob_missing_cannot_reembed' })
        break
      case 'current_and_synced':
        counts.current_and_synced++
        if (mode === 'full_rebuild') reembed.push(r)
        break
      case 'missing_vector':
        counts.missing_vector++
        if (mode === 'payload_only') skipped.push({ filename: r.page.filename, reason: 'missing_vector_needs_reembed' })
        else reembed.push(r)
        break
      case 'stale_embedding': {
        counts.stale_embedding++
        // Distinguish content drift (needs reembed) from metadata-only drift (payload sync).
        // contentChanged was the deciding factor; recompute the cheap comparison here.
        const contentChanged = r.oldContentHash !== undefined
          ? r.oldContentHash !== r.contentHash
          : true // unknown legacy hash → treat conservatively as content-stale
        if (mode === 'full_rebuild') reembed.push(r)
        else if (mode === 'payload_only') {
          if (contentChanged) skipped.push({ filename: r.page.filename, reason: 'content_changed_needs_reembed' })
          else payloadSync.push(r)
        } else {
          // reembed_stale
          if (contentChanged) reembed.push(r)
          else payloadSync.push(r)
        }
        break
      }
      case 'wrong_domain_vector':
        counts.wrong_domain_vector++
        if (mode === 'payload_only') payloadSync.push(r)
        else reembed.push(r)
        break
      case 'bad_payload_vector':
        counts.bad_payload_vector++
        if (mode === 'payload_only') payloadSync.push(r)
        else reembed.push(r)
        break
      case 'embedding_model_mismatch':
        counts.embedding_model_mismatch++
        if (mode === 'payload_only') skipped.push({ filename: r.page.filename, reason: 'embedding_model_mismatch_needs_reembed' })
        else reembed.push(r)
        break
    }
  }

  // Explicit, non-blind delete list, gated by the caller's flags.
  const deletes: DeleteTarget[] = []
  if (deleteOrphans) deletes.push(...c.orphanTargets)
  if (deleteDuplicates) deletes.push(...c.duplicateTargets)
  if (!includeDeprecated) deletes.push(...c.deprecatedTargets)

  return { reembed, payloadSync, skipped, blobMissing, deletes, counts }
}

async function reconcileVectorsImpl(input: unknown): Promise<DomainEnvelope> {
  const a = (input ?? {}) as Record<string, any>

  const domain = assertValidDomain(a.domain)
  const mode: Mode = a.mode === undefined ? 'reembed_stale' : a.mode
  if (!MODES.includes(mode)) {
    throw new DomainException('VALIDATION_ERROR', `mode must be one of: ${MODES.join(' | ')}`)
  }
  // dry_run defaults to true — an apply run must be requested explicitly.
  const dryRun = a.dry_run !== false
  const deleteOrphans = a.delete_orphans === true
  const deleteDuplicates = a.delete_duplicates === true
  const includeDeprecated = a.include_deprecated === true
  const force = a.force === true
  const libraryId = typeof a.library_id === 'string' && a.library_id ? a.library_id : 'default'

  // full_rebuild re-embeds every active page (cost + churn), so an apply requires force.
  if (mode === 'full_rebuild' && !dryRun && !force) {
    throw new DomainException('VALIDATION_ERROR', 'full_rebuild apply requires force: true (it re-embeds every active page)')
  }

  const c = await classify(libraryId, domain)
  const plan = buildPlan(c, mode, deleteOrphans, deleteDuplicates, includeDeprecated)
  const warnings: string[] = []

  const plannedReembed: PlanItem[] = plan.reembed.map((r) => ({
    filename: r.page.filename,
    reason: r.bucket === 'current_and_synced' ? 'full_rebuild' : r.bucket
  }))
  const plannedPayloadSync: PlanItem[] = plan.payloadSync.map((r) => ({ filename: r.page.filename, reason: r.bucket }))
  const plannedDelete = plan.deletes

  const baseData = {
    domain,
    dry_run: dryRun,
    mode,
    pages_in_manifest: c.pagesInManifest,
    active_pages: c.activeCount,
    vectors_in_collection: c.vectorsInCollection,
    ...plan.counts,
    planned_reembed: plannedReembed,
    planned_payload_sync: plannedPayloadSync,
    planned_delete: plannedDelete
  }

  if (plan.blobMissing.length > 0) warnings.push('page_blob_missing')
  if (plan.skipped.length > 0 && mode === 'payload_only') warnings.push('items_need_reembed_skipped_in_payload_only')

  // Dry run: report the plan, mutate nothing.
  if (dryRun) {
    return ok({ ...baseData, skipped: plan.skipped, blob_missing: plan.blobMissing }, warnings)
  }

  // ---- Apply ----
  const startedAt = new Date().toISOString()
  const model = getConfig().embeddingModel
  const auditActions: any[] = []
  const errors: Array<{ filename?: string; vector_id?: string; action: string; error: string }> = []

  let vectorsReembedded = 0
  let payloadsSynced = 0
  let vectorsDeleted = 0

  await ensureCollection()

  // 1. Re-embed (idempotent upsert under the deterministic id).
  for (const r of plan.reembed) {
    const embeddedAt = new Date().toISOString()
    try {
      const [vec] = await embed(embeddingInput(r.page, r.body))
      const point: QdrantPoint = {
        id: r.det,
        vector: { default: vec, text: sparseVector(sparseInput(r.page, r.body)) },
        payload: fullPayload(r.page, libraryId, r.contentHash, embeddedAt, model)
      }
      await upsertPoints([point])
      vectorsReembedded++
      auditActions.push({
        filename: r.page.filename,
        action: 'reembed',
        status: 'success',
        vector_id: r.det,
        old_content_hash: r.oldContentHash ?? null,
        new_content_hash: r.contentHash,
        embedded_at: embeddedAt
      })
    } catch (err) {
      const msg = (err as Error).message
      errors.push({ filename: r.page.filename, vector_id: r.det, action: 'reembed', error: msg })
      auditActions.push({ filename: r.page.filename, action: 'reembed', status: 'error', vector_id: r.det, error: msg })
    }
  }

  // 2. Payload-only syncs.
  for (const r of plan.payloadSync) {
    try {
      await setPayload([r.det], syncPayload(r.page, libraryId, r.contentHash))
      payloadsSynced++
      auditActions.push({ filename: r.page.filename, action: 'payload_sync', status: 'success', vector_id: r.det })
    } catch (err) {
      const msg = (err as Error).message
      errors.push({ filename: r.page.filename, vector_id: r.det, action: 'payload_sync', error: msg })
      auditActions.push({ filename: r.page.filename, action: 'payload_sync', status: 'error', vector_id: r.det, error: msg })
    }
  }

  // 3. Deletes (orphans / duplicates / deprecated) — only the explicit planned list.
  if (plannedDelete.length > 0) {
    const ids = plannedDelete.map((d) => d.vector_id)
    try {
      await deletePoints(ids)
      vectorsDeleted += ids.length
      for (const d of plannedDelete) {
        auditActions.push({ filename: d.filename, action: 'delete', status: 'success', vector_id: d.vector_id, reason: d.reason })
      }
    } catch (err) {
      const msg = (err as Error).message
      for (const d of plannedDelete) errors.push({ filename: d.filename, vector_id: d.vector_id, action: 'delete', error: msg })
      auditActions.push({ action: 'delete', status: 'error', error: msg })
    }
  }

  const completedAt = new Date().toISOString()

  // 4. Audit log: one JSON document per apply run. Written to the wiki container under
  //    logs/vector-reconcile/{domain}/{safe-timestamp}.json (a fresh path each run, so it
  //    never contends with anything and re-runs never overwrite an earlier audit).
  const safeTs = startedAt.replace(/:/g, '-')
  const logPath = `logs/vector-reconcile/${domain}/${safeTs}.json`
  const auditDoc = {
    domain,
    mode,
    started_at: startedAt,
    completed_at: completedAt,
    dry_run: false,
    delete_orphans: deleteOrphans,
    delete_duplicates: deleteDuplicates,
    include_deprecated: includeDeprecated,
    actions: auditActions,
    errors
  }
  try {
    const wiki = await getWikiContainer()
    await writeBlob(wiki, logPath, JSON.stringify(auditDoc, null, 2), 'application/json; charset=utf-8')
  } catch (err) {
    warnings.push('audit_log_write_failed', (err as Error).message)
  }

  // 5. Event log (warning only on failure).
  const log = await appendLog({
    ts: completedAt,
    tool: 'library_write',
    action: `reconcile_vectors ${domain} (${mode}): reembedded ${vectorsReembedded}, synced ${payloadsSynced}, deleted ${vectorsDeleted}`,
    domain,
    library_id: libraryId
  })
  if (!log.ok) warnings.push('log_append_failed')

  return ok(
    {
      domain,
      dry_run: false,
      mode,
      pages_processed: c.activeCount,
      vectors_reembedded: vectorsReembedded,
      payloads_synced: payloadsSynced,
      vectors_deleted: vectorsDeleted,
      errors,
      log_path: logPath
    },
    warnings
  )
}

export const reconcileVectorsTool: ToolDefinition = {
  name: 'library_reconcile_vectors',
  description:
    'Reconcile the active wiki_page vector collection back to the manifest (the authority) ' +
    'for one domain. dry_run defaults to true and returns a plan; set dry_run: false to apply. ' +
    'mode: "payload_only" (sync governance/metadata payload, no embedding call), "reembed_stale" ' +
    '(default — re-embed pages whose content changed, payload-sync the rest), or "full_rebuild" ' +
    '(re-embed every active page; apply requires force). Cleans orphan (delete_orphans), ' +
    'duplicate (delete_duplicates) and deprecated (unless include_deprecated) vectors via an ' +
    'explicit, non-blind delete list. Active vector IDs are deterministic, so re-running is ' +
    'idempotent. Never deletes raw sources, history, schemas, rules, RDF maps, logs, or wiki blobs.',
  inputSchema,
  handler: (input) => toEnvelope(() => reconcileVectorsImpl(input))
}
