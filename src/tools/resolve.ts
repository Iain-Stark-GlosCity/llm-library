// library_resolve — the single governed query that ties the three layers together and
// leaves the LLM with nothing but translation. Pipeline, in order:
//   1. Layer 1 (Constitution): resolve eligibility deterministically, BEFORE retrieval.
//   2. Layer 2 (Library): retrieve sourced context with provenance + freshness + use-gov,
//      by REUSING library_query's handler (no duplicated retrieval logic).
//   3. Layer 3 (Reasoning Map): traverse to the governing answer SHAPE + safety constraints.
// It then emits one governed-answer package whose `translation_brief` is an explicit
// instruction set: the consumer LLM renders prose to that shape, citing the given sources,
// and makes no eligibility, retrieval, or safety judgements of its own.

import { DomainEnvelope, DomainException, ToolDefinition, ok, toEnvelope } from '../types'
import { readRules } from '../storage/rules'
import { resolveEligibility, missingRequiredInputs, EligibilityResult } from '../rules/resolve'
import { loadGraph } from '../rdf/graph'
import { getEngine } from '../rdf/engine'
import { answerShapeFor, ReasoningResult } from '../rdf/reason'
import { queryTool } from './query'

const inputSchema = {
  type: 'object',
  properties: {
    domain: { type: 'string' },
    question: { type: 'string' },
    // A library use mode (analysis | drafting | staff_guidance | public_guidance |
    // decision_support). Operational intents are refused by the Layer 2 retrieval.
    intent: { type: 'string' },
    // Structured facts for Layer 1 eligibility resolution.
    inputs: { type: 'object' },
    // Active question signals for Layer 3, e.g. { bailiff_present: true }.
    signals: { type: 'object' },
    top_k: { type: 'integer', minimum: 1, maximum: 20 },
    library_id: { type: 'string' }
  },
  required: ['domain', 'question'],
  additionalProperties: false
}

function emptyEligibility(): EligibilityResult {
  return {
    eligibility: 'indeterminate',
    rule_fired: null,
    reason_code: 'no_ruleset',
    ruleset_version: 'none',
    governs: []
  }
}

function emptyReasoning(): ReasoningResult {
  return {
    matched_intersection: null,
    answer_shape: null,
    safety_constraints: [],
    must_include: [],
    must_not: [],
    overrides: []
  }
}

async function resolveImpl(input: unknown): Promise<DomainEnvelope> {
  const a = (input ?? {}) as Record<string, any>
  if (typeof a.domain !== 'string' || !a.domain) {
    throw new DomainException('VALIDATION_ERROR', 'domain is required')
  }
  if (typeof a.question !== 'string' || !a.question.trim()) {
    throw new DomainException('VALIDATION_ERROR', 'question is required')
  }
  const domain: string = a.domain
  const intent = typeof a.intent === 'string' ? a.intent : undefined
  const inputs = a.inputs && typeof a.inputs === 'object' && !Array.isArray(a.inputs) ? a.inputs : {}
  const signals = a.signals && typeof a.signals === 'object' && !Array.isArray(a.signals) ? a.signals : {}
  const warnings: string[] = []

  // --- Layer 1: deterministic eligibility, resolved before the LLM is involved. ---
  let eligibility: EligibilityResult
  const ruleset = await readRules(domain)
  if (!ruleset) {
    eligibility = emptyEligibility()
    warnings.push('no_ruleset')
  } else {
    const missing = missingRequiredInputs(ruleset, inputs)
    if (missing.length) warnings.push(`missing_required_inputs:${missing.join(',')}`)
    eligibility = resolveEligibility(ruleset, inputs)
  }

  // --- Layer 2: sourced context via the existing library_query handler. ---
  const queryEnvelope = await queryTool.handler({
    question: a.question,
    domain,
    ...(intent ? { intended_use: intent } : {}),
    ...(typeof a.top_k === 'number' ? { top_k: a.top_k } : {}),
    ...(typeof a.library_id === 'string' ? { library_id: a.library_id } : {})
  })
  if (!queryEnvelope.ok) {
    // A hard retrieval failure (validation/storage) — surface it as the resolve failure.
    return queryEnvelope
  }
  const context = queryEnvelope.data as {
    results: any[]
    gaps: string[]
    query_id: string
    use_decision?: unknown
  }
  for (const w of queryEnvelope.warnings) warnings.push(`query:${w}`)

  // --- Layer 3: answer-shape + safety constraints from the reasoning map. ---
  let reasoning = emptyReasoning()
  const loaded = await loadGraph(domain)
  if (loaded.found && loaded.graph) {
    const engine = await getEngine()
    reasoning = await answerShapeFor(engine, loaded.graph, {
      domain,
      intent,
      eligibility: eligibility.eligibility,
      signals
    })
  } else {
    warnings.push('no_reasoning_map')
  }

  // --- Compose the governed answer package. ---
  const eligible = eligibility.eligibility === 'eligible'
  const permittedResults = (context.results || []).filter((r) =>
    intent ? r.use_permitted === true : true
  )
  const hasPermittedContext = permittedResults.length > 0
  // The map can hard-block by demanding a Refuse shape; otherwise it only shapes the answer.
  const reasoningBlocks = reasoning.answer_shape === 'Refuse'
  const allowed = eligible && hasPermittedContext && !reasoningBlocks

  // Sources the LLM must cite: the provenance source_ids of the permitted curated results.
  const citeSources = Array.from(
    new Set(
      permittedResults.flatMap((r) =>
        Array.isArray(r?.provenance?.sources)
          ? r.provenance.sources.map((s: any) => s?.source_id).filter((id: unknown) => typeof id === 'string')
          : []
      )
    )
  )

  const translationBrief = {
    allowed,
    answer_shape: reasoning.answer_shape,
    safety_constraints: reasoning.safety_constraints,
    must_include: reasoning.must_include,
    must_not: reasoning.must_not,
    cite_sources: citeSources,
    note: allowed
      ? 'Render prose to answer_shape using only the cited context; honour must_include/must_not; do not exceed the governed answer.'
      : !eligible
        ? 'Not eligible under Layer 1; do not assert eligibility. Explain the position and, if a shape is set, follow it.'
        : !hasPermittedContext
          ? 'No permitted curated context for this intent; do not answer substantively.'
          : 'Reasoning map blocks a substantive answer for this intersection.'
  }

  return ok({ eligibility, context, reasoning, translation_brief: translationBrief }, warnings)
}

export const resolveTool: ToolDefinition = {
  name: 'library_resolve',
  description:
    'Produce a governed answer package for a question by composing all three layers: ' +
    'Layer 1 resolves eligibility deterministically (which rule fired), Layer 2 retrieves ' +
    'sourced context with provenance + freshness + permitted-use, and Layer 3 traverses the ' +
    'reasoning map for the required answer_shape and safety constraints. Returns a ' +
    'translation_brief (allowed, answer_shape, safety_constraints, must_include/must_not, ' +
    'cite_sources) for an LLM to render into language — the LLM makes no governance ' +
    'decisions. Inputs: domain, question, optional intent (use mode), inputs (L1 facts), ' +
    'signals (e.g. { bailiff_present: true }).',
  inputSchema,
  handler: (input) => toEnvelope(() => resolveImpl(input))
}
