# AI Library MCP — CLAUDE.md (Build Schema)

You are building an MCP server that exposes an AI-optimised wiki knowledge base.
This is an Azure Functions Node.js project following the existing MCP server patterns
in this codebase. Read existing MCPs before writing any code.

-----

## What this system is

This is not a RAG system. It is not a deterministic MCP tool. It is a third thing:

**RAG retrieves evidence. MCP returns tools. This layer maintains knowledge.**

|        |RAG                                     |Deterministic MCP                                       |This system                               |
|--------|----------------------------------------|--------------------------------------------------------|------------------------------------------|
|Unit    |Document chunk                          |Function call                                           |Curated knowledge page                    |
|Question|What text is relevant?                  |What function returns the answer?                       |What is the current curated understanding?|
|Weakness|Raw, contradictory, no canonical version|Fixed — cannot handle evolving or interpretive knowledge|Requires deliberate curation              |

What this gives an AI agent that neither RAG nor MCP provides:

- what we know
- where it came from
- how confident we are
- when it changed
- what it relates to
- what may be stale or broken

**Why it is universal across models.** RAG and tool calls are model-adjacent — tuned
for specific deployments. This layer is model-agnostic because it is about the
knowledge, not the model. Any model that can call an MCP tool gets the same curated,
versioned, source-linked understanding.

**In one sentence:** The system turns scattered source material into a versioned,
source-linked, machine-queryable body of curated knowledge that AI agents can use
as an extension of their working memory.

-----

## Core architectural principle

The MCP validates, stores, retrieves, versions, indexes, and reports mechanical
inconsistencies. It does not reason.

The librarian agent (CLAUDE-library.md) decides what wiki pages to create, what to
update, what contradictions exist, and what confidence level applies. It then calls
library_update. The MCP executes those instructions deterministically.

If an operation requires interpretation, it belongs in the librarian agent, not here.

-----

## What you are building

Four tools:

- **library_ingest** — store a raw source document, chunk and embed it
- **library_query** — retrieve relevant wiki pages or raw source chunks
- **library_update** — write or update a curated wiki page
- **library_lint** — check the wiki for structural health issues

-----

## Architecture

**Storage:** Azure Blob Storage. Two containers.

`library-raw`:

```
{source_id}             — raw source content
raw_manifest.json       — machine-readable source registry
```

`library-wiki`:

```
pages/                  — current wiki pages
history/{slug}/{safe-timestamp}.md  — previous versions before any overwrite
index.md                — human-readable catalogue
manifest.json           — machine-readable page registry
log.md                  — human-readable event log
log.jsonl               — machine-readable event log (one JSON per line)
```

History path uses slug-without-extension and safe timestamp (colons replaced with
hyphens): `history/service-patterns/2026-05-30T21-30-00Z.md`

**Vector store:** Qdrant. One collection named `library`. HTTP API, no SDK.
Filter by `library_id` payload field for multiple library instances.

**Embedding:** OpenAI text-embedding-3-small. 1536 dimensions. Abstract behind
an embed() function in embed/openai.ts.

**Search:** Hybrid retrieval using Qdrant native Query API. Each point stores a
dense vector (`default`) and a sparse text vector (`text`). Queries generate both
vectors and use Qdrant RRF fusion. manifest.json is used for metadata, filtering,
gap detection, and page lookup — not for manual keyword ranking.

**Framework:** Azure Functions v4 Node.js. MCP protocol over HTTP, same pattern as
existing func-mcp-poc functions.

-----

## Environment variables

```
LIBRARY_STORAGE_CONNECTION_STRING
LIBRARY_RAW_CONTAINER              default: library-raw
LIBRARY_WIKI_CONTAINER             default: library-wiki
QDRANT_URL                         — stark-library cluster endpoint URL
QDRANT_API_KEY                     — stark-library cluster API key
QDRANT_COLLECTION                  — collection name, default: library
                                     (cluster: stark-library, collection: library)
OPENAI_API_KEY
EMBEDDING_MODEL                    default: text-embedding-3-small
```

-----

## Critical write semantics

**Before the main content write fails:** return ok: false.

**After the main content write succeeds but a later step fails:** return ok: true
with warnings[] and explicit boolean flags (manifest_updated, index_updated,
embedded). Do not report the operation as a total failure after content is written.

library_lint detects and reports incomplete secondary state (stale embeddings,
missing manifest entries). Recovery is the librarian’s decision.

**Log failures never fail an operation.** If log append fails after any successful
write, return ok: true with warnings: [“log_append_failed”].

**ETag conflicts on shared files** (manifest.json, raw_manifest.json, index.md,
log files): return CONFLICT. No silent retries. The caller decides.

log.jsonl uses read-modify-write with ETag at MVP. If write contention becomes a
problem later, replace with Azure Append Blob.

-----

## Embedding API

POST to the OpenAI embeddings endpoint:

```
POST https://api.openai.com/v1/embeddings
Authorization: Bearer {OPENAI_API_KEY}
Content-Type: application/json

{
  "model": "text-embedding-3-small",
  "input": "text to embed"
}
```

Response shape:

```json
{
  "data": [
    { "embedding": [0.123, -0.456, ...] }
  ]
}
```

The vector is at `response.data[0].embedding`. It is an array of 1536 floats.
Verify the length before storing. If length !== 1536, throw EMBEDDING_ERROR.

For batch embedding of multiple chunks, pass input as an array of strings:

```json
{ "model": "text-embedding-3-small", "input": ["chunk 1", "chunk 2", ...] }
```

Response will have multiple objects in data[]. Match by index.

-----

## Qdrant HTTP API

Base URL: `{QDRANT_URL}` — include trailing slash in config, strip in calls.
Auth header: `api-key: {QDRANT_API_KEY}` (omit if no key configured).

### Create collection (idempotent)

The stark-library cluster collection has already been created manually with the
correct configuration. Do not recreate it. On startup, verify it exists and has
the expected configuration.

Collection configuration (for reference):

```json
{
  "vectors": {
    "default": {
      "size": 1536,
      "distance": "Cosine"
    }
  },
  "sparse_vectors": {
    "text": {
      "modifier": "idf"
    }
  }
}
```

Payload indexes already created on: library_id, record_type, domain, confidence,
status. All keyword type. Do not attempt to recreate them.

To verify collection exists before use:

```
GET /collections/{collection_name}
```

If 404: return STORAGE_ERROR — do not attempt to create the collection.
If dimensions mismatch on `result.config.params.vectors.default.size`:
return STORAGE_ERROR.
Expected: size=1536, distance=Cosine, sparse vector named “text” with idf modifier.

### Upsert vectors

Points must include both dense and sparse vectors.

```
PUT /collections/{collection_name}/points
Content-Type: application/json

{
  "points": [
    {
      "id": "uuid-string",
      "vector": {
        "default": [0.123, -0.456, ...],
        "text": {
          "indices": [42, 137, 891],
          "values": [0.71, 0.43, 0.89]
        }
      },
      "payload": {
        "record_type": "wiki_page",
        "library_id": "default",
        "filename": "service-patterns.md",
        ...
      }
    }
  ]
}
```

Use PUT (upsert) not POST (insert). PUT overwrites existing points with the same ID.

The sparse vector (`text`) must be generated from the text before upserting.
See Sparse vector generation below.

### Hybrid search

Use the Qdrant query API for native hybrid search combining dense and sparse vectors.

```
POST /collections/{collection_name}/points/query
Content-Type: application/json

{
  "prefetch": [
    {
      "query": [0.123, -0.456, ...],
      "using": "default",
      "limit": 20
    },
    {
      "query": {
        "indices": [42, 137, 891],
        "values": [0.71, 0.43, 0.89]
      },
      "using": "text",
      "limit": 20
    }
  ],
  "query": { "rrf": {} },
  "limit": 10,
  "with_payload": true,
  "filter": {
    "must": [
      { "key": "record_type", "match": { "value": "wiki_page" } },
      { "key": "library_id", "match": { "value": "default" } }
    ]
  }
}
```

RRF (Reciprocal Rank Fusion) merges the dense and sparse result lists automatically.
No manual scoring formula needed — Qdrant handles the combination.

Add domain filter when provided:

```json
{ "key": "domain", "match": { "value": "local-government" } }
```

Response shape:

```json
{
  "result": [
    {
      "id": "uuid-string",
      "score": 0.87,
      "payload": { "filename": "...", "title": "...", ... }
    }
  ]
}
```

### Scroll (enumerate all points for lint)

Used by library_lint to walk all wiki_page points and compare updated timestamps.

```
POST /collections/{collection_name}/points/scroll
Content-Type: application/json

{
  "filter": {
    "must": [
      { "key": "record_type", "match": { "value": "wiki_page" } },
      { "key": "library_id", "match": { "value": "default" } }
    ]
  },
  "with_payload": true,
  "limit": 100,
  "offset": null
}
```

Response includes `next_page_offset`. If not null, call again with that offset to
paginate. Continue until next_page_offset is null.

-----

## Hybrid search

Hybrid search uses Qdrant’s native query API with RRF (Reciprocal Rank Fusion).
No manual scoring formula. The dense vector (`default`) handles semantic similarity.
The sparse vector (`text`) with IDF modifier handles keyword/terminology precision.
RRF fuses the two ranked lists into a single result.

This is what makes exact terminology like “Reg 72”, “SMI”, “63-day minimum” surface
reliably even when the semantic similarity score is moderate.

Log the result scores from Qdrant for later tuning. Do not implement a custom
scoring formula on top of RRF at MVP.

## Sparse vector generation

The sparse vector for the `text` field must be generated before upserting.
Use a simple TF-IDF approach:

1. Tokenise the text: lowercase, split on whitespace and punctuation
1. Remove stopwords (same list as gap detection)
1. For each unique token, compute a term frequency weight
1. Map tokens to integer indices using a stable hash: `Math.abs(hash(token)) % 2^20`
1. Output as `{ indices: number[], values: number[] }`

The IDF component is handled by Qdrant automatically (the `modifier: "idf"` on the
collection). You only need to provide TF weights — Qdrant applies IDF at search time.

Simple hash function for token→index mapping:

```typescript
function tokenToIndex(token: string): number {
  let hash = 0
  for (let i = 0; i < token.length; i++) {
    hash = ((hash << 5) - hash) + token.charCodeAt(i)
    hash |= 0
  }
  return Math.abs(hash) % (2 ** 20)
}
```

Index collisions (two tokens mapping to the same index) are acceptable at MVP scale.

At query time, generate the sparse vector from the question text using the same
tokenise → hash pipeline, then pass both dense and sparse vectors to the query API.

-----

## Tool specifications

### library_ingest

Stores raw source, chunks, embeds, updates raw_manifest.json. Does not touch
library-wiki. Does not infer contradictions or confidence.

```
Input:
  title: string          — max 120 characters
  content: string        — max 200,000 characters
  source_type: string    — primary | secondary | derived
                           AI-generated content should be derived unless
                           the caller has a specific reason otherwise
  source_url?: string
  domain?: string
  library_id?: string    — default: "default"

Output:
  source_id: string
  chunks_indexed: number
  raw_blob_path: string
  embedding_status: ok | failed
  raw_manifest_updated: boolean
  embedded: boolean
  warnings: string[]
  log_entry: string
```

Steps:

1. Validate. Reject oversized content with VALIDATION_ERROR.
1. Generate source_id: `{YYYY}/{MM}/{slugified-title}-{8-char-hash-of-content}.md`
   On source_id collision with existing raw_manifest.json entry:
- If content hash matches existing entry: return ok: true, duplicate: true,
  existing source_id. Do not re-ingest.
- If content differs (hash mismatch): return CONFLICT.
1. Store content in library-raw/{source_id}. This is the critical write.
   If this fails: return ok: false, STORAGE_ERROR.
1. Chunk content. Use token-aware chunking if a tokenizer is already a dependency.
   Otherwise: ~4,000 character chunks with ~800 character overlap.
1. For each chunk, generate point_id:
   UUIDv5(namespace=library_id, name=“raw_chunk:{source_id}:{chunk_index}”)
1. For each chunk: generate dense embedding via OpenAI API (batch), generate
   sparse vector via tokenise→hash pipeline. Upsert in Qdrant with both vectors:
   
   ```json
   {
     "vector": {
       "default": [0.123, ...],
       "text": { "indices": [...], "values": [...] }
     },
     "payload": {
       "record_type": "raw_chunk",
       "library_id": "...",
       "source_id": "...",
       "chunk_index": 0,
       "domain": "...",
       "source_type": "...",
       "title": "..."
     }
   }
   ```
   
   If embedding fails: set embedding_status: failed, continue, include in warnings.
1. Update raw_manifest.json. ETag-aware.
   If conflict after the source blob has been written: return ok: true,
   raw_manifest_updated: false, warnings: [“raw_manifest_conflict”,
   “source_blob_written”]. Do not return ok: false after the critical write
   has succeeded.
1. Append logs. Failure = warning only.

### library_query

Returns curated wiki pages by default. Can also return raw source chunks.

```
Input:
  question: string
  top_k?: number         — default: 5, max: 20
  domain?: string
  scope?: string         — wiki | raw | both (default: wiki)
  min_confidence?: string  — high | medium | low | unverified (default: low)
  include_deprecated?: boolean — default: false
                                 If false, exclude status: deprecated wiki pages
  library_id?: string    — default: "default"

Output:
  results: Result[]
  gaps: string[]
  query_id: string

Result:
  type: wiki_page | raw_chunk
  filename?: string      — wiki_page only
  source_id?: string     — raw_chunk only
  chunk_index?: number   — raw_chunk only
  title: string
  content: string
  confidence?: string    — wiki_page only
  domain?: string
  score: number
```

Confidence ordering for filtering: high > medium > low > unverified.
This is a filtering order only. unverified means not yet assessed, not assessed weak.

Gap detection is mechanical. Do not interpret prose.
Strip common stopwords before gap detection (also, been, does, from, have, into,
more, says, some, that, their, them, then, there, this, were, what, when, where,
which, will, with, your). Report as gaps: remaining words of 4+ characters from
the question that do not match any title, tag, or domain field in manifest.json.
Gaps are informational only. The librarian decides whether they indicate missing
knowledge.

Deduplication:

- Wiki results: deduplicate by filename
- Raw results: deduplicate by source_id + chunk_index (do not collapse chunks)

Steps:

1. Generate dense embedding and sparse vector for the question text using embed()
   and the tokenise→hash pipeline.
1. Query Qdrant using prefetch dense + sparse with RRF fusion. Filter by:
- record_type matching scope (wiki_page | raw_chunk | both)
- library_id
- domain (if provided)
- For wiki scope: exclude status: deprecated unless include_deprecated: true
- For wiki scope: confidence ordering filter (high > medium > low > unverified)
  Request top_k * 2 to allow for deduplication.
1. Deduplicate: wiki_page by filename, raw_chunk by source_id + chunk_index.
1. Trim to top_k.
1. Fetch actual page/chunk content from blob storage for each result.
1. Mechanical gap detection: words 4+ chars from question (stopwords stripped)
   with no match in manifest.json title/tag/domain. Informational only.
1. Append logs. Failure = warning only.

-----

### library_update

The only curated wiki write path. Generates frontmatter deterministically from
inputs. content is body-only — no frontmatter in content input.

```
Input:
  filename: string       — pattern: /^[a-z0-9][a-z0-9-]*\.md$/, max 80 chars
  title: string          — max 120 characters
  content: string        — markdown body only, no frontmatter, max 50,000 chars
  page_type: string      — concept | source | synthesis | contradiction
  domain: string
  confidence: string     — high | medium | low | unverified
  tags: string[]         — max 10
  summary: string        — max 200 characters
  status?: string        — draft | active | deprecated (default: active)
  review_after?: string  — ISO date
  sources?: string[]     — source_ids; validated against raw_manifest.json
  related?: string[]     — wiki filenames this page links to
  library_id?: string    — default: "default"

Output:
  filename: string
  previous_version_path?: string
  manifest_updated: boolean
  index_updated: boolean
  embedded: boolean
  embedding_status: ok | failed
  warnings: string[]
```

Steps:

1. Validate all inputs. Return VALIDATION_ERROR on violation.
1. Validate sources[] against raw_manifest.json. Unknown source_ids → warnings[].
   Do not fail.
1. Read existing page (library-wiki/pages/{filename}) if present. Capture ETag.
   Extract and preserve original created timestamp from existing frontmatter.
1. If page exists, write history copy to:
   library-wiki/history/{slug-without-ext}/{safe-ISO-timestamp}.md
   safe-ISO-timestamp = ISO string with colons replaced by hyphens.
   If history write fails: include in warnings, continue.
1. Compose full page:
- Frontmatter generated from input fields (see Frontmatter format below)
- created: preserved from existing page, or now if new
- updated: now
- Body: content input appended after frontmatter
1. Write to library-wiki/pages/{filename} with ETag conditional write.
   If ETag conflict: return CONFLICT. Do not continue. Do not return ok: true.
   If write fails for other reason: return ok: false, STORAGE_ERROR.
   This is the critical write. All subsequent failures are warnings only.
1. Generate point_id: UUIDv5(library_id, “wiki_page:{filename}”)
1. Generate dense embedding and sparse vector for: `{title}\n{summary}\n\n{content}`
   Upsert in Qdrant with both vectors:
   
   ```json
   {
     "vector": {
       "default": [0.123, ...],
       "text": { "indices": [...], "values": [...] }
     },
     "payload": {
       "record_type": "wiki_page",
       "library_id": "...",
       "filename": "...",
       "title": "...",
       "type": "...",
       "domain": "...",
       "confidence": "...",
       "tags": ["..."],
       "status": "...",
       "updated": "ISO date"
     }
   }
   ```
   
   If embedding fails: set embedded: false, embedding_status: failed, continue.
1. Update manifest.json. ETag-aware. On conflict: manifest_updated: false, warning.
1. Update index.md. ETag-aware. On conflict: index_updated: false, warning.
1. Append logs. Failure = warning only.
1. Return output. ok: true if page was written, regardless of secondary state.

### library_lint

Read-only. Does not modify anything.

```
Input:
  domain?: string
  library_id?: string    — default: "default"

Output:
  issues: LintIssue[]
  issue_count: number

LintIssue:
  type: string
  page?: string
  source_id?: string
  description: string
  severity: error | warning | info
```

All checks are mechanical. No prose interpretation.

Steps:

1. Read manifest.json — current page registry
1. Read raw_manifest.json — current source registry
1. List files in library-wiki/pages/ from blob storage
1. Scroll all wiki_page points from Qdrant for this library_id (paginate with offset)
1. Run all checks below
1. Return issues

Issue types:

- `orphan_page` — active concept or synthesis page with no inbound related[] links
  from other active pages. Do not apply to source or contradiction pages. (info)
- `missing_source_metadata` — active page with empty or absent sources[] array
  (warning)
- `inline_citation_missing` — active page body contains no `[source: ...]` pattern
  (info) — requires fetching page content from blob
- `open_contradiction` — type: contradiction page with no string “resolution:” in
  body (error) — requires fetching page content from blob
- `broken_reference` — related[] entry references a filename absent from
  manifest.json (error)
- `unverified_stale` — confidence: unverified and updated > 30 days ago (warning)
- `stale_embedding` — manifest.json updated for a page does not match Qdrant payload
  updated field for that filename. Compare after scrolling Qdrant. (warning)
- `source_not_indexed` — raw_manifest.json entry with embedding_status: failed or
  chunks_indexed: 0 (error)
- `index_entry_missing_page` — manifest.json entry with no corresponding file in
  library-wiki/pages/ blob list (error)

gap_detected is not a lint issue. Gap detection belongs in library_query only.

-----

## Frontmatter format

Generated by library_update from structured inputs. Never parsed from content input.

```yaml
---
title: [from input]
type: [from input]
domain: [from input]
confidence: [from input]
status: [from input, default: active]
summary: [from input]
tags: [from input as YAML list]
sources: [from input as YAML list]
related: [from input as YAML list]
review_after: [from input, omit field entirely if not provided]
created: [preserved from existing page, or ISO now if new]
updated: [ISO now]
---
```

Use a simple string template to generate frontmatter. Do not use a YAML library
that might reformat or reorder fields unexpectedly.

-----

## UUIDv5 point ID generation

Use the `uuid` npm package (v9+):

```typescript
import { v5 as uuidv5 } from 'uuid'

const NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8' // URL namespace

function wikiPagePointId(libraryId: string, filename: string): string {
  return uuidv5(`wiki_page:${libraryId}:${filename}`, NAMESPACE)
}

function rawChunkPointId(libraryId: string, sourceId: string, chunkIndex: number): string {
  return uuidv5(`raw_chunk:${libraryId}:${sourceId}:${chunkIndex}`, NAMESPACE)
}
```

These IDs are stable — calling with the same inputs always produces the same UUID.
That is what makes upsert idempotent.

-----

## Qdrant collection setup

Collection: `library`
Vector size: 1536
Distance: Cosine

On startup:

1. GET /collections/{name} — check if exists
1. If not found (404): return STORAGE_ERROR and halt. Do not attempt to create
   the collection. The collection must be pre-created with the correct dense vector,
   sparse vector (IDF), and payload indexes configured manually.
1. If found: verify dense vector size === 1536 and distance === Cosine,
   and sparse vector “text” exists.
1. If any mismatch: return STORAGE_ERROR, halt.

-----

## manifest.json

```json
{
  "library_id": "default",
  "updated": "ISO date",
  "pages": [
    {
      "filename": "service-patterns.md",
      "title": "...",
      "type": "concept",
      "domain": "...",
      "confidence": "medium",
      "status": "active",
      "summary": "...",
      "tags": ["..."],
      "sources": ["..."],
      "related": ["..."],
      "created": "ISO date",
      "updated": "ISO date",
      "embedding_status": "ok | failed | pending"
    }
  ]
}
```

## raw_manifest.json

```json
{
  "library_id": "default",
  "updated": "ISO date",
  "sources": [
    {
      "source_id": "2026/05/example-abc12345.md",
      "title": "...",
      "source_type": "primary",
      "domain": "...",
      "source_url": "...",
      "created": "ISO date",
      "chunks_indexed": 12,
      "embedding_status": "ok | failed"
    }
  ]
}
```

-----

## ID format

Source IDs: `{YYYY}/{MM}/{slugified-title}-{8-char-hash-of-content}.md`
Slug: lowercase, spaces→hyphens, strip non-alphanumeric except hyphens, max 60 chars.
Hash: first 8 characters of SHA-256 hex of content string.

Wiki page IDs: the filename (caller-provided, kebab-case .md).

Qdrant point IDs: stable UUIDv5 (see above). Never use raw filenames as point IDs.

Source ID collision: if source_id already exists in raw_manifest.json:

- Content hash matches: return ok: true, duplicate: true, existing source_id.
  Do not re-ingest.
- Content hash differs: return CONFLICT. Do not overwrite.

-----

## ETag-aware blob write pattern

```typescript
async function conditionalWrite(
  containerClient: ContainerClient,
  blobName: string,
  content: string,
  etag: string | null  // null = new file (If-None-Match: *)
): Promise<{ success: boolean; conflict: boolean; newEtag?: string }> {
  const blockBlobClient = containerClient.getBlockBlobClient(blobName)
  try {
    const response = await blockBlobClient.upload(content, Buffer.byteLength(content), {
      conditions: etag
        ? { ifMatch: etag }
        : { ifNoneMatch: '*' },
      overwrite: true
    })
    return { success: true, conflict: false, newEtag: response.etag }
  } catch (err: any) {
    if (err.statusCode === 412 || err.statusCode === 409) {
      return { success: false, conflict: true }
    }
    throw err
  }
}
```

Use this pattern for all writes to manifest.json, raw_manifest.json, index.md,
log.md, log.jsonl. For new files, pass etag: null.

-----

## MCP response envelope

```json
{ "ok": true, "data": { ... }, "warnings": [] }
```

```json
{
  "ok": false,
  "error": {
    "code": "VALIDATION_ERROR | STORAGE_ERROR | EMBEDDING_ERROR | CONFLICT | NOT_FOUND",
    "message": "human-readable description",
    "details": {}
  }
}
```

-----

## index.md format

index.md is human-readable. Generate it deterministically from manifest.json.
Do not allow the coding agent to improvise the format.

```markdown
# Library Index
Updated: {ISO_DATE}

## {domain}

### {Page Title}
- File: `{filename}`
- Type: {type}
- Confidence: {confidence}
- Status: {status}
- Summary: {summary}
```

Group pages by domain, sorted alphabetically within each group. Regenerate the
entire file on each library_update call — do not append incrementally.

-----

## Build order

Build in this sequence. Do not jump ahead.

1. storage/blobs.ts — ETag-aware read/write helpers
1. storage/qdrant.ts — Qdrant HTTP client
1. embed/openai.ts — embedding API call
1. embed/chunk.ts — text chunking
1. embed/ids.ts — UUIDv5 generation
1. storage/manifest.ts and raw-manifest.ts
1. storage/index.ts and log.ts
1. Run the three test round-trips (blob, Qdrant, embedding)
1. tools/ingest.ts
1. tools/update.ts
1. tools/query.ts
1. tools/lint.ts
1. functions/mcp.ts — wire all tools into MCP HTTP trigger

Test after each tool, not just at the end.

First real test after build: one bounded library (suggested: `ai-knowledge-layer`).
Run the full lifecycle: ingest a source → query it → create a curated page →
query the page → update the page → lint the library. This will reveal real friction
before you load any serious knowledge domain.

-----

## File structure

```
library-mcp/
  src/
    functions/
      mcp.ts              — MCP HTTP trigger, tool routing
    tools/
      ingest.ts
      query.ts
      update.ts
      lint.ts
    storage/
      blobs.ts            — ETag-aware read/write helpers, container clients
      qdrant.ts           — Qdrant HTTP client (no SDK)
      manifest.ts         — manifest.json read/write
      raw-manifest.ts     — raw_manifest.json read/write
      index.ts            — index.md read/write
      log.ts              — log.md and log.jsonl append
    embed/
      openai.ts           — OpenAI embedding API call
      chunk.ts            — text chunking
      ids.ts              — UUIDv5 point ID generation
    types.ts              — shared TypeScript types
  host.json
  local.settings.json.example
  package.json
  tsconfig.json
  CLAUDE-library.md       — librarian schema (not this file)
```

-----

## Test first

Before building any tools, verify these three round-trips independently.
Write a small test script for each. Do not proceed until all three pass.

**1. Blob round-trip**

```typescript
// write a file
await containerClient.getBlockBlobClient('test.txt').upload('hello', 5)
// read it back with ETag
const download = await containerClient.getBlockBlobClient('test.txt').download()
const etag = download.etag
// conditional write — should succeed
await conditionalWrite(containerClient, 'test.txt', 'hello2', etag)
// conditional write with stale ETag — should return conflict: true
const stale = await conditionalWrite(containerClient, 'test.txt', 'hello3', etag)
console.assert(stale.conflict === true)
```

**2. Qdrant round-trip**

```typescript
// verify collection exists (do NOT create — already exists on stark-library)
const info = await fetch(`${QDRANT_URL}/collections/library`, {
  headers: { 'api-key': QDRANT_API_KEY }
})
const data = await info.json()
console.assert(data.result.config.params.vectors.default.size === 1536)
console.assert('text' in data.result.config.params.sparse_vectors)

// upsert a test point with both dense and sparse vectors
const testId = uuidv5('test:round-trip', NAMESPACE)
await fetch(`${QDRANT_URL}/collections/library/points`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json', 'api-key': QDRANT_API_KEY },
  body: JSON.stringify({ points: [{
    id: testId,
    vector: {
      default: Array(1536).fill(0.1),
      text: { indices: [42, 137], values: [0.71, 0.43] }
    },
    payload: { record_type: 'wiki_page', library_id: 'test', filename: 'test.md' }
  }]})
})

// hybrid search and confirm payload returns
const result = await fetch(`${QDRANT_URL}/collections/library/points/query`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'api-key': QDRANT_API_KEY },
  body: JSON.stringify({
    prefetch: [
      { query: Array(1536).fill(0.1), using: 'default', limit: 5 },
      { query: { indices: [42, 137], values: [0.71, 0.43] }, using: 'text', limit: 5 }
    ],
    query: { rrf: {} },
    limit: 1,
    with_payload: true,
    filter: { must: [{ key: 'library_id', match: { value: 'test' } }] }
  })
})
const res = await result.json()
console.assert(res.result[0].payload.filename === 'test.md')

// clean up test point
await fetch(`${QDRANT_URL}/collections/library/points/delete`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'api-key': QDRANT_API_KEY },
  body: JSON.stringify({ points: [testId] })
})
```

**3. Embedding round-trip**

```typescript
const response = await fetch('https://api.openai.com/v1/embeddings', {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: 'text-embedding-3-small', input: 'test text' })
})
const data = await response.json()
const vector = data.data[0].embedding
console.assert(vector.length === 1536)
```

All three must pass before building any tool.

-----

## Done means

- All four tools callable via MCP protocol with correct response envelope
- library_ingest stores, chunks, embeds, updates raw_manifest.json only
- library_update versions previous page, generates frontmatter from inputs,
  returns ok: true if page written regardless of secondary state failures
- All shared file writes use ETag conditional writes, no silent retries
- Log failures are warnings, never errors
- library_lint runs all mechanical checks listed, fetches page content for
  inline_citation_missing and open_contradiction checks
- gap_detected is not in lint
- Stale embeddings detectable via lint by scrolling Qdrant
- Qdrant dimension mismatch raises STORAGE_ERROR at collection setup
- Deployed alongside existing func-mcp-poc functions
- Connected as MCP server in Claude settings

## Proof of life test

After deployment, run this sequence using the library on itself.

**1. Ingest the build schema**
Call library_ingest with this CLAUDE-build.md as the source content.
source_type: primary, domain: ai-knowledge-layer

**2. Create five curated pages via library_update**

- knowledge-extension-layer.md — what this system is and why it exists
- rag-vs-mcp-vs-knowledge-layer.md — the three-way distinction
- mcp-boundary-principle.md — the MCP does not reason
- library-tool-contracts.md — the four tools and their responsibilities
- failure-semantics.md — partial write behaviour and recovery model

**3. Query**
Ask: “What is the difference between this system and RAG?”

Expected behaviour:

- Curated wiki pages return first (scope: wiki is default)
- Raw source chunks available only if scope: raw or both is requested
- Gap detection is not noisy — common words filtered by stoplist
- No broken references in lint
- Stale embedding check works — all five pages show ok in Qdrant

**4. Update one page**
Update knowledge-extension-layer.md with a new paragraph.
Confirm previous version is in history/.
Confirm manifest.json updated timestamp changes.
Confirm Qdrant payload updated field changes.
Confirm lint no longer shows stale_embedding for that page.

If this loop feels useful, the system has legs. If it doesn’t, the friction
will be obvious and fixable before loading any real knowledge domain.