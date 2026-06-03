// manifest.json — machine-readable wiki page registry. ETag-aware. See CLAUDE.md.

import { getWikiContainer, readBlob, conditionalWrite, WriteResult } from './blobs'

const MANIFEST_BLOB = 'manifest.json'

export interface PageEntry {
  filename: string
  title: string
  type: string
  domain: string
  confidence: string
  status: string
  summary: string
  tags: string[]
  sources: string[]
  related: string[]
  review_after?: string
  reviewed_by?: string
  reviewed_at?: string
  // Governance metadata (all optional, additive — existing entries need no migration).
  // allowed_use/prohibited_use draw from the governance vocabulary; last_source_check is
  // when the curator last verified the page against its sources; business_consequence_if_stale
  // is low|medium|high; invalidation_policy is free text describing when to invalidate.
  allowed_use?: string[]
  prohibited_use?: string[]
  last_source_check?: string
  business_consequence_if_stale?: string
  invalidation_policy?: string
  created: string
  updated: string
  embedding_status: 'ok' | 'failed' | 'pending'
}

export interface Manifest {
  library_id: string
  updated: string
  pages: PageEntry[]
}

export async function readManifest(
  libraryId: string
): Promise<{ manifest: Manifest; etag: string | null }> {
  const container = await getWikiContainer()
  const res = await readBlob(container, MANIFEST_BLOB)
  if (!res) {
    return {
      manifest: { library_id: libraryId, updated: new Date().toISOString(), pages: [] },
      etag: null
    }
  }
  return { manifest: JSON.parse(res.content) as Manifest, etag: res.etag }
}

export async function writeManifest(
  manifest: Manifest,
  etag: string | null
): Promise<WriteResult> {
  manifest.updated = new Date().toISOString()
  const container = await getWikiContainer()
  return conditionalWrite(container, MANIFEST_BLOB, JSON.stringify(manifest, null, 2), etag)
}
