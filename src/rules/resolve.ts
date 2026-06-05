// Layer 1 — the deterministic resolver. PURE: no I/O, no LLM, no vectors, no network,
// no randomness. Given a ruleset and structured inputs it returns a governed eligibility
// outcome and the id of the rule that fired. This is the literal "Constitution": the same
// inputs always produce the same output, and every decision is auditable to a rule id.

import { Condition, LeafCondition, RuleSet } from '../storage/rules'

export interface EligibilityResult {
  eligibility: 'eligible' | 'ineligible' | 'indeterminate'
  rule_fired: string | null
  reason_code: string
  ruleset_version: string
  governs: string[]
}

// Resolve a dotted path (a.b.c) against the inputs object. Returns undefined if any
// segment is missing. Does not traverse through arrays by index (not needed here).
function getPath(inputs: unknown, path: string): unknown {
  let cur: any = inputs
  for (const seg of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = cur[seg]
  }
  return cur
}

function compare(op: LeafCondition['op'], left: unknown, right: unknown): boolean {
  switch (op) {
    case 'exists':
      return left !== undefined && left !== null
    case 'eq':
      return left === right
    case 'neq':
      return left !== right
    case 'in':
      return Array.isArray(right) && right.includes(left as never)
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte': {
      if (typeof left !== 'number' || typeof right !== 'number') return false
      if (op === 'lt') return left < right
      if (op === 'lte') return left <= right
      if (op === 'gt') return left > right
      return left >= right
    }
    default:
      return false
  }
}

// Recursive evaluator over the closed predicate AST. Unknown shapes evaluate to false
// (fail closed) rather than throwing, so a malformed rule cannot grant eligibility.
export function evalCondition(cond: Condition, inputs: unknown): boolean {
  if (cond && typeof cond === 'object') {
    if ('all' in cond && Array.isArray((cond as any).all)) {
      return (cond as any).all.every((c: Condition) => evalCondition(c, inputs))
    }
    if ('any' in cond && Array.isArray((cond as any).any)) {
      return (cond as any).any.some((c: Condition) => evalCondition(c, inputs))
    }
    if ('not' in cond && (cond as any).not) {
      return !evalCondition((cond as any).not, inputs)
    }
    if ('op' in cond && typeof (cond as any).op === 'string' && typeof (cond as any).path === 'string') {
      const leaf = cond as LeafCondition
      return compare(leaf.op, getPath(inputs, leaf.path), leaf.value)
    }
  }
  return false
}

// Minimal, hand-rolled input check derived from ruleset.input_schema. Supports only the
// top-level `required: string[]` list (presence check). Returns the missing field names.
// Kept intentionally tiny — a full JSON Schema validator (ajv) is out of scope here.
export function missingRequiredInputs(ruleset: RuleSet, inputs: unknown): string[] {
  const schema = ruleset.input_schema
  if (!schema || typeof schema !== 'object') return []
  const required = (schema as any).required
  if (!Array.isArray(required)) return []
  const obj = (inputs ?? {}) as Record<string, unknown>
  return required.filter((k) => typeof k === 'string' && (obj[k] === undefined || obj[k] === null))
}

// Resolve eligibility: walk rules in order, return on the FIRST match (order = priority).
// Fall back to default_outcome when nothing matches.
export function resolveEligibility(ruleset: RuleSet, inputs: unknown): EligibilityResult {
  for (const rule of ruleset.rules || []) {
    if (evalCondition(rule.when, inputs)) {
      return {
        eligibility: rule.outcome.eligibility,
        rule_fired: rule.id,
        reason_code: rule.outcome.reason_code,
        ruleset_version: ruleset.version,
        governs: rule.outcome.governs ?? []
      }
    }
  }
  const d = ruleset.default_outcome
  return {
    eligibility: d.eligibility,
    rule_fired: null,
    reason_code: d.reason_code,
    ruleset_version: ruleset.version,
    governs: d.governs ?? []
  }
}
