import { DomainEnvelope, DomainException, ToolDefinition, ok, toEnvelope } from '../types'
import { readManifest } from '../storage/manifest'
import { readRawManifest } from '../storage/raw-manifest'
import { readSchema } from '../storage/schema'
import { computeSourceFreshness, computePageFreshness } from './freshness'
import { governanceStatusForUse, evaluateUse, OPERATIONAL_USE_MODES } from './governance'

const inputSchema = {
  type: 'object',
  properties: { domain: { type: 'string' }, library_id: { type: 'string' } },
  required: ['domain'],
  additionalProperties: false
}

async function governanceInventoryImpl(input: unknown): Promise<DomainEnvelope> {
  const a = (input ?? {}) as Record<string, any>
  if (typeof a.domain !== 'string' || !a.domain) throw new DomainException('VALIDATION_ERROR', 'domain is required')
  const domain: string = a.domain
  const libraryId: string = typeof a.library_id === 'string' && a.library_id ? a.library_id : 'default'
  const [{ manifest }, { manifest: rawManifest }, schema] = await Promise.all([
    readManifest(libraryId),
    readRawManifest(libraryId),
    readSchema(domain).catch(() => null)
  ])
  const sourceById = new Map(rawManifest.sources.map((s) => [s.source_id, s]))
  const sourceFreshness = computeSourceFreshness(rawManifest.sources)
  const active = manifest.pages.filter((p) => p.domain === domain && p.status === 'active')

  const pages = active.map((p) => {
    const sources = (p.sources || []).map((id) => sourceById.get(id)).filter((s): s is NonNullable<typeof s> => Boolean(s))
    const freshness = computePageFreshness(p.sources || [], sourceFreshness)
    const checked = sources.length > 0 && sources.every((s) => Boolean(s.last_upstream_check))
    const current = sources.length > 0 && sources.every((s) => s.upstream_status === 'current')
    const ds = governanceStatusForUse('decision_support', p, sources, freshness.superseded)
    const pg = governanceStatusForUse('public_guidance', p, sources, freshness.superseded)
    const sg = governanceStatusForUse('staff_guidance', p, sources, freshness.superseded)
    return {
      filename: p.filename,
      page_type: p.type,
      page_role: p.page_role ?? null,
      confidence: p.confidence,
      status: p.status,
      allowed_use: p.allowed_use ?? [],
      prohibited_use: p.prohibited_use ?? [],
      business_consequence_if_stale: p.business_consequence_if_stale ?? null,
      has_invalidation_policy: Boolean(p.invalidation_policy),
      last_source_check: p.last_source_check ?? null,
      all_sources_checked: checked,
      all_sources_current: current,
      decision_support_status: ds.status,
      decision_support_reason: ds.reason,
      public_guidance_status: pg.status,
      staff_guidance_status: sg.status
    }
  })

  const count = (pred: (p: typeof pages[number]) => boolean) => pages.filter(pred).length
  const coverage = {
    domain,
    governance_required: schema?.governance_required === true,
    active_pages_total: active.length,
    pages_with_allowed_use: count((p) => p.allowed_use.length > 0),
    pages_with_prohibited_use: count((p) => p.prohibited_use.length > 0),
    pages_with_stale_risk: count((p) => Boolean(p.business_consequence_if_stale)),
    pages_with_invalidation_policy: count((p) => p.has_invalidation_policy),
    pages_with_last_source_check: count((p) => Boolean(p.last_source_check)),
    pages_with_all_sources_checked_current: count((p) => p.all_sources_checked && p.all_sources_current),
    decision_support_eligible_pages: count((p) => p.decision_support_status === 'eligible'),
    public_guidance_eligible_pages: count((p) => p.public_guidance_status === 'eligible'),
    staff_guidance_eligible_pages: count((p) => p.staff_guidance_status === 'eligible'),
    intentionally_no_decision_support: count((p) => p.decision_support_status === 'intentionally_prohibited'),
    refused_due_to_missing_metadata: count((p) => p.decision_support_status === 'missing_governance_metadata'),
    refused_due_to_source_currency: count((p) => p.decision_support_status === 'source_unchecked' || p.decision_support_status === 'source_superseded' || p.decision_support_status === 'stale_snapshot'),
    refused_due_to_in_prohibited_use: count((p) => p.decision_support_reason.includes('in_prohibited_use') || p.decision_support_reason.includes('page_role_not_decision_support')),
    operational_modes_globally_refused: OPERATIONAL_USE_MODES.every((mode) => !evaluateUse(mode, {}).permitted)
  }

  return ok({ ...coverage, pages }, [])
}

export const governanceInventoryTool: ToolDefinition = {
  name: 'library_governance_inventory',
  description: 'Return domain-wide governance coverage and per-page use eligibility inventory.',
  inputSchema,
  handler: (input) => toEnvelope(() => governanceInventoryImpl(input))
}
