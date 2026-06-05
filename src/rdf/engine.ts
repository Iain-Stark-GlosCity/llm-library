// Layer 3 — the engine-agnostic seam. The reasoning map is canonical as Turtle in blob;
// at query time we parse it into an in-process graph and traverse it. Two interchangeable
// engines implement this interface so the choice is a config flip (LIBRARY_RDF_ENGINE),
// not a rewrite:
//   - oxigraph: real SPARQL 1.1 over a WASM store (the lightweight "Jena equivalent").
//   - n3:       pure-JS parser + triple-pattern traversal (no WASM cold-start cost).
// Dependencies are loaded lazily via require() inside each impl, so tsc stays green even
// when the packages are not installed, and the load cost is paid only on the RDF path.

import { getConfig } from '../config'

// Opaque parsed-graph handle. `engine` lets the reasoner pick its traversal strategy.
export interface LoadedGraph {
  engine: 'oxigraph' | 'n3'
  handle: unknown
}

// One row of a SPARQL SELECT: variable name (no leading '?') → term lexical value.
export type Row = Record<string, string>

// A matched triple, term values only (IRIs as their full string, literals as lexical form).
export interface Triple {
  subject: string
  predicate: string
  object: string
  objectType: 'NamedNode' | 'Literal' | 'BlankNode'
}

export interface RdfEngine {
  name: 'oxigraph' | 'n3'
  // Parse a Turtle document into a graph handle.
  load(turtle: string): Promise<LoadedGraph>
  // Run a SPARQL SELECT. oxigraph supports this; the n3 engine throws (use quads()).
  query(graph: LoadedGraph, sparql: string): Promise<Row[]>
  // Triple-pattern access. null = wildcard. Supported by both engines.
  quads(
    graph: LoadedGraph,
    subject: string | null,
    predicate: string | null,
    object: string | null
  ): Promise<Triple[]>
}

let cached: RdfEngine | null = null

export async function getEngine(): Promise<RdfEngine> {
  const want = getConfig().rdfEngine
  if (cached && cached.name === want) return cached
  if (want === 'n3') {
    const { n3Engine } = await import('./engine.n3')
    cached = n3Engine
  } else {
    const { oxigraphEngine } = await import('./engine.oxigraph')
    cached = oxigraphEngine
  }
  return cached
}

export function engineSupportsSparql(graph: LoadedGraph): boolean {
  return graph.engine === 'oxigraph'
}
