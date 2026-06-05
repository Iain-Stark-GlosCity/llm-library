// MCP transport: JSON-RPC 2.0 over a single HTTP POST, application/json response.
// NOT SSE / not text/event-stream. Stateless — no session, no Mcp-Session-Id.
// See CLAUDE.md "MCP transport contract" for the full contract.
//
// One HTTP function per tool SURFACE: a read-only consumption endpoint plus three per-bit
// admin endpoints (Layer 2 library, Layer 1 rules, Layer 3 reasoning map). createMcpFunction
// closes the shared dispatcher over a surface's tool list + serverInfo name, so each route
// exposes only its own tools. Admin routes avoid the reserved Azure Functions /admin
// namespace by using flat /api/mcp-* paths.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions'
import { ToolDefinition } from '../types'
import { pingTool } from '../tools/ping'
import { SURFACES, SurfaceName } from '../tools/registry'
import { diagnosticsWarnings, getRuntimeDiagnostics } from '../runtime-diagnostics'
import { getConfig } from '../config'

const SERVER_VERSION = '0.1.0'

// Protocol versions we understand, newest first. We echo the client's requested
// version when supported, otherwise fall back to our preferred (first) entry.
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']
const DEFAULT_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0]

// JSON-RPC 2.0 reserved error codes. These signal PROTOCOL problems only.
// Domain failures (VALIDATION_ERROR, CONFLICT, ...) are never JSON-RPC errors —
// they ride inside a successful tools/call result with isError: true.
const PARSE_ERROR = -32700
const INVALID_REQUEST = -32600
const METHOD_NOT_FOUND = -32601
const INVALID_PARAMS = -32602
const INTERNAL_ERROR = -32603

type JsonRpcId = string | number | null

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: JsonRpcId
  method: string
  params?: any
}

// A typed throw used by method handlers to request a specific JSON-RPC error.
class RpcError extends Error {
  constructor(public code: number, message: string) {
    super(message)
  }
}

// Per-surface dispatch context: the serverInfo name advertised on initialize and the tool
// map this endpoint exposes.
interface Surface {
  serverName: string
  tools: ToolDefinition[]
  toolMap: Map<string, ToolDefinition>
}

function jsonResponse(body: unknown, status = 200): HttpResponseInit {
  return {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store'
    },
    jsonBody: body
  }
}

function rpcResult(id: JsonRpcId, result: unknown): HttpResponseInit {
  return jsonResponse({ jsonrpc: '2.0', id, result })
}

function rpcError(id: JsonRpcId, code: number, message: string): HttpResponseInit {
  return jsonResponse({ jsonrpc: '2.0', id, error: { code, message } })
}

function transportHealthResponse(surface: Surface): HttpResponseInit {
  const diagnostics = getRuntimeDiagnostics(surface.serverName)
  return jsonResponse({
    ok: true,
    data: {
      ...diagnostics,
      mcp_mode: getConfig().mcpMode,
      surface: surface.serverName,
      tools: surface.tools.map((t) => t.name)
    },
    warnings: diagnosticsWarnings(diagnostics)
  })
}

function emptyResponse(status: number): HttpResponseInit {
  return { status, headers: { 'Cache-Control': 'no-store' } }
}

// Accepted notification — no response body is sent (HTTP 202).
const NO_RESPONSE = Symbol('no-response')

function lookupTool(surface: Surface, name: string): ToolDefinition | undefined {
  if (name === pingTool.name) return pingTool
  return surface.toolMap.get(name)
}

async function handleMethod(
  surface: Surface,
  req: JsonRpcRequest,
  isNotification: boolean
): Promise<unknown | typeof NO_RESPONSE> {
  switch (req.method) {
    case 'initialize': {
      const requested = req.params?.protocolVersion
      const protocolVersion =
        typeof requested === 'string' && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
          ? requested
          : DEFAULT_PROTOCOL_VERSION
      return {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: surface.serverName, version: SERVER_VERSION }
      }
    }

    case 'notifications/initialized':
      // Client courtesy notification. Accept and ignore. If a client incorrectly
      // attaches an id, still answer so the JSON-RPC request does not hang.
      return isNotification ? NO_RESPONSE : {}

    case 'ping':
      return {}

    case 'tools/list':
      return {
        tools: surface.tools.map(({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema
        }))
      }

    case 'tools/call': {
      const params = req.params
      const name = params?.name
      if (typeof name !== 'string') {
        throw new RpcError(INVALID_PARAMS, 'tools/call requires a string "name"')
      }
      if (!params || typeof params !== 'object' || Array.isArray(params)) {
        throw new RpcError(INVALID_PARAMS, 'tools/call requires params with a string "name"')
      }
      const args = 'arguments' in params ? params.arguments : {}
      if (args === null || typeof args !== 'object' || Array.isArray(args)) {
        throw new RpcError(INVALID_PARAMS, 'tools/call "arguments" must be an object when provided')
      }
      const tool = lookupTool(surface, name)
      if (!tool) {
        throw new RpcError(INVALID_PARAMS, `Unknown tool: ${name}`)
      }
      const envelope = await tool.handler(args)
      return {
        content: [{ type: 'text', text: JSON.stringify(envelope) }],
        isError: envelope.ok === false
      }
    }

    default:
      // Unknown notifications must not produce an error response (no id to address).
      if (isNotification && req.method.startsWith('notifications/')) return NO_RESPONSE
      throw new RpcError(METHOD_NOT_FOUND, `Method not found: ${req.method}`)
  }
}

async function dispatch(
  surface: Surface,
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  if (request.method === 'GET') {
    return transportHealthResponse(surface)
  }
  if (request.method === 'HEAD') {
    return emptyResponse(200)
  }
  if (request.method === 'OPTIONS') {
    return emptyResponse(204)
  }
  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405)
  }

  let raw: string
  try {
    raw = await request.text()
  } catch {
    return rpcError(null, PARSE_ERROR, 'Failed to read request body')
  }

  let body: any
  try {
    body = JSON.parse(raw)
  } catch {
    return rpcError(null, PARSE_ERROR, 'Parse error: request body is not valid JSON')
  }

  // Batch requests are out of scope for MVP.
  if (Array.isArray(body)) {
    return rpcError(null, INVALID_REQUEST, 'Batch requests are not supported')
  }

  if (
    body === null ||
    typeof body !== 'object' ||
    body.jsonrpc !== '2.0' ||
    typeof body.method !== 'string'
  ) {
    const candidateId = body && typeof body === 'object' ? body.id ?? null : null
    const id =
      candidateId === null || typeof candidateId === 'string' || typeof candidateId === 'number'
        ? candidateId
        : null
    return rpcError(id, INVALID_REQUEST, 'Invalid JSON-RPC 2.0 request')
  }

  // A message with no "id" is a notification: process it, return 202, no body.
  const isNotification = !('id' in body)
  const id: JsonRpcId = isNotification ? null : body.id
  if (!isNotification && id !== null && typeof id !== 'string' && typeof id !== 'number') {
    return rpcError(null, INVALID_REQUEST, 'Invalid JSON-RPC id')
  }

  try {
    const result = await handleMethod(surface, body as JsonRpcRequest, isNotification)
    if (isNotification || result === NO_RESPONSE) {
      return { status: 202 }
    }
    return rpcResult(id, result)
  } catch (err) {
    if (isNotification) {
      // Never send an error response to a notification.
      return { status: 202 }
    }
    if (err instanceof RpcError) {
      return rpcError(id, err.code, err.message)
    }
    context.error('Unhandled error in mcp handler', err)
    return rpcError(id, INTERNAL_ERROR, 'Internal error')
  }
}

// Register one HTTP function for a named tool surface.
function createMcpFunction(opts: {
  functionName: string
  route: string
  serverName: string
  surface: SurfaceName
}): void {
  const tools = SURFACES[opts.surface]
  const surface: Surface = {
    serverName: opts.serverName,
    tools,
    toolMap: new Map(tools.map((t) => [t.name, t]))
  }
  // authLevel 'anonymous' for MVP — MCP auth is deferred (function keys are a faff to
  // thread through MCP clients today). Put each route behind a key / APIM / Easy Auth before
  // loading anything sensitive — ADMIN routes especially: they mutate the Constitution
  // (rules) and the reasoning map.
  app.http(opts.functionName, {
    methods: ['GET', 'HEAD', 'OPTIONS', 'POST'],
    authLevel: 'anonymous',
    route: opts.route,
    handler: (request, context) => dispatch(surface, request, context)
  })
}

// Consumption (read-only) — kept at /api/mcp for backward compatibility.
createMcpFunction({ functionName: 'mcp', route: 'mcp', serverName: 'library-consumption', surface: 'consumption' })

// Per-bit admin surfaces. Flat /api/mcp-* routes (NOT under /admin, which Azure reserves).
createMcpFunction({ functionName: 'mcpLibraryAdmin', route: 'mcp-library', serverName: 'library-admin', surface: 'library-admin' })
createMcpFunction({ functionName: 'mcpRulesAdmin', route: 'mcp-rules', serverName: 'rules-admin', surface: 'rules-admin' })
createMcpFunction({ functionName: 'mcpRdfAdmin', route: 'mcp-rdf', serverName: 'rdf-admin', surface: 'rdf-admin' })
