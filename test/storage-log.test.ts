import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { appendLogToContainer, LogEvent } from '../src/storage/log'

type BlobKind = 'append' | 'block'
interface BlobRecord {
  kind: BlobKind
  content: string
  contentType?: string
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
  }

  async createIfNotExists(options: any): Promise<{ succeeded: boolean }> {
    if (this.store.has(this.name)) return { succeeded: false }
    this.store.set(this.name, { kind: 'append', content: '', contentType: options.blobHTTPHeaders.blobContentType })
    return { succeeded: true }
  }

  async create(options: any): Promise<void> {
    if (this.store.has(this.name)) {
      throw Object.assign(new Error('already exists'), { statusCode: 409, details: { errorCode: 'BlobAlreadyExists' } })
    }
    this.store.set(this.name, { kind: 'append', content: '', contentType: options.blobHTTPHeaders.blobContentType })
  }

  async deleteIfExists(): Promise<{ succeeded: boolean }> {
    const existed = this.store.delete(this.name)
    return { succeeded: existed }
  }
}

class FakeBlockBlobClient {
  constructor(private store: Map<string, BlobRecord>, private name: string) {}

  async download(): Promise<{ etag: string; readableStreamBody: Readable }> {
    const record = this.store.get(this.name)
    if (!record) throw Object.assign(new Error('missing'), { statusCode: 404 })
    return { etag: 'etag', readableStreamBody: Readable.from([record.content]) }
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

function event(action = 'test_write'): LogEvent {
  return { ts: '2026-06-09T00:00:00.000Z', tool: 'library_write', action }
}

test('appendLogToContainer migrates legacy block logs to append blobs before writing', async () => {
  const container = new FakeContainerClient(new Map<string, BlobRecord>([
    ['log.jsonl', { kind: 'block', content: '{"ts":"old","tool":"library_write","action":"old"}\n' }],
    ['log.md', { kind: 'block', content: '# Library Event Log\n\n- old **library_write** — old\n' }]
  ]))

  const result = await appendLogToContainer(container as any, event('patch_metadata page.md'))

  assert.deepEqual(result, { ok: true })
  assert.equal(container.store.get('log.jsonl')?.kind, 'append')
  assert.equal(container.store.get('log.md')?.kind, 'append')
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
