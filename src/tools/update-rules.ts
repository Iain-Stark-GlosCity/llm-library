// Layer 1 write handler, surfaced via the rules_write facade (rules-admin endpoint only).
// Writes {domain}.rules.json. Overwrites; no versioning beyond the ruleset's own `version`
// string (recoverable via blob soft-delete if enabled). Mirrors update-schema.ts.

import { DomainEnvelope, DomainException, ToolDefinition, ok, toEnvelope } from '../types'
import { writeRules, RuleSet } from '../storage/rules'
import { appendLog } from '../storage/log'
import { assertValidDomain } from './shared'

const inputSchema = {
  type: 'object',
  properties: {
    domain: { type: 'string', maxLength: 80 },
    // The full ruleset object: { version, input_schema?, rules[], default_outcome }.
    rules: { type: 'object' }
  },
  required: ['domain', 'rules'],
  additionalProperties: false
}

async function updateRulesImpl(input: unknown): Promise<DomainEnvelope> {
  const a = (input ?? {}) as Record<string, any>
  assertValidDomain(a.domain)
  if (a.rules === null || typeof a.rules !== 'object' || Array.isArray(a.rules)) {
    throw new DomainException('VALIDATION_ERROR', 'rules must be a JSON object (the ruleset)')
  }
  const body = a.rules as Record<string, unknown>
  if (typeof body.version !== 'string' || !body.version) {
    throw new DomainException('VALIDATION_ERROR', 'ruleset.version is required (auditable identifier)')
  }
  if (!Array.isArray(body.rules)) {
    throw new DomainException('VALIDATION_ERROR', 'ruleset.rules must be an array')
  }
  if (body.default_outcome === null || typeof body.default_outcome !== 'object') {
    throw new DomainException('VALIDATION_ERROR', 'ruleset.default_outcome is required')
  }
  const domain: string = a.domain

  // Keep the stored ruleset's domain field consistent with the file it lives in.
  const ruleset: RuleSet = { ...(body as unknown as RuleSet), domain }

  const warnings: string[] = []
  await writeRules(domain, ruleset)

  const log = await appendLog({
    ts: new Date().toISOString(),
    tool: 'library_update_rules',
    action: `update ruleset ${domain} (v${ruleset.version}, ${ruleset.rules.length} rules)`,
    domain
  })
  if (!log.ok) warnings.push('log_append_failed')

  return ok({ domain, rules_updated: true, version: ruleset.version, rule_count: ruleset.rules.length }, warnings)
}

export const updateRulesTool: ToolDefinition = {
  name: 'library_update_rules',
  description:
    'Layer 1 (Constitution). Create or overwrite the per-domain deterministic ruleset ' +
    '({domain}.rules.json): an ordered list of rules (first match wins), each with a closed ' +
    'predicate `when` and a governed `outcome`, plus a `version` and `default_outcome`. ' +
    'Overwrites the prior ruleset.',
  inputSchema,
  handler: (input) => toEnvelope(() => updateRulesImpl(input))
}
