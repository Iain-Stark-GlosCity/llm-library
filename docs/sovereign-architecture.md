# Three-Layer Sovereign AI Architecture

> Status: vertical slice. This document describes how the Library MCP is being evolved
> from a single knowledge layer into a three-layer "Sovereign AI" stack, and what the first
> slice (the `ctax-rebuild` / bailiff-at-door scenario) actually ships.

## Thesis

The Library on its own is a filing cabinet with a good catalogue: curated, sourced,
versioned, confidence- and currency-graded knowledge. Necessary, but **passive** — it
tells you what is known and how much to trust it, but not what a question *means*, what
*shape* of answer is permissible, or whether the asker is even *eligible* for the thing
they are asking about. Those are three different jobs, and conflating them with retrieval
(or worse, leaving them to the LLM) is where public-sector AI goes wrong.

So we separate them into three layers, and reduce the LLM to translation only:

| Layer | Name | Job | Determinism |
|---|---|---|---|
| 1 | **Schema / Constitution** | Eligibility, thresholds, valid states. Given inputs → a governed outcome + *which rule fired*. | Fully deterministic. No LLM, no vectors. |
| 2 | **Library / Living Knowledge** | Sourced context with provenance, freshness (currency), and permitted-use governance. | Vector retrieval (already built). |
| 3 | **RDF / Reasoning Map** | What a question means; the required *answer shape* and *safety constraints*; what overrides what. | SPARQL traversal of a curated Turtle map. |
| — | **The LLM** | Translate a precisely governed answer into language for a specific person. | Renders; decides nothing. |

## Current → target mapping

| Layer | Today (before this work) | This slice |
|---|---|---|
| L1 | Did not exist. `storage/schema.ts` is *advisory doctrine*, not a rule engine. | New `library-rules` container + `{domain}.rules.json` + a pure deterministic resolver. |
| L2 | Built: `tools/query.ts` → Qdrant → governed envelope (confidence, freshness, provenance, use-permitted). | Reused unchanged inside the orchestrator. |
| L3 | Did not exist. No RDF/SPARQL/Turtle. | New `library-rdf` container + `{domain}.ttl` + an engine-agnostic SPARQL/triple reasoner. |
| Orchestration | — | New `library_resolve` composes L1 → L2 → L3 into one governed answer package. |

## Topology — one app, four MCP endpoints

All three layers live inside this single Azure Functions app, but they are exposed over
**separate MCP endpoints** so consumption is cleanly isolated from administration of each
"bit". Each endpoint is its own HTTP function with its own `serverInfo.name` and (in
production) its own function key.

| Route | serverInfo.name | Surface |
|---|---|---|
| `POST /api/mcp` | `library-consumption` | `library_ping`, `library_info` (reads across all three layers), `library_query`, `library_resolve`, `library_lint` |
| `POST /api/mcp-library` | `library-admin` | `library_ping`, `library_info`, `library_write` (L2 writes) |
| `POST /api/mcp-rules` | `rules-admin` | `library_ping`, `library_info`, `library_update_rules` (L1 writes) |
| `POST /api/mcp-rdf` | `rdf-admin` | `library_ping`, `library_info`, `library_update_reasoning` (L3 writes) |

This generalises the former `LIBRARY_MCP_MODE` read/librarian toggle: **the mode is now the
route, not an env flag.** `src/functions/mcp.ts` factors the JSON-RPC dispatcher into
`createMcpFunction({ route, serverName, surface })` and registers it once per surface; the
surfaces themselves are named lists in `src/tools/registry.ts`.

**Why `/api/mcp-*` and not `/api/admin/*`.** Azure Functions reserves the `/admin` route
namespace for the host's own admin API (`/admin/host/...`, `/admin/functions/...`), which
makes custom `admin/...` routes unreliable. The admin surfaces therefore use flat,
non-reserved `/api/mcp-*` routes; the `*-admin` label lives in `serverInfo.name`.

**Security.** The admin endpoints mutate the Constitution (L1) and the reasoning map (L3) —
the highest-trust artifacts in the system. They must be separately keyed and never exposed
to agent consumers. The MVP ships `authLevel: 'anonymous'`; put a key / APIM / Easy Auth in
front of every route, admin routes especially, before loading anything sensitive.

## Layer 1 — Schema / Constitution

- **Storage.** New `library-rules` container (`LIBRARY_RULES_CONTAINER`), one
  `{domain}.rules.json` per domain. Kept separate from `library-schemas` on purpose: schema
  is advisory doctrine; a ruleset is an *enforced, versioned, auditable contract*.
- **Shape.** An **ordered** list of rules (first match wins = priority), each a `when`
  predicate and a governed `outcome`, plus a `version` and a `default_outcome`. The `when`
  is a **closed predicate AST** — `all` / `any` / `not` + leaf comparisons (`eq`, `neq`,
  `lt`, `lte`, `gt`, `gte`, `in`, `exists`) against `input.<path>`. It is data, not code.
- **Resolver.** `src/rules/resolve.ts` is **pure**: no I/O, no LLM, no vectors, no network,
  no randomness. `resolveEligibility(ruleset, inputs)` returns
  `{ eligibility, rule_fired, reason_code, ruleset_version, governs }`. The same inputs
  always produce the same output, and every decision is auditable to a `rule_fired` id.
  Malformed conditions fail closed (evaluate to `false`) so a bad rule can never grant
  eligibility.
- **Invariant.** Layer 1 must stay deterministic. If a decision ever needs interpretation,
  it does not belong here.

## Layer 3 — RDF / Reasoning Map

- **Storage.** New `library-rdf` container (`LIBRARY_RDF_CONTAINER`), one `{domain}.ttl`
  Turtle map per domain. **Turtle in blob is canonical**; the parsed graph is ephemeral,
  rebuilt per cold start and cached only as an optimization (keyed by domain + ETag). No
  persistence backend — we deliberately do not drift into a heavyweight triple store.
- **Engine — chosen: oxigraph, with an N3.js fallback behind one interface.**
  `src/rdf/engine.ts` defines an engine-agnostic `RdfEngine` (`load`, `query`, `quads`).
  `LIBRARY_RDF_ENGINE` selects the implementation:

  | Engine | SPARQL | Cold start | CJS interop | Verdict |
  |---|---|---|---|---|
  | **oxigraph** (default) | Real SPARQL 1.1 | WASM instantiation (one-off per cold start, cached) | Ships a CJS `node.js` build — `require()` works | The lightweight "Jena equivalent"; honours the *traversable via SPARQL* pillar. |
  | **n3** (fallback) | None — triple-pattern traversal | Negligible (pure JS) | Clean CJS | For when WASM cold-start cost is unwelcome. |
  | quadstore | Via Comunica | Heavy (level backend) | — | Rejected: persistence we do not want. |

  The reasoner (`src/rdf/reason.ts`) uses **real SPARQL** on oxigraph and equivalent
  triple traversal on n3, producing the identical `ReasoningResult`. Both paths are
  covered by `scripts/verify-sovereign.js`. Dependencies are `require()`'d lazily so a
  missing install surfaces as a clear runtime error rather than a load-time crash.
- **What it encodes.** *Semantic intersections.* The bailiff case is modelled as
  `sov:BailiffAtDoor a sov:SemanticIntersection` — not a rule, not a fact — that, when a
  `bailiff_present` signal meets the `ctax-rebuild` domain, `requiresAnswerShape`
  `shape:UrgentSafeguardingGuidance`, carries `hasSafetyConstraint` (e.g.
  `no_payment_instruction`), declares `mustInclude` content, and `overrides` the standard
  rebuild answer shape.
- **Fixed ontology namespace.** The reasoner only reads a fixed set of predicate/class IRIs
  under one namespace — `urn:sovereign:` (`sov:`). It is the **engine ontology, reused by
  every domain**, not a per-domain or "ctax" vocabulary; the domain is the literal value of
  `sov:inDomain`. It is a `urn:` precisely so it is an opaque identifier with no host to
  resolve — there is nothing "local" to reference at runtime, in Azure or anywhere (RDF IRIs
  are never dereferenced). Subject IRIs and answer-shape/override objects are read by local
  name only, so `shape:` is cosmetic. Because predicates outside this set are silently
  ignored at query time, `library_update_reasoning` runs a **vocabulary guard** that returns
  `warnings[]` (it does not block) for unknown ontology predicates or intersections missing
  `inDomain` / `whenSignal` / `requiresAnswerShape`.

## Orchestration — `library_resolve`

`src/tools/resolve.ts` runs the single governed query. Input:
`{ domain, question, intent?, inputs?, signals? }`.

1. **Layer 1 first** — resolve eligibility deterministically *before* anything else.
2. **Layer 2** — retrieve sourced context by **reusing `library_query`'s handler** (no
   duplicated retrieval); the existing operational-use refusal and the
   confidence/freshness/provenance/use-permitted envelope come for free.
3. **Layer 3** — traverse the reasoning map for the governing `answer_shape`,
   `safety_constraints`, `must_include` / `must_not`, and `overrides`.
4. **Compose** one package whose `translation_brief` is an explicit instruction set:
   `allowed` (NOT explicitly ineligible AND has permitted context AND not blocked),
   `answer_shape`, `safety_constraints`, `must_include`, `must_not`, and `cite_sources`
   (the provenance source ids of the permitted results). Only an explicit Layer 1
   `ineligible` vetoes; an absent ruleset resolves to `indeterminate` ("Layer 1 does not
   govern this domain") and does **not** block, so a domain with Layer 2 context but no
   Constitution can still be `allowed` — the brief's `note` then flags that eligibility was
   undetermined.

The consuming LLM renders prose to `answer_shape`, honouring `must_include` / `must_not`
and citing `cite_sources` — and makes no eligibility, retrieval, or safety judgement of its
own.

## The bailiff walkthrough (ctax-rebuild)

Question: *"A bailiff is at my door about council tax — what do I do?"* with
`intent: public_guidance`, `inputs: { liable_occupier: true, low_income: true, in_arrears: true }`,
`signals: { bailiff_present: true }`.

1. **L1** fires `CTR-001` → `eligible` (`rule_fired: "CTR-001"`), decided before the LLM.
2. **L2** returns the curated bailiff-rights page with provenance + freshness;
   `use_permitted: true` for `public_guidance`.
3. **L3** matches `sov:BailiffAtDoor` → `UrgentSafeguardingGuidance`, safety constraint
   `no_payment_instruction`, `must_include: right_to_request_breathing_space`; it
   **overrides** the standard rebuild shape (this is urgent safeguarding, not an
   eligibility lecture).
4. **`library_resolve`** composes the package: eligible + sourced context + urgent
   safeguarding shape + a hard "no payment instruction" constraint.
5. **The LLM translates only**: calm, actionable, source-cited guidance including
   breathing-space rights, that never instructs payment — because the package forbade it.

Fixtures for this slice live in `fixtures/ctax-rebuild/`
(`ctax-rebuild.rules.json`, `ctax-rebuild.ttl`, `ctax-rebuild-bailiff-rights.md`).

## Verification

- **`npm run build`** — tsc is the de-facto unit gate.
- **`npm run verify:sovereign`** — pure-function checks (no Azure / Qdrant / network):
  Layer 1 rule firing, and Layer 3 reasoning under **both** the oxigraph (SPARQL) and n3
  (traversal) engines, against the fixtures.
- **End-to-end (deployed / `func start`)** — load the fixtures via the admin endpoints
  (`mcp-rules` → `library_update_rules`, `mcp-rdf` → `library_update_reasoning`,
  `mcp-library` → `library_write` for the page), then call `library_resolve` on the
  consumption endpoint and assert `eligibility.rule_fired === "CTR-001"`,
  `reasoning.answer_shape === "UrgentSafeguardingGuidance"`, and
  `translation_brief.must_not`/`safety_constraints` carry the payment-instruction
  prohibition. (Requires `azure-functions-core-tools`, which needs outbound access to the
  Azure CDN to install.)

## Out of scope for this slice

Multi-domain rollout; richer SPARQL reasoning / Comunica; a full JSON-Schema validator
(`ajv`) for rule inputs; ruleset version history beyond the `version` string; endpoint
authentication. One domain (`ctax-rebuild`), one intersection (bailiff), one intent.
