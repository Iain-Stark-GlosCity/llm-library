// Small deterministic helpers shared across tools: slug/hash for IDs, frontmatter
// generation (string template — no YAML lib, per CLAUDE.md), and content parsing.

import { createHash } from 'crypto'

export function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex')
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
  created: string
  updated: string
}

export function renderFrontmatter(fm: FrontmatterInput): string {
  const lines = ['---']
  lines.push(`title: ${yamlScalar(fm.title)}`)
  lines.push(`type: ${fm.type}`)
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
