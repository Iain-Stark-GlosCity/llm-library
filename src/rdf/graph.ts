// Load a domain's Turtle reasoning map from blob and parse it into a graph handle.
// Module-level cache keyed by (domain, engine, etag): the Turtle is canonical in blob and
// parsed once per cold start, reused across warm invocations, and invalidated when the
// blob's ETag changes. Mirrors the *Init singleton idiom in storage/blobs.ts.

import { getRdfContainer, readBlob } from '../storage/blobs'
import { getEngine, LoadedGraph } from './engine'

interface CacheEntry {
  etag: string
  engine: string
  graph: LoadedGraph
}

const cache = new Map<string, CacheEntry>()

function blobName(domain: string): string {
  return `${domain}.ttl`
}

export interface GraphLoad {
  found: boolean
  graph: LoadedGraph | null
  turtle: string | null
}

export async function loadGraph(domain: string): Promise<GraphLoad> {
  const container = await getRdfContainer()
  const res = await readBlob(container, blobName(domain))
  if (!res) return { found: false, graph: null, turtle: null }

  const engine = await getEngine()
  const cached = cache.get(domain)
  if (cached && cached.etag === res.etag && cached.engine === engine.name) {
    return { found: true, graph: cached.graph, turtle: res.content }
  }

  const graph = await engine.load(res.content)
  cache.set(domain, { etag: res.etag, engine: engine.name, graph })
  return { found: true, graph, turtle: res.content }
}
