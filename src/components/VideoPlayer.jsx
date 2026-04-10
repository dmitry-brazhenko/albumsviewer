import { useEffect, useRef, useState } from 'react'
import { hexToIV, decryptDoubleBuffer } from '../utils/crypto.js'
import { fetchChunk } from '../utils/chunks.js'
import { resolveChunkUrl } from '../utils/album.js'
import styles from './VideoPlayer.module.css'

// Keep at most this many seconds buffered ahead of playhead
const MAX_BUFFER_AHEAD_S = 90
// Evict everything more than this many seconds behind playhead
const EVICT_BEHIND_S = 20

function canStream(item) {
  if (!item.fragmented) return false
  if (typeof MediaSource === 'undefined') return false
  const supported = MediaSource.isTypeSupported(item.codecString || item.type)
  console.log(`[VideoPlayer] isTypeSupported("${item.codecString || item.type}") = ${supported}`)
  return supported
}

function fmtTime(s) {
  if (!s || !isFinite(s)) return '--:--'
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = Math.floor(s % 60)
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    : `${m}:${String(sec).padStart(2, '0')}`
}

export default function VideoPlayer({ item, cryptoKeys }) {
  const videoRef = useRef(null)
  const [loadInfo, setLoadInfo] = useState(null) // { bufferedSec, totalSec } | null
  const [error, setError] = useState(null)

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    let cancelled = false
    const onCancel = () => cancelled

    if (canStream(item)) {
      streamWithMediaSource(video, item, cryptoKeys, setLoadInfo, setError, onCancel)
    } else {
      if (item.chunks.length > 1) {
        console.warn(`[VideoPlayer] "${item.name}" is not streamable — downloading all ${item.chunks.length} chunks`)
      }
      decryptAllThenPlay(video, item, cryptoKeys, setLoadInfo, setError, onCancel)
    }

    return () => {
      cancelled = true
      if (video.src?.startsWith('blob:')) URL.revokeObjectURL(video.src)
    }
  }, [item, cryptoKeys])

  const totalSec = item.duration || null
  const showLoadBar = loadInfo && (loadInfo.chunksLoaded < loadInfo.totalChunks)

  return (
    <div className={styles.container}>
      {showLoadBar && (
        <div className={styles.loadBar}>
          <div className={styles.loadFill} style={{ width: `${(loadInfo.chunksLoaded / loadInfo.totalChunks) * 100}%` }} />
        </div>
      )}
      {loadInfo && (
        <div className={styles.loadLabel}>
          {loadInfo.chunksLoaded < loadInfo.totalChunks
            ? `Buffered ${fmtTime(loadInfo.bufferedSec)}${totalSec ? ` / ${fmtTime(totalSec)}` : ''} · chunk ${loadInfo.chunksLoaded}/${loadInfo.totalChunks}`
            : `Loaded ${fmtTime(totalSec)}`
          }
        </div>
      )}
      {error && <p className={styles.error}>{error}</p>}
      <video ref={videoRef} className={styles.video} controls autoPlay playsInline />
    </div>
  )
}

// ── SourceBuffer helpers ───────────────────────────────────────────────────────

function sbOperation(sb, fn) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      sb.removeEventListener('updateend', onEnd)
      sb.removeEventListener('error', onErr)
    }
    const onEnd = () => { cleanup(); resolve() }
    const onErr = () => { cleanup(); reject(new Error('SourceBuffer error')) }
    sb.addEventListener('updateend', onEnd)
    sb.addEventListener('error', onErr)
    try { fn() } catch (e) { cleanup(); reject(e) }
  })
}

// How many seconds are buffered ahead of currentTime
function bufferedAhead(sb, currentTime) {
  for (let i = 0; i < sb.buffered.length; i++) {
    if (sb.buffered.start(i) <= currentTime + 0.5 && currentTime < sb.buffered.end(i)) {
      return sb.buffered.end(i) - currentTime
    }
  }
  return 0
}

// Evict data behind the playhead; returns a promise that resolves when done (or immediately if nothing to do)
async function evictPlayed(sb, video) {
  if (sb.updating || sb.buffered.length === 0) return
  const evictEnd = video.currentTime - EVICT_BEHIND_S
  const lastBufferedEnd = sb.buffered.end(sb.buffered.length - 1)
  // Never evict if it would fully empty the SourceBuffer — Safari rejects
  // appendBuffer into an empty SourceBuffer for non-zero-timestamp fragments
  if (evictEnd >= lastBufferedEnd) return
  if (evictEnd > sb.buffered.start(0) + 1) {
    console.log(`[VideoPlayer] Evicting 0..${evictEnd.toFixed(1)}s`)
    await sbOperation(sb, () => sb.remove(0, evictEnd))
  }
}

// Wait until the browser has consumed enough buffer to accept more data
async function waitForBufferRoom(sb, video, isCancelled) {
  while (!isCancelled()) {
    if (bufferedAhead(sb, video.currentTime) < MAX_BUFFER_AHEAD_S) return
    await new Promise(r => setTimeout(r, 200))
  }
}

// ── Streaming implementation ───────────────────────────────────────────────────

async function streamWithMediaSource(video, item, { key1, key2 }, setLoadInfo, setError, isCancelled) {
  const mimeType = item.codecString || item.type

  // Create a fresh MediaSource + SourceBuffer and attach it to the video element.
  // Called once at start and again on every seek — Safari fires a SourceBuffer
  // error event the moment a seek interrupts an in-flight appendBuffer, making
  // the existing SourceBuffer defunct; a new one is the only reliable recovery.
  async function createSession() {
    const prevSrc = video.src
    const newMs = new MediaSource()
    const url = URL.createObjectURL(newMs)
    video.src = url
    if (prevSrc?.startsWith('blob:')) URL.revokeObjectURL(prevSrc)
    await new Promise(resolve => newMs.addEventListener('sourceopen', resolve, { once: true }))
    if (isCancelled()) { URL.revokeObjectURL(url); return null }
    try {
      const newSb = newMs.addSourceBuffer(mimeType)
      if (item.duration) try { newMs.duration = item.duration } catch {}
      return { ms: newMs, sb: newSb, url }
    } catch (e) {
      console.warn('[VideoPlayer] addSourceBuffer failed:', e.message)
      URL.revokeObjectURL(url)
      return null
    }
  }

  let session = await createSession()
  if (!session) {
    decryptAllThenPlay(video, item, { key1, key2 }, setLoadInfo, setError, isCancelled)
    return
  }
  let { ms, sb } = session

  // seekTarget: chunk index to jump to; set by the seeking event handler
  let seekTarget = null
  let initChunk  = null  // cached chunk 0 — re-appended after session restart on seek

  const onSeeking = () => {
    if (!item.duration) return
    const idx = Math.floor((video.currentTime / item.duration) * item.chunks.length)
    seekTarget = Math.max(0, idx)
    console.log(`[VideoPlayer] Seek → ${video.currentTime.toFixed(1)}s, jumping to chunk ~${seekTarget}`)
  }
  video.addEventListener('seeking', onSeeking)

  try {
    let i = 0
    while (i < item.chunks.length) {
      if (isCancelled()) break

      // Seek: restart the MSE session so the SourceBuffer is fresh, then
      // re-append the cached init chunk before loading the seek target.
      if (seekTarget !== null) {
        i = seekTarget
        seekTarget = null
        const newSession = await createSession()
        if (!newSession || isCancelled()) break
        ms = newSession.ms
        sb = newSession.sb
        if (initChunk) {
          try { await sbOperation(sb, () => sb.appendBuffer(initChunk)) } catch {}
        }
        continue
      }

      await evictPlayed(sb, video)
      await waitForBufferRoom(sb, video, isCancelled)
      if (isCancelled()) break
      if (seekTarget !== null) continue

      const { path, iv1: iv1Hex, iv2: iv2Hex } = item.chunks[i]
      console.log(`[VideoPlayer] chunk ${i + 1}/${item.chunks.length} buffered=${bufferedAhead(sb, video.currentTime).toFixed(0)}s ahead`)

      const iv1 = hexToIV(iv1Hex)
      const iv2 = hexToIV(iv2Hex)
      const encrypted = await fetchChunk(resolveChunkUrl(path))
      if (isCancelled()) break
      if (seekTarget !== null) continue

      const decrypted = await decryptDoubleBuffer(key1, key2, iv1, iv2, encrypted)
      if (isCancelled()) break
      if (seekTarget !== null) continue

      if (i === 0) initChunk = decrypted

      try {
        await sbOperation(sb, () => sb.appendBuffer(decrypted))
      } catch (sbErr) {
        // Safari fires SourceBuffer error when a seek interrupts appendBuffer —
        // the session is now defunct; the seek handler will recreate it.
        if (seekTarget !== null) { continue }
        throw sbErr
      }

      setLoadInfo({
        chunksLoaded: i + 1,
        totalChunks: item.chunks.length,
        bufferedSec: bufferedAhead(sb, video.currentTime) + video.currentTime,
      })

      i++
    }

    if (!isCancelled()) {
      try { ms.endOfStream() } catch {}
      setLoadInfo(info => ({ ...info, chunksLoaded: item.chunks.length }))
      console.log('[VideoPlayer] Stream complete')
    }
  } catch (e) {
    console.error('[VideoPlayer] Streaming error:', e)
    setError(`Streaming error: ${e.message}`)
    try { ms.endOfStream('network') } catch {}
  } finally {
    video.removeEventListener('seeking', onSeeking)
  }
}

// ── Fallback: download everything then play ────────────────────────────────────

async function decryptAllThenPlay(video, item, { key1, key2 }, setLoadInfo, setError, isCancelled) {
  try {
    const parts = []
    for (let i = 0; i < item.chunks.length; i++) {
      if (isCancelled()) return
      const { path, iv1: iv1Hex, iv2: iv2Hex } = item.chunks[i]
      console.log(`[VideoPlayer] Downloading chunk ${i + 1}/${item.chunks.length}`)
      const iv1 = hexToIV(iv1Hex)
      const iv2 = hexToIV(iv2Hex)
      const encrypted = await fetchChunk(resolveChunkUrl(path))
      const decrypted = await decryptDoubleBuffer(key1, key2, iv1, iv2, encrypted)
      parts.push(decrypted)
      setLoadInfo({ chunksLoaded: i + 1, totalChunks: item.chunks.length, bufferedSec: null })
    }
    if (isCancelled()) return
    const total = parts.reduce((s, p) => s + p.length, 0)
    const merged = new Uint8Array(total)
    let offset = 0
    for (const p of parts) { merged.set(p, offset); offset += p.length }
    const blob = new Blob([merged], { type: item.type })
    video.src = URL.createObjectURL(blob)
    setLoadInfo({ chunksLoaded: item.chunks.length, totalChunks: item.chunks.length, bufferedSec: null })
    console.log('[VideoPlayer] Fallback ready:', (total / 1024 / 1024).toFixed(1), 'MB')
  } catch (e) {
    console.error('[VideoPlayer] Fallback error:', e)
    setError(`Failed to load video: ${e.message}`)
  }
}
