// Shared types for the library MCP.
//
// Two layers exist (see CLAUDE.md "MCP transport contract"):
//   - The JSON-RPC protocol envelope, owned by functions/mcp.ts.
//   - The DOMAIN envelope below, owned by the tool handlers. A tool handler
//     never knows it is being spoken over JSON-RPC; it just returns one of these.

export type DomainErrorCode =
  | 'VALIDATION_ERROR'
  | 'STORAGE_ERROR'
  | 'EMBEDDING_ERROR'
  | 'CONFLICT'
  | 'NOT_FOUND'

export interface DomainSuccess<T = unknown> {
  ok: true
  data: T
  warnings: string[]
}

export interface DomainError {
  code: DomainErrorCode
  message: string
  details?: unknown
}

export interface DomainFailure {
  ok: false
  error: DomainError
}

export type DomainEnvelope<T = unknown> = DomainSuccess<T> | DomainFailure

// A tool is a pure async function plus a static JSON Schema describing its input.
// functions/mcp.ts routes tools/call through the registry without knowing any
// tool's internals — adding a tool is a single registry entry.
export interface ToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  handler: (input: unknown) => Promise<DomainEnvelope>
}

export function ok<T>(data: T, warnings: string[] = []): DomainSuccess<T> {
  return { ok: true, data, warnings }
}

export function fail(
  code: DomainErrorCode,
  message: string,
  details?: unknown
): DomainFailure {
  return { ok: false, error: { code, message, ...(details !== undefined ? { details } : {}) } }
}
