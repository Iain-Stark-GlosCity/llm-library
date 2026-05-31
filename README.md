# Library MCP

An MCP server that exposes an AI-optimised, curated wiki knowledge base over
**JSON-RPC 2.0 on a single HTTP POST** (Streamable HTTP — not SSE). Built as an
Azure Functions v4 app (Node 20 LTS, TypeScript).

> **RAG retrieves evidence. MCP returns tools. This layer maintains knowledge.**
> It turns scattered source material into a versioned, source-linked,
> machine-queryable body of curated knowledge that any MCP-capable model can use
> as an extension of its working memory.

See [`CLAUDE.md`](./CLAUDE.md) for the full build schema and design rationale.

---

## The four tools

| Tool | What it does |
|---|---|
| `library_ingest` | Store a raw source document; chunk, embed (dense + sparse), register in `raw_manifest.json`. Does not touch the wiki. |
| `library_query` | Hybrid retrieval (Qdrant RRF) over curated wiki pages (default) and/or raw chunks, with confidence/domain filtering and mechanical gap detection. |
| `library_update` | The only curated wiki write path. Deterministic frontmatter, previous-version archival to `history/`, re-embedding, `manifest.json` + `index.md` regeneration. |
| `library_lint` | Read-only mechanical health checks (orphans, broken refs, missing citations, open contradictions, stale embeddings, unindexed sources, manifest/blob drift). |

A no-dependency `library_ping` health tool is also exposed — call it first to
confirm the transport before touching storage. It returns safe runtime diagnostics
that identify missing Function App settings without exposing secret values.

---

## Architecture

- **Storage:** Azure Blob Storage. `library-raw` (raw sources + `raw_manifest.json`)
  and `library-wiki` (`pages/`, `history/`, `manifest.json`, `index.md`, logs).
- **Vector store:** Qdrant, one collection `library`. Each point carries a dense
  vector (`default`, 1536-dim Cosine) and a sparse vector (`text`, IDF). Queries
  fuse both with native RRF. Called over the HTTP API — no SDK.
- **Embedding:** OpenAI `text-embedding-3-small` (1536 dims), via raw `fetch`.
- **Transport:** one HTTP-trigger function `mcp` at `POST /api/mcp` for MCP
  JSON-RPC calls, plus a lightweight `GET /api/mcp` health response for
  deployment diagnostics. Stateless (no session, no `Mcp-Session-Id`). Two layers
  kept distinct: the JSON-RPC protocol envelope (owned by `functions/mcp.ts`) and
  the domain `{ ok, data, warnings }` envelope (owned by the tool handlers).

```
src/
  functions/mcp.ts     JSON-RPC dispatcher + tool routing
  tools/               registry.ts + ingest/query/update/lint + shared helpers
  storage/             blobs, qdrant, manifest, raw-manifest, index, log
  embed/               openai, chunk, ids, sparse
  config.ts            env-driven config
  types.ts             DomainEnvelope / ToolDefinition contract
```

---

## Configuration

Set these as **Application settings** on the Function App (and in a local
`local.settings.json` for local runs — copy `local.settings.json.example`).

| Setting | Required | Default | Notes |
|---|:--:|---|---|
| `LIBRARY_STORAGE_CONNECTION_STRING` | ✅ | — | Blob storage account connection string |
| `QDRANT_URL` | ✅ | — | Cluster endpoint, e.g. `https://xxxx.qdrant.io:6333` |
| `QDRANT_API_KEY` | ✅ | — | Qdrant cluster API key |
| `OPENAI_API_KEY` | ✅ | — | OpenAI API key |
| `LIBRARY_RAW_CONTAINER` | | `library-raw` | |
| `LIBRARY_WIKI_CONTAINER` | | `library-wiki` | |
| `QDRANT_COLLECTION` | | `library` | |
| `EMBEDDING_MODEL` | | `text-embedding-3-small` | |

Plus the runtime settings Azure Functions itself needs:
`FUNCTIONS_WORKER_RUNTIME=node`, `FUNCTIONS_EXTENSION_VERSION=~4`,
`WEBSITE_NODE_DEFAULT_VERSION=~20`, and `AzureWebJobsStorage`.

### Prerequisites

- The Qdrant `library` collection **must already exist** with dense vector
  `default` (size 1536, Cosine) and sparse vector `text` (modifier `idf`), plus
  keyword payload indexes on `library_id`, `record_type`, `domain`, `confidence`,
  `status`. The app verifies this on first use and errors clearly if it is missing
  or misconfigured — it never creates the collection.
- Blob containers are created automatically on first use.

---

## Run locally

```bash
npm install
cp local.settings.json.example local.settings.json   # then fill in the values
npm start                                             # builds (tsc) then func start
```

`npm start` runs `tsc` then `func start`. Requires the Azure Functions Core Tools
(installed as a dev dependency; needs network access to fetch its binary).

Smoke-test the wire with raw JSON-RPC (no auth at MVP):

```bash
URL="http://localhost:7071/api/mcp"
curl -s "$URL"   # lightweight deployment health + safe config diagnostics
curl -s -X POST "$URL" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}'
curl -s -X POST "$URL" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
curl -s -X POST "$URL" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"library_ping","arguments":{}}}'
```

---

## Deploy to Azure

```bash
npm install
npm run build
func azure functionapp publish <app-name>
```

Compiled output ships from `dist/`; `.funcignore` excludes `src/**/*.ts`,
`local.settings.json`, and tests from the package.

Endpoint: `POST https://<app-name>.azurewebsites.net/api/mcp`

---

## Connect as an MCP server

Add it to your MCP client as an **HTTP** server (not SSE) pointing at
`https://<app-name>.azurewebsites.net/api/mcp`.

> **Auth note.** The endpoint is **anonymous** at MVP — anyone with the URL can
> call it. This is deliberate to avoid MCP auth friction while proving the
> concept. Put a function key, API Management, or App Service Easy Auth in front
> before loading anything sensitive.

---

## Proof of life

Once connected, run the full lifecycle to prove the system end to end:

1. **Ingest** a source — `library_ingest` (e.g. this repo's `CLAUDE.md`,
   `source_type: primary`, `domain: ai-knowledge-layer`).
2. **Query** it — `library_query` with `scope: raw` to confirm chunks return.
3. **Create** a curated page — `library_update`.
4. **Query** the wiki — `library_query` (default `scope: wiki`) returns the page.
5. **Update** the page — confirm the previous version lands in `history/`, the
   `manifest.json` `updated` timestamp changes, and the Qdrant payload `updated`
   changes.
6. **Lint** — `library_lint` shows no `stale_embedding` for the updated page.

---

## Failure semantics

- **Before the critical content write fails:** `ok: false` with an error code.
- **After the critical write succeeds:** `ok: true` with `warnings[]` and explicit
  boolean flags — secondary failures (embedding, manifest, index, log) never turn
  a successful write into a total failure.
- **Log failures** are always warnings, never errors.
- **ETag conflicts** on shared files return `CONFLICT` with no silent retries —
  the caller decides.
- Domain errors (`VALIDATION_ERROR`, `STORAGE_ERROR`, `EMBEDDING_ERROR`,
  `CONFLICT`, `NOT_FOUND`) ride inside a successful `tools/call` result with
  `isError: true` — they are never JSON-RPC protocol errors.
