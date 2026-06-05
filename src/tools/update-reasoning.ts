// Layer 3 write handler, surfaced via the reasoning_write facade (rdf-admin endpoint only).
// Writes {domain}.ttl. Validates that the Turtle PARSES with the configured engine before
// writing — a cheap correctness gate so a broken map can never land in blob.

import { DomainEnvelope, DomainException, ToolDefinition, ok, toEnvelope } from '../types'
import { getRdfContainer, writeBlob } from '../storage/blobs'
import { getEngine } from '../rdf/engine'
import { checkVocabulary } from '../rdf/reason'
import { appendLog } from '../storage/log'

const DOMAIN_RE = /^[a-z0-9][a-z0-9-]*$/

const inputSchema = {
  type: 'object',
  properties: {
    domain: { type: 'string', maxLength: 80 },
    turtle: { type: 'string', maxLength: 500_000 }
  },
  required: ['domain', 'turtle'],
  additionalProperties: false
}

async function updateReasoningImpl(input: unknown): Promise<DomainEnvelope> {
  const a = (input ?? {}) as Record<string, any>
  if (typeof a.domain !== 'string' || a.domain.length > 80 || !DOMAIN_RE.test(a.domain)) {
    throw new DomainException('VALIDATION_ERROR', 'domain must match ^[a-z0-9][a-z0-9-]*$ and be ≤80 chars')
  }
  if (typeof a.turtle !== 'string' || !a.turtle.trim()) {
    throw new DomainException('VALIDATION_ERROR', 'turtle (a Turtle document) is required')
  }
  const domain: string = a.domain
  const turtle: string = a.turtle

  // Parse-gate: load() throws VALIDATION_ERROR on malformed Turtle before we persist.
  const engine = await getEngine()
  const graph = await engine.load(turtle)

  const warnings: string[] = []
  // Vocabulary guard: the parse-gate only checks syntax. This warns (does not block) when the
  // map uses predicates the reasoner does not read — e.g. the wrong namespace or a typo —
  // which would otherwise write cleanly and then contribute nothing at query time.
  const vocab = await checkVocabulary(engine, graph)
  for (const w of vocab) warnings.push(w)

  const container = await getRdfContainer()
  await writeBlob(container, `${domain}.ttl`, turtle, 'text/turtle; charset=utf-8')

  const log = await appendLog({
    ts: new Date().toISOString(),
    tool: 'library_update_reasoning',
    action: `update reasoning map ${domain} (${turtle.length} chars)`,
    domain
  })
  if (!log.ok) warnings.push('log_append_failed')

  return ok({ domain, reasoning_updated: true, engine: engine.name }, warnings)
}

export const updateReasoningTool: ToolDefinition = {
  name: 'library_update_reasoning',
  description:
    'Layer 3 (Reasoning Map). Create or overwrite the per-domain Turtle map ({domain}.ttl) ' +
    'that encodes semantic intersections — answer-shape and safety constraints. Validates ' +
    'that the Turtle parses before writing. Overwrites the prior map.',
  inputSchema,
  handler: (input) => toEnvelope(() => updateReasoningImpl(input))
}
