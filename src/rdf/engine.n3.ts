// N3.js implementation of RdfEngine. Pure JS, no WASM — the fallback for when oxigraph's
// cold-start cost is unwelcome (LIBRARY_RDF_ENGINE=n3). It does NOT do SPARQL; the reasoner
// uses quads() triple-pattern traversal for this engine. require()'d lazily like oxigraph.

import { DomainException } from '../types'
import { LoadedGraph, RdfEngine, Row, Triple } from './engine'

let mod: any = null

function lib(): any {
  if (mod) return mod
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    mod = require('n3')
  } catch (err: any) {
    throw new DomainException(
      'STORAGE_ERROR',
      `n3 is not installed (${err?.message || err}). Run npm install, or set LIBRARY_RDF_ENGINE=oxigraph.`
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

export const n3Engine: RdfEngine = {
  name: 'n3',

  async load(turtle: string): Promise<LoadedGraph> {
    const N3 = lib()
    const store = new N3.Store()
    try {
      const quads = new N3.Parser().parse(turtle)
      store.addQuads(quads)
    } catch (err: any) {
      throw new DomainException('VALIDATION_ERROR', `Turtle failed to parse: ${err?.message || err}`)
    }
    return { engine: 'n3', handle: store }
  },

  async query(): Promise<Row[]> {
    throw new DomainException(
      'VALIDATION_ERROR',
      'SPARQL is not available with LIBRARY_RDF_ENGINE=n3; the reasoner uses triple traversal here.'
    )
  },

  async quads(
    graph: LoadedGraph,
    subject: string | null,
    predicate: string | null,
    object: string | null
  ): Promise<Triple[]> {
    const N3 = lib()
    const store = graph.handle as any
    const s = subject ? N3.DataFactory.namedNode(subject) : null
    const p = predicate ? N3.DataFactory.namedNode(predicate) : null
    const o = object ? N3.DataFactory.namedNode(object) : null
    const quads = store.getQuads(s, p, o, null)
    return quads.map((q: any) => ({
      subject: q.subject.value,
      predicate: q.predicate.value,
      object: q.object.value,
      objectType: termType(q.object)
    }))
  }
}
