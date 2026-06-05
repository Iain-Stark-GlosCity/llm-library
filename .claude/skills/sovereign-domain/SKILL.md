---
name: sovereign-domain
description: >-
  Use when authoring or revising a complete three-layer "Sovereign AI" domain in the Library
  MCP — deterministic rules (Layer 1 / Constitution), curated sourced pages (Layer 2 /
  Library), and an RDF reasoning map (Layer 3) — so that library_resolve returns one coherent,
  governed answer package the LLM only translates. Invoke for tasks like "build the ctax-rebuild
  domain", "add the bailiff scenario", "make resolve return the right answer shape", or
  "wire eligibility, sources, and safety constraints together for <domain>".
---

# Authoring a coherent three-layer domain

A domain is **coherent** when the three layers share one vocabulary and feed a single
`library_resolve` answer. Each layer has a distinct job; the LLM decides nothing.

| Layer | Job | Tool (endpoint) | Storage |
|---|---|---|---|
| 1 — Constitution | Eligibility, thresholds, valid states → governed outcome + which rule fired | `library_update_rules` (`/api/mcp-rules`) | `{domain}.rules.json` |
| 2 — Library | Sourced context: confidence, currency, provenance, permitted use | `library_write` (`/api/mcp-library`) | curated pages |
| 3 — Reasoning Map | What the question means, the required answer **shape**, safety constraints, overrides | `library_update_reasoning` (`/api/mcp-rdf`) | `{domain}.ttl` |
| Orchestrator | Compose 1→2→3 into a `translation_brief` | `library_resolve` (`/api/mcp`) | — |

> The admin tools live on **separate keyed endpoints**. Reads (`library_info`) and the
> orchestrator (`library_resolve`) live on the read-only consumption endpoint `/api/mcp`.

## The shared vocabulary (get this right first)

Before writing anything, fix these names — every layer must use them identically:

- **`domain`** — one slug matching `^[a-z0-9][a-z0-9-]*$` (e.g. `ctax-rebuild`). Identical in
  all three layers.
- **Signals** — short snake_case flags describing the situation (e.g. `bailiff_present`). A
  caller passes them to `library_resolve` as `signals: { bailiff_present: true }`; **truthy =
  active**. Layer 3 `ctax:whenSignal "bailiff_present"` must spell them the same.
- **Inputs** — structured facts for Layer 1 (e.g. `liable_occupier`, `low_income`). A rule's
  `when` references them by `path`; callers pass them as `inputs: {...}`.
- **Answer shapes / intersections** — IRIs/local names in Layer 3 (e.g.
  `shape:UrgentSafeguardingGuidance`, `ctax:BailiffAtDoor`). A Layer 1 `outcome.governs` entry
  should name the shape it points at, by convention.
- **Source ids** — every Layer 2 claim cites a `source_id` that exists in the raw manifest
  (ingest or register it first); these become `translation_brief.cite_sources`.

Write a one-paragraph vocabulary note and keep it; drift between layers is the main failure
mode.

## Build order

Author **bottom-up so each step is verifiable**, then validate top-down with `library_resolve`.

### 0. (Optional) Domain schema — `library_write { operation: update_schema }`
Set advisory doctrine and, if this domain should be governed, `governance_required: true` and
`max_snapshot_age_days`. Inherited global doctrine applies if you skip this.

### 1. Layer 2 — sources and pages (`/api/mcp-library`)
1. **Register or ingest sources** so citations resolve: `library_write { operation:
   register_source, source_id, title, ... }` (metadata-only) or `{ operation: ingest, ... }`
   (store + chunk + embed).
2. **Write curated pages**: `library_write { operation: update_page, filename, title, content,
   page_type, domain, confidence, tags, summary, sources[], related[], allowed_use[], ... }`.
   - The body must carry inline `[source: <source_id>]` markers, and `sources[]` must list
     them. Promote to `status: active` only once sourced + reviewed.
   - Set `allowed_use` to the highest mode this page may support (`analysis` … `decision_support`).
     For `public_guidance`/`decision_support`, also set `last_source_check` and (for the latter)
     `business_consequence_if_stale`, or `library_resolve` will not pass that result.
3. **Verify**: `library_query { domain, question, intent }` returns the page with
   `use_permitted: true` and a clean provenance/freshness block.

### 2. Layer 1 — the ruleset (`/api/mcp-rules`)
`library_update_rules { domain, rules }` where `rules` is:

```jsonc
{
  "version": "2026-06-05.1",                 // auditable; bump on every change
  "input_schema": { "required": ["liable_occupier"] },
  "rules": [                                 // ORDERED — first match wins
    { "id": "CTR-002",
      "when": { "op": "eq", "path": "liable_occupier", "value": false },
      "outcome": { "eligibility": "ineligible", "reason_code": "not_liable" } },
    { "id": "CTR-001",
      "when": { "all": [
        { "op": "eq", "path": "liable_occupier", "value": true },
        { "op": "eq", "path": "low_income",      "value": true },
        { "op": "eq", "path": "in_arrears",      "value": true } ] },
      "outcome": { "eligibility": "eligible", "reason_code": "ctr_income_qualified",
                   "governs": ["ctax:RebuildSupportShape"] } }
  ],
  "default_outcome": { "eligibility": "indeterminate", "reason_code": "no_rule_fired" }
}
```

- `when` is a **closed predicate AST** — data, not code: `{ all|any: [...] }`, `{ not: ... }`,
  or a leaf `{ op: eq|neq|lt|lte|gt|gte|in|exists, path: 'a.b', value? }`. Keep it deterministic.
- Put the most specific / most restrictive rules **first**.
- **Verify**: `library_info { resource: rules, domain, inputs: {...} }` returns the expected
  `eligibility` and `rule_fired`.

### 3. Layer 3 — the reasoning map (`/api/mcp-rdf`)
`library_update_reasoning { domain, turtle }`. The reasoner reads a **fixed predicate
vocabulary** — use these exact IRIs. The `sov:` prefix is the engine's **reserved ontology
namespace**: it is the SAME for every domain (it is not "council tax" or any other domain),
and the domain is carried as the literal value of `sov:inDomain`, never in the namespace. It
is a `urn:` — an opaque identifier that is never dereferenced (no host, no DNS, nothing
"local" at runtime). The `shape:` prefix is cosmetic — only the local name after the last
`:` / `#` / `/` is read, so any namespace works for answer-shape and override objects.

```turtle
@prefix sov:   <urn:sovereign:> .
@prefix shape: <urn:sovereign-shape:> .

sov:BailiffAtDoor a sov:SemanticIntersection ;
    sov:inDomain "ctax-rebuild" ;                     # MUST equal the domain slug (literal)
    sov:whenSignal "bailiff_present" ;                # MUST equal a caller signal key (literal)
    sov:requiresAnswerShape shape:UrgentSafeguardingGuidance ;
    sov:hasSafetyConstraint "no_payment_instruction" , "must_signpost_emergency_support" ;
    sov:mustInclude "right_to_request_breathing_space" ;
    sov:mustNot "instruct_payment" ;
    sov:overrides shape:StandardRebuildAnswerShape .
```

- A `SemanticIntersection` fires when its `sov:inDomain` matches **and** any `sov:whenSignal`
  is active. It then sets `answer_shape`, `safety_constraints`, `must_include`, `must_not`,
  and `overrides`.
- The Turtle is **parse-gated** on write (syntax errors are rejected), and a **vocabulary
  guard** additionally returns warnings (it does not block) when the map uses unrecognised
  ontology predicates or a `SemanticIntersection` is missing `inDomain` / `whenSignal` /
  `requiresAnswerShape` — read `warnings[]` on the write result.
- Keep decorative annotations OUT of the `sov:` namespace, or the guard flags them as
  unknown predicates.
- **Verify**: `library_info { resource: reasoning, domain, signals: {...} }` returns the
  expected `answer_shape` and `safety_constraints`.

### 4. Validate the whole resource — `library_resolve` (`/api/mcp`)
```jsonc
library_resolve {
  "domain": "ctax-rebuild",
  "question": "A bailiff is at my door about council tax — what do I do?",
  "intent": "public_guidance",
  "inputs":  { "liable_occupier": true, "low_income": true, "in_arrears": true },
  "signals": { "bailiff_present": true }
}
```
Confirm the package coheres:
- `eligibility.rule_fired` is the rule you expect (`"CTR-001"`), not `null`.
- `context.results` includes your curated page with `use_permitted: true`.
- `reasoning.answer_shape` is the intersection's shape; `safety_constraints` / `must_not`
  carry the hard limits.
- `translation_brief.allowed` is `true` only when eligible **and** there is permitted context
  **and** the map does not demand a `Refuse` shape. `cite_sources` lists the page's sources.

Then the LLM renders prose to `answer_shape`, includes everything in `must_include`, avoids
everything in `must_not`/`safety_constraints`, cites `cite_sources` — and judges nothing.

## Coherence checklist (the cross-layer contract)

- [ ] One `domain` slug, spelled identically in rules, pages, and Turtle.
- [ ] Every `ctax:whenSignal` is a signal a caller will actually pass; every rule `when.path`
      is an input a caller will pass. Document the expected `inputs`/`signals` for the domain.
- [ ] Each Layer 1 `outcome.governs` entry names a Layer 3 shape/node that exists.
- [ ] Each Layer 3 `mustInclude` topic is actually covered by an **active**, cited Layer 2 page.
- [ ] Page `allowed_use` and currency metadata clear the bar for the `intent` you expect
      (e.g. `public_guidance` ⇒ `last_source_check` set + non-superseded snapshot).
- [ ] Intersections that should win override the standard shape via `ctax:overrides`.
- [ ] `npm run verify:sovereign` (for fixture-backed domains) and `library_lint` are clean.

## Pitfalls

- **Vocabulary drift** — a signal named `bailiff_present` in Turtle but `bailiffPresent` in the
  caller never fires. Keep snake_case and one spelling.
- **Wrong RDF predicates / namespace** — only the `urn:sovereign:` predicate IRIs above are
  read; a custom predicate or the wrong namespace produces no reasoning. The write-time
  vocabulary guard now warns about this, but it does not block — check `warnings[]`.
- **Rule order** — rules are first-match-wins; a broad rule placed first shadows specific ones.
- **Confidence ≠ currency** — a high-confidence page can cite a superseded snapshot; resolve
  will down-rank/refuse it for higher intents. Set `last_source_check`/provenance deliberately.
- **Operational intent** — `formal_decision`/`live_account_action`/`payment_action`/
  `enforcement_action` are refused outright; content is withheld. The library never authorises
  an operational act.
- **Eligibility is Layer 1's job, not the page's** — do not encode eligibility prose into a
  page and expect resolve to honour it; put it in the ruleset.
