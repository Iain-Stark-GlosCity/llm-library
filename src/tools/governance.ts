// Governance vocabulary — the permitted-use modes, page roles, default policies,
// and decision helpers shared by update_page, lint, query, resolve, and migration.

import { PageEntry, PageRole } from '../storage/manifest'
import { SourceEntry } from '../storage/raw-manifest'
import { TOOL_CONTRACT_VERSION } from './version'

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

export const PAGE_ROLES = [
  'statutory_extraction',
  'local_policy',
  'local_policy_placeholder',
  'index',
  'checklist',
  'operational_model',
  'validation_contract',
  'synthesis',
  'rule_slot',
  'rule_family',
  'compiler_grade_rule',
  'contradiction',
  'unknown'
] as const

export const GOVERNANCE_POLICY_VERSION = TOOL_CONTRACT_VERSION

export const PAGE_ROLE_DEFAULTS: Partial<Record<PageRole, {
  allowed_use: string[]
  prohibited_use: string[]
  business_consequence_if_stale: 'low' | 'medium' | 'high'
}>> = {
  statutory_extraction: {
    allowed_use: ['analysis', 'drafting', 'staff_guidance', 'public_guidance', 'decision_support'],
    prohibited_use: ['formal_decision', 'live_account_action', 'payment_action', 'enforcement_action'],
    business_consequence_if_stale: 'high'
  },
  compiler_grade_rule: {
    allowed_use: ['analysis', 'drafting', 'staff_guidance', 'public_guidance', 'decision_support'],
    prohibited_use: ['formal_decision', 'live_account_action', 'payment_action', 'enforcement_action'],
    business_consequence_if_stale: 'high'
  },
  rule_family: {
    allowed_use: ['analysis', 'drafting', 'staff_guidance', 'public_guidance'],
    prohibited_use: ['decision_support', 'formal_decision', 'live_account_action', 'payment_action', 'enforcement_action'],
    business_consequence_if_stale: 'high'
  },
  local_policy_placeholder: {
    allowed_use: ['analysis', 'drafting', 'staff_guidance', 'public_guidance'],
    prohibited_use: ['decision_support', 'formal_decision', 'live_account_action', 'payment_action', 'enforcement_action'],
    business_consequence_if_stale: 'high'
  },
  local_policy: {
    allowed_use: ['analysis', 'drafting', 'staff_guidance', 'public_guidance', 'decision_support'],
    prohibited_use: ['formal_decision', 'live_account_action', 'payment_action', 'enforcement_action'],
    business_consequence_if_stale: 'high'
  },
  index: {
    allowed_use: ['analysis', 'drafting', 'staff_guidance'],
    prohibited_use: ['decision_support', 'formal_decision', 'live_account_action', 'payment_action', 'enforcement_action'],
    business_consequence_if_stale: 'medium'
  },
  checklist: {
    allowed_use: ['analysis', 'drafting', 'staff_guidance', 'public_guidance'],
    prohibited_use: ['decision_support', 'formal_decision', 'live_account_action', 'payment_action', 'enforcement_action'],
    business_consequence_if_stale: 'medium'
  },
  operational_model: {
    allowed_use: ['analysis', 'drafting', 'staff_guidance'],
    prohibited_use: ['decision_support', 'formal_decision', 'live_account_action', 'payment_action', 'enforcement_action'],
    business_consequence_if_stale: 'high'
  },
  validation_contract: {
    allowed_use: ['analysis', 'drafting', 'staff_guidance', 'public_guidance', 'decision_support'],
    prohibited_use: ['formal_decision', 'live_account_action', 'payment_action', 'enforcement_action'],
    business_consequence_if_stale: 'high'
  },
  synthesis: {
    allowed_use: ['analysis', 'drafting', 'staff_guidance', 'public_guidance'],
    prohibited_use: ['formal_decision', 'live_account_action', 'payment_action', 'enforcement_action'],
    business_consequence_if_stale: 'high'
  }
}

export const INVALIDATION_POLICY_DEFAULTS: Partial<Record<PageRole, string>> = {
  index: 'Re-check when linked pages are added, deprecated, renamed, or when cited sources change. This is a navigation/index page and must not be used as decision-support authority.',
  checklist: 'Re-check when completion status changes, dependent source pages are updated, or production-readiness gates change. This is a checklist/planning page and must not be used as decision-support authority.',
  statutory_extraction: 'Re-check when any cited legislation source changes, when extraction confidence changes, or before use in production-candidate decision logic. Decision support remains subject to Layer 1 operational and local-policy gates.',
  local_policy_placeholder: 'Re-check when current local policy sources are registered or changed. Do not use for decision support until current citable local values are present.',
  operational_model: 'Re-check when operational channels, evidence rules, payment/recovery workflows, identity checks, or retention policies change. This page must not authorise live account, payment, recovery, or enforcement action.',
  compiler_grade_rule: 'Re-check when cited source rules change, extraction confidence changes, or before use in production-candidate decision logic. Decision support remains subject to Layer 1 operational and local-policy gates.',
  local_policy: 'Re-check when the local authority publishes, withdraws, or changes the cited local policy values. Decision support remains subject to Layer 1 operational gates.',
  validation_contract: 'Re-check when validation gates, cited source rules, or production-readiness criteria change.',
  synthesis: 'Re-check when any related or cited source page changes, is deprecated, or has unresolved high-risk source currency.'
}

export type GovernanceUseStatus =
  | 'eligible'
  | 'intentionally_prohibited'
  | 'missing_governance_metadata'
  | 'source_unchecked'
  | 'source_superseded'
  | 'stale_snapshot'
  | 'deprecated'
  | 'unknown'

export function isUseMode(value: string): boolean {
  return ALL_USE_MODES.includes(value)
}

export function isOperationalUse(value: string): boolean {
  return (OPERATIONAL_USE_MODES as readonly string[]).includes(value)
}

export function isStaleConsequence(value: string): boolean {
  return (STALE_CONSEQUENCE_LEVELS as readonly string[]).includes(value)
}

export function isPageRole(value: string): value is PageRole {
  return (PAGE_ROLES as readonly string[]).includes(value)
}

export function inferPageRole(page: Pick<PageEntry, 'filename' | 'title' | 'tags'>, content = ''): PageRole {
  const filename = (page.filename || '').toLowerCase()
  const title = (page.title || '').toLowerCase()
  const body = content.toLowerCase()
  const tags = (page.tags || []).map((t) => t.toLowerCase())
  if (filename.includes('links')) return 'index'
  if (filename.includes('open-issues')) return 'checklist'
  if (filename.includes('completion')) return 'checklist'
  if (filename.includes('operational-model')) return 'operational_model'
  if (filename.includes('validation-contract')) return 'validation_contract'
  if (filename.includes('synthesis')) return 'synthesis'
  if (filename.includes('local-policy')) return 'local_policy_placeholder'
  if (filename.includes('rule-slots')) return 'rule_slot'
  if (body.includes('rule-family') || body.includes('non-compiler-grade') || body.includes('truncates')) return 'rule_family'
  if (body.includes('compiler-grade')) return 'compiler_grade_rule'
  if (tags.includes('secondary-legislation') || /\bsi\s+\d/i.test(page.title || '')) return 'statutory_extraction'
  if (title.includes('contradiction')) return 'contradiction'
  return 'unknown'
}

// Per-result permitted-use decision for a declared intended_use (answer modes, C).
export interface UseContext {
  allowed_use?: string[]
  prohibited_use?: string[]
  last_source_check?: string | null
  business_consequence_if_stale?: string | null
  invalidation_policy?: string | null
  superseded?: boolean
  status?: string | null
  page_role?: PageRole | string | null
  sources?: SourceEntry[]
}

export interface UseDecision {
  permitted: boolean
  notes: string[]
}

const NON_DECISION_SUPPORT_ROLES = new Set(['index', 'checklist', 'operational_model', 'local_policy_placeholder', 'rule_family'])
const DECISION_SUPPORT_ROLES_REQUIRING_CURRENCY = new Set(['statutory_extraction', 'compiler_grade_rule', 'validation_contract'])

function sourceCurrencyNotes(sources: SourceEntry[] | undefined): string[] {
  const notes: string[] = []
  for (const s of sources || []) {
    if (!s.last_upstream_check) notes.push('source_unchecked')
    if (!s.upstream_status || s.upstream_status === 'unknown') notes.push('source_unknown_status')
    if (s.upstream_status === 'superseded') notes.push('source_superseded')
    if ((s.upstream_status as string) === 'changed') notes.push('source_changed')
    if (s.upstream_status === 'unavailable' || (s.upstream_status as string) === 'unreachable') notes.push('source_unavailable')
  }
  return Array.from(new Set(notes))
}

export function evaluateUse(intended: string, ctx: UseContext): UseDecision {
  const notes: string[] = []
  if (isOperationalUse(intended)) return { permitted: false, notes: ['operational_use_not_supported'] }
  if (ctx.status === 'deprecated') notes.push('deprecated')

  const allowed = ctx.allowed_use || []
  const prohibited = ctx.prohibited_use || []
  if (prohibited.includes(intended)) notes.push('in_prohibited_use')
  if (allowed.length > 0 && !allowed.includes(intended)) notes.push('not_in_allowed_use')

  const role = ctx.page_role || undefined
  if (intended === 'decision_support' && role && NON_DECISION_SUPPORT_ROLES.has(role)) {
    notes.push('page_role_not_decision_support')
  }

  // Higher-consequence modes carry additional currency + governance requirements.
  if ((intended === 'public_guidance' || intended === 'decision_support') && ctx.superseded) {
    notes.push('cites_superseded_source')
  }
  if (intended === 'public_guidance' && !ctx.last_source_check) {
    notes.push('no_last_source_check')
  }
  if (intended === 'decision_support') {
    if (!ctx.business_consequence_if_stale) notes.push('no_stale_risk_declared')
    if (!ctx.invalidation_policy) notes.push('no_invalidation_policy')
    if (!ctx.last_source_check) notes.push('no_last_source_check')
    if (role === 'synthesis' && !allowed.includes('decision_support')) notes.push('synthesis_not_explicitly_decision_support')
    if (!role || role === 'unknown' || role === 'rule_slot' || role === 'contradiction') notes.push('page_role_not_decision_support')
    if (role && DECISION_SUPPORT_ROLES_REQUIRING_CURRENCY.has(role)) notes.push(...sourceCurrencyNotes(ctx.sources))
  }

  const BLOCKING = new Set([
    'deprecated',
    'in_prohibited_use',
    'not_in_allowed_use',
    'page_role_not_decision_support',
    'cites_superseded_source',
    'no_last_source_check',
    'no_stale_risk_declared',
    'no_invalidation_policy',
    'synthesis_not_explicitly_decision_support',
    'source_unchecked',
    'source_unknown_status',
    'source_superseded',
    'source_changed',
    'source_unavailable'
  ])
  return { permitted: !notes.some((n) => BLOCKING.has(n)), notes: Array.from(new Set(notes)) }
}

export function governanceStatusForUse(intended: string, page: PageEntry, sources: SourceEntry[], superseded = false): { status: GovernanceUseStatus; reason: string } {
  if (page.status === 'deprecated') return { status: 'deprecated', reason: 'page_deprecated' }
  const decision = evaluateUse(intended, {
    allowed_use: page.allowed_use,
    prohibited_use: page.prohibited_use,
    last_source_check: page.last_source_check ?? null,
    business_consequence_if_stale: page.business_consequence_if_stale ?? null,
    invalidation_policy: page.invalidation_policy ?? null,
    superseded,
    status: page.status,
    page_role: page.page_role,
    sources
  })
  if (decision.permitted) return { status: 'eligible', reason: 'metadata_complete' }
  if (decision.notes.includes('in_prohibited_use') || decision.notes.includes('page_role_not_decision_support')) {
    return { status: 'intentionally_prohibited', reason: decision.notes.join(',') }
  }
  if (decision.notes.some((n) => n.includes('source') || n === 'no_last_source_check' || n === 'cites_superseded_source')) {
    if (decision.notes.some((n) => n.includes('superseded'))) return { status: 'source_superseded', reason: decision.notes.join(',') }
    return { status: 'source_unchecked', reason: decision.notes.join(',') }
  }
  if (decision.notes.some((n) => n.startsWith('no_'))) return { status: 'missing_governance_metadata', reason: decision.notes.join(',') }
  return { status: 'unknown', reason: decision.notes.join(',') || 'unknown' }
}
