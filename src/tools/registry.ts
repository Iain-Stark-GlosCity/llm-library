// Tool registry. The transport (functions/mcp.ts) registers one HTTP endpoint per named
// surface and routes that endpoint's tools/call requests through the surface's tool map.
// library_ping is also imported directly by the transport so health checks stay
// dependency-light. Adding a tool is one entry on the relevant surface here.
//
// Three-layer "Sovereign AI" topology: a single read-only CONSUMPTION surface, plus three
// per-bit ADMIN surfaces (Layer 2 library, Layer 1 rules, Layer 3 reasoning map), each
// separately routed and keyed. This generalises the former LIBRARY_MCP_MODE read/librarian
// toggle: the mode is now the route, not an env flag.

import { ToolDefinition } from '../types'
import { pingTool } from './ping'
import { infoTool } from './info'
import { queryTool } from './query'
import { resolveTool } from './resolve'
import { writeTool } from './write'
import { lintTool } from './lint'
import { updateRulesTool } from './update-rules'
import { updateReasoningTool } from './update-reasoning'

// Read-only consumption: orient → read (all three layers, via library_info) → retrieve →
// resolve a governed answer → check health. No mutation.
export const CONSUMPTION_TOOLS: ToolDefinition[] = [
  pingTool,
  infoTool,
  queryTool,
  resolveTool,
  lintTool
]

// Layer 2 admin — the library write path (ingest/register/update_page/schema/etc.).
export const LIBRARY_ADMIN_TOOLS: ToolDefinition[] = [pingTool, infoTool, writeTool]

// Layer 1 admin — the Constitution. Write deterministic rulesets.
export const RULES_ADMIN_TOOLS: ToolDefinition[] = [pingTool, infoTool, updateRulesTool]

// Layer 3 admin — the Reasoning Map. Write Turtle maps.
export const RDF_ADMIN_TOOLS: ToolDefinition[] = [pingTool, infoTool, updateReasoningTool]

export type SurfaceName = 'consumption' | 'library-admin' | 'rules-admin' | 'rdf-admin'

export const SURFACES: Record<SurfaceName, ToolDefinition[]> = {
  consumption: CONSUMPTION_TOOLS,
  'library-admin': LIBRARY_ADMIN_TOOLS,
  'rules-admin': RULES_ADMIN_TOOLS,
  'rdf-admin': RDF_ADMIN_TOOLS
}

// Backwards-compatible default surface (the consumption endpoint at /api/mcp).
export const TOOLS: ToolDefinition[] = CONSUMPTION_TOOLS
export const TOOL_MAP: Map<string, ToolDefinition> = new Map(TOOLS.map((t) => [t.name, t]))
