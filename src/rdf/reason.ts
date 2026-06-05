// Layer 3 — the reasoner. Given the active signals (and the domain/intent/eligibility for
// context), find the SemanticIntersection node that applies and read what answer SHAPE and
// SAFETY constraints it imposes. This is the "bailiff at the door" logic: not a rule, not a
// fact, but a semantic intersection that governs the permissible response shape.
//
// The oxigraph engine answers via real SPARQL 1.1; the n3 fallback answers via triple
// traversal. Both produce the same ReasoningResult.

import { LoadedGraph, RdfEngine, engineSupportsSparql, Triple } from './engine'

export const NS = {
  ctax: 'https://stark.local/ctax#',
  shape: 'https://stark.local/shape#',
  rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'
}

const P = {
  type: NS.rdf + 'type',
  intersection: NS.ctax + 'SemanticIntersection',
  inDomain: NS.ctax + 'inDomain',
  whenSignal: NS.ctax + 'whenSignal',
  requiresAnswerShape: NS.ctax + 'requiresAnswerShape',
  hasSafetyConstraint: NS.ctax + 'hasSafetyConstraint',
  mustInclude: NS.ctax + 'mustInclude',
  mustNot: NS.ctax + 'mustNot',
  overrides: NS.ctax + 'overrides'
}

export interface ReasoningInput {
  domain: string
  intent?: string
  eligibility?: string
  signals: Record<string, unknown>
}

export interface ReasoningResult {
  matched_intersection: string | null
  answer_shape: string | null
  safety_constraints: string[]
  must_include: string[]
  must_not: string[]
  overrides: string[]
}

// Local name of an IRI (after the last '#' or '/'); pass literals through unchanged.
function localName(value: string): string {
  const hash = value.lastIndexOf('#')
  const slash = value.lastIndexOf('/')
  const cut = Math.max(hash, slash)
  return cut >= 0 ? value.slice(cut + 1) : value
}

// Signals whose value is truthy are "active".
function activeSignals(signals: Record<string, unknown>): string[] {
  return Object.keys(signals || {}).filter((k) => !!signals[k])
}

function emptyResult(): ReasoningResult {
  return {
    matched_intersection: null,
    answer_shape: null,
    safety_constraints: [],
    must_include: [],
    must_not: [],
    overrides: []
  }
}

// Fold the matched intersection's properties into a ReasoningResult. `props` is the list of
// (predicate, object, objectType) triples for the single matched intersection subject.
function foldProps(subjectIri: string, props: { predicate: string; object: string; objectType: string }[]): ReasoningResult {
  const r = emptyResult()
  r.matched_intersection = localName(subjectIri)
  for (const t of props) {
    switch (t.predicate) {
      case P.requiresAnswerShape:
        r.answer_shape = localName(t.object)
        break
      case P.hasSafetyConstraint:
        r.safety_constraints.push(t.object)
        break
      case P.mustInclude:
        r.must_include.push(t.object)
        break
      case P.mustNot:
        r.must_not.push(t.object)
        break
      case P.overrides:
        r.overrides.push(localName(t.object))
        break
    }
  }
  return r
}

// SPARQL path (oxigraph). One SELECT returns every property of the intersection(s) whose
// domain matches and whose whenSignal is among the active signals.
async function reasonViaSparql(
  engine: RdfEngine,
  graph: LoadedGraph,
  domain: string,
  signals: string[]
): Promise<ReasoningResult> {
  if (signals.length === 0) return emptyResult()
  const inList = signals.map((s) => JSON.stringify(s)).join(', ')
  const sparql = `
    PREFIX ctax: <${NS.ctax}>
    SELECT ?intersection ?prop ?value WHERE {
      ?intersection a ctax:SemanticIntersection ;
                    ctax:inDomain ${JSON.stringify(domain)} ;
                    ctax:whenSignal ?sig ;
                    ?prop ?value .
      FILTER(?sig IN (${inList}))
    }`
  const rows = await engine.query(graph, sparql)
  if (rows.length === 0) return emptyResult()
  // Take the first matched intersection (the slice has exactly one); group its props.
  const subject = rows[0].intersection
  const props = rows
    .filter((row) => row.intersection === subject)
    .map((row) => ({ predicate: row.prop, object: row.value, objectType: 'Literal' }))
  return foldProps(subject, props)
}

// Triple-traversal path (n3 fallback). Find intersection subjects, filter by domain +
// signal, then read all their props.
async function reasonViaQuads(
  engine: RdfEngine,
  graph: LoadedGraph,
  domain: string,
  signals: string[]
): Promise<ReasoningResult> {
  if (signals.length === 0) return emptyResult()
  const signalSet = new Set(signals)
  const typed = await engine.quads(graph, null, P.type, P.intersection)
  for (const t of typed) {
    const subject = t.subject
    const all: Triple[] = await engine.quads(graph, subject, null, null)
    const inDomain = all.some((q) => q.predicate === P.inDomain && q.object === domain)
    const hasSignal = all.some((q) => q.predicate === P.whenSignal && signalSet.has(q.object))
    if (inDomain && hasSignal) {
      return foldProps(
        subject,
        all.map((q) => ({ predicate: q.predicate, object: q.object, objectType: q.objectType }))
      )
    }
  }
  return emptyResult()
}

export async function answerShapeFor(
  engine: RdfEngine,
  graph: LoadedGraph,
  input: ReasoningInput
): Promise<ReasoningResult> {
  const signals = activeSignals(input.signals)
  if (engineSupportsSparql(graph)) {
    return reasonViaSparql(engine, graph, input.domain, signals)
  }
  return reasonViaQuads(engine, graph, input.domain, signals)
}
