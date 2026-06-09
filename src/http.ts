// Outbound fetch with a per-attempt timeout and a single retry on NETWORK failure
// (DNS, reset, timeout — i.e. fetch threw). HTTP error statuses are returned to the
// caller, never retried here: the callers' operations are idempotent at the transport
// level (PUT upsert, POST query/scroll, embeddings), but a 4xx/5xx is a real answer
// that the caller maps to its own domain error. Without a timeout a hung connection
// burns the entire Azure Functions execution window.

export interface FetchRetryOptions {
  timeoutMs?: number
  retries?: number
}

export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts: FetchRetryOptions = {}
): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? 30_000
  const retries = opts.retries ?? 1
  let lastErr: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
    } catch (err) {
      lastErr = err
      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)))
      }
    }
  }
  throw lastErr
}
