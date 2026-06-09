// Small deterministic helpers shared across tools: slug/hash for IDs, frontmatter
// generation (string template — no YAML lib, per CLAUDE.md), and content parsing.

import { createHash } from 'crypto'
import { DomainException } from '../types'

export function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex')
}

// Canonical domain-slug shape, shared by every layer that keys storage by domain
// ({domain}.rules.json, {domain}.schema.json, {domain}.ttl, and the wiki `domain` field).
// Every artifact must agree on the exact string — a rules file under a mistyped domain
// silently never fires — so all writers validate against this one definition.
export const DOMAIN_RE = /^[a-z0-9][a-z0-9-]*$/

export function assertValidDomain(domain: unknown): string {
  if (typeof domain !== 'string' || domain.length === 0 || domain.length > 80 || !DOMAIN_RE.test(domain)) {
    throw new DomainException(
      'VALIDATION_ERROR',
      'domain is required and must match ^[a-z0-9][a-z0-9-]*$ (lowercase, digits, hyphens) and be ≤80 chars'
    )
  }
  return domain
}

// Resolve the optional library_id argument. Accepted for forward compatibility, but blob
// storage paths (manifest.json, raw_manifest.json, pages/, logs) are NOT namespaced per
// library — only Qdrant point ids and payloads are. A second library id would therefore
// silently share and clobber the default library's blobs while keeping separate vectors.
// Until blob paths are namespaced, any non-default id is rejected rather than corrupting.
export function resolveLibraryId(a: Record<string, any> | undefined): string {
  const id = a?.library_id
  if (id === undefined || id === null || id === '') return 'default'
  if (typeof id !== 'string' || id !== 'default') {
    throw new DomainException(
      'VALIDATION_ERROR',
      `library_id ${JSON.stringify(id)} is not supported: blob storage is not namespaced per library yet, so a non-default id would silently share the default library's pages and manifests. Omit library_id or pass "default".`
    )
  }
  return id
}

export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '')
}

// Double-quote a scalar that may contain YAML-significant characters (colons, etc.).
function yamlScalar(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function yamlList(items: string[]): string {
  if (!items || items.length === 0) return ' []'
  return '\n' + items.map((i) => `  - ${yamlScalar(i)}`).join('\n')
}

export interface FrontmatterInput {
  title: string
  type: string
  page_role?: string
  domain: string
  confidence: string
  status: string
  summary: string
  tags: string[]
  sources: string[]
  related: string[]
  review_after?: string
  reviewed_by?: string
  reviewed_at?: string
  allowed_use?: string[]
  prohibited_use?: string[]
  last_source_check?: string
  business_consequence_if_stale?: string
  invalidation_policy?: string
  governance_migrated_at?: string
  governance_migrated_by?: string
  governance_policy_version?: string
  governance_role_inferred?: boolean
  created: string
  updated: string
}

export function renderFrontmatter(fm: FrontmatterInput): string {
  const lines = ['---']
  lines.push(`title: ${yamlScalar(fm.title)}`)
  lines.push(`type: ${fm.type}`)
  if (fm.page_role) lines.push(`page_role: ${fm.page_role}`)
  lines.push(`domain: ${yamlScalar(fm.domain)}`)
  lines.push(`confidence: ${fm.confidence}`)
  lines.push(`status: ${fm.status}`)
  lines.push(`summary: ${yamlScalar(fm.summary)}`)
  lines.push(`tags:${yamlList(fm.tags)}`)
  lines.push(`sources:${yamlList(fm.sources)}`)
  lines.push(`related:${yamlList(fm.related)}`)
  if (fm.review_after) lines.push(`review_after: ${fm.review_after}`)
  if (fm.reviewed_by) lines.push(`reviewed_by: ${yamlScalar(fm.reviewed_by)}`)
  if (fm.reviewed_at) lines.push(`reviewed_at: ${fm.reviewed_at}`)
  if (fm.allowed_use && fm.allowed_use.length) lines.push(`allowed_use:${yamlList(fm.allowed_use)}`)
  if (fm.prohibited_use && fm.prohibited_use.length) lines.push(`prohibited_use:${yamlList(fm.prohibited_use)}`)
  if (fm.last_source_check) lines.push(`last_source_check: ${fm.last_source_check}`)
  if (fm.business_consequence_if_stale) lines.push(`business_consequence_if_stale: ${fm.business_consequence_if_stale}`)
  if (fm.invalidation_policy) lines.push(`invalidation_policy: ${yamlScalar(fm.invalidation_policy)}`)
  if (fm.governance_migrated_at) lines.push(`governance_migrated_at: ${fm.governance_migrated_at}`)
  if (fm.governance_migrated_by) lines.push(`governance_migrated_by: ${yamlScalar(fm.governance_migrated_by)}`)
  if (fm.governance_policy_version) lines.push(`governance_policy_version: ${yamlScalar(fm.governance_policy_version)}`)
  if (fm.governance_role_inferred !== undefined) lines.push(`governance_role_inferred: ${fm.governance_role_inferred}`)
  lines.push(`created: ${fm.created}`)
  lines.push(`updated: ${fm.updated}`)
  lines.push('---')
  return lines.join('\n')
}

// Extract the created timestamp from an existing page's frontmatter, or null.
export function extractCreated(content: string): string | null {
  const m = content.match(/^created:\s*(.+)$/m)
  if (!m) return null
  return m[1].trim().replace(/^["']|["']$/g, '')
}

// Strip a leading YAML frontmatter block, returning the body.
export function stripFrontmatter(md: string): string {
  if (!md.startsWith('---')) return md
  const end = md.indexOf('\n---', 3)
  if (end < 0) return md
  const afterFence = md.indexOf('\n', end + 1)
  if (afterFence < 0) return ''
  return md.slice(afterFence + 1).replace(/^\s+/, '')
}

export function inlineSourceIds(markdown: string): string[] {
  const ids = new Set<string>()
  for (const match of markdown.matchAll(/\[source:\s*([^\]\s]+)\s*\]/g)) {
    ids.add(match[1])
  }
  return [...ids]
}

export function daysSince(iso: string): number {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return 0
  return (Date.now() - t) / 86_400_000
}
