// Event log: log.jsonl (machine, one JSON per line) + log.md (human). Backed by Azure
// APPEND blobs: appendBlock is atomic on the service side, so concurrent operations never
// contend the way the old whole-blob read-modify-write did (which also re-uploaded the
// entire history on every call). Legacy block-blob logs are migrated in place on first
// append. Per CLAUDE.md, log failures NEVER fail an operation — appendLog returns
// { ok: false } and the caller records a "log_append_failed" warning.

import { ContainerClient } from '@azure/storage-blob'
import { getWikiContainer, readBlob } from './blobs'

const JSONL_BLOB = 'log.jsonl'
const MD_BLOB = 'log.md'
const MD_HEADER = '# Library Event Log\n\n'

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

async function replaceLegacyBlobWithAppendBlob(
  blob: any,
  blobName: string,
  contentType: string,
  seededContent: string,
  fallbackAppend: string
): Promise<void> {
  await blob.deleteIfExists()

  try {
    await blob.create({ blobHTTPHeaders: { blobContentType: contentType } })
  } catch (err: any) {
    if (isStatus(err, 409, 'BlobAlreadyExists')) {
      // Another writer won the migration race. Do not seed the full legacy content again;
      // just append this call's line to the append blob that now exists.
      await blob.appendBlock(fallbackAppend, Buffer.byteLength(fallbackAppend))
      return
    }
    throw err
  }

  await blob.appendBlock(seededContent, Buffer.byteLength(seededContent))
}

// Append text to an append blob, creating it (with optional header) when missing and
// migrating a legacy block blob (which rejects appendBlock with InvalidBlobType) by
// replacing it with an append blob seeded with its existing content. The migration is a
// one-time event per blob; a concurrent appender racing it can lose a line, which is an
// acceptable trade for removing the permanent ETag contention of the old design.
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
      const existing = await readBlob(container, blobName)
      const seeded = (existing?.content ?? header) + text
      await replaceLegacyBlobWithAppendBlob(blob, blobName, contentType, seeded, text)
      return true
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
