# Library MCP

An MCP server that maintains a curated, source-linked knowledge base and exposes it
to AI agents as queryable tools. Built as an Azure Functions v4 app (Node 20 LTS,
TypeScript).

> **RAG retrieves evidence. MCP returns tools. This layer maintains knowledge.**
>
> But underneath, it is a data problem, not an AI one: a **derived, governed knowledge
> layer** between systems of record and the AI channels that consume it — two hops from
> truth, never a system of record. Confidence is not currency.

-----

## Why this exists

Most AI systems that work with documents use RAG — Retrieval Augmented Generation.
You upload files, the AI searches them at query time, and generates an answer. It
works, but the AI re-derives everything from scratch on every question. Nothing
accumulates. If you ask a question that requires synthesising five documents, the
AI has to find and piece together the relevant fragments every time.

This system takes a different approach. Instead of retrieving from raw documents
at query time, an AI agent incrementally builds and maintains a **persistent wiki**
of curated knowledge pages. Each page is written by an AI librarian, linked to its
sources, graded for confidence, and updated when the underlying material changes.
The knowledge compounds over time rather than being re-derived on every query.

The practical difference: a query against this system returns a curated, versioned,
source-linked page that reflects everything that has been read and assessed on a topic.
A RAG query returns raw fragments.

### The problem it is designed for

Structured knowledge domains — legislation, policy, regulation, technical standards —
are difficult for AI systems to handle reliably. The source material is dense,
heavily amended, and legally precise. A single regulation might span hundreds of
provisions. Getting a fact wrong has real consequences.

RAG does not solve this. It finds relevant text. It does not know whether that text
is current, whether it contradicts something else, or how much confidence to place
in a partial fetch. A curated knowledge base where every claim is tied to a specific
source provision, and where confidence is explicitly graded, is a different tool for
a different problem.

### What this is not

This is not a chatbot. It is not a question-answering system. It is infrastructure —
a knowledge layer that any MCP-capable AI agent can use as an extension of its
working memory. The agent that queries it decides what to do with what it gets back.

It is also not a system of record, and not a source of truth. Mistaking it for either
is the central risk, which is why the next section is about data, not AI.

-----

## A data problem, not an AI problem

It is tempting to frame this as an AI capability. It is more useful — and safer — to
frame it as a data architecture, because that is where the risks live. It is a
**derived, governed knowledge layer that sits between systems of record and the AI
channels that consume it.** Five concerns that should stay separate get blurred the
moment you let an agent "just answer from the library":

- **System of record** — the authoritative origin of a fact. For these domains it is
  external: legislation.gov.uk, a council's constitution, a supplier register. It is
  never this app.
- **Source of truth** — the system of record *as of now*. Also external, and only
  knowable by re-reading upstream.
- **Operations** — live data that drives a decision in the moment. Needs freshness
  guarantees and deterministic controls.
- **Analysis** — derived, interpretive, lag-tolerant understanding.
- **Governed interpretation** — approved organisational understanding, source-linked,
  with explicit ownership, currency, review, and permitted use. This is the most the
  library should aspire to be.

These have different properties, and trying to serve all five with one store — or not
knowing which one you are operating in — is where things go wrong.

**This system is a derived knowledge layer: analysis by default, and governed
interpretation only where ownership, source currency, review, and permitted use are
explicit.** It is never a system of record or a source of truth. Concretely it is a
read-optimised **index and cache** sitting two hops from truth: `library-raw` is a
point-in-time **snapshot** of an external system of record, and the wiki is a
**derived view** over those snapshots. Treating a curated page as the source of truth
is a category error — it is a governed cache entry.

Two consequences follow, and they are the whole reason to be careful.

**Confidence is not currency.** A page's confidence grade reflects how cleanly the
underlying material was extracted — a tidy three-line provision scores high, a
truncated 200-paragraph fetch scores medium. It says nothing about whether the cited
provision has since been amended. A high-confidence page can be badly out of date.
The two are independent axes.

**Caching means cache invalidation.** A snapshot is stale against upstream the moment
it is taken; a curated page is stale against its snapshot once the source is re-read
and changes. The business consequence of answering from stale cache — a superseded
regulation cited into a live procurement or planning decision — is the failure mode
this design has to respect. Because a re-ingested source lands under a new `source_id`
(the id embeds the content hash) while older snapshots remain, the system can detect
this mechanically: snapshots are grouped by `upstream_id` (falling back to `source_url`),
`library_query` returns a freshness signal per result, and `library_lint` flags
`cites_superseded_source`, `snapshot_aged`, and `source_missing_upstream_id`. This is
offline detection — it sees that a newer snapshot exists once one has been ingested, and
how old a snapshot is, but it cannot by itself know that upstream changed without a
re-fetch. Existing content needs no migration: any source with a `source_url` groups
automatically; for those without one, lint surfaces them and `set_provenance` assigns an
identity. The caller still owns the decision about how much staleness is acceptable for
the consequence at hand.

-----

## Conceptual lineage

This system implements a domain-specific, source-gated extension of the
**LLM-wiki pattern** described by Andrej Karpathy in
[llm-wiki.md](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)
(April 2026). Karpathy’s core insight: instead of re-deriving knowledge from
raw documents on every query, let an LLM incrementally build and maintain a
persistent, compounding wiki that sits between you and the sources.

This implementation applies that pattern to structured legislative and policy
domains with three additions that the general pattern does not include.

**Source-gating.** A claim only exists in the wiki if a specific statutory
provision or primary source backs it. Pages that assert knowledge without
citation are a regression, not a contribution. The lint checks enforce this.

**Confidence typing.** Pages carry an explicit confidence level (`high`,
`medium`, `low`, plus `unverified` for material not yet assessed) that reflects
the quality of the underlying extraction, not the AI’s self-assessed certainty.
A cleanly fetched three-line provision is high confidence. A 200-paragraph
regulation fetched in chunks with visible truncation is medium. The distinction
matters in domains where errors have real consequences.

**Gap register.** Unresolved provisions are tracked as first-class state rather
than left implicit. `library_query` reports a mechanical gap list for terms it
cannot satisfy from the catalogue or returned evidence, and contradiction pages
are linted for an explicit resolution. The intent is an epistemic control —
gaps are named and source-backed updates are required to close them — not a
maintenance afterthought.

The pattern, the tooling, and the domain application are all separate
contributions. Credit to Karpathy for the gates.

-----

## How it works

The system has three layers, following Karpathy’s architecture.

**Raw sources** are ingested documents — legislation, guidance, policy text,
primary sources. They are stored immutably and never modified by the AI. But
immutable means fixed, not authoritative: each is a point-in-time **snapshot** of an
external system of record, and can be stale against upstream the moment it is fetched.
The real source of truth stays upstream.

**The wiki** is a directory of curated knowledge pages maintained by an AI
librarian agent. Each page covers a specific concept or provision. Pages are
versioned, source-linked, and confidence-graded. The librarian writes and updates
them as new sources are ingested or existing understanding changes.

**The schema** is the operating doctrine: what the library is, how pages should
be structured, what citation conventions apply, and what the librarian agent
should do in each situation.

When an AI agent queries the library, it gets back curated pages, not raw fragments.
The cross-references are already there. The confidence levels are already assessed.
The gaps are already flagged. The agent does not have to reconstruct any of this
from scratch.

-----

## The tools

The surface is five role-shaped tools. Reads fold into `library_info` (pick a
`resource`) and writes fold into `library_write` (pick an `operation`), so the
same capabilities are exposed through fewer top-level tools.

|Tool           |What it does                                                                                                                                                                                                                                                                                                                                                                                                                                    |
|---------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
|`library_ping` |Health check. No dependencies. Call first to confirm the transport is working before touching storage. Returns safe diagnostics for missing configuration without exposing secret values.                                                                                                                                                                                                                                                       |
|`library_info` |Read-only inspection. `resource: instructions` returns the operating doctrine. `resource: schema` returns the per-domain schema (needs `domain`). `resource: pages` returns the curated catalogue (optional `domain`/`status` filter). `resource: page` returns one page by filename.                                                                                                                                                           |
|`library_query`|Hybrid retrieval over curated wiki pages (default) or raw source chunks (dense + sparse fused, so exact terminology like regulation numbers surfaces reliably). Each curated result is a **governed answer**: `confidence` (extraction quality), a **freshness** block (stalest cited snapshot age, whether a newer snapshot exists), and a **provenance** block (cited `source_id`s with `source_url`, `upstream_owner`, capture date, `upstream_status`; plus page review and permitted-use). Confidence and currency are independent. Optionally pass **`intended_use`** for a per-result `use_permitted` decision (increasing guard rails by mode); operational intents are refused and content withheld. Plus a mechanical gap list.|
|`library_write`|The only mutating tool (librarian mode only). Operations: `ingest`, `register_source`, `update_page` (the only path to the wiki; carries governance metadata — `allowed_use`/`prohibited_use`, `last_source_check`, `business_consequence_if_stale`, `invalidation_policy`), `update_schema`, `deprecate_page`, `delete_blob` (hard-delete blob + vector + registry entry), `set_provenance` (assign `upstream_id`/`source_url`/`upstream_owner` to an existing source).|
|`library_lint` |Read-only mechanical health checks. Finds: orphan pages, missing citations, open contradictions, broken refs, stale embeddings, unindexed sources, manifest/blob drift; **stale cache** (`cites_superseded_source`, `snapshot_aged`, `source_missing_upstream_id`); and — for domains that set `governance_required` — **governance** (`operational_use_not_permitted`, `public_guidance_without_last_source_check`, `decision_support_without_stale_risk`, `high_risk_page_without_invalidation_policy`, `active_page_cites_unchecked_source`, `active_page_cites_stale_source`). Reports, does not fix.|

-----

## Governed answers and permitted use

Every curated answer can carry the governance a public-sector consumer needs to decide
whether to rely on it: **provenance** (which sources, owned by whom, captured when, at
what currency), **review** (`reviewed_at`, `last_source_check`), and **permitted use**.

Pages declare `allowed_use` / `prohibited_use` from a fixed vocabulary. The library
**supports**, with increasing guard rails:

`analysis` · `drafting` · `staff_guidance` · `public_guidance` · `decision_support`

It will **never** authorise the operational modes — `formal_decision`,
`live_account_action`, `payment_action`, `enforcement_action`. `update_page` rejects
them in `allowed_use`, and lint flags any that slip in. Crucially: **the library
declares and warns on use; it cannot enforce it.** A returned answer is data — the hard
block on acting from cached knowledge must live in the operational channel's controls,
not here. Treating this layer as the enforcement point would repeat the
cache-as-system-of-record error one level up.

A consumer can declare its intent per query with **`intended_use`**. `library_query`
then returns a `use_permitted` decision per result against a ladder of guard rails:
`analysis`/`drafting`/`staff_guidance` pass unless the page prohibits them;
`public_guidance` also requires `last_source_check` and a non-superseded snapshot;
`decision_support` also requires a declared `business_consequence_if_stale`. Each
refusal carries `use_notes` saying why. An operational `intended_use` short-circuits
before retrieval — content is withheld with `use_decision.permitted: false`.

Governance is adopted **per domain**: the guard-rail lint checks only apply where a
domain's schema sets `governance_required: true`. Existing domains stay quiet until they
opt in — a controlled-pilot path, not a big-bang migration. None of this metadata lives
in the vector index; it is stored in the manifests and enforced in the query/lint layer.

-----

## Architecture

The system runs on Azure infrastructure with no vendor-specific AI services.

**Storage** is Azure Blob Storage across three containers. `library-raw` holds
ingested source documents and a source registry. `library-wiki` holds current wiki
pages, a version history directory, a human-readable catalogue (`index.md`), a
machine-readable registry (`manifest.json`), and append-only logs. `library-schemas`
holds the optional per-domain schema files.

**Vector search** uses Qdrant. Each knowledge point stores a dense semantic vector
and a sparse keyword vector. Queries generate both and fuse the results using
Reciprocal Rank Fusion. This is what makes precise terminology surface reliably
alongside conceptual similarity matches.

**Embeddings** use OpenAI `text-embedding-3-small` (1536 dimensions).

**Transport** is JSON-RPC 2.0 over a single HTTP POST endpoint. Stateless — no
sessions, no streaming. Every request is self-contained, which suits the Azure
Functions consumption plan where instances may scale to zero between calls.

**Operating surfaces (multiple MCP endpoints).** The app exposes one read-only
**consumption** endpoint plus three per-layer **admin** endpoints, each a separate MCP
server (its own `serverInfo.name`, its own function key in production). This is part of the
three-layer "Sovereign AI" architecture — see [`docs/sovereign-architecture.md`](./docs/sovereign-architecture.md).

| Route | serverInfo.name | Tools |
|---|---|---|
| `POST /api/mcp` | `library-consumption` | `library_ping`, `library_info`, `library_query`, `library_resolve`, `library_lint` |
| `POST /api/mcp-library` | `library-admin` | `library_ping`, `library_info`, `library_write` (Layer 2) |
| `POST /api/mcp-rules` | `rules-admin` | `library_ping`, `library_info`, `library_update_rules` (Layer 1) |
| `POST /api/mcp-rdf` | `rdf-admin` | `library_ping`, `library_info`, `library_update_reasoning` (Layer 3) |

`library_info` reads across all three layers (`resource: instructions | schema | pages |
page | rules | reasoning`). `library_resolve` composes Layer 1 eligibility, Layer 2
context, and Layer 3 answer-shape into one governed answer package. Admin routes mutate the
highest-trust artifacts (the rule Constitution and the reasoning map) — key them and never
expose them to agent consumers. Admin routes use flat `/api/mcp-*` paths because Azure
Functions reserves the `/admin` namespace for its own host API.

> ⚠️ **Key the admin routes before production.** All four routes ship `authLevel:
> 'anonymous'` at MVP. Deployed as-is, `/api/mcp-library`, `/api/mcp-rules`, and
> `/api/mcp-rdf` are **public, unauthenticated mutation endpoints** (they can update and
> delete existing pages, rules, and reasoning maps). Before the production app, switch the
> admin routes to `authLevel: 'function'` (in `createMcpFunction`, `src/functions/mcp.ts`)
> or front them with APIM / Easy Auth. Note the deploy workflow auto-publishes on push to
> `main`, so do not merge to `main` until the admin routes are locked down.

```
src/
  functions/mcp.ts     JSON-RPC dispatcher and tool routing
  tools/               registry, info, query, write, lint, per-operation handlers, shared helpers
  storage/             blobs, qdrant, manifest, raw-manifest, index, log, schema
  embed/               openai, chunk, ids, sparse
  config.ts            environment-driven configuration
  types.ts             DomainEnvelope and ToolDefinition contracts
```

-----

## Configuration

Set these as Application settings on the Function App. Copy
`local.settings.json.example` for local development.

|Setting                            |Required|Default                 |Notes                                               |
|-----------------------------------|:------:|------------------------|----------------------------------------------------|
|`LIBRARY_STORAGE_CONNECTION_STRING`|✅       |—                       |Blob storage account connection string              |
|`QDRANT_URL`                       |✅       |—                       |Cluster endpoint, e.g. `https://xxxx.qdrant.io:6333`|
|`QDRANT_API_KEY`                   |✅       |—                       |Qdrant cluster API key                              |
|`OPENAI_API_KEY`                   |✅       |—                       |OpenAI API key for embeddings                       |
|`LIBRARY_RAW_CONTAINER`            |        |`library-raw`           |                                                    |
|`LIBRARY_WIKI_CONTAINER`           |        |`library-wiki`          |                                                    |
|`LIBRARY_SCHEMA_CONTAINER`         |        |`library-schemas`       |                                                    |
|`LIBRARY_RULES_CONTAINER`          |        |`library-rules`         |Layer 1 deterministic rulesets (`{domain}.rules.json`).|
|`LIBRARY_RDF_CONTAINER`            |        |`library-rdf`           |Layer 3 reasoning maps (`{domain}.ttl`).            |
|`LIBRARY_RDF_ENGINE`               |        |`oxigraph`              |`oxigraph` (real SPARQL) or `n3` (triple-traversal fallback).|
|`QDRANT_COLLECTION`                |        |`library`               |                                                    |
|`EMBEDDING_MODEL`                  |        |`text-embedding-3-small`|                                                    |
|`LIBRARY_MCP_MODE`                 |        |`read_only`             |Legacy health-report flag; surfaces are now route-based (see below).|

The Qdrant `library` collection must already exist with the correct vector
configuration before first use. The app verifies this on startup and errors clearly
if it is missing or misconfigured. It never creates the collection.

Blob containers are created automatically on first use.

-----

## Run locally

```bash
npm install
cp local.settings.json.example local.settings.json   # fill in the values
npm start                                             # builds (tsc) then func start
```

Smoke-test the wire:

```bash
URL="http://localhost:7071/api/mcp"
curl -s "$URL"
curl -s -X POST "$URL" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}'
curl -s -X POST "$URL" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
curl -s -X POST "$URL" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"library_ping","arguments":{}}}'
```

-----

## Deploy to Azure

```bash
npm install
npm run build
npm run smoke:entrypoint   # verifies package.json main resolves and imports cleanly
func azure functionapp publish <app-name>
```

Compiled output ships from `dist/`. `.funcignore` excludes source TypeScript,
`local.settings.json`, and tests from the deployment package.

> ⚠️ Before deploying the production app, lock down the admin routes (`/api/mcp-library`,
> `/api/mcp-rules`, `/api/mcp-rdf`) — see the warning under **Architecture → Operating
> surfaces**. They are anonymous mutation endpoints at MVP.

Endpoints: consumption `POST https://<app-name>.azurewebsites.net/api/mcp`; admin
`/api/mcp-library`, `/api/mcp-rules`, `/api/mcp-rdf`.

If Azure reports `AZFD0005` with `node exited with code 1`, run
`npm run smoke:entrypoint` locally first. This rebuilds TypeScript and loads every
compiled entry point. A missing `dist` file or top-level startup exception fails
locally before Azure has to discover it.

-----

## Connect as an MCP server

Add it to your MCP client as an **HTTP** server (not SSE) pointing at
`https://<app-name>.azurewebsites.net/api/mcp`.

The endpoint is anonymous at MVP. Put a function key, API Management layer, or
App Service Easy Auth in front before loading anything sensitive.

-----

## Proof of life

Once connected, run the full lifecycle to prove the system end to end.

1. **Ingest** a source — `library_write` (`operation: ingest`, `source_type: primary`,
   `domain: ai-knowledge-layer`).
1. **Query** raw chunks — `library_query` with `scope: raw` to confirm chunks return.
1. Switch to librarian mode (`LIBRARY_MCP_MODE=librarian`) before write tests.
1. **Create** a curated page — `library_write` (`operation: update_page`).
1. **Query** the wiki — `library_query` (default `scope: wiki`) returns the page.
1. **Update** the page — confirm the previous version lands in `history/`, the
   `manifest.json` `updated` timestamp changes, and the Qdrant payload `updated` changes.
1. **Lint** — `library_lint` shows no `stale_embedding` for the updated page.

-----

## Failure semantics

Before the critical content write fails: `ok: false` with an error code.

After the critical write succeeds: `ok: true` with `warnings[]` and explicit boolean
flags. Secondary failures (embedding, manifest, index, log) never turn a successful
write into a total failure. `library_lint` detects and reports incomplete secondary
state. Recovery is the librarian’s decision.

Log failures are always warnings, never errors.

ETag conflicts on shared files return `CONFLICT` with no silent retries. The caller
decides.

Domain errors (`VALIDATION_ERROR`, `STORAGE_ERROR`, `EMBEDDING_ERROR`, `CONFLICT`,
`NOT_FOUND`) ride inside a successful `tools/call` result with `isError: true`. They
are not JSON-RPC protocol errors.

-----

See [`CLAUDE.md`](./CLAUDE.md) for the full build schema, wire contract, tool
specifications, and operating doctrine.
