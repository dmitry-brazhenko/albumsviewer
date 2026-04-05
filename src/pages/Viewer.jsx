import { useState, useEffect } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { loadAlbum } from '../utils/album.js'
import MediaGrid from '../components/MediaGrid.jsx'
import Lightbox from '../components/Lightbox.jsx'
import styles from './Viewer.module.css'

export default function Viewer() {
  const navigate = useNavigate()
  const [state, setState] = useState('idle') // idle | loading | ready | error
  const [error, setError] = useState('')
  const [album, setAlbum] = useState(null)   // { config, cryptoKeys }
  const [lightbox, setLightbox] = useState(null) // index or null

  useEffect(() => {
    const token = sessionStorage.getItem('album_token')
    if (!token) {
      console.warn('[Viewer] No token in sessionStorage, redirecting home')
      navigate('/', { replace: true })
      return
    }
    console.log('[Viewer] Loading album from token...')
    setState('loading')
    loadAlbum(token)
      .then(data => {
        console.log('[Viewer] Album loaded:', data.config.title, `(${data.config.media.length} items)`)
        setAlbum(data)
        setState('ready')
      })
      .catch(e => {
        console.error('[Viewer] Failed to load album:', e)
        // OperationError = wrong key or corrupted data → stale token
        const msg = e.name === 'OperationError'
          ? 'Decryption failed — the token may be invalid or the album was re-generated. Please paste a fresh token.'
          : e.message
        sessionStorage.removeItem('album_token')
        setError(msg)
        setState('error')
      })
  }, [])

  if (state === 'loading') {
    return (
      <div className={styles.center}>
        <div className="spinner" />
        <p className={styles.loadingText}>Loading album…</p>
      </div>
    )
  }

  if (state === 'error') {
    return (
      <div className={styles.center}>
        <div className="error-box" style={{ maxWidth: 420, textAlign: 'center' }}>
          <p style={{ marginBottom: 8, fontWeight: 600 }}>Failed to load album</p>
          <p style={{ fontSize: 13 }}>{error}</p>
        </div>
        <Link to="/" style={{ marginTop: 16, color: 'var(--accent)' }}>← Back</Link>
      </div>
    )
  }

  if (state !== 'ready') return null

  const { config, cryptoKeys } = album

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <Link to="/" className={styles.back}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/>
          </svg>
        </Link>
        <div className={styles.headerInfo}>
          <h1 className={styles.albumTitle}>{config.title || 'Album'}</h1>
          {config.description && <p className={styles.albumDesc}>{config.description}</p>}
        </div>
        <span className={styles.count}>{config.media.length} items</span>
      </header>

      <main className={styles.main}>
        <MediaGrid
          items={config.media}
          cryptoKeys={cryptoKeys}
          onOpen={i => setLightbox(i)}
        />
      </main>

      {lightbox !== null && (
        <Lightbox
          items={config.media}
          index={lightbox}
          cryptoKeys={cryptoKeys}
          onClose={() => setLightbox(null)}
          onNavigate={setLightbox}
        />
      )}
    </div>
  )
}
