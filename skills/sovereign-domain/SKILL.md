---
name: sovereign-domain
description: >-
  Use when authoring or revising a complete three-layer "Sovereign AI" domain through the
  Library MCP — deterministic rules (Layer 1 / Constitution), curated sourced pages (Layer 2 /
  Library), and an RDF reasoning map (Layer 3) — so that library_resolve returns one coherent,
  governed answer package to translate into language. Invoke for tasks like "build the
  ctax-rebuild domain", "add the bailiff-at-the-door scenario", "make resolve return the right
  answer shape", or "wire eligibility, sources, and safety constraints together for <domain>".
---

# Authoring a coherent three-layer domain

This skill is for an assistant that has the **Library MCP** connected. It explains how to use
the library's tools to build one coherent domain across three layers. A domain is **coherent**
when the three layers share one vocabulary and feed a single `library_resolve` answer. Each
layer has a distinct job, and you (the model) translate the governed result into language —
you do not decide eligibility, retrieve, or judge safety yourself.

| Layer | Job | Tool to call | Lives in |
|---|---|---|---|
| 1 — Constitution | Eligibility, thresholds, valid states → a governed outcome + which rule fired | `library_update_rules` | `{domain}.rules.json` |
| 2 — Library | Sourced context: confidence, currency, provenance, permitted use | `library_write` | curated pages |
| 3 — Reasoning Map | What the question means, the required answer **shape**, safety constraints, overrides | `library_update_reasoning` | `{domain}.ttl` |
| Orchestrator | Compose 1→2→3 into a `translation_brief` | `library_resolve` | — |

> The three write tools are administrative and may be exposed on **separate MCP connections**
> from the read/query tools (and may require their own access). Reading (`library_info`),
> querying (`library_query`), and resolving (`library_resolve`) are the everyday tools. If a
> write tool isn't available to you, you are on the read-only connection — author the content
> and hand the tool calls to whoever holds the admin connection.

## Step 1 — fix the shared vocabulary (do this first)

Drift between layers is the main failure mode, so agree these names up front and reuse them
**verbatim** everywhere:

- **`domain`** — one slug matching `^[a-z0-9][a-z0-9-]*$` (e.g. `ctax-rebuild`). Identical in
  all three layers.
- **Signals** — short snake_case flags for the situation (e.g. `bailiff_present`). A caller
  passes them to `library_resolve` as `signals: { bailiff_present: true }` (**truthy = active**),
  and Layer 3 must spell each one identically in `sov:whenSignal "bailiff_present"`.
- **Inputs** — structured facts for Layer 1 (e.g. `liable_occupier`, `low_income`). A rule's
  `when` references them by `path`; callers pass them as `inputs: {...}`.
- **Answer shapes / intersections** — names in Layer 3 (e.g. `UrgentSafeguardingGuidance`,
  `BailiffAtDoor`). A Layer 1 `outcome.governs` entry should name the shape it points at.
- **Source ids** — every Layer 2 claim cites a `source_id` that exists in the source registry
  (register or ingest it first); these become `translation_brief.cite_sources`.

Capture this as a short vocabulary note and keep it beside the domain.

## Step 2 — Layer 2: sources and curated pages (`library_write`)

1. **Register or ingest the sources** so citations resolve:
   `library_write { operation: "register_source", source_id, title, ... }` for a metadata-only
   citable source, or `library_write { operation: "ingest", title, content, source_type, ... }`
   to store and index the full text.
2. **Write the curated page(s)**:
   `library_write { operation: "update_page", filename, title, content, page_type, domain,
   confidence, tags, summary, sources[], related[], allowed_use[], ... }`.
   - The body must carry inline `[source: <source_id>]` markers, and `sources[]` must list them.
   - Set `allowed_use` to the highest mode the page may support (`analysis` → `drafting` →
     `staff_guidance` → `public_guidance` → `decision_support`). For `public_guidance` /
     `decision_support`, also set `last_source_check` and (for the latter)
     `business_consequence_if_stale`, or `library_resolve` will not pass that result.
   - Promote to `status: "active"` only once the page is sourced and reviewed.
3. **Check it**: `library_query { domain, question, intent }` returns the page with
   `use_permitted: true` and a clean provenance/freshness block.

## Step 3 — Layer 1: the ruleset (`library_update_rules`)

`library_update_rules { domain, rules }`, where `rules` is an **ordered** list (first match
wins) of deterministic rules:

```jsonc
{
  "version": "2026-06-05.1",                 // auditable; bump on every change
  "input_schema": { "required": ["liable_occupier"] },
  "rules": [                                 // ORDERED — most specific first
    { "id": "CTR-002",
      "when": { "op": "eq", "path": "liable_occupier", "value": false },
      "outcome": { "eligibility": "ineligible", "reason_code": "not_liable" } },
    { "id": "CTR-001",
      "when": { "all": [
        { "op": "eq", "path": "liable_occupier", "value": true },
        { "op": "eq", "path": "low_income",      "value": true },
        { "op": "eq", "path": "in_arrears",      "value": true } ] },
      "outcome": { "eligibility": "eligible", "reason_code": "ctr_income_qualified",
                   "governs": ["RebuildSupportShape"] } }
  ],
  "default_outcome": { "eligibility": "indeterminate", "reason_code": "no_rule_fired" }
}
```

- `when` is a **closed predicate AST** — data, not prose: `{ all|any: [...] }`, `{ not: ... }`,
  or a leaf `{ op: eq|neq|lt|lte|gt|gte|in|exists, path: "a.b", value? }`. Keep it deterministic;
  do not smuggle judgement into it.
- Put the most specific / most restrictive rules **first** — a broad rule placed first shadows
  the specific ones below it.
- **Check it**: `library_info { resource: "rules", domain, inputs: {...} }` returns the expected
  `eligibility` and `rule_fired`.

## Step 4 — Layer 3: the reasoning map (`library_update_reasoning`)

`library_update_reasoning { domain, turtle }`. The reasoner reads a **fixed vocabulary**: the
`sov:` prefix is the engine's **reserved ontology**, the SAME for every domain (it is not
"council tax" or any other domain — the domain is the literal value of `sov:inDomain`). It is a
`urn:`, an opaque identifier with no host to resolve, so there is nothing "local" to reach at
runtime. The `shape:` prefix is cosmetic — only the local name (after the last `:`/`#`/`/`) of
answer-shape and override objects is read, so any namespace works for those.

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
  is active; it then sets `answer_shape`, `safety_constraints`, `must_include`, `must_not`, and
  `overrides`.
- The Turtle is **parse-gated** (syntax errors are rejected), and a **vocabulary guard** returns
  `warnings[]` (it does not block) when the map uses unrecognised `sov:` predicates or an
  intersection is missing `inDomain` / `whenSignal` / `requiresAnswerShape`. Read `warnings[]`
  on the write result and fix anything flagged.
- Keep decorative annotations OUT of the `sov:` namespace, or the guard flags them.
- **Check it**: `library_info { resource: "reasoning", domain, signals: {...} }` returns the
  expected `answer_shape` and `safety_constraints`.

## Step 5 — validate the whole resource (`library_resolve`)

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
- `eligibility.rule_fired` is the rule you expect (here `"CTR-001"`), not `null`.
- `context.results` includes your curated page with `use_permitted: true`.
- `reasoning.answer_shape` is the intersection's shape; `safety_constraints` / `must_not` carry
  the hard limits.
- `translation_brief.allowed` is `true` only when eligible **and** there is permitted context
  **and** the map does not demand a `Refuse` shape. `cite_sources` lists the page's sources.

Then **translate only**: render prose to `answer_shape`, include everything in `must_include`,
avoid everything in `must_not` / `safety_constraints`, cite `cite_sources` — and judge nothing.

## Coherence checklist (the cross-layer contract)

- [ ] One `domain` slug, spelled identically in rules, pages, and Turtle.
- [ ] Every `sov:whenSignal` is a signal a caller will actually pass; every rule `when.path` is
      an input a caller will actually pass. Document the expected `inputs` / `signals`.
- [ ] Each Layer 1 `outcome.governs` entry names a Layer 3 shape/node that exists.
- [ ] Each Layer 3 `sov:mustInclude` topic is covered by an **active**, cited Layer 2 page.
- [ ] Page `allowed_use` and currency metadata clear the bar for the `intent` you expect
      (e.g. `public_guidance` ⇒ `last_source_check` set + a non-superseded snapshot).
- [ ] Intersections that should win override the standard shape via `sov:overrides`.
- [ ] `library_update_reasoning` returned no vocabulary `warnings[]`, and `library_lint` is clean.

## Pitfalls

- **Vocabulary drift** — `bailiff_present` in the Turtle but `bailiffPresent` from the caller
  never fires. One spelling, snake_case, everywhere.
- **Wrong RDF predicates / namespace** — only the `urn:sovereign:` predicates above are read; a
  custom predicate or the wrong namespace produces no reasoning. The vocabulary guard warns but
  does not block — read `warnings[]`.
- **Rule order** — first match wins; a broad rule above a specific one shadows it.
- **Confidence ≠ currency** — a high-confidence page can cite a superseded snapshot; resolve
  down-ranks or refuses it for higher intents. Set `last_source_check` / provenance deliberately.
- **Operational intent** — `formal_decision` / `live_account_action` / `payment_action` /
  `enforcement_action` are refused outright and content is withheld. The library never
  authorises an operational act; that belongs to a deterministic operational system.
- **Eligibility is Layer 1's job, not the page's** — don't write eligibility prose into a page
  and expect resolve to honour it; put it in the ruleset.
