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
