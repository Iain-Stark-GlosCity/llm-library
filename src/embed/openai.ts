// OpenAI embeddings via raw fetch (no SDK). text-embedding-3-small, 1536 dims.
// Accepts a single string or an array (batch); returns one vector per input,
// ordered to match the input order. See CLAUDE.md "Embedding API".

import { getConfig } from '../config'
import { DomainException } from '../types'

const ENDPOINT = 'https://api.openai.com/v1/embeddings'
const EXPECTED_DIMS = 1536

export async function embed(input: string | string[]): Promise<number[][]> {
  const cfg = getConfig()
  if (!cfg.openaiApiKey) {
    throw new DomainException('EMBEDDING_ERROR', 'OPENAI_API_KEY is not configured')
  }

  let resp: Response
  try {
    resp = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.openaiApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ model: cfg.embeddingModel, input })
    })
  } catch (err) {
    throw new DomainException('EMBEDDING_ERROR', `OpenAI unreachable: ${(err as Error).message}`)
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new DomainException('EMBEDDING_ERROR', `OpenAI embeddings failed: ${resp.status} ${text}`)
  }

  const data = (await resp.json()) as { data: { index: number; embedding: number[] }[] }
  const expectedCount = Array.isArray(input) ? input.length : 1
  if (!Array.isArray(data.data) || data.data.length !== expectedCount) {
    throw new DomainException(
      'EMBEDDING_ERROR',
      `Expected ${expectedCount} embedding result(s), got ${Array.isArray(data.data) ? data.data.length : typeof data.data}`
    )
  }

  const sorted = [...data.data].sort((a, b) => a.index - b.index)
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].index !== i) {
      throw new DomainException('EMBEDDING_ERROR', `OpenAI embedding response missing index ${i}`)
    }
  }
  const vectors = sorted.map((d) => d.embedding)

  for (const v of vectors) {
    if (!Array.isArray(v) || v.length !== EXPECTED_DIMS) {
      throw new DomainException(
        'EMBEDDING_ERROR',
        `Expected ${EXPECTED_DIMS}-dim embedding, got ${Array.isArray(v) ? v.length : typeof v}`
      )
    }
  }
  return vectors
}

export async function embedOne(text: string): Promise<number[]> {
  const [vec] = await embed(text)
  return vec
}
