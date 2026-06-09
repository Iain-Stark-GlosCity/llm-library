// Layer 3 — the reasoner. Given the active signals (and the domain/intent/eligibility for
// context), find the SemanticIntersection node that applies and read what answer SHAPE and
// SAFETY constraints it imposes. This is the "bailiff at the door" logic: not a rule, not a
// fact, but a semantic intersection that governs the permissible response shape.
//
// The oxigraph engine answers via real SPARQL 1.1; the n3 fallback answers via triple
// traversal. Both produce the same ReasoningResult.

import { LoadedGraph, RdfEngine, engineSupportsSparql, Triple } from './engine'

// The engine ontology namespace. This is the SYSTEM vocabulary every domain reuses
// verbatim — it is NOT domain-specific. The domain is carried as the string value of
// sov:inDomain, never in the namespace. Only these IRIs are load-bearing; subject IRIs and
// the objects of requiresAnswerShape/overrides are read by local name only (so the `shape:`
// namespace is cosmetic), and constraint values are free literals.
//
// These are URNs, not URLs. An RDF IRI is an opaque identifier, never dereferenced — nothing
// ever makes a network call to it — so a `urn:` scheme makes that explicit and removes any
// reliance on a (resolvable or unresolvable) hostname. This matters in Azure: there is no host
// to look up, no DNS, nothing "local". To rebind the vocabulary to an owned domain later,
// change these constants and re-issue each {domain}.ttl.
export const NS = {
  sov: 'urn:sovereign:',
  shape: 'urn:sovereign:shape:',
  rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'
}

const P = {
  type: NS.rdf + 'type',
  intersection: NS.sov + 'SemanticIntersection',
  inDomain: NS.sov + 'inDomain',
  whenSignal: NS.sov + 'whenSignal',
  requiresAnswerShape: NS.sov + 'requiresAnswerShape',
  hasSafetyConstraint: NS.sov + 'hasSafetyConstraint',
  mustInclude: NS.sov + 'mustInclude',
  mustNot: NS.sov + 'mustNot',
  overrides: NS.sov + 'overrides',
  suppressResultPattern: NS.sov + 'suppressResultPattern',
  allowSuppressedWhenQuestionPattern: NS.sov + 'allowSuppressedWhenQuestionPattern'
}

// The predicates the reasoner recognises (everything else in the ontology namespace is a
// typo or unsupported). Exported so the write path can warn before a broken map is stored.
export const KNOWN_PREDICATES: ReadonlySet<string> = new Set([
  P.inDomain,
  P.whenSignal,
  P.requiresAnswerShape,
  P.hasSafetyConstraint,
  P.mustInclude,
  P.mustNot,
  P.overrides,
  P.suppressResultPattern,
  P.allowSuppressedWhenQuestionPattern
])
// Predicates an intersection must declare to do anything useful.
const REQUIRED_PREDICATES = [P.inDomain, P.whenSignal, P.requiresAnswerShape]

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
  suppress_result_patterns: string[]
  allow_suppressed_when_question_patterns: string[]
}

// Local name of an IRI: the part after the last '#', '/', or ':'. The ':' case lets URN-style
// IRIs (urn:sovereign:BailiffAtDoor) reduce to a clean token, while http(s) IRIs still cut at
// their trailing '#'/'/'. Plain literals (no separator) pass through unchanged.
function localName(value: string): string {
  const cut = Math.max(value.lastIndexOf('#'), value.lastIndexOf('/'), value.lastIndexOf(':'))
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
    overrides: [],
    suppress_result_patterns: [],
    allow_suppressed_when_question_patterns: []
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
      case P.suppressResultPattern:
        r.suppress_result_patterns.push(t.object)
        break
      case P.allowSuppressedWhenQuestionPattern:
        r.allow_suppressed_when_question_patterns.push(t.object)
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
    PREFIX sov: <${NS.sov}>
    SELECT ?intersection ?prop ?value WHERE {
      ?intersection a sov:SemanticIntersection ;
                    sov:inDomain ${JSON.stringify(domain)} ;
                    sov:whenSignal ?sig ;
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

// Vocabulary guard for the write path. The Turtle parse-gate only checks SYNTAX; this checks
// that the map uses the engine ontology the reasoner actually reads, so a structurally-valid
// but semantically-dead map is flagged instead of silently contributing nothing. Returns
// human-readable warning strings (never throws) — the caller decides whether to surface them.
// Works under both engines via triple traversal (no SPARQL required).
export async function checkVocabulary(engine: RdfEngine, graph: LoadedGraph): Promise<string[]> {
  const warnings: string[] = []
  const all = await engine.quads(graph, null, null, null)

  // Predicates in the ontology namespace that the reasoner does not recognise (typos like
  // sov:requireAnswerShape, or unsupported terms) — these are silently ignored at query time.
  const unknown = new Set<string>()
  for (const q of all) {
    if (q.predicate.startsWith(NS.sov) && !KNOWN_PREDICATES.has(q.predicate)) {
      unknown.add(q.predicate)
    }
  }
  for (const u of unknown) warnings.push(`unknown_reasoning_predicate:${localName(u)}`)

  // whenSignal objects must be string LITERALS: the reasoner matches them against the
  // caller's signal names, and a signal written as an IRI behaves differently per engine
  // (SPARQL FILTER ... IN never matches an IRI against a string; the n3 traversal compares
  // the full IRI text). Flag it so the map author fixes the Turtle rather than debugging
  // engine-dependent matching.
  for (const q of all) {
    if (q.predicate === P.whenSignal && q.objectType !== 'Literal') {
      warnings.push(`signal_not_literal:${localName(q.object)}`)
    }
  }

  // Intersection nodes typed in the ontology namespace.
  const subjects = all
    .filter((q) => q.predicate === P.type && q.object === P.intersection)
    .map((q) => q.subject)
  if (subjects.length === 0) {
    // Either an empty map, or the class was written in the wrong namespace (e.g. ctax:/plan:).
    warnings.push('no_semantic_intersection_found')
  }
  for (const subject of subjects) {
    const props = all.filter((q) => q.subject === subject)
    for (const required of REQUIRED_PREDICATES) {
      if (!props.some((q) => q.predicate === required)) {
        warnings.push(`intersection_missing_predicate:${localName(subject)}:${localName(required)}`)
      }
    }
  }
  return warnings
}
