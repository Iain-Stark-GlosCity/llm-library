// Sparse (TF) vector generation + tokenisation. The IDF component is applied by
// Qdrant at search time (the collection's "text" sparse vector uses modifier: idf),
// so we only emit term-frequency weights. See CLAUDE.md "Sparse vector generation".
//
// The stopword list is shared with gap detection in library_query.

export const STOPWORDS = new Set([
  'also', 'been', 'does', 'from', 'have', 'into', 'more', 'says', 'some', 'that',
  'their', 'them', 'then', 'there', 'this', 'were', 'what', 'when', 'where',
  'which', 'will', 'with', 'your'
])

export interface SparseVector {
  indices: number[]
  values: number[]
}

// Lowercase, split on non-alphanumeric, drop empties and stopwords.
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0 && !STOPWORDS.has(t))
}

// Stable token -> sparse index hash in [0, 2^20). Collisions are acceptable at MVP.
export function tokenToIndex(token: string): number {
  let hash = 0
  for (let i = 0; i < token.length; i++) {
    hash = (hash << 5) - hash + token.charCodeAt(i)
    hash |= 0
  }
  return Math.abs(hash) % 2 ** 20
}

export function sparseVector(text: string): SparseVector {
  const counts = new Map<number, number>()
  for (const token of tokenize(text)) {
    const idx = tokenToIndex(token)
    counts.set(idx, (counts.get(idx) ?? 0) + 1)
  }
  const indices = [...counts.keys()]
  const values = indices.map((i) => counts.get(i)!)
  return { indices, values }
}
