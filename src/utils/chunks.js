export const CHUNK_SIZE = 8 * 1024 * 1024 // 8MB

export function splitIntoChunks(buffer, chunkSize = CHUNK_SIZE) {
  const chunks = []
  let offset = 0
  while (offset < buffer.length) {
    chunks.push(buffer.slice(offset, offset + chunkSize))
    offset += chunkSize
  }
  return chunks
}

// Fetch a single chunk URL and return Uint8Array
export async function fetchChunk(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Failed to fetch chunk: ${url} (${res.status})`)
  return new Uint8Array(await res.arrayBuffer())
}

// Fetch all chunks and concatenate
export async function fetchAndConcatChunks(urls) {
  const parts = await Promise.all(urls.map(fetchChunk))
  const total = parts.reduce((s, p) => s + p.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

// Async generator: yields decrypted chunks one by one for streaming
export async function* streamDecryptedChunks(chunkUrls, key, iv, decryptBuffer) {
  for (const url of chunkUrls) {
    const raw = await fetchChunk(url)
    const decrypted = await decryptBuffer(key, iv, raw)
    yield decrypted
  }
}
