// Central config read from environment (Azure Function App settings).
// QDRANT_URL keeps no trailing slash here; callers build paths with explicit slashes.

export interface Config {
  storageConnectionString: string
  rawContainer: string
  wikiContainer: string
  schemaContainer: string
  // Layer 1 (Constitution) deterministic rulesets: {domain}.rules.json
  rulesContainer: string
  // Layer 3 (Reasoning Map) Turtle graphs: {domain}.ttl
  rdfContainer: string
  // Which in-process RDF engine to load: oxigraph (real SPARQL 1.1) or n3 (triple
  // traversal fallback for when WASM cold-start cost is unwelcome).
  rdfEngine: 'oxigraph' | 'n3'
  qdrantUrl: string
  qdrantApiKey: string | undefined
  qdrantCollection: string
  openaiApiKey: string
  embeddingModel: string
  mcpMode: 'read_only' | 'librarian'
}

export function getConfig(): Config {
  return {
    storageConnectionString: process.env.LIBRARY_STORAGE_CONNECTION_STRING || '',
    rawContainer: process.env.LIBRARY_RAW_CONTAINER || 'library-raw',
    wikiContainer: process.env.LIBRARY_WIKI_CONTAINER || 'library-wiki',
    schemaContainer: process.env.LIBRARY_SCHEMA_CONTAINER || 'library-schemas',
    rulesContainer: process.env.LIBRARY_RULES_CONTAINER || 'library-rules',
    rdfContainer: process.env.LIBRARY_RDF_CONTAINER || 'library-rdf',
    rdfEngine: process.env.LIBRARY_RDF_ENGINE === 'n3' ? 'n3' : 'oxigraph',
    qdrantUrl: (process.env.QDRANT_URL || '').replace(/\/+$/, ''),
    qdrantApiKey: process.env.QDRANT_API_KEY || undefined,
    qdrantCollection: process.env.QDRANT_COLLECTION || 'library',
    openaiApiKey: process.env.OPENAI_API_KEY || '',
    embeddingModel: process.env.EMBEDDING_MODEL || 'text-embedding-3-small',
    mcpMode: process.env.LIBRARY_MCP_MODE === 'librarian' ? 'librarian' : 'read_only'
  }
}
