// library_info (resource: domains) — the per-domain coverage inventory / registry.
//
// There was no single place that answered "which domains exist, and which of the four
// per-domain artifacts does each have?" That matters for two reasons: (1) governing an
// estate of domains needs a coverage map, not a per-domain probe; (2) every layer keys
// storage on the exact domain string, so an artifact written under a mistyped domain
// (e.g. `ctax-rebuild` vs `council-tax-rebuild`) silently never composes — this report
// surfaces that as `artifacts_without_pages`.
//
// Read-only: it unions the domains seen across the wiki manifest, the schema container,
// the rules container, and the rdf container, and reports coverage + gaps for each.

import { DomainEnvelope, ToolDefinition, ok, toEnvelope } from '../types'
import { readManifest } from '../storage/manifest'
import { listSchemaDomains, readSchema } from '../storage/schema'
import { listRuleDomains } from '../storage/rules'
import { listRdfDomains } from '../rdf/graph'
import { resolveLibraryId } from './shared'

const inputSchema = {
  type: 'object',
  properties: {
    library_id: { type: 'string' }
  },
  additionalProperties: true
}

interface DomainCoverage {
  domain: string
  pages: { total: number; active: number; draft: number; deprecated: number; synthesis: number }
  has_schema: boolean
  governance_required: boolean
  has_rules: boolean
  has_reasoning: boolean
  gaps: string[]
}

async function coverageImpl(input: unknown): Promise<DomainEnvelope> {
  const a = (input ?? {}) as Record<string, any>
  const libraryId = resolveLibraryId(a)

  const { manifest } = await readManifest(libraryId)
  const [schemaDomains, ruleDomains, rdfDomains] = await Promise.all([
    listSchemaDomains(),
    listRuleDomains(),
    listRdfDomains()
  ])

  // Tally pages per domain.
  const pageStats = new Map<string, DomainCoverage['pages']>()
  for (const p of manifest.pages) {
    if (!pageStats.has(p.domain)) {
      pageStats.set(p.domain, { total: 0, active: 0, draft: 0, deprecated: 0, synthesis: 0 })
    }
    const s = pageStats.get(p.domain)!
    s.total++
    if (p.status === 'active') s.active++
    else if (p.status === 'draft') s.draft++
    else if (p.status === 'deprecated') s.deprecated++
    if (p.type === 'synthesis') s.synthesis++
  }

  // The full domain set is the union across all four artifact stores.
  const allDomains = new Set<string>([
    ...pageStats.keys(),
    ...schemaDomains,
    ...ruleDomains,
    ...rdfDomains
  ])

  const domains: DomainCoverage[] = []
  for (const domain of [...allDomains].sort()) {
    const pages = pageStats.get(domain) ?? { total: 0, active: 0, draft: 0, deprecated: 0, synthesis: 0 }
    const hasSchema = schemaDomains.has(domain)
    const hasRules = ruleDomains.has(domain)
    const hasReasoning = rdfDomains.has(domain)
    let governanceRequired = false
    if (hasSchema) {
      const schema = await readSchema(domain).catch(() => null)
      governanceRequired = schema?.governance_required === true
    }

    const gaps: string[] = []
    // An artifact with no pages in the same domain is almost always a domain-string typo:
    // the rules/map/schema will never compose with retrieval.
    if (pages.total === 0 && (hasSchema || hasRules || hasReasoning)) {
      gaps.push('artifacts_without_pages')
    }
    if (pages.active > 0) {
      if (!hasRules) gaps.push('no_rules')
      if (!hasReasoning) gaps.push('no_reasoning_map')
      if (hasSchema && !governanceRequired) gaps.push('schema_without_governance')
      if (!hasSchema && pages.active >= 5) gaps.push('no_schema')
    }

    domains.push({
      domain,
      pages,
      has_schema: hasSchema,
      governance_required: governanceRequired,
      has_rules: hasRules,
      has_reasoning: hasReasoning,
      gaps
    })
  }

  return ok({ library_id: libraryId, domain_count: domains.length, domains })
}

export const coverageTool: ToolDefinition = {
  name: 'library_domains',
  description:
    'Per-domain coverage inventory: for every domain seen across the wiki, schema, rules, ' +
    'and reasoning-map stores, reports page counts by status and which layers it has, plus ' +
    'gaps (artifacts_without_pages = likely domain-string typo; no_rules; no_reasoning_map; ' +
    'schema_without_governance; no_schema).',
  inputSchema,
  handler: (input) => toEnvelope(() => coverageImpl(input))
}
