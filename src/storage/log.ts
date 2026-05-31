// Event log: log.jsonl (machine, one JSON per line) + log.md (human). ETag read-modify-
// write. Per CLAUDE.md, log failures NEVER fail an operation — appendLog returns
// { ok: false } and the caller records a "log_append_failed" warning.

import { getWikiContainer, readBlob, conditionalWrite } from './blobs'

const JSONL_BLOB = 'log.jsonl'
const MD_BLOB = 'log.md'

export interface LogEvent {
  ts: string
  tool: string
  action: string
  [key: string]: unknown
}

export async function appendLog(event: LogEvent): Promise<{ ok: boolean }> {
  try {
    const container = await getWikiContainer()

    const jsonl = await readBlob(container, JSONL_BLOB)
    const newJsonl = (jsonl?.content ?? '') + JSON.stringify(event) + '\n'
    const w1 = await conditionalWrite(
      container,
      JSONL_BLOB,
      newJsonl,
      jsonl?.etag ?? null,
      'application/x-ndjson; charset=utf-8'
    )

    const md = await readBlob(container, MD_BLOB)
    const mdLine = `- ${event.ts} **${event.tool}** — ${event.action}\n`
    const newMd = (md?.content ?? '# Library Event Log\n\n') + mdLine
    const w2 = await conditionalWrite(
      container,
      MD_BLOB,
      newMd,
      md?.etag ?? null,
      'text/markdown; charset=utf-8'
    )

    return { ok: w1.success && w2.success }
  } catch {
    return { ok: false }
  }
}
