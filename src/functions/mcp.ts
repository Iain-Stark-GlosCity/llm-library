// MCP transport: JSON-RPC 2.0 over a single HTTP POST, application/json response.
// NOT SSE / not text/event-stream. Stateless — no session, no Mcp-Session-Id.
// See CLAUDE.md "MCP transport contract" for the full contract.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions'
import { TOOLS, TOOL_MAP } from '../tools/registry'

const SERVER_NAME = 'library-mcp'
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

function jsonResponse(body: unknown, status = 200): HttpResponseInit {
  return {
    status,
    headers: { 'Content-Type': 'application/json' },
    jsonBody: body
  }
}

function rpcResult(id: JsonRpcId, result: unknown): HttpResponseInit {
  return jsonResponse({ jsonrpc: '2.0', id, result })
}

function rpcError(id: JsonRpcId, code: number, message: string): HttpResponseInit {
  return jsonResponse({ jsonrpc: '2.0', id, error: { code, message } })
}

// Accepted notification — no response body is sent (HTTP 202).
const NO_RESPONSE = Symbol('no-response')

async function handleMethod(req: JsonRpcRequest): Promise<unknown | typeof NO_RESPONSE> {
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
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION }
      }
    }

    case 'notifications/initialized':
      // Client courtesy notification. Accept and ignore.
      return NO_RESPONSE

    case 'ping':
      return {}

    case 'tools/list':
      return {
        tools: TOOLS.map(({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema
        }))
      }

    case 'tools/call': {
      const name = req.params?.name
      const args = req.params?.arguments ?? {}
      if (typeof name !== 'string') {
        throw new RpcError(INVALID_PARAMS, 'tools/call requires a string "name"')
      }
      const tool = TOOL_MAP.get(name)
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
      if (req.method.startsWith('notifications/')) return NO_RESPONSE
      throw new RpcError(METHOD_NOT_FOUND, `Method not found: ${req.method}`)
  }
}

export async function mcpHandler(
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
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
    const id = body && typeof body === 'object' ? body.id ?? null : null
    return rpcError(id, INVALID_REQUEST, 'Invalid JSON-RPC 2.0 request')
  }

  // A message with no "id" is a notification: process it, return 202, no body.
  const isNotification = !('id' in body)
  const id: JsonRpcId = isNotification ? null : body.id

  try {
    const result = await handleMethod(body as JsonRpcRequest)
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

app.http('mcp', {
  methods: ['POST'],
  authLevel: 'function',
  route: 'mcp',
  handler: mcpHandler
})
