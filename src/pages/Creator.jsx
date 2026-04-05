import { useState, useRef, useCallback } from 'react'
import { Link } from 'react-router-dom'
import {
  generateKey, exportKeyBase64, encryptBuffer, encryptJSON,
  generateIV, ivToHex, encodeToken
} from '../utils/crypto.js'
import { splitIntoChunks, CHUNK_SIZE } from '../utils/chunks.js'
import styles from './Creator.module.css'

const THUMB_SIZE = 320 // thumbnail max dimension

// Generate thumbnail for image/video as JPEG blob
async function generateThumbnail(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file)
    if (file.type.startsWith('video/')) {
      const video = document.createElement('video')
      video.src = url
      video.muted = true
      video.playsInline = true
      video.currentTime = 1
      video.addEventListener('seeked', () => {
        const canvas = document.createElement('canvas')
        const scale = Math.min(THUMB_SIZE / video.videoWidth, THUMB_SIZE / video.videoHeight, 1)
        canvas.width = Math.round(video.videoWidth * scale)
        canvas.height = Math.round(video.videoHeight * scale)
        canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height)
        canvas.toBlob(b => { URL.revokeObjectURL(url); resolve(b) }, 'image/jpeg', 0.8)
      }, { once: true })
      video.addEventListener('error', () => { URL.revokeObjectURL(url); resolve(null) }, { once: true })
      video.load()
    } else {
      const img = new Image()
      img.onload = () => {
        const scale = Math.min(THUMB_SIZE / img.naturalWidth, THUMB_SIZE / img.naturalHeight, 1)
        const canvas = document.createElement('canvas')
        canvas.width = Math.round(img.naturalWidth * scale)
        canvas.height = Math.round(img.naturalHeight * scale)
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height)
        canvas.toBlob(b => { URL.revokeObjectURL(url); resolve(b) }, 'image/jpeg', 0.8)
      }
      img.onerror = () => { URL.revokeObjectURL(url); resolve(null) }
      img.src = url
    }
  })
}

async function getImageDimensions(file) {
  if (!file.type.startsWith('image/')) return {}
  return new Promise(resolve => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => { URL.revokeObjectURL(url); resolve({ width: img.naturalWidth, height: img.naturalHeight }) }
    img.onerror = () => { URL.revokeObjectURL(url); resolve({}) }
    img.src = url
  })
}

function generateId() {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 16)
}

// ProcessedFile: { id, name, type, iv, chunks: Uint8Array[], thumbIV, thumbData, width, height, date }
async function processFile(file, albumKey, onProgress) {
  const id = generateId()
  const iv = generateIV()
  const buf = new Uint8Array(await file.arrayBuffer())
  onProgress('encrypting')
  const encrypted = await encryptBuffer(albumKey, iv, buf)
  const chunks = splitIntoChunks(encrypted, CHUNK_SIZE)

  let thumbIV = null, thumbData = null
  const thumbBlob = await generateThumbnail(file)
  if (thumbBlob) {
    const thumbBuf = new Uint8Array(await thumbBlob.arrayBuffer())
    thumbIV = generateIV()
    thumbData = await encryptBuffer(albumKey, thumbIV, thumbBuf)
  }

  const dims = await getImageDimensions(file)
  return { id, name: file.name, type: file.type, iv, chunks, thumbIV, thumbData, ...dims, date: new Date().toISOString() }
}

export default function Creator() {
  const [albumTitle, setAlbumTitle] = useState('')
  const [albumDesc, setAlbumDesc] = useState('')
  const [albumId, setAlbumId] = useState(() => `album-${generateId()}`)
  const [files, setFiles] = useState([]) // File[]
  const [status, setStatus] = useState('idle') // idle | processing | done | error
  const [progress, setProgress] = useState({ current: 0, total: 0, label: '' })
  const [result, setResult] = useState(null) // { token, downloadItems }
  const [error, setError] = useState('')
  const dropRef = useRef(null)

  function handleFiles(newFiles) {
    setFiles(prev => {
      const existing = new Set(prev.map(f => f.name + f.size))
      const filtered = Array.from(newFiles).filter(f => !existing.has(f.name + f.size))
      return [...prev, ...filtered]
    })
  }

  function onDrop(e) {
    e.preventDefault()
    dropRef.current?.classList.remove(styles.dropOver)
    handleFiles(e.dataTransfer.files)
  }

  async function createAlbum() {
    if (!files.length) return
    setStatus('processing')
    setError('')
    try {
      const albumKey = await generateKey()
      const keyBase64 = await exportKeyBase64(albumKey)
      const processedFiles = []

      for (let i = 0; i < files.length; i++) {
        setProgress({ current: i + 1, total: files.length, label: `Processing ${files[i].name}…` })
        const pf = await processFile(files[i], albumKey, () => {})
        processedFiles.push(pf)
      }

      setProgress({ current: files.length, total: files.length, label: 'Building config…' })

      // Build config
      const configObj = {
        title: albumTitle || 'My Album',
        description: albumDesc,
        created: new Date().toISOString(),
        media: processedFiles.map(pf => ({
          id: pf.id,
          type: pf.type,
          name: pf.name,
          width: pf.width,
          height: pf.height,
          date: pf.date,
          iv: ivToHex(pf.iv),
          chunks: pf.chunks.map((_, ci) => `albums/${albumId}/chunks/${pf.id}_${ci}`),
          totalSize: pf.chunks.reduce((s, c) => s + c.length, 0),
          thumbnail: pf.thumbData ? {
            iv: ivToHex(pf.thumbIV),
            chunk: `albums/${albumId}/thumbs/${pf.id}_thumb`,
          } : undefined,
        })),
      }

      const encryptedConfig = await encryptJSON(albumKey, configObj)
      const configPath = `albums/${albumId}/config.enc`
      const token = encodeToken(configPath, keyBase64)

      // Build download manifest
      const downloadItems = []

      // Config
      downloadItems.push({ path: configPath, data: encryptedConfig, label: 'config.enc' })

      // Chunks + thumbnails
      for (const pf of processedFiles) {
        for (let ci = 0; ci < pf.chunks.length; ci++) {
          downloadItems.push({
            path: `albums/${albumId}/chunks/${pf.id}_${ci}`,
            data: pf.chunks[ci],
            label: `${pf.name} chunk ${ci + 1}/${pf.chunks.length}`,
          })
        }
        if (pf.thumbData) {
          downloadItems.push({
            path: `albums/${albumId}/thumbs/${pf.id}_thumb`,
            data: pf.thumbData,
            label: `${pf.name} thumbnail`,
          })
        }
      }

      setResult({ token, albumId, downloadItems })
      setStatus('done')
    } catch (e) {
      console.error(e)
      setError(e.message)
      setStatus('error')
    }
  }

  function downloadFile(item) {
    const blob = new Blob([item.data], { type: 'application/octet-stream' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = item.path.split('/').pop()
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  function downloadAll() {
    result.downloadItems.forEach((item, i) => {
      setTimeout(() => downloadFile(item), i * 80)
    })
  }

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <Link to="/" className={styles.back}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/>
          </svg>
        </Link>
        <h1 className={styles.title}>Create Album</h1>
      </div>

      {status !== 'done' && (
        <div className={styles.form}>
          <div className={styles.row}>
            <input
              type="text"
              placeholder="Album title"
              value={albumTitle}
              onChange={e => setAlbumTitle(e.target.value)}
              className={styles.input}
            />
            <input
              type="text"
              placeholder="Description (optional)"
              value={albumDesc}
              onChange={e => setAlbumDesc(e.target.value)}
              className={styles.input}
            />
          </div>

          <div className={styles.row}>
            <label className={styles.fieldLabel}>Album ID</label>
            <input
              type="text"
              value={albumId}
              onChange={e => setAlbumId(e.target.value.replace(/[^a-z0-9-_]/g, ''))}
              className={styles.input}
              style={{ fontFamily: 'monospace' }}
            />
            <p className={styles.hint}>Files will be placed under <code>albums/{albumId}/</code></p>
          </div>

          {/* Drop zone */}
          <div
            ref={dropRef}
            className={styles.dropZone}
            onClick={() => document.getElementById('fileInput').click()}
            onDragOver={e => { e.preventDefault(); dropRef.current?.classList.add(styles.dropOver) }}
            onDragLeave={() => dropRef.current?.classList.remove(styles.dropOver)}
            onDrop={onDrop}
          >
            <svg width="40" height="40" viewBox="0 0 24 24" fill="currentColor" opacity=".4">
              <path d="M19.35 10.04A7.49 7.49 0 0 0 12 4C9.11 4 6.6 5.64 5.35 8.04A5.994 5.994 0 0 0 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM14 13v4h-4v-4H7l5-5 5 5h-3z"/>
            </svg>
            <p>Drop photos &amp; videos here or click to select</p>
            <p className={styles.hint}>JPEG, PNG, GIF, MP4, WebM, MOV…</p>
            <input
              id="fileInput"
              type="file"
              multiple
              accept="image/*,video/*"
              style={{ display: 'none' }}
              onChange={e => handleFiles(e.target.files)}
            />
          </div>

          {files.length > 0 && (
            <div className={styles.fileList}>
              <div className={styles.fileListHeader}>
                <span>{files.length} file{files.length !== 1 ? 's' : ''} selected</span>
                <button className="btn-ghost" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => setFiles([])}>Clear</button>
              </div>
              {files.map((f, i) => (
                <div key={i} className={styles.fileItem}>
                  <span className={styles.fileName}>{f.name}</span>
                  <span className={styles.fileSize}>{(f.size / 1024 / 1024).toFixed(1)} MB</span>
                  <button className={styles.removeBtn} onClick={() => setFiles(prev => prev.filter((_, j) => j !== i))}>×</button>
                </div>
              ))}
            </div>
          )}

          {status === 'processing' && (
            <div className={styles.progressBox}>
              <div className="spinner" style={{ width: 24, height: 24, borderWidth: 2 }} />
              <span>{progress.label}</span>
              <span className={styles.progressCount}>{progress.current}/{progress.total}</span>
            </div>
          )}

          {error && <p className="error-box">{error}</p>}

          <button
            className="btn-primary"
            style={{ padding: '12px 32px', fontSize: 15 }}
            onClick={createAlbum}
            disabled={!files.length || status === 'processing'}
          >
            {status === 'processing' ? 'Encrypting…' : 'Encrypt & Create Album'}
          </button>
        </div>
      )}

      {status === 'done' && result && (
        <AlbumResult result={result} onDownload={downloadFile} onDownloadAll={downloadAll} />
      )}
    </div>
  )
}

function AlbumResult({ result, onDownload, onDownloadAll }) {
  const [copied, setCopied] = useState(false)

  function copy() {
    navigator.clipboard.writeText(result.token)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className={styles.result}>
      <div className={styles.successHeader}>
        <svg width="32" height="32" viewBox="0 0 24 24" fill="var(--success)">
          <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>
        </svg>
        <h2>Album created!</h2>
      </div>

      <section className={styles.section}>
        <h3>Step 1 — Save your album token</h3>
        <p className={styles.sectionDesc}>This token contains the encryption key. Keep it safe — without it the album cannot be opened.</p>
        <div className={styles.tokenBox}>
          <code className={styles.token}>{result.token}</code>
          <button className="btn-ghost" onClick={copy} style={{ flexShrink: 0 }}>
            {copied ? 'Copied!' : 'Copy'}
          </button>
        </div>
      </section>

      <section className={styles.section}>
        <h3>Step 2 — Push files to GitHub</h3>
        <p className={styles.sectionDesc}>
          Download all encrypted files and commit them to your repository under the paths shown.
          The folder structure must be preserved exactly.
        </p>
        <div className={styles.fileTree}>
          {result.downloadItems.map((item, i) => (
            <div key={i} className={styles.downloadRow}>
              <code className={styles.filePath}>{item.path}</code>
              <button className="btn-ghost" style={{ fontSize: 12, padding: '4px 10px' }} onClick={() => onDownload(item)}>
                Download
              </button>
            </div>
          ))}
        </div>
        <button className="btn-primary" onClick={onDownloadAll} style={{ marginTop: 12 }}>
          Download all files
        </button>
        <p className={styles.hint} style={{ marginTop: 8 }}>
          Then run: <code>git add albums/{result.albumId} && git commit -m "Add album" && git push</code>
        </p>
      </section>

      <section className={styles.section}>
        <h3>Step 3 — Share the token</h3>
        <p className={styles.sectionDesc}>
          Share the token with anyone you want to give access. They paste it on the home page to view the album.
        </p>
      </section>
    </div>
  )
}
