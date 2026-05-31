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
