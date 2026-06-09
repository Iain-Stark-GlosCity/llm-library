// JSON-RPC dispatcher protocol edges, exercised without HTTP scaffolding via the
// exported dispatch()/makeSurface(). The key contract under test: protocol problems are
// JSON-RPC errors; DOMAIN failures ride inside a SUCCESSFUL tools/call result with
// isError: true.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dispatch, makeSurface } from '../src/functions/mcp'
import { ToolDefinition, ok, fail } from '../src/types'

const echoTool: ToolDefinition = {
  name: 'echo',
  description: 'returns its input',
  inputSchema: { type: 'object' },
  handler: async (input) => ok({ echoed: input })
}

const failingTool: ToolDefinition = {
  name: 'always_fails',
  description: 'returns a domain failure',
  inputSchema: { type: 'object' },
  handler: async () => fail('VALIDATION_ERROR', 'nope')
}

const surface = makeSurface('test-surface', [echoTool, failingTool])
const ctx: any = { error: () => {} }

function post(body: unknown): any {
  const raw = typeof body === 'string' ? body : JSON.stringify(body)
  return { method: 'POST', text: async () => raw }
}

async function rpc(body: unknown) {
  const res = await dispatch(surface, post(body), ctx)
  return res
}

test('initialize echoes a supported protocolVersion and pins ours otherwise', async () => {
  const res = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } })
  assert.equal((res.jsonBody as any).result.protocolVersion, '2025-03-26')
  const res2 = await rpc({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } })
  assert.equal((res2.jsonBody as any).result.protocolVersion, '2025-06-18')
  assert.deepEqual((res2.jsonBody as any).result.capabilities, { tools: {} })
  assert.equal((res2.jsonBody as any).result.serverInfo.name, 'test-surface')
})

test('tools/list returns the surface tools', async () => {
  const res = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/list' })
  const tools = (res.jsonBody as any).result.tools
  assert.deepEqual(tools.map((t: any) => t.name), ['echo', 'always_fails'])
  assert.ok(tools.every((t: any) => t.inputSchema && t.description))
})

test('ping returns an empty object result', async () => {
  const res = await rpc({ jsonrpc: '2.0', id: 4, method: 'ping' })
  assert.deepEqual((res.jsonBody as any).result, {})
})

test('a message without id is a notification: 202, no body', async () => {
  const res = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' })
  assert.equal(res.status, 202)
  assert.equal(res.jsonBody, undefined)
})

test('invalid JSON → -32700 with null id', async () => {
  const res = await rpc('{not json')
  assert.equal((res.jsonBody as any).error.code, -32700)
  assert.equal((res.jsonBody as any).id, null)
})

test('batch arrays are rejected with -32600', async () => {
  const res = await rpc([{ jsonrpc: '2.0', id: 1, method: 'ping' }])
  assert.equal((res.jsonBody as any).error.code, -32600)
})

test('non-JSON-RPC body → -32600; unknown method → -32601; unknown tool → -32602', async () => {
  assert.equal(((await rpc({ id: 1, method: 'ping' })).jsonBody as any).error.code, -32600)
  assert.equal(((await rpc({ jsonrpc: '2.0', id: 1, method: 'no/such' })).jsonBody as any).error.code, -32601)
  const res = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'missing', arguments: {} } })
  assert.equal((res.jsonBody as any).error.code, -32602)
})

test('tools/call wraps the domain envelope as text content', async () => {
  const res = await rpc({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'echo', arguments: { a: 1 } } })
  const result = (res.jsonBody as any).result
  assert.equal(result.isError, false)
  const envelope = JSON.parse(result.content[0].text)
  assert.deepEqual(envelope, { ok: true, data: { echoed: { a: 1 } }, warnings: [] })
})

test('a DOMAIN failure is a SUCCESSFUL JSON-RPC response with isError: true', async () => {
  const res = await rpc({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'always_fails', arguments: {} } })
  const body = res.jsonBody as any
  assert.equal(body.error, undefined, 'domain failures must not become JSON-RPC errors')
  assert.equal(body.result.isError, true)
  const envelope = JSON.parse(body.result.content[0].text)
  assert.equal(envelope.ok, false)
  assert.equal(envelope.error.code, 'VALIDATION_ERROR')
})

test('non-POST methods are handled (HEAD 200, OPTIONS 204, PUT 405)', async () => {
  assert.equal((await dispatch(surface, { method: 'HEAD' } as any, ctx)).status, 200)
  assert.equal((await dispatch(surface, { method: 'OPTIONS' } as any, ctx)).status, 204)
  assert.equal((await dispatch(surface, { method: 'PUT' } as any, ctx)).status, 405)
})
