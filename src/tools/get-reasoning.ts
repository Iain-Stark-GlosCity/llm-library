// Layer 3 read/traverse handler, surfaced via library_info `resource: reasoning`.
// Two modes on one handler:
//   - no `signals`            → return the raw Turtle map (inspection).
//   - `signals: {...}` given  → traverse to the applicable semantic intersection and return
//                               the required answer shape + safety constraints.
// Reports reasoning_found: false when a domain has no Turtle map.

import { DomainEnvelope, DomainException, ToolDefinition, ok, toEnvelope } from '../types'
import { loadGraph } from '../rdf/graph'
import { getEngine } from '../rdf/engine'
import { answerShapeFor } from '../rdf/reason'

const inputSchema = {
  type: 'object',
  properties: {
    domain: { type: 'string' },
    intent: { type: 'string' },
    eligibility: { type: 'string' },
    // Active question signals, e.g. { bailiff_present: true }. When present, the map is
    // traversed and the governing answer shape is returned.
    signals: { type: 'object' }
  },
  required: ['domain'],
  additionalProperties: true
}

async function getReasoningImpl(input: unknown): Promise<DomainEnvelope> {
  const a = (input ?? {}) as Record<string, any>
  if (typeof a.domain !== 'string' || !a.domain) {
    throw new DomainException('VALIDATION_ERROR', 'domain is required')
  }
  const domain: string = a.domain

  const loaded = await loadGraph(domain)
  if (!loaded.found || !loaded.graph) {
    return ok({
      domain,
      reasoning_found: false,
      turtle: null,
      note: 'No reasoning map (Layer 3) for this domain. No answer-shape constraints apply.'
    })
  }

  const hasSignals = a.signals !== undefined && a.signals !== null
  if (!hasSignals) {
    return ok({ domain, reasoning_found: true, engine: loaded.graph.engine, turtle: loaded.turtle })
  }
  if (typeof a.signals !== 'object' || Array.isArray(a.signals)) {
    throw new DomainException('VALIDATION_ERROR', 'signals must be a JSON object when provided')
  }

  const engine = await getEngine()
  const reasoning = await answerShapeFor(engine, loaded.graph, {
    domain,
    intent: typeof a.intent === 'string' ? a.intent : undefined,
    eligibility: typeof a.eligibility === 'string' ? a.eligibility : undefined,
    signals: a.signals
  })
  return ok({ domain, reasoning_found: true, engine: engine.name, reasoning })
}

export const getReasoningTool: ToolDefinition = {
  name: 'library_get_reasoning',
  description:
    'Layer 3 (Reasoning Map). Return the per-domain Turtle map, or — when `signals` is ' +
    'supplied — traverse it to the governing semantic intersection and return the required ' +
    'answer_shape, safety_constraints, must_include/must_not, and what it overrides. ' +
    'oxigraph answers via SPARQL; the n3 fallback via triple traversal. ' +
    'Reports reasoning_found: false when a domain has no map.',
  inputSchema,
  handler: (input) => toEnvelope(() => getReasoningImpl(input))
}
