# Data Correction Plan

> Companion to the platform changes that added `patch_page_metadata` (lightweight metadata
> writes), the `domains` coverage inventory, centralised domain-string validation, and the
> `governance_not_adopted` lint signal. Those changes make the data gaps *visible and
> cheap to fix*; this document is the process for fixing them. It is estate-wide — every
> domain follows the same sequence — not specific to `council-tax-rebuild`.

## Principles

1. **Governance claims must be true, not synthesised.** `last_source_check`, `reviewed_by`,
   `reviewed_at`, `allowed_use`, `business_consequence_if_stale` are assertions a person
   stands behind. Tooling can *write* them; it must not *invent* them. A human decides the
   values; the tool applies them.
2. **Per-domain, reversible, controlled-pilot.** Fix one domain at a time. Re-run lint after
   each change to confirm the issue cleared and nothing new appeared.
3. **No content rewrite for metadata.** Use `patch_page_metadata` (no re-embed, no history)
   for governance/review fields; reserve `update_page` for content/identity changes.
4. **Authority stays upstream.** None of this makes a page a source of truth. Currency is
   still only knowable by re-reading upstream.

## Step 0 — Inventory the estate

`library_info { resource: "domains" }` → the coverage map: per domain, page counts by
status and which of {schema, rules, reasoning} exist, plus `gaps`.

Triage the gaps in this order:

| Gap | Meaning | Fix path |
|---|---|---|
| `artifacts_without_pages` | a rules/reasoning/schema file exists for a domain with **no pages** — almost always a domain-string typo (e.g. `ctax-rebuild` vs `council-tax-rebuild`) so the artifact never composes | reconcile to the canonical domain string (below) |
| `schema_without_governance` | schema exists but `governance_required` is off — query still gates use, lint stays quiet | Step 2 |
| `no_rules` / `no_reasoning_map` | domain runs on Layer 2 only | Layer 1 / Layer 3 authoring (separate, design-led work) |
| `no_schema` | 5+ active pages, no schema | author a schema |

## Step 1 — Lint each domain

`library_lint { domain }` now surfaces, in addition to the existing structural checks:

- `governance_not_adopted` (info) — the adoption gap itself.
- `operational_use_not_permitted` (error) — **now always checked**, regardless of opt-in.

This is the per-domain worklist. Group the findings into the categories below.

## Step 2 — Correction categories

### A. Domain-string drift (`artifacts_without_pages`)
The most dangerous class: a `{domain}.rules.json` or `{domain}.ttl` under a string that no
page or query uses **silently never fires**. For each:
1. Confirm the canonical domain string (the one the pages use).
2. Re-write the artifact under the canonical string: `update_rules` / `update_reasoning` /
   `update_schema`.
3. Delete the mis-keyed artifact: `delete_blob` (container `rules`/`rdf`/`schema`).
4. Re-run `library_info { resource: "domains" }` — the gap should be gone.

> Centralised validation now rejects malformed domain strings at write time, so new drift
> from typos can't be introduced; this step cleans up any pre-existing drift.

### B. Missing review metadata on active pages (`active_missing_review_metadata`)
Active pages require `reviewed_by` + `reviewed_at`. Pages created before that rule may lack
them. Once a reviewer has actually reviewed the page:
`patch_page_metadata { filename, reviewed_by, reviewed_at }`.

### C. Governance metadata for consumption
To make pages usable under a real `intended_use` (and clear the Step-2 lint warnings),
after the curator has verified each page against its sources:

| To enable… | Set via `patch_page_metadata` |
|---|---|
| `public_guidance` | `last_source_check` (ISO date of the verification) |
| `decision_support` | `business_consequence_if_stale` = low \| medium \| high |
| high-consequence pages | `invalidation_policy` (when to re-check / retire) |
| restricting use | `allowed_use` / `prohibited_use` |

Scope this to the pages genuinely intended for consumption under that mode — do **not**
blanket-stamp every page.

### D. Schema governance switch (`schema_without_governance` / `governance_not_adopted`)
Once a domain's pages carry the metadata above, turn on detection so it stays honest:
`update_schema { domain, schema: { …, governance_required: true, max_snapshot_age_days: N } }`.
(Enabling this *before* the backfill is also fine — it just makes lint list the work.)

### E. Provenance / upstream identity (`source_missing_upstream_id`)
`set_provenance { source_id, upstream_id | source_url }` so supersession can be detected.

### F. Stale snapshots (`cites_superseded_source`, `snapshot_aged`)
A newer snapshot exists or the snapshot is past the domain threshold. Re-ingest upstream
(`ingest`) and re-point the page (`update_page`) — this *is* a content change, so it goes
through the full path, not the patch.

## Recommended per-domain sequence

```
domains inventory → fix domain drift (A) → lint domain
   → backfill review metadata (B) → backfill consumption metadata (C)
   → enable schema governance (D) → fix provenance (E) → re-curate stale snapshots (F)
   → re-lint until clean
```

## Notes & safety

- `patch_page_metadata` keeps **no history version** (it's metadata-only); the event log
  records every patch. If you need an archived before-state, use `update_page`.
- The patch keeps the Qdrant payload `updated` in sync, so it will **not** create a false
  `stale_embedding`.
- All shared-file writes remain ETag-conditional; a `CONFLICT` means re-read and retry.
- Re-run `library_lint` after each domain to verify closure.

## Out of scope here

Authoring Layer 1 rulesets and Layer 3 reasoning maps (`no_rules` / `no_reasoning_map`) is
design-led domain modelling, not a data correction — tracked separately. Admin-route
authentication is deliberately deferred for now so latent issues surface during testing.
