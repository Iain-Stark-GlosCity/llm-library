// Runtime diagnostics that are safe to expose in health responses.
// This module intentionally has no storage, vector, embedding, or Azure SDK imports
// so it can be used by liveness checks without touching downstream services.

export interface RuntimeDiagnostics {
  status: 'alive'
  server: string
  time: string
  node: string
  configuration: {
    ready: boolean
    missing: string[]
    present: string[]
    optionalMissing: string[]
  }
}

const REQUIRED_SETTINGS = [
  'FUNCTIONS_WORKER_RUNTIME',
  'FUNCTIONS_EXTENSION_VERSION',
  'WEBSITE_NODE_DEFAULT_VERSION',
  'AzureWebJobsStorage',
  'LIBRARY_STORAGE_CONNECTION_STRING',
  'QDRANT_URL',
  'QDRANT_API_KEY',
  'OPENAI_API_KEY'
]

const OPTIONAL_SETTINGS = [
  'LIBRARY_RAW_CONTAINER',
  'LIBRARY_WIKI_CONTAINER',
  'LIBRARY_SCHEMA_CONTAINER',
  'QDRANT_COLLECTION',
  'EMBEDDING_MODEL'
]

function isConfigured(name: string): boolean {
  return (process.env[name] || '').trim().length > 0
}

export function getRuntimeDiagnostics(server: string): RuntimeDiagnostics {
  const missing = REQUIRED_SETTINGS.filter((name) => !isConfigured(name))
  const present = REQUIRED_SETTINGS.filter((name) => isConfigured(name))
  const optionalMissing = OPTIONAL_SETTINGS.filter((name) => !isConfigured(name))

  return {
    status: 'alive',
    server,
    time: new Date().toISOString(),
    node: process.version,
    configuration: {
      ready: missing.length === 0,
      missing,
      present,
      optionalMissing
    }
  }
}

export function diagnosticsWarnings(diagnostics: RuntimeDiagnostics): string[] {
  if (diagnostics.configuration.ready) return []
  return [
    `Missing required Function App settings: ${diagnostics.configuration.missing.join(', ')}`
  ]
}
