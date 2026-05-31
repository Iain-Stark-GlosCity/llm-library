// Stable UUIDv5 point IDs. Same inputs always produce the same UUID, which is what
// makes Qdrant upsert idempotent. See CLAUDE.md "UUIDv5 point ID generation".

import { v5 as uuidv5 } from 'uuid'

const NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8' // URL namespace

export function wikiPagePointId(libraryId: string, filename: string): string {
  return uuidv5(`wiki_page:${libraryId}:${filename}`, NAMESPACE)
}

export function rawChunkPointId(
  libraryId: string,
  sourceId: string,
  chunkIndex: number
): string {
  return uuidv5(`raw_chunk:${libraryId}:${sourceId}:${chunkIndex}`, NAMESPACE)
}
