// Event log: log.jsonl (machine, one JSON per line) + log.md (human). Backed by Azure
// append blobs when possible. If an existing deployment still has legacy BLOCK blob logs,
// append safely with an ETag-guarded block-blob write instead of deleting/recreating the
// governed audit trail. Per CLAUDE.md, log failures NEVER fail an operation — appendLog
// returns { ok: false } and the caller records a "log_append_failed" warning.

import { ContainerClient } from '@azure/storage-blob'
import { conditionalWrite, getWikiContainer, readBlob } from './blobs'

const JSONL_BLOB = 'log.jsonl'
const MD_BLOB = 'log.md'
const MD_HEADER = '# Library Event Log\n\n'
const LEGACY_BLOCK_APPEND_ATTEMPTS = 3

export interface LogEvent {
  ts: string
  tool: string
  action: string
  [key: string]: unknown
}

function errorCode(err: any): string | undefined {
  return err?.details?.errorCode ?? err?.code
}

function isStatus(err: any, statusCode: number, code?: string): boolean {
  if (err?.statusCode !== statusCode) return false
  return code ? errorCode(err) === code : true
}

async function createAppendBlobIfMissing(blob: any, contentType: string): Promise<boolean> {
  const res = await blob.createIfNotExists({ blobHTTPHeaders: { blobContentType: contentType } })
  return Boolean(res?.succeeded)
}

async function appendToLegacyBlockBlob(
  container: ContainerClient,
  blobName: string,
  text: string,
  contentType: string,
  header: string
): Promise<boolean> {
  for (let attempt = 0; attempt < LEGACY_BLOCK_APPEND_ATTEMPTS; attempt++) {
    const existing = await readBlob(container, blobName)
    const current = existing?.content ?? header
    const write = await conditionalWrite(container, blobName, current + text, existing?.etag ?? null, contentType)
    if (write.success) return true
  }
  return false
}

// Append text to an append blob, creating it (with optional header) when missing. Legacy
// block-blob logs cannot accept appendBlock; for those, use a bounded ETag retry loop
// rather than deleting/recreating the audit log in-place.
async function appendTo(
  container: ContainerClient,
  blobName: string,
  text: string,
  contentType: string,
  header = ''
): Promise<boolean> {
  const blob = container.getAppendBlobClient(blobName)
  try {
    await blob.appendBlock(text, Buffer.byteLength(text))
    return true
  } catch (err: any) {
    if (err?.statusCode === 404) {
      const created = await createAppendBlobIfMissing(blob, contentType)
      const seeded = created ? header + text : text
      await blob.appendBlock(seeded, Buffer.byteLength(seeded))
      return true
    }
    if (isStatus(err, 409, 'InvalidBlobType')) {
      return appendToLegacyBlockBlob(container, blobName, text, contentType, header)
    }
    throw err
  }
}

export async function appendLogToContainer(container: ContainerClient, event: LogEvent): Promise<{ ok: boolean }> {
  try {
    const jsonlLine = JSON.stringify(event) + '\n'
    const ok1 = await appendTo(container, JSONL_BLOB, jsonlLine, 'application/x-ndjson; charset=utf-8')

    const mdLine = `- ${event.ts} **${event.tool}** — ${event.action}\n`
    const ok2 = await appendTo(container, MD_BLOB, mdLine, 'text/markdown; charset=utf-8', MD_HEADER)

    return { ok: ok1 && ok2 }
  } catch {
    return { ok: false }
  }
}

export async function appendLog(event: LogEvent): Promise<{ ok: boolean }> {
  try {
    const container = await getWikiContainer()
    return appendLogToContainer(container, event)
  } catch {
    return { ok: false }
  }
}
