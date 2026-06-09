// Cache-currency (supersession) computation — pure read-side logic over raw_manifest
// entries. Pins the grouping rules: upstream_id beats source_url, registered sources
// never participate, and ungroupable snapshots only know their age.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeSourceFreshness, computePageFreshness, upstreamKey } from '../src/tools/freshness'
import { SourceEntry } from '../src/storage/raw-manifest'

function src(partial: Partial<SourceEntry>): SourceEntry {
  return {
    source_id: 'id',
    title: 't',
    source_type: 'primary',
    domain: 'd',
    source_url: '',
    created: '2026-01-01T00:00:00.000Z',
    chunks_indexed: 1,
    embedding_status: 'ok',
    ...partial
  }
}

test('upstreamKey prefers upstream_id, falls back to source_url, null for registered', () => {
  assert.equal(upstreamKey(src({ upstream_id: 'leg/uk/1992', source_url: 'https://x' })), 'leg/uk/1992')
  assert.equal(upstreamKey(src({ source_url: 'https://x' })), 'https://x')
  assert.equal(upstreamKey(src({})), null)
  assert.equal(upstreamKey(src({ kind: 'registered', source_url: 'https://x' })), null)
})

const sources: SourceEntry[] = [
  src({ source_id: 'old.md', upstream_id: 'doc-1', created: '2026-01-01T00:00:00.000Z' }),
  src({ source_id: 'mid.md', upstream_id: 'doc-1', created: '2026-03-01T00:00:00.000Z' }),
  src({ source_id: 'new.md', upstream_id: 'doc-1', created: '2026-05-01T00:00:00.000Z' }),
  src({ source_id: 'lone.md', created: '2026-04-01T00:00:00.000Z' }), // no upstream identity
  src({ source_id: 'reg-anchor', kind: 'registered' })
]

test('computeSourceFreshness detects supersession within an upstream group', () => {
  const f = computeSourceFreshness(sources)
  assert.deepEqual(f.get('old.md')!.superseded_by, ['mid.md', 'new.md'])
  assert.deepEqual(f.get('mid.md')!.superseded_by, ['new.md'])
  assert.deepEqual(f.get('new.md')!.superseded_by, [])
  assert.equal(f.get('old.md')!.groupable, true)
  assert.equal(f.get('lone.md')!.groupable, false)
  assert.deepEqual(f.get('lone.md')!.superseded_by, [])
  assert.equal(f.has('reg-anchor'), false, 'registered sources are not snapshots')
})

test('computePageFreshness aggregates cited snapshots', () => {
  const f = computeSourceFreshness(sources)
  const stale = computePageFreshness(['old.md', 'new.md'], f)
  assert.equal(stale.superseded, true)
  assert.deepEqual(stale.superseding_sources.sort(), ['mid.md', 'new.md'])
  assert.ok(stale.oldest_snapshot_age_days! > 0)

  const current = computePageFreshness(['new.md'], f)
  assert.equal(current.superseded, false)

  const none = computePageFreshness(['reg-anchor', 'unknown.md'], f)
  assert.equal(none.oldest_snapshot_age_days, null)
  assert.equal(none.superseded, false)
})
