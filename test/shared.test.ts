// Deterministic helpers: slug/hash, frontmatter render/strip round-trip, citation
// extraction, and the library_id / domain guards.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  sha256,
  slugify,
  renderFrontmatter,
  stripFrontmatter,
  extractCreated,
  inlineSourceIds,
  daysSince,
  resolveLibraryId,
  assertValidDomain
} from '../src/tools/shared'
import { DomainException } from '../src/types'

test('sha256 is hex and stable', () => {
  assert.equal(sha256('hello'), sha256('hello'))
  assert.match(sha256('hello'), /^[0-9a-f]{64}$/)
})

test('slugify lowercases, hyphenates, trims, caps at 60', () => {
  assert.equal(slugify('Service Patterns: An Overview!'), 'service-patterns-an-overview')
  assert.equal(slugify('  --Weird   input--  '), 'weird-input')
  assert.ok(slugify('x'.repeat(100)).length <= 60)
  assert.ok(!slugify('a'.repeat(59) + ' b').endsWith('-'))
})

const fm = renderFrontmatter({
  title: 'Title: with "quotes"',
  type: 'concept',
  domain: 'ai-knowledge-layer',
  confidence: 'medium',
  status: 'draft',
  summary: 'A summary: testing',
  tags: ['one', 'two'],
  sources: [],
  related: ['other.md'],
  created: '2026-01-01T00:00:00.000Z',
  updated: '2026-06-09T00:00:00.000Z'
})

test('renderFrontmatter quotes scalars and renders lists', () => {
  assert.ok(fm.startsWith('---\n'))
  assert.ok(fm.endsWith('\n---'))
  assert.ok(fm.includes('title: "Title: with \\"quotes\\""'))
  assert.ok(fm.includes('tags:\n  - "one"\n  - "two"'))
  assert.ok(fm.includes('sources: []'))
  assert.ok(!fm.includes('review_after'), 'omitted optional fields are absent entirely')
})

test('stripFrontmatter returns the body; extractCreated reads the original timestamp', () => {
  const page = `${fm}\n\nThe body text.\n`
  assert.equal(stripFrontmatter(page), 'The body text.\n')
  assert.equal(stripFrontmatter('no frontmatter'), 'no frontmatter')
  assert.equal(extractCreated(page), '2026-01-01T00:00:00.000Z')
  assert.equal(extractCreated('body only'), null)
})

test('inlineSourceIds extracts unique [source: ...] markers', () => {
  const body = 'Claim A [source: 2026/05/x-abc.md]. Claim B [source: claude-build-13] and again [source: 2026/05/x-abc.md].'
  assert.deepEqual(inlineSourceIds(body).sort(), ['2026/05/x-abc.md', 'claude-build-13'])
  assert.deepEqual(inlineSourceIds('nothing cited'), [])
})

test('daysSince returns 0 for unparseable dates', () => {
  assert.equal(daysSince('not-a-date'), 0)
  assert.ok(daysSince(new Date(Date.now() - 86_400_000 * 2).toISOString()) >= 2)
})

test('resolveLibraryId defaults and rejects non-default ids', () => {
  assert.equal(resolveLibraryId(undefined), 'default')
  assert.equal(resolveLibraryId({}), 'default')
  assert.equal(resolveLibraryId({ library_id: '' }), 'default')
  assert.equal(resolveLibraryId({ library_id: 'default' }), 'default')
  assert.throws(() => resolveLibraryId({ library_id: 'other' }), (e: any) => e instanceof DomainException && e.code === 'VALIDATION_ERROR')
  assert.throws(() => resolveLibraryId({ library_id: 42 }), DomainException)
})

test('assertValidDomain accepts slugs and rejects everything else', () => {
  assert.equal(assertValidDomain('council-tax'), 'council-tax')
  for (const bad of ['', 'Has Spaces', 'UPPER', '-leading', 'a'.repeat(81), 42, null]) {
    assert.throws(() => assertValidDomain(bad as any), DomainException)
  }
})
