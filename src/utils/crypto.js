const ALGO = { name: 'AES-GCM', length: 256 }

export async function generateKey() {
  return crypto.subtle.generateKey(ALGO, true, ['encrypt', 'decrypt'])
}

export async function exportKeyBase64(key) {
  const raw = await crypto.subtle.exportKey('raw', key)
  return uint8ToBase64(new Uint8Array(raw))
}

export async function importKeyBase64(b64) {
  const raw = base64ToUint8(b64)
  return crypto.subtle.importKey('raw', raw, ALGO, false, ['encrypt', 'decrypt'])
}

export function generateIV() {
  return crypto.getRandomValues(new Uint8Array(12))
}

export function ivToHex(iv) {
  return Array.from(iv).map(b => b.toString(16).padStart(2, '0')).join('')
}

export function hexToIV(hex) {
  const arr = new Uint8Array(hex.length / 2)
  for (let i = 0; i < arr.length; i++) {
    arr[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return arr
}

export async function encryptBuffer(key, iv, data) {
  return new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data))
}

export async function decryptBuffer(key, iv, data) {
  const t0 = performance.now()
  const result = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data))
  const ms = (performance.now() - t0).toFixed(1)
  const mb = (data.byteLength / 1024 / 1024).toFixed(2)
  console.log(`[crypto] decrypt ${mb} MB → ${ms} ms  (${(data.byteLength / (performance.now() - t0 + 0.001) / 1024 / 1024 * 1000).toFixed(0)} MB/s)`)
  return result
}

export async function encryptJSON(key, obj) {
  const iv = generateIV()
  const data = new TextEncoder().encode(JSON.stringify(obj))
  const encrypted = await encryptBuffer(key, iv, data)
  // Format: [12 bytes IV][encrypted data]
  const out = new Uint8Array(12 + encrypted.length)
  out.set(iv, 0)
  out.set(encrypted, 12)
  return out
}

export async function decryptJSON(key, bytes) {
  const iv = bytes.slice(0, 12)
  const data = bytes.slice(12)
  const decrypted = await decryptBuffer(key, iv, data)
  return JSON.parse(new TextDecoder().decode(decrypted))
}

// Token = base64( JSON { url, key } )
export function encodeToken(configUrl, keyBase64) {
  const obj = { url: configUrl, key: keyBase64 }
  return btoa(JSON.stringify(obj))
}

export function decodeToken(token) {
  try {
    return JSON.parse(atob(token.trim()))
  } catch {
    throw new Error('Invalid token')
  }
}

export function uint8ToBase64(arr) {
  let binary = ''
  for (let i = 0; i < arr.length; i++) binary += String.fromCharCode(arr[i])
  return btoa(binary)
}

export function base64ToUint8(b64) {
  const binary = atob(b64)
  const arr = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) arr[i] = binary.charCodeAt(i)
  return arr
}
