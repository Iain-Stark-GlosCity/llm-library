// Governance vocabulary — the permitted-use modes and stale-risk levels shared by
// update_page validation, lint, and (later) query answer-mode gating.
//
// The library SUPPORTS the first set with increasing guard rails. It must never let a
// page authorise an OPERATIONAL mode: formal decisions and live account/payment/
// enforcement actions belong to deterministic operational systems, not cached
// knowledge. The library can declare and warn on use; the actual block lives in the
// consuming channel.

export const SUPPORTED_USE_MODES = [
  'analysis',
  'drafting',
  'staff_guidance',
  'public_guidance',
  'decision_support'
] as const

export const OPERATIONAL_USE_MODES = [
  'formal_decision',
  'live_account_action',
  'payment_action',
  'enforcement_action'
] as const

export const ALL_USE_MODES: readonly string[] = [...SUPPORTED_USE_MODES, ...OPERATIONAL_USE_MODES]

export const STALE_CONSEQUENCE_LEVELS = ['low', 'medium', 'high'] as const

export function isUseMode(value: string): boolean {
  return ALL_USE_MODES.includes(value)
}

export function isOperationalUse(value: string): boolean {
  return (OPERATIONAL_USE_MODES as readonly string[]).includes(value)
}

export function isStaleConsequence(value: string): boolean {
  return (STALE_CONSEQUENCE_LEVELS as readonly string[]).includes(value)
}

// Per-result permitted-use decision for a declared intended_use (answer modes, C).
// The ladder of guard rails increases with consequence: analysis/drafting/staff_guidance
// have a low bar; public_guidance and decision_support additionally require currency and
// the relevant governance metadata. Operational modes are never supported here.
export interface UseContext {
  allowed_use?: string[]
  prohibited_use?: string[]
  last_source_check?: string | null
  business_consequence_if_stale?: string | null
  superseded?: boolean
}

export interface UseDecision {
  permitted: boolean
  notes: string[]
}

export function evaluateUse(intended: string, ctx: UseContext): UseDecision {
  const notes: string[] = []
  if (isOperationalUse(intended)) return { permitted: false, notes: ['operational_use_not_supported'] }

  const allowed = ctx.allowed_use || []
  const prohibited = ctx.prohibited_use || []
  if (prohibited.includes(intended)) return { permitted: false, notes: ['in_prohibited_use'] }
  if (allowed.length > 0 && !allowed.includes(intended)) return { permitted: false, notes: ['not_in_allowed_use'] }

  // Higher-consequence modes carry additional currency + governance requirements.
  if ((intended === 'public_guidance' || intended === 'decision_support') && ctx.superseded) {
    notes.push('cites_superseded_source')
  }
  if (intended === 'public_guidance' && !ctx.last_source_check) {
    notes.push('no_last_source_check')
  }
  if (intended === 'decision_support' && !ctx.business_consequence_if_stale) {
    notes.push('no_stale_risk_declared')
  }
  const BLOCKING = new Set(['cites_superseded_source', 'no_last_source_check', 'no_stale_risk_declared'])
  return { permitted: !notes.some((n) => BLOCKING.has(n)), notes }
}
