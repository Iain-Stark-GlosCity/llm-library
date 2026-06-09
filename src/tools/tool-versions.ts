import { createHash } from 'crypto'
import { DomainEnvelope, ToolDefinition, ok, toEnvelope } from '../types'
import { TOOL_CONTRACT_VERSION } from './version'
import { WRITE_OPERATIONS } from './write'

function versions(): Record<string, unknown> {
  // Derived from the live OPERATIONS map (see write.ts) — the manifest always reflects
  // exactly what the runtime accepts, so the contract hash can never advertise a stale set.
  const operations = WRITE_OPERATIONS
  const payload = {
    server: 'library-mcp',
    server_version: TOOL_CONTRACT_VERSION,
    tool_contract_version: TOOL_CONTRACT_VERSION,
    consumer_surface: { tools: ['library_ping', 'library_info', 'library_query', 'library_resolve', 'library_lint'], version: TOOL_CONTRACT_VERSION },
    admin_surface: { tools: ['library_write'], operations, version: TOOL_CONTRACT_VERSION },
    rules_surface: { tools: ['library_update_rules'], version: TOOL_CONTRACT_VERSION },
    rdf_surface: { tools: ['library_update_reasoning'], version: TOOL_CONTRACT_VERSION }
  }
  return {
    ...payload,
    manifest_generated_at: new Date().toISOString(),
    contract_hash: createHash('sha256').update(JSON.stringify(payload)).digest('hex')
  }
}

export const toolVersionsTool: ToolDefinition = {
  name: 'library_tool_versions',
  description: 'Return the exposed tool/schema contract version manifest.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  handler: async (): Promise<DomainEnvelope> => toEnvelope(async () => ok(versions(), []))
}
