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
  content_hash?: string
  // 'ingested' = full raw blob + vectors. 'registered' = metadata-only citation
  // anchor created by library_register_source (no blob, no vectors). Defaults to
  // 'ingested' when absent for backwards compatibility.
  kind?: 'ingested' | 'registered'
  // false for metadata-only registered sources; lint skips the indexing check for them.
  indexed?: boolean
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
