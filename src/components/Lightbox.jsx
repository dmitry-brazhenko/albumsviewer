import { useState, useEffect, useCallback, useRef } from 'react'
import { decryptMedia } from '../utils/album.js'
import VideoPlayer from './VideoPlayer.jsx'
import styles from './Lightbox.module.css'

export default function Lightbox({ items, index, cryptoKeys, onClose, onNavigate }) {
  // mediaMap only used for images — videos go straight to VideoPlayer
  const [mediaMap, setMediaMap] = useState({})
  const touchStartX = useRef(null)

  const item = items[index]
  const isVideo = (item) => item?.type?.startsWith('video/')

  const loadItem = useCallback(async (i) => {
    if (!items[i]) return
    if (isVideo(items[i])) return // videos handle themselves
    if (mediaMap[i]) return
    console.log(`[Lightbox] Loading image ${i}: ${items[i].name}`)
    setMediaMap(m => ({ ...m, [i]: 'loading' }))
    try {
      const blob = await decryptMedia(items[i], cryptoKeys)
      console.log(`[Lightbox] Image ${i} ready: ${(blob.size / 1024).toFixed(0)} KB`)
      setMediaMap(m => ({ ...m, [i]: blob }))
    } catch (e) {
      console.error(`[Lightbox] Failed to decrypt image ${i}:`, e)
      setMediaMap(m => ({ ...m, [i]: 'error' }))
    }
  }, [items, cryptoKeys, mediaMap])

  useEffect(() => {
    loadItem(index)
    if (index > 0) loadItem(index - 1)
    if (index < items.length - 1) loadItem(index + 1)
  }, [index]) // eslint-disable-line

  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') onClose()
      if (e.key === 'ArrowRight' && index < items.length - 1) onNavigate(index + 1)
      if (e.key === 'ArrowLeft' && index > 0) onNavigate(index - 1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [index, items.length, onClose, onNavigate])

  useEffect(() => {
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = '' }
  }, [])

  function onTouchStart(e) { touchStartX.current = e.touches[0].clientX }
  function onTouchEnd(e) {
    if (touchStartX.current === null) return
    const dx = e.changedTouches[0].clientX - touchStartX.current
    touchStartX.current = null
    if (dx > 60 && index > 0) onNavigate(index - 1)
    if (dx < -60 && index < items.length - 1) onNavigate(index + 1)
  }

  const media = mediaMap[index]

  function renderMedia() {
    if (isVideo(item)) {
      return <VideoPlayer key={item.id} item={item} cryptoKeys={cryptoKeys} />
    }
    if (!media || media === 'loading') {
      return (
        <div className={styles.loading}>
          <div className="spinner" />
          <p style={{ marginTop: 12, color: 'var(--text2)' }}>Decrypting…</p>
        </div>
      )
    }
    if (media === 'error') {
      return <div className="error-box">Failed to decrypt image</div>
    }
    return <BlobImage blob={media} alt={item?.name} />
  }

  return (
    <div className={styles.overlay} onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
      <div className={styles.topBar}>
        <span className={styles.itemName}>{item?.name || ''}</span>
        <span className={styles.counter}>{index + 1} / {items.length}</span>
        <button className={styles.closeBtn} onClick={onClose} aria-label="Close">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
            <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
          </svg>
        </button>
      </div>

      <div className={styles.mediaArea} onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
        {renderMedia()}
      </div>

      {index > 0 && (
        <button className={`${styles.navBtn} ${styles.navLeft}`} onClick={() => onNavigate(index - 1)} aria-label="Previous">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor">
            <path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"/>
          </svg>
        </button>
      )}
      {index < items.length - 1 && (
        <button className={`${styles.navBtn} ${styles.navRight}`} onClick={() => onNavigate(index + 1)} aria-label="Next">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor">
            <path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/>
          </svg>
        </button>
      )}

      {item?.date && (
        <div className={styles.bottomBar}>
          {new Date(item.date).toLocaleString()}
        </div>
      )}
    </div>
  )
}

function BlobImage({ blob, alt }) {
  const [src, setSrc] = useState(null)
  useEffect(() => {
    const url = URL.createObjectURL(blob)
    setSrc(url)
    return () => URL.revokeObjectURL(url)
  }, [blob])
  if (!src) return null
  return <img src={src} alt={alt} className={styles.image} draggable={false} />
}
