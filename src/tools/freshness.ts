// Cache-currency helpers — Challenge B, Phase 1 (offline).
//
// A source_id embeds the content hash, so re-ingesting a changed upstream document
// lands as a NEW source_id while older snapshots remain. A page that cites an older
// source_id is therefore version-pinned to that snapshot. To recognise that two
// snapshots are versions of the SAME upstream document we need a stable upstream
// identity: upstream_id when set, else source_url. Without either, a snapshot cannot
// be grouped and only its age is knowable (not whether it has been superseded).
//
// All supersession is computed on read from raw_manifest — nothing is stored as a
// "superseded" flag — so existing content needs no migration: any source that already
// carries a source_url groups correctly with zero backfill.

import { SourceEntry } from '../storage/raw-manifest'
import { daysSince } from './shared'

// The stable identity used to group snapshots of the same upstream document.
// Registered (metadata-only) sources are citation anchors, not snapshots, so they
// never participate in supersession.
export function upstreamKey(s: SourceEntry): string | null {
  if ((s.kind ?? 'ingested') === 'registered') return null
  const key = (s.upstream_id || s.source_url || '').trim()
  return key.length > 0 ? key : null
}

export interface SourceFreshness {
  source_id: string
  age_days: number
  // Newer snapshots of the same upstream document, oldest-first. Non-empty => this
  // snapshot has been superseded.
  superseded_by: string[]
  // false when the source has no upstream identity (no upstream_id and no source_url),
  // so supersession cannot be determined — only age.
  groupable: boolean
}

// Build a source_id -> freshness map over the ingested sources in a raw manifest.
export function computeSourceFreshness(sources: SourceEntry[]): Map<string, SourceFreshness> {
  const ingested = sources.filter((s) => (s.kind ?? 'ingested') !== 'registered')

  const groups = new Map<string, SourceEntry[]>()
  for (const s of ingested) {
    const key = upstreamKey(s)
    if (!key) continue
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(s)
  }
  for (const arr of groups.values()) {
    arr.sort((a, b) => Date.parse(a.created) - Date.parse(b.created))
  }

  const out = new Map<string, SourceFreshness>()
  for (const s of ingested) {
    const key = upstreamKey(s)
    let superseded_by: string[] = []
    if (key) {
      const created = Date.parse(s.created)
      superseded_by = groups
        .get(key)!
        .filter((o) => o.source_id !== s.source_id && Date.parse(o.created) > created)
        .map((o) => o.source_id)
    }
    out.set(s.source_id, {
      source_id: s.source_id,
      age_days: Math.floor(daysSince(s.created)),
      superseded_by,
      groupable: Boolean(key)
    })
  }
  return out
}

// Freshness of a curated page, derived from the snapshots it cites.
export interface PageFreshness {
  // Stalest cited snapshot age, or null when the page cites no ingested snapshot.
  oldest_snapshot_age_days: number | null
  // true when any cited snapshot has a newer version available.
  superseded: boolean
  // Newer source_ids available for the page's cited snapshots.
  superseding_sources: string[]
}

export function computePageFreshness(
  citedSourceIds: string[],
  freshness: Map<string, SourceFreshness>
): PageFreshness {
  let oldest: number | null = null
  const superseding = new Set<string>()
  for (const id of citedSourceIds) {
    const f = freshness.get(id)
    if (!f) continue // registered/unknown source: not a snapshot
    oldest = oldest === null ? f.age_days : Math.max(oldest, f.age_days)
    for (const newer of f.superseded_by) superseding.add(newer)
  }
  return {
    oldest_snapshot_age_days: oldest,
    superseded: superseding.size > 0,
    superseding_sources: [...superseding]
  }
}
