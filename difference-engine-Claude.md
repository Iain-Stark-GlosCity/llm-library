# The Difference Engine — CLAUDE.md (Build Schema)

You are rebuilding the AI Library MCP as **The Difference Engine** — a new iteration in
a new repo. This is an Azure Functions v4 Node.js project (Node 20 LTS, TypeScript).

**Code source.** The existing `llm-library` repo
(`github.com/iain-stark-gloscity/llm-library`) is the code source. Most files are
copied and adapted (renamed), not rewritten. This document specifies what to copy, what
to adapt, and what to create new. The source repo has a working three-layer architecture
with a reference domain (`ctax-rebuild`) that must migrate cleanly.

**What changed.** Layer 3 (the RDF reasoning map) is enriched into a **unified knowledge
graph** that models both semantic intersections AND executable process flows. The graph
IS the process — queryable via SPARQL, traversable as a workflow. All tool names change
from `library_*` to `engine_*`. All env vars change from `LIBRARY_*` to `ENGINE_*`. The
infrastructure (Azure Functions, Azure Blob, Qdrant, OpenAI embeddings, MCP JSON-RPC
2.0) is unchanged.

-----

## What this system is

Like Babbage's Difference Engine, it computes the difference between where you are and
where you need to be — deterministically.

This is not a RAG system. It is not a deterministic MCP tool. It is a third thing:

**RAG retrieves evidence. MCP returns tools. The Difference Engine maintains governed
knowledge and process.**

|        |RAG                                     |Deterministic MCP                                       |The Difference Engine                     |
|--------|----------------------------------------|--------------------------------------------------------|------------------------------------------|
|Unit    |Document chunk                          |Function call                                           |Curated knowledge page + process stage    |
|Question|What text is relevant?                  |What function returns the answer?                       |What is known, where are we, what is next?|
|Weakness|Raw, contradictory, no canonical version|Fixed — cannot handle evolving or interpretive knowledge|Requires deliberate curation              |

What this gives an AI agent that neither RAG nor MCP provides:

- what we know
- where it came from
- how confident we are
- when it changed
- what it relates to
- what may be stale or broken
- **where we are in a process**
- **what comes next and what came before**
- **what the process connects to**

**In one sentence:** The Difference Engine turns scattered source material and implicit
process knowledge into a versioned, source-linked, graph-navigable, machine-queryable
body of governed knowledge that AI agents can use as an extension of their working memory
and process awareness.

-----

## Core architectural principle

The Engine validates, stores, retrieves, versions, indexes, traverses, and reports
mechanical inconsistencies. It does not reason.

The librarian agent decides what wiki pages to create, what to update, what
contradictions exist, what confidence level applies, and how to model process flows. It
then calls engine_write / engine_update_reasoning. The Engine executes those instructions
deterministically.

If an operation requires interpretation, it belongs in the librarian agent, not here.

-----

## Architecture: three layers, one graph

|Layer|Name|Job|Determinism|Storage|
|-----|---|-----------|-------|-------|
|**1 — Constitution**|Rules|Eligibility, thresholds, valid states → governed outcome + which rule fired|Fully deterministic; no LLM/vectors|`engine-rules` container, `{domain}.rules.json`|
|**2 — Library**|Knowledge|Sourced context with confidence, currency, permitted-use governance|Vector retrieval|`engine-raw` / `engine-wiki` / `engine-schemas`|
|**3 — Knowledge Graph**|Graph|Semantic intersections + process flows + connections. What the question means, what shape of answer is permissible, where you are in a process, what happens next.|SPARQL / triple traversal over curated Turtle|`engine-rdf` container, `{domain}.ttl`|
|**LLM**|Translation|Translate the governed answer into language|Renders; decides nothing|—|

The key design change from `llm-library`: **Layer 3 is no longer just a reasoning map.
It is a unified knowledge graph.** The `.ttl` files contain both `sov:SemanticIntersection`
nodes (what answer shape to use) AND `sov:ProcessStage` / `sov:ProcessTransition` nodes
(where you are in a process and what comes next). One graph per domain, one ontology
vocabulary, one admin tool (`engine_update_reasoning`).

Process stages can activate signals that trigger semantic intersections. For example,
arriving at the `BailiffEnforcement` stage activates the `bailiff_present` signal, which
fires `sov:BailiffAtDoor` and produces `UrgentSafeguardingGuidance`. The graph IS the
process.

-----

## What you are building

Core consumption tools (read-only):

- **engine_ping** — liveness check + contract hash
- **engine_info** — consolidated read-only inspection (resource discriminator: instructions,
  schema, pages, page, rules, reasoning, process, domains, governance, tool_versions)
- **engine_query** — hybrid dense+sparse retrieval with governance
- **engine_resolve** — orchestrate L1→L3-process→L2→L3-reasoning into one governed package
- **engine_lint** — structural + governance + graph health checks

Admin tools (per-layer write paths):

- **engine_write** — Layer 2 writes (ingest, register_source, update_page, patch_metadata,
  update_schema, deprecate_page, set_provenance, etc.)
- **engine_update_rules** — Layer 1 writes (deterministic rulesets)
- **engine_update_reasoning** — Layer 3 writes (Turtle maps containing both semantic
  intersections AND process flows)

-----

## The knowledge graph ontology (`sov:`)

The `sov:` namespace (`urn:sovereign:`) is the engine's **reserved ontology**, reused
verbatim by every domain. The domain is the literal value of `sov:inDomain`, never in
the namespace. These are URNs — opaque identifiers, never dereferenced. Subject IRIs
and answer-shape objects are read by local name only.

### Existing predicates (semantic intersections — unchanged from llm-library)

Classes:
- `sov:SemanticIntersection` — a semantic intersection node

Predicates:
- `sov:inDomain` — domain slug (string literal)
- `sov:whenSignal` — signal name (string literal, must match caller signal key)
- `sov:requiresAnswerShape` — answer shape IRI (read by local name)
- `sov:hasSafetyConstraint` — safety constraint (free string literal)
- `sov:mustInclude` — required content marker (free string literal)
- `sov:mustNot` — prohibited content marker (free string literal)
- `sov:overrides` — overridden shape IRI (read by local name)
- `sov:suppressResultPattern` — substring to suppress from results (case-insensitive)
- `sov:allowSuppressedWhenQuestionPattern` — re-admit suppressed when question matches

### New predicates (process flows — The Difference Engine addition)

Classes:
- `sov:ProcessStage` — a stage in a directed process graph
- `sov:ProcessTransition` — a directed edge between stages

Stage predicates:
- `sov:inDomain` — (shared) domain slug
- `sov:stageType` — `"stage"` | `"decision"` | `"gateway"` | `"terminal"`
  - `stage`: a processing step
  - `decision`: has multiple conditional outgoing edges
  - `gateway`: parallel split (multiple unconditional outgoing) or join (multiple incoming)
  - `terminal`: process endpoint — no outgoing transitions expected
- `sov:stageLabel` — human-readable name (string literal)
- `sov:isEntryPoint` — `"true"` if this is a valid starting point for the process
- `sov:isExitPoint` — `"true"` if this is a terminal point
- `sov:evaluatesRule` — L1 rule ID relevant at this stage (string literal, advisory)
- `sov:relevantPage` — L2 page filename relevant at this stage (string literal, advisory)
- `sov:activatesSignal` — signal key activated when process reaches this stage (string
  literal). This is the critical cross-layer bridge: a stage that activates
  `bailiff_present` will trigger any `sov:SemanticIntersection` with
  `sov:whenSignal "bailiff_present"` in the same domain.
- `sov:requiresInput` — L1 input path that must be present to enter this stage (string
  literal, advisory)
- `sov:stageMetadata` — JSON string literal for domain-specific metadata
  (e.g. `'{"statutory_reference":"LGFA 1992 s6","sla_days":14}'`)

Transition predicates:
- `sov:inDomain` — (shared) domain slug
- `sov:fromStage` — source stage IRI
- `sov:toStage` — target stage IRI
- `sov:transitionLabel` — human-readable edge label (string literal)
- `sov:edgeCondition` — JSON string literal using L1's closed predicate AST. The
  traverser parses this and evaluates it with the same `evalCondition` function from
  `src/rules/resolve.ts`. `null` or absent = unconditional (always available). Example:
  `'{"op":"eq","path":"in_arrears","value":true}'`
- `sov:edgePriority` — integer string literal, lower = higher priority (default `"0"`).
  When multiple edges from the same node match, first match wins (same as L1 rules).
- `sov:transitionType` — `"auto"` | `"manual"` (default `"auto"`). Auto transitions
  happen when conditions are met. Manual transitions require explicit action.

### Complete predicate registry

The vocabulary guard (`checkVocabulary`) recognises all of the above. Predicates in
the `sov:` namespace not in this list produce warnings (not blocking). This is the
single source of truth for what the engine reads.

```typescript
const KNOWN_PREDICATES: ReadonlySet<string> = new Set([
  // Semantic intersections (existing)
  P.inDomain, P.whenSignal, P.requiresAnswerShape, P.hasSafetyConstraint,
  P.mustInclude, P.mustNot, P.overrides, P.suppressResultPattern,
  P.allowSuppressedWhenQuestionPattern,
  // Process stages (new)
  P.stageType, P.stageLabel, P.isEntryPoint, P.isExitPoint,
  P.evaluatesRule, P.relevantPage, P.activatesSignal, P.requiresInput,
  P.stageMetadata,
  // Process transitions (new)
  P.fromStage, P.toStage, P.transitionLabel, P.edgeCondition,
  P.edgePriority, P.transitionType
])
```

-----

## Example: ctax-rebuild knowledge graph

This extends the existing `ctax-rebuild.ttl` with process stages. The existing semantic
intersection (`sov:BailiffAtDoor`) is unchanged — the process stages are added alongside
it in the same file.

```turtle
@prefix sov:   <urn:sovereign:> .
@prefix shape: <urn:sovereign-shape:> .

# ─── Semantic intersection (existing, unchanged) ───

sov:BailiffAtDoor a sov:SemanticIntersection ;
    sov:inDomain "ctax-rebuild" ;
    sov:whenSignal "bailiff_present" ;
    sov:requiresAnswerShape shape:UrgentSafeguardingGuidance ;
    sov:hasSafetyConstraint "no_payment_instruction" ,
                            "no_legal_advice_as_fact" ,
                            "must_signpost_emergency_support" ;
    sov:mustInclude "right_to_request_breathing_space" ,
                    "entry_rights_summary" ;
    sov:suppressResultPattern "ctr" ,
                              "council tax reduction" ,
                              "discount" ,
                              "premium" ;
    sov:allowSuppressedWhenQuestionPattern "can i get council tax reduction" ,
                                           "benefit" ,
                                           "ctr" ,
                                           "reduction" ;
    sov:overrides shape:StandardRebuildAnswerShape .

# ─── Process stages (new) ───

sov:LiabilityCheck a sov:ProcessStage ;
    sov:inDomain "ctax-rebuild" ;
    sov:stageType "stage" ;
    sov:stageLabel "Liability Check" ;
    sov:isEntryPoint "true" ;
    sov:evaluatesRule "CTAX-LIABILITY-001" ;
    sov:relevantPage "ctax-rebuild-liability.md" ;
    sov:stageMetadata '{"statutory_reference":"LGFA 1992 s6"}' .

sov:Assessment a sov:ProcessStage ;
    sov:inDomain "ctax-rebuild" ;
    sov:stageType "stage" ;
    sov:stageLabel "Assessment & Discount" ;
    sov:evaluatesRule "CTAX-SPD-001" ;
    sov:evaluatesRule "CTAX-DISREGARD-SMI-001" ;
    sov:relevantPage "ctax-rebuild-spd.md" ;
    sov:relevantPage "ctax-rebuild-exemptions.md" .

sov:Billing a sov:ProcessStage ;
    sov:inDomain "ctax-rebuild" ;
    sov:stageType "stage" ;
    sov:stageLabel "Bill Issue" .

sov:ArrearsCheck a sov:ProcessStage ;
    sov:inDomain "ctax-rebuild" ;
    sov:stageType "decision" ;
    sov:stageLabel "Arrears Decision" ;
    sov:requiresInput "in_arrears" .

sov:Reminder a sov:ProcessStage ;
    sov:inDomain "ctax-rebuild" ;
    sov:stageType "stage" ;
    sov:stageLabel "Reminder Notice" ;
    sov:stageMetadata '{"statutory_reference":"CT(A&E) Regs 1992 reg 23","sla_days":14}' .

sov:Summons a sov:ProcessStage ;
    sov:inDomain "ctax-rebuild" ;
    sov:stageType "stage" ;
    sov:stageLabel "Summons" ;
    sov:stageMetadata '{"statutory_reference":"CT(A&E) Regs 1992 reg 34"}' .

sov:LiabilityOrder a sov:ProcessStage ;
    sov:inDomain "ctax-rebuild" ;
    sov:stageType "stage" ;
    sov:stageLabel "Liability Order" .

sov:EnforcementDecision a sov:ProcessStage ;
    sov:inDomain "ctax-rebuild" ;
    sov:stageType "decision" ;
    sov:stageLabel "Enforcement Route" .

sov:BailiffEnforcement a sov:ProcessStage ;
    sov:inDomain "ctax-rebuild" ;
    sov:stageType "stage" ;
    sov:stageLabel "Bailiff Enforcement" ;
    sov:activatesSignal "bailiff_present" ;
    sov:relevantPage "ctax-rebuild-bailiff-rights.md" ;
    sov:stageMetadata '{"statutory_reference":"TCE Act 2007"}' .

sov:AttachmentOfEarnings a sov:ProcessStage ;
    sov:inDomain "ctax-rebuild" ;
    sov:stageType "stage" ;
    sov:stageLabel "Attachment of Earnings" .

sov:Resolved a sov:ProcessStage ;
    sov:inDomain "ctax-rebuild" ;
    sov:stageType "terminal" ;
    sov:stageLabel "Resolved" ;
    sov:isExitPoint "true" .

sov:EnforcementComplete a sov:ProcessStage ;
    sov:inDomain "ctax-rebuild" ;
    sov:stageType "terminal" ;
    sov:stageLabel "Enforcement Complete" ;
    sov:isExitPoint "true" .

# ─── Process transitions (new) ───

sov:E_LiabilityToAssessment a sov:ProcessTransition ;
    sov:inDomain "ctax-rebuild" ;
    sov:fromStage sov:LiabilityCheck ;
    sov:toStage sov:Assessment ;
    sov:transitionLabel "Liable party identified" .

sov:E_AssessmentToBilling a sov:ProcessTransition ;
    sov:inDomain "ctax-rebuild" ;
    sov:fromStage sov:Assessment ;
    sov:toStage sov:Billing ;
    sov:transitionLabel "Assessment complete" .

sov:E_BillingToArrears a sov:ProcessTransition ;
    sov:inDomain "ctax-rebuild" ;
    sov:fromStage sov:Billing ;
    sov:toStage sov:ArrearsCheck ;
    sov:transitionLabel "Payment window elapsed" .

sov:E_ArrearsToResolved a sov:ProcessTransition ;
    sov:inDomain "ctax-rebuild" ;
    sov:fromStage sov:ArrearsCheck ;
    sov:toStage sov:Resolved ;
    sov:transitionLabel "Not in arrears" ;
    sov:edgeCondition '{"op":"eq","path":"in_arrears","value":false}' .

sov:E_ArrearsToReminder a sov:ProcessTransition ;
    sov:inDomain "ctax-rebuild" ;
    sov:fromStage sov:ArrearsCheck ;
    sov:toStage sov:Reminder ;
    sov:transitionLabel "In arrears" ;
    sov:edgeCondition '{"op":"eq","path":"in_arrears","value":true}' .

sov:E_ReminderToSummons a sov:ProcessTransition ;
    sov:inDomain "ctax-rebuild" ;
    sov:fromStage sov:Reminder ;
    sov:toStage sov:Summons ;
    sov:transitionLabel "Reminder period expired, no payment" .

sov:E_SummonsToOrder a sov:ProcessTransition ;
    sov:inDomain "ctax-rebuild" ;
    sov:fromStage sov:Summons ;
    sov:toStage sov:LiabilityOrder ;
    sov:transitionLabel "Order granted" .

sov:E_SummonsToResolved a sov:ProcessTransition ;
    sov:inDomain "ctax-rebuild" ;
    sov:fromStage sov:Summons ;
    sov:toStage sov:Resolved ;
    sov:transitionLabel "Paid before hearing" .

sov:E_OrderToEnforcement a sov:ProcessTransition ;
    sov:inDomain "ctax-rebuild" ;
    sov:fromStage sov:LiabilityOrder ;
    sov:toStage sov:EnforcementDecision ;
    sov:transitionLabel "Order in effect" .

sov:E_ToBailiff a sov:ProcessTransition ;
    sov:inDomain "ctax-rebuild" ;
    sov:fromStage sov:EnforcementDecision ;
    sov:toStage sov:BailiffEnforcement ;
    sov:transitionLabel "Bailiff route chosen" ;
    sov:edgePriority "0" .

sov:E_ToAttachment a sov:ProcessTransition ;
    sov:inDomain "ctax-rebuild" ;
    sov:fromStage sov:EnforcementDecision ;
    sov:toStage sov:AttachmentOfEarnings ;
    sov:transitionLabel "Attachment route chosen" ;
    sov:edgePriority "1" .

sov:E_BailiffToComplete a sov:ProcessTransition ;
    sov:inDomain "ctax-rebuild" ;
    sov:fromStage sov:BailiffEnforcement ;
    sov:toStage sov:EnforcementComplete ;
    sov:transitionLabel "Enforcement concluded" .

sov:E_BailiffToResolved a sov:ProcessTransition ;
    sov:inDomain "ctax-rebuild" ;
    sov:fromStage sov:BailiffEnforcement ;
    sov:toStage sov:Resolved ;
    sov:transitionLabel "Paid / arrangement made" .

sov:E_AttachmentToComplete a sov:ProcessTransition ;
    sov:inDomain "ctax-rebuild" ;
    sov:fromStage sov:AttachmentOfEarnings ;
    sov:toStage sov:EnforcementComplete ;
    sov:transitionLabel "Deductions complete" .
```

This demonstrates the critical L3-internal integration: the `BailiffEnforcement` stage
has `sov:activatesSignal "bailiff_present"`. When the traverser arrives at this stage,
it activates that signal. The `BailiffAtDoor` semantic intersection has
`sov:whenSignal "bailiff_present"`. The orchestrator merges the process-activated
signal into the L3 reasoning input, and the intersection fires — producing
`UrgentSafeguardingGuidance` with its safety constraints. The process graph and the
semantic reasoning map are one unified graph.

-----

## Process traversal

### The pure traversal function

File: `src/rdf/traverse.ts`

Like `src/rules/resolve.ts`, this is a **pure module** — no I/O, no LLM, no vectors,
no network, no randomness. It operates on a materialised graph structure extracted from
the RDF triples (not on the RDF engine directly). The engine-specific extraction happens
in `src/rdf/reason.ts`; the traverser works on plain TypeScript objects.

```typescript
import { evalCondition, Condition } from '../rules/resolve'

interface GraphStage {
  id: string              // local name of the stage IRI
  label: string
  type: 'stage' | 'decision' | 'gateway' | 'terminal'
  is_entry: boolean
  is_exit: boolean
  evaluates_rules: string[]
  relevant_pages: string[]
  activates_signals: string[]
  requires_inputs: string[]
  metadata: Record<string, unknown>
}

interface GraphTransition {
  id: string              // local name of the transition IRI
  from: string            // local name of source stage
  to: string              // local name of target stage
  label: string
  condition: Condition | null
  priority: number
  type: 'auto' | 'manual'
}

interface ProcessGraph {
  domain: string
  stages: GraphStage[]
  transitions: GraphTransition[]
  entry_points: string[]
  exit_points: string[]
}

interface ProcessPosition {
  current_nodes: string[]
  completed_nodes: string[]
  available_transitions: Array<{
    transition_id: string
    from: string
    to: string
    label: string
    condition_met: boolean
    type: 'auto' | 'manual'
  }>
  path_taken: string[]
  progress: number         // 0.0 = entry, 1.0 = exit
  remaining_to_exit: string[]
  is_terminal: boolean
  active_rule_refs: string[]
  active_page_refs: string[]
  active_signals: string[]
}
```

**`traverseProcess(graph, current, completed, inputs)`** → `ProcessPosition`

1. Validate that `current` node IDs exist in the graph.
2. Find all outgoing transitions from each current node.
3. For each transition, parse `edgeCondition` JSON and evaluate with `evalCondition`
   against `inputs`. Unconditional edges always match.
4. Sort matched edges by priority (lower = first). First match wins per source node.
5. Aggregate cross-layer references from current node(s): `evaluates_rules`,
   `relevant_pages`, `activates_signals`.
6. Compute `progress`: `completed.length / (completed.length + remaining_to_exit.length)`.
7. Compute `remaining_to_exit` via BFS from current nodes to nearest exit point.
8. Return deterministic `ProcessPosition`.

**`extractProcessGraph(engine, graph, domain)`** → `ProcessGraph | null`

Extracts all `sov:ProcessStage` and `sov:ProcessTransition` triples for the given domain
from the loaded RDF graph. Uses triple traversal (not SPARQL) so it works under both
engines. Returns `null` if no process stages exist for the domain.

**`validateProcessGraph(graph)`** → `string[]`

Returns warning strings (like `checkVocabulary`):
- Unreachable stages (not reachable from any entry point)
- Dead ends (non-terminal stages with no outgoing transitions)
- Missing targets (transition references nonexistent stage)
- No entry/exit points declared
- Duplicate stage/transition IDs
- Unparseable `edgeCondition` JSON

-----

## Orchestration — `engine_resolve`

The pipeline becomes: **L1 → L3-process → L2 → L3-reasoning**

Input:
```typescript
{
  domain: string
  question: string
  intent?: string           // use mode (analysis|drafting|staff_guidance|public_guidance|decision_support)
  inputs?: object           // structured facts for L1 AND process edge conditions
  signals?: object          // active signals for L3 (augmented by process activatesSignal)
  process_position?: {      // where we are in the process
    current: string[]       // current stage local names
    completed: string[]     // completed stage local names
  }
  top_k?: number
  library_id?: string
}
```

Pipeline:

1. **L1 (Constitution)** — resolve eligibility deterministically before anything else.
   Unchanged from `llm-library`.

2. **L3-process (Knowledge Graph — process traversal)** — if `process_position` is
   provided AND the domain's Turtle contains `sov:ProcessStage` nodes:
   - Extract the process graph from the loaded RDF
   - Call `traverseProcess(graph, position.current, position.completed, inputs)`
   - Merge the current node's `activates_signals` into the signals map (these will
     feed L3 reasoning)
   - Use `relevant_pages` to influence L2 retrieval (boost or domain filter)

3. **L2 (Library)** — retrieve sourced context via `engine_query`. Unchanged, but if
   L3-process provided `relevant_pages`, use them to narrow or boost the query.

4. **L3-reasoning (Knowledge Graph — semantic intersections)** — traverse for the
   governing `answer_shape`, `safety_constraints`, `must_include`, `must_not`, and
   `overrides`. Unchanged, but signals now include process-activated signals.

5. **Compose** the governed answer package. The `translation_brief` gains a
   `process_context` block:

```typescript
translation_brief: {
  // ...existing fields (allowed, answer_scope, answer_shape, safety_constraints,
  //    must_include, must_not, cite_sources, usable_context_only, note)...
  process_context?: {
    current_stage: string | null
    current_stage_label: string | null
    progress: number
    is_terminal: boolean
    available_next_steps: Array<{ label: string; condition_met: boolean }>
    remaining_stages: number
    note: string  // e.g. "The person is at the Bailiff Enforcement stage (9 of 13)."
  }
}
```

**Absent process graph does not block.** If no `process_position` is provided, or the
domain has no `sov:ProcessStage` nodes, `process_context` is `null` and the rest of the
pipeline runs unchanged. This follows the existing pattern: absent L1 = indeterminate,
absent L3 = empty shape.

-----

## Layer 1 — Constitution (unchanged from llm-library)

Copy `src/rules/resolve.ts` verbatim. **Export `evalCondition`** (it is already exported
in the source). This function is reused by the process traverser for edge conditions.

Storage: `engine-rules` container, `{domain}.rules.json`. Format unchanged.

Resolver: `resolveEligibility(ruleset, inputs)` — pure, deterministic, first-match-wins,
fail-closed. Same as `llm-library`.

-----

## Layer 2 — Library (unchanged from llm-library)

Copy all storage, embedding, and tool files. Rename `library_` → `engine_` in tool
names only. Container names change from `library-*` to `engine-*`.

Storage, embedding, chunking, Qdrant, manifest, index, log — all unchanged.

The governance layer (use modes, freshness, provenance, permitted-use) is unchanged.

-----

## Layer 3 — Knowledge Graph (extended from llm-library)

The existing `src/rdf/` directory gains one new file: `traverse.ts`. The existing files
(`engine.ts`, `engine.oxigraph.ts`, `engine.n3.ts`, `graph.ts`, `reason.ts`) are
adapted:

- `reason.ts` — extend `KNOWN_PREDICATES` with all process predicates. Extend
  `checkVocabulary` to validate process stages (missing `inDomain`, no transitions
  from non-terminal stages, unparseable `edgeCondition` JSON, etc.). The
  `answerShapeFor` function is unchanged.
- `engine.ts`, `engine.oxigraph.ts`, `engine.n3.ts`, `graph.ts` — copy verbatim.
  No changes needed.

-----

## MCP transport contract

Identical to `llm-library`. JSON-RPC 2.0 over single HTTP POST, `application/json`
response. Stateless, no session. Four surfaces (NOT five — process is part of L3,
not a separate surface):

| Route | serverInfo.name | Surface | Tools |
|---|---|---|---|
| `POST /api/mcp` | `engine-consumption` | consumption | `engine_ping`, `engine_info`, `engine_query`, `engine_resolve`, `engine_lint` |
| `POST /api/mcp-library` | `engine-library-admin` | library-admin | `engine_ping`, `engine_info`, `engine_write` |
| `POST /api/mcp-rules` | `engine-rules-admin` | rules-admin | `engine_ping`, `engine_info`, `engine_update_rules` |
| `POST /api/mcp-rdf` | `engine-rdf-admin` | rdf-admin | `engine_ping`, `engine_info`, `engine_update_reasoning` |

The `engine_update_reasoning` tool writes Turtle maps containing both semantic
intersections and process flows. The vocabulary guard validates both.

All JSON-RPC methods, error codes, envelope formats, content wrapping — unchanged from
`llm-library`. See the source repo's CLAUDE.md for the full transport contract.

-----

## `engine_info` resource: `process`

New resource entry in the `RESOURCES` map:

```typescript
process: getProcessTool.handler
```

Input: `{ resource: "process", domain: string, process_position?: { current: string[], completed: string[] }, inputs?: object }`

Two modes:
- **Without `process_position`**: returns the extracted `ProcessGraph` (inspection — stages,
  transitions, entry/exit points). Returns `{ process_found: false }` if no stages exist.
- **With `process_position`**: traverses and returns the `ProcessPosition` (current stage,
  available transitions, progress, cross-layer references).

Handler file: `src/tools/get-process.ts`

-----

## New lint checks (process graph)

Added to `engine_lint` alongside existing checks:

- `process_orphan_stage` (warning) — stage not reachable from any entry point via BFS
- `process_dead_end` (warning) — non-terminal stage with no outgoing transitions
- `process_missing_target` (error) — transition's `fromStage` or `toStage` references
  nonexistent stage
- `process_rule_ref_missing` (warning) — `evaluatesRule` references a rule ID not in
  the domain's `{domain}.rules.json`
- `process_page_ref_missing` (warning) — `relevantPage` references a filename not in
  manifest.json
- `process_no_entry` (error) — domain has process stages but none marked `isEntryPoint`
- `process_no_exit` (error) — domain has process stages but no terminal/exit point
- `stale_process_intersection` (info) — a stage's `activatesSignal` doesn't match
  any `sov:whenSignal` in the domain's semantic intersections
- `process_unparseable_condition` (error) — `edgeCondition` is not valid JSON or not
  a valid L1 predicate AST

-----

## Environment variables

```
ENGINE_STORAGE_CONNECTION_STRING
ENGINE_RAW_CONTAINER               default: engine-raw
ENGINE_WIKI_CONTAINER              default: engine-wiki
ENGINE_SCHEMA_CONTAINER            default: engine-schemas
ENGINE_RULES_CONTAINER             default: engine-rules
ENGINE_RDF_CONTAINER               default: engine-rdf
ENGINE_RDF_ENGINE                  default: oxigraph (real SPARQL) | n3 (fallback)
QDRANT_URL                         — cluster endpoint URL
QDRANT_API_KEY                     — cluster API key
QDRANT_COLLECTION                  default: engine
OPENAI_API_KEY
EMBEDDING_MODEL                    default: text-embedding-3-small
```

-----

## File structure

```
difference-engine/
  src/
    functions/
      mcp.ts                    — adapted from llm-library (rename surfaces)
    rules/
      resolve.ts                — copied from llm-library (evalCondition exported)
    rdf/
      engine.ts                 — copied from llm-library
      engine.oxigraph.ts        — copied from llm-library
      engine.n3.ts              — copied from llm-library
      graph.ts                  — copied from llm-library
      reason.ts                 — adapted (extend KNOWN_PREDICATES + checkVocabulary)
      traverse.ts               — NEW: pure process traversal function
    tools/
      registry.ts               — adapted (rename tools, same 4 surfaces)
      ping.ts                   — adapted (rename)
      info.ts                   — adapted (add 'process' resource)
      query.ts                  — adapted (rename)
      resolve.ts                — adapted (add L3-process step + process_context)
      write.ts                  — adapted (rename)
      lint.ts                   — adapted (add process graph checks)
      get-process.ts            — NEW: read/traverse process graph
      instructions.ts           — adapted (update doctrine for process graph)
      coverage.ts               — adapted (add has_process to domain inventory)
      [all other existing tools] — adapted (rename prefix)
    storage/
      blobs.ts                  — copied (rename container defaults)
      rules.ts                  — copied
      manifest.ts               — copied
      raw-manifest.ts           — copied
      qdrant.ts                 — copied
      index.ts                  — copied
      log.ts                    — copied
      schema.ts                 — copied
    embed/
      openai.ts                 — copied
      chunk.ts                  — copied
      sparse.ts                 — copied
      ids.ts                    — copied
    config.ts                   — adapted (rename env prefix)
    http.ts                     — copied
    types.ts                    — copied
    runtime-diagnostics.ts      — copied
  fixtures/
    ctax-rebuild/
      ctax-rebuild.rules.json   — copied from llm-library
      ctax-rebuild.ttl           — extended with process stages/transitions
      ctax-rebuild-bailiff-rights.md — copied from llm-library
  scripts/
    verify-sovereign.js         — adapted (add process traversal assertions)
    migrate-from-library.ts     — NEW: migration script
  test/
    process-traverse.test.ts    — NEW: pure-function tests
    rules-resolve.test.ts       — copied from llm-library
    mcp-dispatch.test.ts        — adapted (rename)
    [other tests]               — adapted
  docs/
    sovereign-architecture.md   — adapted (add process graph section)
  host.json
  package.json                  — adapted (rename)
  tsconfig.json                 — copied
  .funcignore                   — copied
  CLAUDE.md                     — THIS DOCUMENT
```

-----

## Source mapping — what to copy, adapt, or create

### Copy verbatim
These files need only the `library_` → `engine_` tool name rename where it appears
in string literals. No structural changes.

- `src/rules/resolve.ts`
- `src/rdf/engine.ts`, `engine.oxigraph.ts`, `engine.n3.ts`, `graph.ts`
- `src/embed/openai.ts`, `chunk.ts`, `sparse.ts`, `ids.ts`
- `src/storage/blobs.ts`, `manifest.ts`, `raw-manifest.ts`, `qdrant.ts`, `index.ts`,
  `log.ts`, `schema.ts`, `rules.ts`
- `src/http.ts`, `src/types.ts`, `src/runtime-diagnostics.ts`
- `src/tools/governance.ts`, `freshness.ts`, `shared.ts`, `version.ts`,
  `tool-versions.ts`, `governance-inventory.ts`
- `src/tools/ingest.ts`, `register-source.ts`, `update.ts`, `get-page.ts`,
  `get-schema.ts`, `list-pages.ts`, `deprecate-page.ts`, `delete-blob.ts`,
  `patch-metadata.ts`, `set-provenance.ts`, `mark-source-checked.ts`,
  `migrate-governance.ts`, `reconcile-vectors.ts`, `update-schema.ts`
- `fixtures/ctax-rebuild/ctax-rebuild.rules.json`
- `fixtures/ctax-rebuild/ctax-rebuild-bailiff-rights.md`

### Adapt (extend + rename)
- `src/config.ts` — rename `LIBRARY_*` → `ENGINE_*`, container defaults `library-*`
  → `engine-*`
- `src/functions/mcp.ts` — rename server names (`library-consumption` → `engine-consumption`,
  etc.), same 4 surfaces, same transport
- `src/tools/registry.ts` — rename all tool imports and surface definitions
- `src/tools/resolve.ts` — insert L3-process step between L1 and L2, add
  `process_context` to `translation_brief`, merge `activatesSignal` into L3 signals
- `src/rdf/reason.ts` — extend `KNOWN_PREDICATES` set with all process predicates,
  extend `checkVocabulary` to validate process stages and transitions (missing
  required predicates, unparseable conditions, dangling stage references)
- `src/tools/info.ts` — add `process` to `RESOURCES` map
- `src/tools/lint.ts` — add all process graph lint checks
- `src/tools/instructions.ts` — update doctrine text to describe the knowledge graph
  and process traversal
- `src/tools/coverage.ts` — add `has_process: boolean` to domain inventory
- `src/tools/update-reasoning.ts` — extend vocabulary guard call to cover process
  predicates (already handled by the adapted `checkVocabulary`)
- `scripts/verify-sovereign.js` — add process traversal assertions
- `fixtures/ctax-rebuild/ctax-rebuild.ttl` — extend with process stages/transitions
  (see the example above)

### Create new
- `src/rdf/traverse.ts` — the pure process traversal function. The key new file.
  Imports `evalCondition` from `src/rules/resolve.ts`.
- `src/tools/get-process.ts` — handler for `engine_info resource: process`
- `test/process-traverse.test.ts` — pure-function tests against ctax-rebuild fixture
- `scripts/migrate-from-library.ts` — migration script

-----

## Build order

**Phase 0 — scaffold and transport.**
1. Scaffold: `package.json`, `tsconfig.json`, `host.json`, `.funcignore`, `.gitignore`,
   `local.settings.json.example`, `CLAUDE.md`
2. Copy + rename `src/types.ts`, `src/http.ts`, `src/config.ts`, `src/runtime-diagnostics.ts`
3. Copy + rename `src/functions/mcp.ts`, `src/tools/registry.ts`, `src/tools/ping.ts`
4. Prove the wire: `initialize`, `tools/list`, `ping` on all 4 surfaces

**Phase 1 — storage and embedding.**
5. Copy all `src/storage/*` and `src/embed/*` files (rename container defaults)
6. Run three round-trip tests: blob, Qdrant, embedding (same tests as llm-library)

**Phase 2 — L1 (rules).**
7. Copy `src/rules/resolve.ts`. Confirm `evalCondition` is exported.
8. Copy L1 tool files (`get-rules.ts`, `update-rules.ts`)

**Phase 3 — L3 core (RDF).**
9. Copy `src/rdf/engine.ts`, `engine.oxigraph.ts`, `engine.n3.ts`, `graph.ts`
10. Copy + adapt `src/rdf/reason.ts` (extend predicates + vocabulary guard)
11. Copy L3 tool files (`get-reasoning.ts`, `update-reasoning.ts`)

**Phase 4 — L3 process traversal (the key new work).**
12. Create `src/rdf/traverse.ts` — pure traversal function
13. Create `src/tools/get-process.ts` — process read/traverse handler
14. Create `fixtures/ctax-rebuild/ctax-rebuild.ttl` (extended with process stages)
15. Create `test/process-traverse.test.ts`
16. Run tests. All process traversal must pass before wiring into orchestrator.

**Phase 5 — tools and orchestration.**
17. Copy + rename all remaining tool files
18. Wire `process` into `engine_info`'s RESOURCES map
19. Adapt `src/tools/resolve.ts` — add L3-process step, add `process_context`
20. Adapt `src/tools/lint.ts` — add process graph checks
21. Adapt `src/tools/coverage.ts` — add `has_process`
22. Adapt `src/tools/instructions.ts` — update doctrine

**Phase 6 — verification.**
23. Adapt `scripts/verify-sovereign.js` — add process traversal assertions
24. Full lifecycle test (see **Proof of life** below)

**Phase 7 — migration.**
25. Create `scripts/migrate-from-library.ts`
26. Test migration against existing llm-library content

-----

## Migration plan: llm-library → The Difference Engine

### Phase 1 — infrastructure
1. Create new Azure Storage containers: `engine-raw`, `engine-wiki`, `engine-schemas`,
   `engine-rules`, `engine-rdf`
2. Verify or create Qdrant collection (same cluster, new collection name `engine`)
3. Deploy new Azure Functions app

### Phase 2 — content migration (deterministic copy)
1. **Rules (L1)**: Copy all `{domain}.rules.json` from `library-rules` → `engine-rules`
   verbatim. No format changes.
2. **Wiki pages (L2)**: Copy all blobs from `library-wiki` → `engine-wiki` verbatim:
   `pages/*`, `history/*`, `manifest.json`, `index.md`, `log.md`, `log.jsonl`
3. **Raw sources (L2)**: Copy all blobs from `library-raw` → `engine-raw` verbatim:
   `{source_id}` files, `raw_manifest.json`
4. **Schemas (L2)**: Copy from `library-schemas` → `engine-schemas` verbatim.
5. **RDF (L3)**: Copy existing `.ttl` files from `library-rdf` → `engine-rdf`. The
   existing semantic intersection triples are unchanged. Process stages are authored
   separately and appended to the `.ttl` files (this is the only step that requires
   new content authoring).

### Phase 3 — vector re-indexing
If using a new Qdrant collection (`engine` instead of `library`):
1. Re-embed all wiki pages and raw chunks into the new collection
2. Update `library_id` payload field if needed (or keep `"default"`)

If reusing the same Qdrant collection:
1. No re-indexing needed — the `library_id` filter handles isolation

### Phase 4 — verification
1. `engine_lint` — zero errors on migrated content (info-level items for domains
   without process graphs are expected)
2. `engine_resolve` without `process_position` — should produce identical
   `translation_brief` to the old `library_resolve`
3. `engine_resolve` WITH `process_position` — should additionally return
   `process_context`
4. `engine_info resource: process` — should return the process graph for domains
   that have process stages in their `.ttl`

### Migration script (`scripts/migrate-from-library.ts`)

```typescript
// Reads all blobs from old containers, writes to new containers.
// Optionally re-indexes vectors.
// Reports: blobs_copied, vectors_indexed, process_authoring_needed (domains
//   with rules but no process stages in their .ttl).
```

Run with: `npx ts-node scripts/migrate-from-library.ts`

Environment: requires both old (`LIBRARY_STORAGE_CONNECTION_STRING`) and new
(`ENGINE_STORAGE_CONNECTION_STRING`) connection strings. If same storage account,
use the same connection string for both.

-----

## Proof of life test

After deployment, run this sequence using the Difference Engine on itself.

**1. Ingest this build schema**
Call `engine_write` with `operation: "ingest"`, content = this CLAUDE.md,
source_type: primary, domain: difference-engine

**2. Create curated pages via `engine_write operation: "update_page"`**
- `difference-engine-overview.md` — what this system is and why it exists
- `three-layer-architecture.md` — the three layers and how they compose
- `knowledge-graph-design.md` — how process flows and intersections coexist in RDF
- `process-traversal.md` — the pure traversal function and cross-layer integration
- `migration-model.md` — how content moves from llm-library to the Difference Engine

**3. Load the ctax-rebuild domain**
Load rules via `engine_update_rules`, load the extended `.ttl` (with process stages)
via `engine_update_reasoning`.

**4. Query**
Ask: "A bailiff is at my door about council tax" with
`process_position: { current: ["BailiffEnforcement"], completed: ["LiabilityCheck", "Assessment", "Billing", "ArrearsCheck", "Reminder", "Summons", "LiabilityOrder", "EnforcementDecision"] }`

Expected:
- `eligibility.rule_fired` is the expected rule (if inputs supplied)
- `reasoning.answer_shape` = `UrgentSafeguardingGuidance` (because
  `BailiffEnforcement` activated `bailiff_present` signal → `BailiffAtDoor` fired)
- `process_context.current_stage` = `BailiffEnforcement`
- `process_context.current_stage_label` = `Bailiff Enforcement`
- `process_context.progress` ≈ 0.69 (9 of 13 stages)
- `process_context.available_next_steps` includes `EnforcementComplete` and `Resolved`
- `safety_constraints` includes `no_payment_instruction`

**5. Update one page**
Update `knowledge-graph-design.md`. Confirm versioning, manifest, embedding all work.

**6. Lint**
`engine_lint` with domain: `ctax-rebuild`. Confirm zero errors. Confirm process
graph lint checks run (no orphan stages, no dead ends, no missing targets).

-----

## Key design decisions

**Why enrich Layer 3 instead of adding Layer 4?**
The user specified "both combined" — a process-aware knowledge graph that IS also an
executable workflow. Process stages and semantic intersections share a vocabulary
(`sov:inDomain`, `sov:activatesSignal` → `sov:whenSignal`), share storage (same `.ttl`
file), and share an admin tool (`engine_update_reasoning`). Adding a separate layer
would fragment the graph and lose the natural cross-references. One graph, one
vocabulary, one truth.

**Why JSON string literals for edge conditions in RDF?**
Edge conditions reuse L1's closed predicate AST (`evalCondition`). Encoding conditions
as RDF triples would require a complex condition vocabulary and lose the direct
compatibility with L1. A JSON string literal is parsed by the traverser and evaluated
with the same pure function that evaluates L1 rules. One predicate language across the
entire system.

**Why process traversal before retrieval in the pipeline?**
Process position influences what knowledge to retrieve. A `BailiffEnforcement` stage
has `relevantPage "ctax-rebuild-bailiff-rights.md"` — this can narrow or boost the L2
query. Process position also activates signals that feed L3 reasoning. Both must
happen before retrieval and reasoning.

**Why advisory cross-layer references (not binding)?**
A stage's `evaluatesRule`, `relevantPage`, and `activatesSignal` are hints, not hard
dependencies. A process graph remains valid even if referenced rules or pages don't
exist (lint warns, traversal doesn't fail). This follows the existing pattern: absent
L1 ruleset = indeterminate (not error), absent L3 map = empty shape (not error).

**Why not embed process stages as vectors?**
Process stages are structural, not semantic. You don't search for "which stage am I at"
by similarity — you know where you are by explicit position. The process graph is
traversed, not searched.

-----

## Dependencies

Same as `llm-library`:

```json
{
  "dependencies": {
    "@azure/functions": "^4.5.0",
    "@azure/storage-blob": "^12.24.0",
    "n3": "^1.21.3",
    "oxigraph": "^0.4.9",
    "uuid": "^9.0.1"
  },
  "devDependencies": {
    "@types/node": "^20.14.0",
    "@types/uuid": "^9.0.8",
    "typescript": "~5.4.5"
  }
}
```

No new dependencies. The process traversal uses the existing `evalCondition` function
(pure TypeScript) and the existing RDF engines (oxigraph/n3).

-----

## Done means

Everything from the `llm-library` CLAUDE.md's "Done means" section, plus:

- All four surfaces callable via MCP with `engine_*` tool names
- `engine_info resource: process` returns raw graph or traversed `ProcessPosition`
- `engine_resolve` includes `process_context` in `translation_brief` when
  `process_position` is supplied
- Process stages and transitions live in `.ttl` files alongside semantic intersections
- `sov:activatesSignal` on a process stage correctly merges into L3 reasoning signals
  (bailiff stage → bailiff_present → UrgentSafeguardingGuidance)
- Edge conditions use L1's `evalCondition` — one predicate language system-wide
- `checkVocabulary` validates both intersection AND process predicates
- Process lint checks detect structural graph issues
- Missing process graph does not block `engine_resolve` (empty process context)
- Existing `ctax-rebuild` content migrates cleanly
- Extended `.ttl` fixture demonstrates the full ctax recovery process (13 stages)
- `npm run verify:sovereign` covers L1 + L3 (intersections + process traversal)
- Migration script transfers content from `llm-library` containers to `engine-*`
  containers
