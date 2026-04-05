import { useState, useEffect, useRef } from 'react'
import { decryptThumbnail } from '../utils/album.js'
import styles from './MediaGrid.module.css'

// Group items by date
function groupByDate(items) {
  const groups = []
  const map = {}
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    const date = item.date ? new Date(item.date).toLocaleDateString('en-US', {
      year: 'numeric', month: 'long', day: 'numeric'
    }) : 'Unknown date'
    if (!map[date]) {
      map[date] = { label: date, items: [] }
      groups.push(map[date])
    }
    map[date].items.push({ ...item, _index: i })
  }
  return groups
}

function ThumbnailCell({ item, cryptoKeys, onOpen }) {
  const [src, setSrc] = useState(null)
  const [loaded, setLoaded] = useState(false)
  const ref = useRef(null)
  const urlRef = useRef(null)
  const loadingRef = useRef(false)

  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return
        observer.disconnect()
        if (loadingRef.current) return
        loadingRef.current = true

        ;(async () => {
          try {
            if (!item.thumbnail) { setSrc('placeholder'); return }
            const blob = await decryptThumbnail(item, cryptoKeys)
            if (!blob) { setSrc('placeholder'); return }
            const url = URL.createObjectURL(blob)
            urlRef.current = url
            setSrc(url)
          } catch (e) {
            console.error('Thumbnail load error', e)
            setSrc('placeholder')
          }
        })()
      },
      { rootMargin: '300px' }
    )
    if (ref.current) observer.observe(ref.current)
    return () => {
      observer.disconnect()
      if (urlRef.current) { URL.revokeObjectURL(urlRef.current); urlRef.current = null }
    }
  }, []) // run once on mount — item/cryptoKeys are stable per cell

  const isVideo = item.type?.startsWith('video/')

  return (
    <div ref={ref} className={styles.cell} onClick={() => onOpen(item._index)}>
      {src && src !== 'placeholder' ? (
        <img
          src={src}
          alt={item.name}
          className={`${styles.thumb} ${loaded ? styles.thumbLoaded : ''}`}
          onLoad={() => setLoaded(true)}
          draggable={false}
        />
      ) : (
        <div className={styles.placeholder}>
          {isVideo ? (
            <svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor" opacity=".4">
              <path d="M8 5v14l11-7z"/>
            </svg>
          ) : (
            <svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor" opacity=".4">
              <path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/>
            </svg>
          )}
        </div>
      )}
      {isVideo && (
        <div className={styles.videoBadge}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="white">
            <path d="M8 5v14l11-7z"/>
          </svg>
        </div>
      )}
    </div>
  )
}

export default function MediaGrid({ items, cryptoKeys, onOpen }) {
  const groups = groupByDate(items)

  return (
    <div className={styles.container}>
      {groups.map(group => (
        <section key={group.label} className={styles.group}>
          <h2 className={styles.dateLabel}>{group.label}</h2>
          <div className={styles.grid}>
            {group.items.map(item => (
              <ThumbnailCell
                key={item.id}
                item={item}
                cryptoKeys={cryptoKeys}
                onOpen={onOpen}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}
