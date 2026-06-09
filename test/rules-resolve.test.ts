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


const councilTaxRuleset: RuleSet = {
  domain: 'ctax-rebuild',
  version: 'test-council-tax-eligibility.1',
  rules: [
    {
      id: 'single-adult-discount-eligible',
      description: 'One counted adult is the deterministic gateway for single adult discount.',
      when: { op: 'eq', path: 'adult_count.counted_adults', value: 1 } as any,
      outcome: { eligibility: 'eligible', reason_code: 'single_adult_discount_25_percent', governs: ['SinglePersonDiscountShape'] }
    },
    {
      id: 'single-adult-discount-not-eligible',
      description: 'More than one counted adult fails the single adult discount gateway.',
      when: { op: 'gt', path: 'adult_count.counted_adults', value: 1 } as any,
      outcome: { eligibility: 'ineligible', reason_code: 'more_than_one_counted_adult' }
    },
    {
      id: 'smi-disregard-eligible',
      when: { op: 'eq', path: 'person.smi_disregard_criteria_met', value: true } as any,
      outcome: { eligibility: 'eligible', reason_code: 'smi_disregard_gateway', governs: ['DisregardShape'] }
    },
    {
      id: 'student-disregard-eligible',
      when: { op: 'eq', path: 'person.student_disregard_criteria_met', value: true } as any,
      outcome: { eligibility: 'eligible', reason_code: 'student_disregard_gateway', governs: ['DisregardShape'] }
    },
    {
      id: 'class-n-exempt-dwelling-eligible',
      when: { op: 'eq', path: 'dwelling.class_n_conditions_met', value: true } as any,
      outcome: { eligibility: 'eligible', reason_code: 'exempt_dwelling_class_n', governs: ['ExemptionShape'] }
    },
    {
      id: 'disabled-reduction-gateway-eligible',
      when: { op: 'eq', path: 'dwelling.disabled_reduction_gateway_met', value: true } as any,
      outcome: { eligibility: 'eligible', reason_code: 'disabled_reduction_gateway', governs: ['ReductionShape'] }
    },
    {
      id: 'owner-liability-hmo-eligible',
      when: {
        all: [
          { op: 'eq', path: 'liability.hmo', value: true },
          { op: 'eq', path: 'liability.owner', value: true }
        ]
      } as any,
      outcome: { eligibility: 'eligible', reason_code: 'owner_liability_hmo', governs: ['LiabilityShape'] }
    },
    {
      id: 'empty-property-premium-local-policy-required',
      when: { op: 'eq', path: 'local_policy.empty_property_premium_slot', value: true } as any,
      outcome: { eligibility: 'local_policy_required', reason_code: 'empty_property_premium_local_policy_required', governs: ['LocalPolicyPremiumShape'] }
    },
    {
      id: 'ctr-working-age-local-policy-required',
      when: { op: 'eq', path: 'ctr.working_age_scheme_slot', value: true } as any,
      outcome: { eligibility: 'local_policy_required', reason_code: 'ctr_working_age_scheme_local_policy_required', governs: ['LocalCtrSchemeShape'] }
    }
  ],
  default_outcome: { eligibility: 'indeterminate', reason_code: 'insufficient_facts' }
} as RuleSet

test('council tax Layer 1 resolves core discount, disregard, exemption, liability and local-policy slots deterministically', () => {
  const cases: Array<[string, unknown, string, string, string | null]> = [
    ['single adult discount', { adult_count: { counted_adults: 1 } }, 'eligible', 'single_adult_discount_25_percent', 'single-adult-discount-eligible'],
    ['single adult discount refused', { adult_count: { counted_adults: 2 } }, 'ineligible', 'more_than_one_counted_adult', 'single-adult-discount-not-eligible'],
    ['SMI disregard', { person: { smi_disregard_criteria_met: true } }, 'eligible', 'smi_disregard_gateway', 'smi-disregard-eligible'],
    ['student disregard', { person: { student_disregard_criteria_met: true } }, 'eligible', 'student_disregard_gateway', 'student-disregard-eligible'],
    ['Class N exemption', { dwelling: { class_n_conditions_met: true } }, 'eligible', 'exempt_dwelling_class_n', 'class-n-exempt-dwelling-eligible'],
    ['disabled reduction', { dwelling: { disabled_reduction_gateway_met: true } }, 'eligible', 'disabled_reduction_gateway', 'disabled-reduction-gateway-eligible'],
    ['owner liability HMO', { liability: { hmo: true, owner: true } }, 'eligible', 'owner_liability_hmo', 'owner-liability-hmo-eligible'],
    ['local premium', { local_policy: { empty_property_premium_slot: true } }, 'local_policy_required', 'empty_property_premium_local_policy_required', 'empty-property-premium-local-policy-required'],
    ['working age CTR', { ctr: { working_age_scheme_slot: true } }, 'local_policy_required', 'ctr_working_age_scheme_local_policy_required', 'ctr-working-age-local-policy-required'],
    ['insufficient facts', { adult_count: {} }, 'indeterminate', 'insufficient_facts', null]
  ]

  for (const [label, facts, eligibility, reasonCode, ruleFired] of cases) {
    const first = resolveEligibility(councilTaxRuleset, facts)
    const second = resolveEligibility(councilTaxRuleset, JSON.parse(JSON.stringify(facts)))
    assert.deepEqual(second, first, `${label} should be deterministic`)
    assert.equal(first.eligibility, eligibility, label)
    assert.equal(first.reason_code, reasonCode, label)
    assert.equal(first.rule_fired, ruleFired, label)
  }
})
