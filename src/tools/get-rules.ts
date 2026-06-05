// Layer 1 read/evaluate handler, surfaced via library_info `resource: rules`.
// Two modes on one handler:
//   - no `inputs`            → return the raw ruleset (inspection).
//   - `inputs: {...}` given  → run the deterministic resolver and return the governed
//                              EligibilityResult (which rule fired, reason, version).
// Reports rules_found: false when a domain has no ruleset (inherit global doctrine).

import { DomainEnvelope, DomainException, ToolDefinition, ok, toEnvelope } from '../types'
import { readRules } from '../storage/rules'
import { resolveEligibility, missingRequiredInputs } from '../rules/resolve'

const inputSchema = {
  type: 'object',
  properties: {
    domain: { type: 'string' },
    // When provided, the ruleset is evaluated against these structured facts.
    inputs: { type: 'object' }
  },
  required: ['domain'],
  additionalProperties: true
}

async function getRulesImpl(input: unknown): Promise<DomainEnvelope> {
  const a = (input ?? {}) as Record<string, any>
  if (typeof a.domain !== 'string' || !a.domain) {
    throw new DomainException('VALIDATION_ERROR', 'domain is required')
  }
  const domain: string = a.domain

  const ruleset = await readRules(domain)
  if (!ruleset) {
    return ok({
      domain,
      rules_found: false,
      ruleset: null,
      note: 'No domain ruleset (Layer 1). Eligibility is indeterminate until a ruleset is written.'
    })
  }

  const hasInputs = a.inputs !== undefined && a.inputs !== null
  if (!hasInputs) {
    return ok({ domain, rules_found: true, ruleset })
  }
  if (typeof a.inputs !== 'object' || Array.isArray(a.inputs)) {
    throw new DomainException('VALIDATION_ERROR', 'inputs must be a JSON object when provided')
  }

  const warnings: string[] = []
  const missing = missingRequiredInputs(ruleset, a.inputs)
  if (missing.length) warnings.push(`missing_required_inputs:${missing.join(',')}`)

  const result = resolveEligibility(ruleset, a.inputs)
  return ok({ domain, rules_found: true, eligibility: result }, warnings)
}

export const getRulesTool: ToolDefinition = {
  name: 'library_get_rules',
  description:
    'Layer 1 (Constitution). Return the per-domain deterministic ruleset, or — when ' +
    '`inputs` is supplied — resolve eligibility against it and return the governed outcome ' +
    '(eligibility, the rule_fired id, reason_code, ruleset_version). Deterministic: no LLM, ' +
    'no vectors. Reports rules_found: false when a domain has no ruleset.',
  inputSchema,
  handler: (input) => toEnvelope(() => getRulesImpl(input))
}
