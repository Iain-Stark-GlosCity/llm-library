// Layer 1 resolver — the deterministic "Constitution". These tests pin the properties
// the whole layer is sold on: same inputs → same outcome, first match wins, malformed
// conditions fail closed.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evalCondition, missingRequiredInputs, resolveEligibility } from '../src/rules/resolve'
import { RuleSet } from '../src/storage/rules'

const inputs = {
  property: { occupancy_status: 'empty', band: 'C' },
  debt: { amount: 1200.5, stage: 'enforcement' },
  flags: { vulnerable: true }
}

test('leaf operators evaluate against dotted paths', () => {
  assert.equal(evalCondition({ op: 'eq', path: 'property.band', value: 'C' } as any, inputs), true)
  assert.equal(evalCondition({ op: 'neq', path: 'property.band', value: 'D' } as any, inputs), true)
  assert.equal(evalCondition({ op: 'lt', path: 'debt.amount', value: 2000 } as any, inputs), true)
  assert.equal(evalCondition({ op: 'lte', path: 'debt.amount', value: 1200.5 } as any, inputs), true)
  assert.equal(evalCondition({ op: 'gt', path: 'debt.amount', value: 1200.5 } as any, inputs), false)
  assert.equal(evalCondition({ op: 'gte', path: 'debt.amount', value: 1200.5 } as any, inputs), true)
  assert.equal(evalCondition({ op: 'in', path: 'debt.stage', value: ['recovery', 'enforcement'] } as any, inputs), true)
  assert.equal(evalCondition({ op: 'exists', path: 'flags.vulnerable' } as any, inputs), true)
  assert.equal(evalCondition({ op: 'exists', path: 'flags.missing' } as any, inputs), false)
})

test('numeric comparisons against non-numbers fail closed', () => {
  assert.equal(evalCondition({ op: 'lt', path: 'property.band', value: 5 } as any, inputs), false)
  assert.equal(evalCondition({ op: 'gte', path: 'debt.amount', value: '100' } as any, inputs), false)
})

test('all / any / not combinators', () => {
  const cond: any = {
    all: [
      { op: 'eq', path: 'property.occupancy_status', value: 'empty' },
      { any: [{ op: 'eq', path: 'property.band', value: 'A' }, { op: 'eq', path: 'property.band', value: 'C' }] },
      { not: { op: 'eq', path: 'debt.stage', value: 'closed' } }
    ]
  }
  assert.equal(evalCondition(cond, inputs), true)
})

test('malformed conditions fail closed (never grant eligibility)', () => {
  assert.equal(evalCondition(null as any, inputs), false)
  assert.equal(evalCondition({} as any, inputs), false)
  assert.equal(evalCondition({ op: 'matches', path: 'x' } as any, inputs), false)
  assert.equal(evalCondition({ all: 'not-an-array' } as any, inputs), false)
  assert.equal(evalCondition({ op: 'eq', value: 1 } as any, inputs), false) // missing path
})

const ruleset: RuleSet = {
  domain: 'test-domain',
  version: '1.0.0',
  rules: [
    {
      id: 'r1',
      when: { op: 'eq', path: 'property.band', value: 'C' } as any,
      outcome: { eligibility: 'eligible', reason_code: 'BAND_C', governs: ['discount'] }
    },
    {
      id: 'r2',
      when: { op: 'exists', path: 'property.band' } as any,
      outcome: { eligibility: 'ineligible', reason_code: 'ANY_BAND' }
    }
  ],
  default_outcome: { eligibility: 'indeterminate', reason_code: 'NO_RULE' }
} as RuleSet

test('first matching rule wins (order = priority)', () => {
  const r = resolveEligibility(ruleset, inputs)
  assert.equal(r.rule_fired, 'r1')
  assert.equal(r.eligibility, 'eligible')
  assert.equal(r.reason_code, 'BAND_C')
  assert.deepEqual(r.governs, ['discount'])
  assert.equal(r.ruleset_version, '1.0.0')
})

test('default outcome when nothing matches', () => {
  const r = resolveEligibility(ruleset, { property: {} })
  assert.equal(r.rule_fired, null)
  assert.equal(r.eligibility, 'indeterminate')
  assert.equal(r.reason_code, 'NO_RULE')
})

test('resolution is deterministic: same inputs, same outcome', () => {
  const a = resolveEligibility(ruleset, inputs)
  const b = resolveEligibility(ruleset, JSON.parse(JSON.stringify(inputs)))
  assert.deepEqual(a, b)
})

test('missingRequiredInputs resolves nested dotted paths', () => {
  const rs = { ...ruleset, input_schema: { required: ['property.occupancy_status', 'debt.amount', 'absent.field'] } } as RuleSet
  assert.deepEqual(missingRequiredInputs(rs, inputs), ['absent.field'])
  assert.deepEqual(missingRequiredInputs(ruleset, inputs), []) // no schema → nothing missing
})
