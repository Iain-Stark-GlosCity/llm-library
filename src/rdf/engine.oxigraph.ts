// oxigraph implementation of RdfEngine. Real SPARQL 1.1 over an in-process WASM store.
// The dependency is require()'d lazily so a missing install surfaces as a clear runtime
// STORAGE_ERROR rather than a load-time crash, and tsc does not need the package present.

import { DomainException } from '../types'
import { LoadedGraph, RdfEngine, Row, Triple } from './engine'

let mod: any = null

function lib(): any {
  if (mod) return mod
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    mod = require('oxigraph')
  } catch (err: any) {
    throw new DomainException(
      'STORAGE_ERROR',
      `oxigraph is not installed (${err?.message || err}). Run npm install, or set LIBRARY_RDF_ENGINE=n3.`
    )
  }
  return mod
}

function termType(term: any): Triple['objectType'] {
  const t = term?.termType
  if (t === 'Literal') return 'Literal'
  if (t === 'BlankNode') return 'BlankNode'
  return 'NamedNode'
}

export const oxigraphEngine: RdfEngine = {
  name: 'oxigraph',

  async load(turtle: string): Promise<LoadedGraph> {
    const oxi = lib()
    const store = new oxi.Store()
    try {
      // oxigraph v0.4 signature: load(data, { format }). Turtle MIME type.
      store.load(turtle, { format: 'text/turtle' })
    } catch (err: any) {
      throw new DomainException('VALIDATION_ERROR', `Turtle failed to parse: ${err?.message || err}`)
    }
    return { engine: 'oxigraph', handle: store }
  },

  async query(graph: LoadedGraph, sparql: string): Promise<Row[]> {
    const store = graph.handle as any
    const out: Row[] = []
    // For SELECT, oxigraph returns an array of Map<variableName, Term>.
    const results = store.query(sparql)
    for (const binding of results) {
      const row: Row = {}
      for (const [key, term] of binding) {
        if (term && typeof term.value === 'string') row[key] = term.value
      }
      out.push(row)
    }
    return out
  },

  async quads(
    graph: LoadedGraph,
    subject: string | null,
    predicate: string | null,
    object: string | null
  ): Promise<Triple[]> {
    const oxi = lib()
    const store = graph.handle as any
    const s = subject ? oxi.namedNode(subject) : null
    const p = predicate ? oxi.namedNode(predicate) : null
    // We never match on object in the reasoner, so treat a provided object as a NamedNode.
    const o = object ? oxi.namedNode(object) : null
    const quads = store.match(s, p, o, null)
    return quads.map((q: any) => ({
      subject: q.subject.value,
      predicate: q.predicate.value,
      object: q.object.value,
      objectType: termType(q.object)
    }))
  }
}
