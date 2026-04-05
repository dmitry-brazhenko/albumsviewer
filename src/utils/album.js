import { importKeyBase64, decryptJSON, decryptBuffer, hexToIV, decodeToken } from './crypto.js'
import { fetchChunk } from './chunks.js'

export async function loadAlbum(token) {
  const decoded = decodeToken(token)
  const { url, key: keyBase64 } = decoded
  console.log('[album] Token decoded:', JSON.stringify({ url, key: keyBase64.slice(0, 8) + '…' }))
  console.log('[album] Fetching config from:', url)
  const cryptoKey = await importKeyBase64(keyBase64)

  const res = await fetch(resolveChunkUrl(url))
  if (!res.ok) throw new Error(`Cannot fetch album config: ${res.status} ${res.statusText}`)
  const configBytes = new Uint8Array(await res.arrayBuffer())
  console.log(`[album] Config fetched (${(configBytes.length / 1024).toFixed(1)} KB), decrypting...`)

  const t0 = performance.now()
  const config = await decryptJSON(cryptoKey, configBytes)
  console.log(`[album] Config decrypted in ${(performance.now() - t0).toFixed(1)} ms — "${config.title}" (${config.media.length} items)`)
  console.log('[album] Config:', JSON.stringify({
    ...config,
    media: config.media.map(m => ({ ...m, thumbnail: m.thumbnail ? '…' : undefined }))
  }, null, 2))
  return { config, cryptoKey }
}

export function resolveChunkUrl(chunkPath) {
  if (chunkPath.startsWith('http')) return chunkPath
  return `./${chunkPath}`
}

// Decrypt a full media item — fetches+decrypts all chunks, returns Blob
export async function decryptMedia(item, cryptoKey) {
  console.log(`[album] Decrypting media: ${item.name} (${item.chunks.length} chunks)`)
  const t0 = performance.now()
  const parts = []
  for (let i = 0; i < item.chunks.length; i++) {
    const { path, iv: ivHex } = item.chunks[i]
    const iv = hexToIV(ivHex)
    console.log(`[album]   chunk ${i + 1}/${item.chunks.length}: fetching ${path}`)
    const encrypted = await fetchChunk(resolveChunkUrl(path))
    const decrypted = await decryptBuffer(cryptoKey, iv, encrypted)
    parts.push(decrypted)
  }
  const total = parts.reduce((s, p) => s + p.length, 0)
  const merged = new Uint8Array(total)
  let offset = 0
  for (const p of parts) { merged.set(p, offset); offset += p.length }
  console.log(`[album] ${item.name} ready — ${(total/1024/1024).toFixed(1)} MB in ${(performance.now()-t0).toFixed(0)} ms`)
  return new Blob([merged], { type: item.type })
}

export async function decryptThumbnail(item, cryptoKey) {
  if (!item.thumbnail) return null
  const iv = hexToIV(item.thumbnail.iv)
  const url = resolveChunkUrl(item.thumbnail.chunk)
  console.log(`[album] Fetching thumbnail: ${item.name}`)
  const encrypted = await fetchChunk(url)
  const decrypted = await decryptBuffer(cryptoKey, iv, encrypted)
  return new Blob([decrypted], { type: 'image/jpeg' })
}
