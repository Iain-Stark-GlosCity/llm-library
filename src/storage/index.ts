// index.md — human-readable catalogue, regenerated deterministically from manifest.json
// on every library_update. Grouped by domain, pages sorted by title. See CLAUDE.md.

import { getWikiContainer, readBlob, conditionalWrite, WriteResult } from './blobs'
import { Manifest } from './manifest'

const INDEX_BLOB = 'index.md'

export function renderIndex(manifest: Manifest): string {
  const lines: string[] = ['# Library Index', `Updated: ${manifest.updated}`, '']

  const byDomain = new Map<string, typeof manifest.pages>()
  for (const page of manifest.pages) {
    const domain = page.domain || 'uncategorised'
    if (!byDomain.has(domain)) byDomain.set(domain, [])
    byDomain.get(domain)!.push(page)
  }

  for (const domain of [...byDomain.keys()].sort()) {
    lines.push(`## ${domain}`, '')
    const pages = byDomain.get(domain)!.slice().sort((a, b) => a.title.localeCompare(b.title))
    for (const p of pages) {
      lines.push(
        `### ${p.title}`,
        `- File: \`${p.filename}\``,
        `- Type: ${p.type}`,
        `- Confidence: ${p.confidence}`,
        `- Status: ${p.status}`,
        `- Summary: ${p.summary}`,
        ''
      )
    }
  }
  return lines.join('\n')
}

export async function regenerateIndex(manifest: Manifest): Promise<WriteResult> {
  const container = await getWikiContainer()
  const existing = await readBlob(container, INDEX_BLOB)
  return conditionalWrite(
    container,
    INDEX_BLOB,
    renderIndex(manifest),
    existing?.etag ?? null,
    'text/markdown; charset=utf-8'
  )
}
