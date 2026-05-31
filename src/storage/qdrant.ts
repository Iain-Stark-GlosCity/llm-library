// Qdrant HTTP client via raw fetch (no SDK). The collection is pre-created externally;
// we verify it (once per cold start) and never create it. See CLAUDE.md "Qdrant HTTP API".

import { getConfig } from '../config'
import { DomainException } from '../types'
import { SparseVector } from '../embed/sparse'

export interface QdrantPoint {
  id: string
  vector: {
    default: number[]
    text: SparseVector
  }
  payload: Record<string, unknown>
}

export interface QdrantHit {
  id: string | number
  score: number
  payload: Record<string, any>
}

function conn() {
  const cfg = getConfig()
  if (!cfg.qdrantUrl) {
    throw new DomainException('STORAGE_ERROR', 'QDRANT_URL is not configured')
  }
  return { url: cfg.qdrantUrl, collection: cfg.qdrantCollection, apiKey: cfg.qdrantApiKey }
}

function headers(apiKey?: string): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' }
  if (apiKey) h['api-key'] = apiKey
  return h
}

// Verify the collection exists with the expected dense + sparse configuration.
async function verifyCollection(): Promise<void> {
  const { url, collection, apiKey } = conn()
  let resp: Response
  try {
    resp = await fetch(`${url}/collections/${collection}`, { headers: headers(apiKey) })
  } catch (err) {
    throw new DomainException('STORAGE_ERROR', `Qdrant unreachable: ${(err as Error).message}`)
  }
  if (resp.status === 404) {
    throw new DomainException('STORAGE_ERROR', `Qdrant collection "${collection}" not found (must be pre-created)`)
  }
  if (!resp.ok) {
    throw new DomainException('STORAGE_ERROR', `Qdrant collection check failed: ${resp.status}`)
  }
  const data = (await resp.json()) as any
  const dense = data.result?.config?.params?.vectors?.default
  if (!dense || dense.size !== 1536 || dense.distance !== 'Cosine') {
    throw new DomainException(
      'STORAGE_ERROR',
      'Qdrant dense vector config mismatch (expected default size 1536, distance Cosine)'
    )
  }
  const sparse = data.result?.config?.params?.sparse_vectors
  if (!sparse || !('text' in sparse)) {
    throw new DomainException('STORAGE_ERROR', 'Qdrant sparse vector "text" is missing')
  }
}

let verifyPromise: Promise<void> | null = null

// Memoised per cold start; resets on failure so a transient error can be retried.
export function ensureCollection(): Promise<void> {
  if (!verifyPromise) {
    verifyPromise = verifyCollection().catch((err) => {
      verifyPromise = null
      throw err
    })
  }
  return verifyPromise
}

export async function upsertPoints(points: QdrantPoint[]): Promise<void> {
  if (points.length === 0) return
  const { url, collection, apiKey } = conn()
  const resp = await fetch(`${url}/collections/${collection}/points?wait=true`, {
    method: 'PUT',
    headers: headers(apiKey),
    body: JSON.stringify({ points })
  })
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new DomainException('STORAGE_ERROR', `Qdrant upsert failed: ${resp.status} ${text}`)
  }
}

export async function hybridQuery(opts: {
  dense: number[]
  sparse: SparseVector
  filter?: unknown
  limit: number
  prefetchLimit?: number
}): Promise<QdrantHit[]> {
  const { url, collection, apiKey } = conn()
  const prefetchLimit = opts.prefetchLimit ?? Math.max(opts.limit, 20)
  const densePrefetch: Record<string, unknown> = {
    query: opts.dense,
    using: 'default',
    limit: prefetchLimit
  }
  if (opts.filter) densePrefetch.filter = opts.filter

  const body: any = {
    query: opts.dense,
    using: 'default',
    limit: opts.limit,
    with_payload: true
  }

  if (opts.sparse.indices.length > 0) {
    const sparsePrefetch: Record<string, unknown> = {
      query: { indices: opts.sparse.indices, values: opts.sparse.values },
      using: 'text',
      limit: prefetchLimit
    }
    if (opts.filter) sparsePrefetch.filter = opts.filter

    body.prefetch = [densePrefetch, sparsePrefetch]
    body.query = { rrf: {} }
    delete body.using
  }

  if (opts.filter) body.filter = opts.filter

  const resp = await fetch(`${url}/collections/${collection}/points/query`, {
    method: 'POST',
    headers: headers(apiKey),
    body: JSON.stringify(body)
  })
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new DomainException('STORAGE_ERROR', `Qdrant query failed: ${resp.status} ${text}`)
  }
  const data = (await resp.json()) as any
  const points = data.result?.points ?? data.result ?? []
  return points.map((p: any) => ({ id: p.id, score: p.score ?? 0, payload: p.payload ?? {} }))
}

// Enumerate all points matching a filter, paginating until exhausted.
export async function scrollPoints(filter: unknown, limit = 100): Promise<QdrantHit[]> {
  const { url, collection, apiKey } = conn()
  const all: QdrantHit[] = []
  let offset: unknown = null
  do {
    const resp = await fetch(`${url}/collections/${collection}/points/scroll`, {
      method: 'POST',
      headers: headers(apiKey),
      body: JSON.stringify({ filter, with_payload: true, limit, offset })
    })
    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      throw new DomainException('STORAGE_ERROR', `Qdrant scroll failed: ${resp.status} ${text}`)
    }
    const data = (await resp.json()) as any
    for (const p of data.result?.points ?? []) {
      all.push({ id: p.id, score: 0, payload: p.payload ?? {} })
    }
    offset = data.result?.next_page_offset ?? null
  } while (offset !== null && offset !== undefined)
  return all
}

export async function setPayload(points: Array<string | number>, payload: Record<string, unknown>): Promise<void> {
  if (points.length === 0) return
  const { url, collection, apiKey } = conn()
  const resp = await fetch(`${url}/collections/${collection}/points/payload?wait=true`, {
    method: 'POST',
    headers: headers(apiKey),
    body: JSON.stringify({ points, payload })
  })
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new DomainException('STORAGE_ERROR', `Qdrant payload update failed: ${resp.status} ${text}`)
  }
}
