---
name: llm-library-domain
description: >-
  Use when building or revising a complete three-layer domain in the LLM Library MCP
  (func-stark-library). Covers Layer 1 deterministic rules via library_update_rules,
  Layer 2 curated sourced pages via library_write, and Layer 3 RDF reasoning map via
  library_update_reasoning, so that library_resolve returns one coherent, governed
  answer package. Invoke for tasks like "build the ctax-rebuild domain", "add the
  bailiff-at-the-door scenario", "make resolve return the right answer shape", or
  "wire eligibility, sources, and safety constraints together for a domain".
---

# Authoring a coherent three-layer domain in the LLM Library MCP

This skill is for use when the Library MCP (func-stark-library) is connected. It explains how
to use the library tools to build one coherent domain across three layers. A domain is coherent
when all three layers share one vocabulary and feed a single `library_resolve` answer. Each
layer has a distinct job. The model translates the governed result into language — it does not
decide eligibility, retrieve, or judge safety itself.

## Layer responsibilities

| Layer | Job | Write tool | Storage |
|---|---|---|---|
| 1 — Constitution | Eligibility, thresholds, valid states; returns a governed outcome and which rule fired | `library_update_rules` | `{domain}.rules.json` |
| 2 — Library | Sourced context: confidence, currency, provenance, permitted use | `library_write` | curated wiki pages |
| 3 — Reasoning Map | What the question means, the required answer shape, safety constraints, overrides | `library_update_reasoning` | `{domain}.ttl` |
| Orchestrator | Composes 1+2+3 into a `translation_brief` | `library_resolve` | — |

The three write tools are administrative and may be on a separate MCP connection from the read
and query tools. Reading (`library_info`), querying (`library_query`), and resolving
(`library_resolve`) are the everyday tools. If a write tool is not available, you are on the
read-only connection — author the content and hand the tool calls to whoever holds the admin
connection.


## Step 1 — Fix the shared vocabulary first

Vocabulary drift between layers is the main failure mode. Agree these names up front and reuse
them verbatim everywhere.

**domain** — one slug matching `^[a-z0-9][a-z0-9-]*$` (e.g. `ctax-rebuild`). Identical in all
three layers.

**Signals** — short snake_case flags for the situation (e.g. `bailiff_present`). A caller passes
them to `library_resolve` as `signals: { bailiff_present: true }` (truthy = active). Layer 3
must spell each one identically in `sov:whenSignal "bailiff_present"`.

**Inputs** — structured facts for Layer 1 (e.g. `liable_occupier`, `low_income`). A rule's
`when` references them by `path`; callers pass them as `inputs: {...}`.

**Answer shapes / intersections** — names in Layer 3 (e.g. `UrgentSafeguardingGuidance`,
`BailiffAtDoor`). A Layer 1 `outcome.governs` entry should name the shape it points at.

**Source ids** — every Layer 2 claim cites a `source_id` that exists in the source registry.
Register or ingest it first. These become `translation_brief.cite_sources`.

Capture this as a short vocabulary note and keep it beside the domain.


## Step 2 — Layer 2: sources and curated pages (`library_write`)

Register or ingest sources so citations resolve:

```
library_write { operation: "register_source", source_id, title, ... }
```

For a metadata-only citable source. Or:

```
library_write { operation: "ingest", title, content, source_type, ... }
```

To store and index the full text.

Write the curated pages:

```
library_write {
  operation: "update_page",
  filename, title, content, page_type, domain,
  confidence, tags, summary,
  sources[], related[], allowed_use[], ...
}
```

The body must carry inline `[source: source_id]` markers, and `sources[]` must list them.

Set `allowed_use` to the highest mode the page may support:
`analysis` → `drafting` → `staff_guidance` → `public_guidance` → `decision_support`

For `public_guidance` and `decision_support`, also set `last_source_check` and (for
`decision_support`) `business_consequence_if_stale`, or `library_resolve` will not pass that
result.

Promote to `status: "active"` only once the page is sourced and reviewed.

Check it with `library_query { domain, question, intent }` — the page should return with
`use_permitted: true` and a clean provenance and freshness block.


## Step 3 — Layer 1: the ruleset (`library_update_rules`)

```
library_update_rules { domain, rules }
```

Where `rules` is an ordered list (first match wins) of deterministic rules:

```json
{
  "version": "2026-06-05.1",
  "input_schema": { "required": ["liable_occupier"] },
  "rules": [
    {
      "id": "CTR-002",
      "when": { "op": "eq", "path": "liable_occupier", "value": false },
      "outcome": { "eligibility": "ineligible", "reason_code": "not_liable" }
    },
    {
      "id": "CTR-001",
      "when": {
        "all": [
          { "op": "eq", "path": "liable_occupier", "value": true },
          { "op": "eq", "path": "low_income",      "value": true },
          { "op": "eq", "path": "in_arrears",      "value": true }
        ]
      },
      "outcome": {
        "eligibility": "eligible",
        "reason_code": "ctr_income_qualified",
        "governs": ["RebuildSupportShape"]
      }
    }
  ],
  "default_outcome": { "eligibility": "indeterminate", "reason_code": "no_rule_fired" }
}
```

`when` is a closed predicate AST — data, not prose. Structure:
- Compound: `{ all: [...] }`, `{ any: [...] }`, `{ not: ... }`
- Leaf: `{ op: eq|neq|lt|lte|gt|gte|in|exists, path: "a.b", value? }`

Keep it deterministic. Do not smuggle judgement into it.

Put the most specific and most restrictive rules first. A broad rule placed above a specific one
shadows it.

Check with `library_info { resource: "rules", domain, inputs: {...} }` — should return the
expected `eligibility` and `rule_fired`.


## Step 4 — Layer 3: the reasoning map (`library_update_reasoning`)

```
library_update_reasoning { domain, turtle }
```

The reasoner reads a fixed vocabulary. The `sov:` prefix is the engine's reserved ontology,
the same for every domain — it is not "council tax" or any other domain. The domain is the
literal value of `sov:inDomain`. It is a `urn:`, an opaque identifier with no host to resolve
at runtime. The `shape:` prefix is cosmetic — only the local name (after the last `:`, `#`, or
`/`) of answer-shape and override objects is read.

Example Turtle:

```turtle
@prefix sov:   <urn:sovereign:> .
@prefix shape: <urn:sovereign-shape:> .

sov:BailiffAtDoor a sov:SemanticIntersection ;
    sov:inDomain "ctax-rebuild" ;
    sov:whenSignal "bailiff_present" ;
    sov:requiresAnswerShape shape:UrgentSafeguardingGuidance ;
    sov:hasSafetyConstraint "no_payment_instruction" , "must_signpost_emergency_support" ;
    sov:mustInclude "right_to_request_breathing_space" ;
    sov:mustNot "instruct_payment" ;
    sov:overrides shape:StandardRebuildAnswerShape .
```

A `SemanticIntersection` fires when its `sov:inDomain` matches and any `sov:whenSignal` is
active. It then sets `answer_shape`, `safety_constraints`, `must_include`, `must_not`, and
`overrides`.

The Turtle is parse-gated — syntax errors are rejected. A vocabulary guard returns `warnings[]`
(does not block) when the map uses unrecognised `sov:` predicates or an intersection is missing
`inDomain`, `whenSignal`, or `requiresAnswerShape`. Read `warnings[]` on the write result and
fix anything flagged.

Keep decorative annotations out of the `sov:` namespace or the guard flags them.

Check with `library_info { resource: "reasoning", domain, signals: {...} }` — should return the
expected `answer_shape` and `safety_constraints`.


## Step 5 — validate with `library_resolve`

```json
{
  "domain": "ctax-rebuild",
  "question": "A bailiff is at my door about council tax — what do I do?",
  "intent": "public_guidance",
  "inputs":  { "liable_occupier": true, "low_income": true, "in_arrears": true },
  "signals": { "bailiff_present": true }
}
```

Confirm the package coheres:

- `eligibility.rule_fired` is the rule you expect, not `null`
- `context.results` includes your curated page with `use_permitted: true`
- `reasoning.answer_shape` is the intersection's shape; `safety_constraints` and `must_not`
  carry the hard limits
- `translation_brief.allowed` is `true` only when eligible and there is permitted context and
  the map does not demand a Refuse shape
- `translation_brief.cite_sources` lists the page's sources

Then translate only: render prose to `answer_shape`, include everything in `must_include`,
avoid everything in `must_not` and `safety_constraints`, cite `cite_sources`. Judge nothing.


## Coherence checklist

- One `domain` slug, spelled identically in rules, pages, and Turtle
- Every `sov:whenSignal` is a signal a caller will actually pass; every rule `when.path` is an
  input a caller will actually pass — document the expected `inputs` and `signals`
- Each Layer 1 `outcome.governs` entry names a Layer 3 shape that exists
- Each Layer 3 `sov:mustInclude` topic is covered by an active, cited Layer 2 page
- Page `allowed_use` and currency metadata clear the bar for the `intent` expected
  (e.g. `public_guidance` requires `last_source_check` set and a non-superseded snapshot)
- Intersections that should win override the standard shape via `sov:overrides`
- `library_update_reasoning` returned no vocabulary `warnings[]`, and `library_lint` is clean


## Pitfalls

**Vocabulary drift** — `bailiff_present` in the Turtle but `bailiffPresent` from the caller
never fires. One spelling, snake_case, everywhere.

**Wrong RDF predicates or namespace** — only the `urn:sovereign:` predicates above are read. A
custom predicate or the wrong namespace produces no reasoning. The vocabulary guard warns but
does not block — read `warnings[]`.

**Rule order** — first match wins; a broad rule above a specific one shadows it.

**Confidence is not currency** — a high-confidence page can cite a superseded snapshot; resolve
down-ranks or refuses it for higher intents. Set `last_source_check` and provenance
deliberately.

**Operational intent** — `formal_decision`, `live_account_action`, `payment_action`, and
`enforcement_action` are refused outright and content is withheld. The library never authorises
an operational act; that belongs to a deterministic operational system.

**Eligibility is Layer 1's job, not the page's** — do not write eligibility prose into a page
and expect resolve to honour it. Put it in the ruleset.
