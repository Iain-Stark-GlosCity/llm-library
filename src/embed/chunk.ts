// Character-based chunking. ~4,000 char chunks with ~800 char overlap, per CLAUDE.md.
// (No tokenizer dependency at MVP, so this is the documented fallback.)

export function chunkText(text: string, size = 4000, overlap = 800): string[] {
  if (text.length <= size) return [text]
  const step = Math.max(1, size - overlap)
  const chunks: string[] = []
  let start = 0
  while (start < text.length) {
    const end = Math.min(start + size, text.length)
    chunks.push(text.slice(start, end))
    if (end >= text.length) break
    start += step
  }
  return chunks
}
