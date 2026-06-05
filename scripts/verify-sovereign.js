// Pure-function verification for the three-layer "Sovereign AI" vertical slice.
// No Azure / Qdrant / network: it imports the compiled pure modules and the RDF engine
// implementations directly, and runs them against the ctax-rebuild fixtures.
//
//   node scripts/verify-sovereign.js
//
// Asserts:
//   L1  CTR-001 fires for the eligible input; CTR-002 for not-liable; default otherwise.
//   L3  the bailiff signal yields UrgentSafeguardingGuidance + no_payment_instruction,
//       under BOTH the oxigraph (SPARQL) and n3 (triple-traversal) engines.

const fs = require('fs')
const path = require('path')
const assert = require('assert')

const FIX = path.join(__dirname, '..', 'fixtures', 'ctax-rebuild')
const ruleset = JSON.parse(fs.readFileSync(path.join(FIX, 'ctax-rebuild.rules.json'), 'utf8'))
const turtle = fs.readFileSync(path.join(FIX, 'ctax-rebuild.ttl'), 'utf8')

const { resolveEligibility } = require('../dist/src/rules/resolve')
const { answerShapeFor } = require('../dist/src/rdf/reason')
const { oxigraphEngine } = require('../dist/src/rdf/engine.oxigraph')
const { n3Engine } = require('../dist/src/rdf/engine.n3')

let failures = 0
function check(label, fn) {
  try {
    fn()
    console.log('  ok  ' + label)
  } catch (err) {
    failures++
    console.log('  FAIL ' + label + ' — ' + err.message)
  }
}

async function main() {
  console.log('Layer 1 — deterministic eligibility')
  check('CTR-001 fires for liable + low_income + in_arrears', () => {
    const r = resolveEligibility(ruleset, { liable_occupier: true, low_income: true, in_arrears: true })
    assert.strictEqual(r.eligibility, 'eligible')
    assert.strictEqual(r.rule_fired, 'CTR-001')
    assert.deepStrictEqual(r.governs, ['ctax:RebuildSupportShape'])
    assert.strictEqual(r.ruleset_version, '2026-06-05.1')
  })
  check('CTR-002 fires for not-liable', () => {
    const r = resolveEligibility(ruleset, { liable_occupier: false })
    assert.strictEqual(r.eligibility, 'ineligible')
    assert.strictEqual(r.rule_fired, 'CTR-002')
  })
  check('default_outcome when nothing matches', () => {
    const r = resolveEligibility(ruleset, { liable_occupier: true, low_income: false })
    assert.strictEqual(r.eligibility, 'indeterminate')
    assert.strictEqual(r.rule_fired, null)
  })

  for (const engine of [oxigraphEngine, n3Engine]) {
    console.log(`Layer 3 — reasoning map (engine: ${engine.name})`)
    const graph = await engine.load(turtle)
    const reasoning = await answerShapeFor(engine, graph, {
      domain: 'ctax-rebuild',
      intent: 'public_guidance',
      eligibility: 'eligible',
      signals: { bailiff_present: true }
    })
    check(`[${engine.name}] matched BailiffAtDoor intersection`, () => {
      assert.strictEqual(reasoning.matched_intersection, 'BailiffAtDoor')
    })
    check(`[${engine.name}] answer_shape is UrgentSafeguardingGuidance`, () => {
      assert.strictEqual(reasoning.answer_shape, 'UrgentSafeguardingGuidance')
    })
    check(`[${engine.name}] safety_constraints include no_payment_instruction`, () => {
      assert.ok(reasoning.safety_constraints.includes('no_payment_instruction'), JSON.stringify(reasoning.safety_constraints))
    })
    check(`[${engine.name}] must_include has right_to_request_breathing_space`, () => {
      assert.ok(reasoning.must_include.includes('right_to_request_breathing_space'), JSON.stringify(reasoning.must_include))
    })
    check(`[${engine.name}] overrides StandardRebuildAnswerShape`, () => {
      assert.ok(reasoning.overrides.includes('StandardRebuildAnswerShape'), JSON.stringify(reasoning.overrides))
    })
    check(`[${engine.name}] no signal → empty reasoning`, async () => {
      const empty = await answerShapeFor(engine, graph, { domain: 'ctax-rebuild', signals: {} })
      assert.strictEqual(empty.matched_intersection, null)
    })
  }

  console.log('')
  if (failures) {
    console.log(`FAILED: ${failures} check(s) failed.`)
    process.exit(1)
  }
  console.log('All sovereign-slice checks passed.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
