import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import styles from './Home.module.css'

export default function Home() {
  const [token, setToken] = useState('')
  const [error, setError] = useState('')
  const navigate = useNavigate()

  function handleOpen() {
    const t = token.trim()
    if (!t) { setError('Paste your album token'); return }
    try {
      const parsed = JSON.parse(atob(t))
      if (!parsed.url || !parsed.key1 || !parsed.key2) throw new Error()
    } catch {
      setError('Invalid token — make sure you copied the full string')
      return
    }
    // Store token in sessionStorage — never put the key in the URL
    sessionStorage.setItem('album_token', t)
    navigate('/view')
  }

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <div className={styles.logo}>
          <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
            <rect width="48" height="48" rx="12" fill="#303030"/>
            <path d="M8 32l10-12 7 8 5-6 10 14H8z" fill="#8ab4f8" opacity=".8"/>
            <circle cx="34" cy="17" r="4" fill="#f8d66e"/>
          </svg>
        </div>
        <h1 className={styles.title}>Albums Viewer</h1>
        <p className={styles.subtitle}>Encrypted private photo &amp; video albums</p>

        <div className={styles.inputGroup}>
          <textarea
            className={styles.tokenInput}
            placeholder="Paste your album token here…"
            value={token}
            onChange={e => { setToken(e.target.value); setError('') }}
            rows={4}
            spellCheck={false}
            onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) handleOpen() }}
          />
          {error && <p className={styles.error}>{error}</p>}
          <button className={`btn-primary ${styles.openBtn}`} onClick={handleOpen} disabled={!token.trim()}>
            Open Album
          </button>
        </div>

      </div>

      <p className={styles.footer}>
        All decryption happens in your browser. Nothing is sent to any server.
      </p>
    </div>
  )
}
