// raw_manifest.json — machine-readable source registry. ETag-aware. See CLAUDE.md.
// content_hash (full SHA-256) is stored so library_ingest can distinguish a true
// duplicate from a source_id collision with differing content.

import { getRawContainer, readBlob, conditionalWrite, WriteResult } from './blobs'

const RAW_MANIFEST_BLOB = 'raw_manifest.json'

export interface SourceEntry {
  source_id: string
  title: string
  source_type: string
  domain: string
  source_url: string
  created: string
  chunks_indexed: number
  embedding_status: 'ok' | 'failed'
  content_hash: string
}

export interface RawManifest {
  library_id: string
  updated: string
  sources: SourceEntry[]
}

export async function readRawManifest(
  libraryId: string
): Promise<{ manifest: RawManifest; etag: string | null }> {
  const container = await getRawContainer()
  const res = await readBlob(container, RAW_MANIFEST_BLOB)
  if (!res) {
    return {
      manifest: { library_id: libraryId, updated: new Date().toISOString(), sources: [] },
      etag: null
    }
  }
  return { manifest: JSON.parse(res.content) as RawManifest, etag: res.etag }
}

export async function writeRawManifest(
  manifest: RawManifest,
  etag: string | null
): Promise<WriteResult> {
  manifest.updated = new Date().toISOString()
  const container = await getRawContainer()
  return conditionalWrite(container, RAW_MANIFEST_BLOB, JSON.stringify(manifest, null, 2), etag)
}
