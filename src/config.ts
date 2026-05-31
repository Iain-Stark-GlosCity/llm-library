// Central config read from environment (Azure Function App settings).
// QDRANT_URL keeps no trailing slash here; callers build paths with explicit slashes.

export interface Config {
  storageConnectionString: string
  rawContainer: string
  wikiContainer: string
  qdrantUrl: string
  qdrantApiKey: string | undefined
  qdrantCollection: string
  openaiApiKey: string
  embeddingModel: string
}

export function getConfig(): Config {
  return {
    storageConnectionString: process.env.LIBRARY_STORAGE_CONNECTION_STRING || '',
    rawContainer: process.env.LIBRARY_RAW_CONTAINER || 'library-raw',
    wikiContainer: process.env.LIBRARY_WIKI_CONTAINER || 'library-wiki',
    qdrantUrl: (process.env.QDRANT_URL || '').replace(/\/+$/, ''),
    qdrantApiKey: process.env.QDRANT_API_KEY || undefined,
    qdrantCollection: process.env.QDRANT_COLLECTION || 'library',
    openaiApiKey: process.env.OPENAI_API_KEY || '',
    embeddingModel: process.env.EMBEDDING_MODEL || 'text-embedding-3-small'
  }
}
