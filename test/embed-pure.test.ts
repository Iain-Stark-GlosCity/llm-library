// Pure embedding helpers: sparse (TF) vector generation, tokenisation, chunking, and
// stable point-id generation.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tokenize, tokenToIndex, sparseVector, STOPWORDS } from '../src/embed/sparse'
import { chunkText } from '../src/embed/chunk'
import { wikiPagePointId, rawChunkPointId } from '../src/embed/ids'

test('tokenize lowercases, splits on non-alphanumerics, drops stopwords', () => {
  assert.deepEqual(tokenize('Reg 72 applies WITH their consent!'), ['reg', '72', 'applies', 'consent'])
  for (const t of tokenize('this that there were')) assert.equal(STOPWORDS.has(t), false)
})

test('tokenToIndex is stable and within [0, 2^20)', () => {
  for (const token of ['reg', 'smi', '63-day', 'bailiff', 'a']) {
    const idx = tokenToIndex(token)
    assert.equal(idx, tokenToIndex(token))
    assert.ok(idx >= 0 && idx < 2 ** 20, `${token} -> ${idx}`)
    assert.ok(Number.isInteger(idx))
  }
})

test('sparseVector counts term frequency per hashed index', () => {
  const v = sparseVector('bailiff bailiff warrant')
  assert.equal(v.indices.length, 2)
  assert.equal(v.values[v.indices.indexOf(tokenToIndex('bailiff'))], 2)
  assert.equal(v.values[v.indices.indexOf(tokenToIndex('warrant'))], 1)
})

test('sparseVector of empty/stopword-only text is empty (query falls back to dense-only)', () => {
  assert.deepEqual(sparseVector(''), { indices: [], values: [] })
  assert.deepEqual(sparseVector('this that'), { indices: [], values: [] })
})

test('chunkText returns one chunk for short text', () => {
  assert.deepEqual(chunkText('hello'), ['hello'])
  const exactly = 'x'.repeat(4000)
  assert.deepEqual(chunkText(exactly), [exactly])
})

test('chunkText covers the full text with the documented overlap', () => {
  const text = 'a'.repeat(10_000)
  const chunks = chunkText(text)
  // step = 4000 - 800 = 3200: starts at 0, 3200, 6400; the third chunk reaches the end.
  assert.equal(chunks.length, 3)
  assert.equal(chunks[0].length, 4000)
  assert.equal(chunks[chunks.length - 1].length, 10_000 - 6400)
  // Reconstruct: every character position must be covered by some chunk.
  let covered = 0
  for (let i = 0; i < chunks.length; i++) {
    const start = i * 3200
    covered = Math.max(covered, start + chunks[i].length)
    assert.ok(start <= covered, 'no gap between chunks')
  }
  assert.equal(covered, text.length)
})

test('point ids are stable UUIDv5s, distinct per identity', () => {
  const a = wikiPagePointId('default', 'service-patterns.md')
  assert.equal(a, wikiPagePointId('default', 'service-patterns.md'))
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  assert.notEqual(a, wikiPagePointId('default', 'other.md'))
  const c0 = rawChunkPointId('default', '2026/05/x-abc.md', 0)
  assert.equal(c0, rawChunkPointId('default', '2026/05/x-abc.md', 0))
  assert.notEqual(c0, rawChunkPointId('default', '2026/05/x-abc.md', 1))
})
