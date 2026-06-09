import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shouldSuppressByReasoningFilters } from '../src/tools/resolve'
import { ReasoningResult } from '../src/rdf/reason'

const reasoning: ReasoningResult = {
  matched_intersection: 'ExampleUrgentIntersection',
  answer_shape: 'UrgentGuidance',
  safety_constraints: [],
  must_include: [],
  must_not: [],
  overrides: [],
  suppress_result_patterns: [
    'ctr',
    'pensioner income',
    'working age ctr',
    'discount',
    'premium'
  ],
  allow_suppressed_when_question_patterns: [
    'can i get council tax reduction',
    'income',
    'benefit',
    'discount'
  ]
}

test('reasoning filters suppress configured result families without hard-coding a domain intersection in resolver code', () => {
  const urgentQuestion = 'Someone is at my door about arrears. What should I do right now?'

  assert.equal(shouldSuppressByReasoningFilters({ filename: 'council-tax-rebuild-ctr-pensioner-income-capital.md', title: 'CTR pensioner income and capital' }, reasoning, urgentQuestion), true)
  assert.equal(shouldSuppressByReasoningFilters({ filename: 'working-age-ctr-local-policy.md', title: 'Working-age CTR scheme' }, reasoning, urgentQuestion), true)
  assert.equal(shouldSuppressByReasoningFilters({ filename: 'empty-property-premiums.md', title: 'Empty property premiums' }, reasoning, urgentQuestion), true)
  assert.equal(shouldSuppressByReasoningFilters({ filename: 'single-person-discount.md', title: 'Single person discount' }, reasoning, urgentQuestion), true)
  assert.equal(shouldSuppressByReasoningFilters({ filename: 'urgent-routing.md', title: 'Urgent routing', tags: ['enforcement', 'entry-rights'] }, reasoning, urgentQuestion), false)
})

test('reasoning filters keep otherwise suppressed pages when configured query patterns are explicit', () => {
  const entitlementQuestion = 'Someone is at my door. Can I get council tax reduction based on my income or benefits?'

  assert.equal(shouldSuppressByReasoningFilters({ filename: 'council-tax-rebuild-ctr-pensioner-income-capital.md', title: 'CTR pensioner income and capital' }, reasoning, entitlementQuestion), false)
})
