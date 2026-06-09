// Layer 1 — the Constitution. Per-domain deterministic rulesets stored as
// {domain}.rules.json in the library-rules container. Unlike {domain}.schema.json (which
// is advisory doctrine), a ruleset is an ENFORCED, versioned, auditable contract: given
// structured inputs it resolves a governed eligibility outcome and names the rule that
// fired. The evaluation logic lives in ../rules/resolve.ts; this module is storage only.

import { getRulesContainer, readBlob, writeBlob, listBlobs } from './blobs'

const SUFFIX = '.rules.json'

// A closed predicate AST. Deliberately NOT executable code — a small, fixed set of
// operators that is deterministic, auditable, and safe to load from blob.
//   { all: [...] } | { any: [...] } | { not: Condition }
//   { op: 'eq'|'neq'|'lt'|'lte'|'gt'|'gte'|'in'|'exists', path: 'a.b.c', value?: ... }
export type Condition =
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition }
  | LeafCondition

export interface LeafCondition {
  op: 'eq' | 'neq' | 'lt' | 'lte' | 'gt' | 'gte' | 'in' | 'exists'
  path: string
  value?: unknown
}

export interface RuleOutcome {
  eligibility: 'eligible' | 'ineligible' | 'indeterminate' | 'local_policy_required'
  reason_code: string
  // Optional links to Layer 3 nodes this outcome points at (answer-shape refs etc.).
  governs?: string[]
}

export interface Rule {
  id: string
  description?: string
  when: Condition
  outcome: RuleOutcome
}

export interface RuleSet {
  domain: string
  version: string
  // Optional, minimal JSON-Schema-ish description of the expected inputs. Enforced by a
  // hand-rolled check in resolve.ts (type + required) — no ajv dependency at this stage.
  input_schema?: Record<string, unknown>
  rules: Rule[]
  default_outcome: RuleOutcome
}

function blobName(domain: string): string {
  return `${domain}${SUFFIX}`
}

export async function readRules(domain: string): Promise<RuleSet | null> {
  const container = await getRulesContainer()
  const res = await readBlob(container, blobName(domain))
  if (!res) return null
  return JSON.parse(res.content) as RuleSet
}

export async function writeRules(domain: string, ruleset: RuleSet): Promise<void> {
  const container = await getRulesContainer()
  await writeBlob(
    container,
    blobName(domain),
    JSON.stringify(ruleset, null, 2),
    'application/json; charset=utf-8'
  )
}

// Domains that currently have a ruleset file.
export async function listRuleDomains(): Promise<Set<string>> {
  const container = await getRulesContainer()
  const names = await listBlobs(container, '')
  const domains = new Set<string>()
  for (const n of names) {
    if (n.endsWith(SUFFIX)) domains.add(n.slice(0, -SUFFIX.length))
  }
  return domains
}
