import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { appendLogToContainer, LogEvent } from '../src/storage/log'

type BlobKind = 'append' | 'block'
interface BlobRecord {
  kind: BlobKind
  content: string
  contentType?: string
  etag: string
}

class FakeAppendBlobClient {
  constructor(private store: Map<string, BlobRecord>, private name: string) {}

  async appendBlock(text: string, length: number): Promise<void> {
    assert.equal(length, Buffer.byteLength(text))
    const record = this.store.get(this.name)
    if (!record) throw Object.assign(new Error('missing'), { statusCode: 404 })
    if (record.kind !== 'append') {
      throw Object.assign(new Error('invalid blob type'), { statusCode: 409, details: { errorCode: 'InvalidBlobType' } })
    }
    record.content += text
    record.etag = bump(record.etag)
  }

  async createIfNotExists(options: any): Promise<{ succeeded: boolean }> {
    if (this.store.has(this.name)) return { succeeded: false }
    this.store.set(this.name, { kind: 'append', content: '', contentType: options.blobHTTPHeaders.blobContentType, etag: '1' })
    return { succeeded: true }
  }
}

class FakeBlockBlobClient {
  constructor(private store: Map<string, BlobRecord>, private name: string) {}

  async download(): Promise<{ etag: string; readableStreamBody: Readable }> {
    const record = this.store.get(this.name)
    if (!record) throw Object.assign(new Error('missing'), { statusCode: 404 })
    return { etag: record.etag, readableStreamBody: Readable.from([record.content]) }
  }

  async upload(content: string, length: number, options: any): Promise<{ etag: string }> {
    assert.equal(length, Buffer.byteLength(content))
    const existing = this.store.get(this.name)
    const ifMatch = options.conditions?.ifMatch
    const ifNoneMatch = options.conditions?.ifNoneMatch

    if (ifNoneMatch === '*' && existing) throw Object.assign(new Error('exists'), { statusCode: 409 })
    if (ifMatch && existing?.etag !== ifMatch) throw Object.assign(new Error('conflict'), { statusCode: 412 })

    const nextEtag = bump(existing?.etag ?? '0')
    this.store.set(this.name, {
      kind: 'block',
      content,
      contentType: options.blobHTTPHeaders.blobContentType,
      etag: nextEtag
    })
    return { etag: nextEtag }
  }
}

class FakeContainerClient {
  constructor(public store = new Map<string, BlobRecord>()) {}

  getAppendBlobClient(name: string): FakeAppendBlobClient {
    return new FakeAppendBlobClient(this.store, name)
  }

  getBlockBlobClient(name: string): FakeBlockBlobClient {
    return new FakeBlockBlobClient(this.store, name)
  }
}

function bump(etag: string): string {
  return String(Number(etag) + 1)
}

function block(content: string, etag = '1'): BlobRecord {
  return { kind: 'block', content, etag }
}

function event(action = 'test_write'): LogEvent {
  return { ts: '2026-06-09T00:00:00.000Z', tool: 'library_write', action }
}

test('appendLogToContainer appends to legacy block logs without deleting or migrating them', async () => {
  const container = new FakeContainerClient(new Map<string, BlobRecord>([
    ['log.jsonl', block('{"ts":"old","tool":"library_write","action":"old"}\n')],
    ['log.md', block('# Library Event Log\n\n- old **library_write** — old\n')]
  ]))

  const result = await appendLogToContainer(container as any, event('patch_metadata page.md'))

  assert.deepEqual(result, { ok: true })
  assert.equal(container.store.get('log.jsonl')?.kind, 'block')
  assert.equal(container.store.get('log.md')?.kind, 'block')
  assert.match(container.store.get('log.jsonl')?.content ?? '', /"action":"old"/)
  assert.match(container.store.get('log.jsonl')?.content ?? '', /"action":"patch_metadata page\.md"/)
  assert.match(container.store.get('log.md')?.content ?? '', /- old \*\*library_write\*\* — old/)
  assert.match(container.store.get('log.md')?.content ?? '', /- 2026-06-09T00:00:00\.000Z \*\*library_write\*\* — patch_metadata page\.md/)
})

test('appendLogToContainer creates missing append logs and seeds the markdown header once', async () => {
  const container = new FakeContainerClient()

  assert.deepEqual(await appendLogToContainer(container as any, event('first')), { ok: true })
  assert.deepEqual(await appendLogToContainer(container as any, event('second')), { ok: true })

  const md = container.store.get('log.md')?.content ?? ''
  assert.equal(container.store.get('log.jsonl')?.kind, 'append')
  assert.equal(container.store.get('log.md')?.kind, 'append')
  assert.equal((md.match(/# Library Event Log/g) ?? []).length, 1)
  assert.match(md, /— first/)
  assert.match(md, /— second/)
})
