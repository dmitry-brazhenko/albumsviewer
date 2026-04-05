#!/usr/bin/env node
/**
 * CLI album creator
 * Usage: node scripts/create-album.mjs --input ./my-photos --album-id my-album [--title "My Album"] [--output ./]
 */

import { readdir, readFile, writeFile, mkdir, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, extname } from 'node:path'
import { webcrypto } from 'node:crypto'
import { parseArgs } from 'node:util'
import { spawnSync, execSync } from 'node:child_process'
import { tmpdir } from 'node:os'

const subtle = webcrypto.subtle
const getRandomValues = (arr) => webcrypto.getRandomValues(arr)

const CHUNK_SIZE   = 8 * 1024 * 1024
const ALGO         = { name: 'AES-GCM', length: 256 }
const IMAGE_EXTS   = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.avif'])
const VIDEO_EXTS   = new Set(['.mp4', '.webm', '.mov', '.avi', '.mkv', '.m4v'])
const MIME_MAP     = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif',  '.webp': 'image/webp',  '.heic': 'image/heic', '.avif': 'image/avif',
  '.mp4': 'video/mp4',  '.webm': 'video/webm',  '.mov': 'video/mp4',
  '.avi': 'video/mp4',  '.mkv': 'video/mp4',    '.m4v': 'video/mp4',
}

// ── Crypto ─────────────────────────────────────────────────────────────────────

const generateKey    = () => subtle.generateKey(ALGO, true, ['encrypt', 'decrypt'])
const exportKeyB64   = async (k) => Buffer.from(await subtle.exportKey('raw', k)).toString('base64')
const generateIV     = () => getRandomValues(new Uint8Array(12))
const ivToHex        = (iv) => Buffer.from(iv).toString('hex')
const randomName     = () => Buffer.from(getRandomValues(new Uint8Array(16))).toString('hex')

async function encryptBuffer(key, iv, data) {
  return new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, data))
}

// Double AES-GCM: encrypt with key1 first, then key2.
// Returns { enc, iv1, iv2 } — both IVs must be stored in the album config.
async function encryptDoubleBuffer(key1, key2, data) {
  const iv1 = generateIV()
  const enc1 = await encryptBuffer(key1, iv1, data)
  const iv2 = generateIV()
  const enc2 = await encryptBuffer(key2, iv2, enc1)
  return { enc: enc2, iv1, iv2 }
}

// Double AES-GCM for JSON config.
// Format: [iv2 (12 bytes)] [enc(key2, iv2, [iv1 (12 bytes)][enc(key1, iv1, JSON)])]
async function encryptDoubleJSON(key1, key2, obj) {
  const iv1 = generateIV()
  const inner = new Uint8Array(await subtle.encrypt(
    { name: 'AES-GCM', iv: iv1 }, key1, Buffer.from(JSON.stringify(obj), 'utf8')
  ))
  const innerBlob = new Uint8Array(12 + inner.length)
  innerBlob.set(iv1); innerBlob.set(inner, 12)

  const iv2 = generateIV()
  const outer = await encryptBuffer(key2, iv2, innerBlob)
  const out = new Uint8Array(12 + outer.length)
  out.set(iv2); out.set(outer, 12)
  return out
}

const encodeToken = (url, key1, key2) => Buffer.from(JSON.stringify({ url, key1, key2 })).toString('base64')

// ── Helpers ────────────────────────────────────────────────────────────────────

const ensureDir = (dir) => mkdir(dir, { recursive: true })

function findBin(name) {
  try { return execSync(`which ${name}`, { stdio: ['ignore','pipe','ignore'] }).toString().trim() } catch { return null }
}

function splitIntoChunks(buf) {
  const out = []
  for (let i = 0; i < buf.length; i += CHUNK_SIZE) out.push(buf.slice(i, i + CHUNK_SIZE))
  return out
}

// ── ffmpeg / ffprobe ───────────────────────────────────────────────────────────

function probeVideoInfo(filePath) {
  const fp = findBin('ffprobe')
  if (!fp) return { codecString: null, duration: null }
  try {
    const raw = execSync(
      `"${fp}" -v quiet -print_format json -show_streams -show_format "${filePath}"`,
      { stdio: ['ignore','pipe','ignore'] }
    ).toString()
    const { streams, format } = JSON.parse(raw)
    const vid = streams.find(s => s.codec_type === 'video')
    const aud = streams.find(s => s.codec_type === 'audio')
    const duration = parseFloat(format?.duration || 0) || null

    let vCodec = ''
    if (vid?.codec_name === 'h264') {
      const pp = { Baseline:'42', Main:'4D', High:'64' }[vid.profile] || '64'
      const ll = (vid.level || 40).toString(16).padStart(2,'0')
      vCodec = `avc1.${pp}00${ll}`
    } else if (vid?.codec_name === 'hevc') { vCodec = 'hvc1.1.6.L120.B0'
    } else if (vid?.codec_name === 'vp9')  { vCodec = 'vp09.00.10.08'
    } else if (vid?.codec_name === 'vp8')  { vCodec = 'vp8' }

    const aCodec = aud?.codec_name === 'aac' ? 'mp4a.40.2' : aud?.codec_name === 'opus' ? 'opus' : ''
    const parts = [vCodec, aCodec].filter(Boolean)
    const container = (vid?.codec_name === 'vp8' || vid?.codec_name === 'vp9') ? 'video/webm' : 'video/mp4'
    return { codecString: parts.length ? `${container}; codecs="${parts.join(', ')}"` : null, duration }
  } catch { return { codecString: null, duration: null } }
}

// Compress to FullHD H.264 + fragment in one pass; returns { data, codecString, duration }
async function compressAndFragment(inputPath) {
  const ff = findBin('ffmpeg')
  if (!ff) return null
  const tmpOut = join(tmpdir(), `av_${Date.now()}.mp4`)
  const r = spawnSync(ff, [
    '-i', inputPath,
    '-vf', "scale='min(1920,iw)':'min(1080,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
    '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    '-f', 'mp4', '-y', tmpOut,
  ], { stdio: ['ignore','ignore','pipe'] })

  if (r.status !== 0) {
    console.log(`\n    ⚠  compress failed: ${r.stderr?.toString().slice(-120)}`)
    return null
  }
  const data = await readFile(tmpOut)
  const info = probeVideoInfo(tmpOut)
  await unlink(tmpOut).catch(() => {})
  return { data, codecString: info.codecString, duration: info.duration, fragmented: true }
}

// Extract a JPEG thumbnail frame from a video
async function extractVideoFrame(videoPath) {
  const ff = findBin('ffmpeg')
  if (!ff) return null
  const tmpJpg = join(tmpdir(), `thumb_${Date.now()}.jpg`)
  // Try at 3 s; fall back to 0.5 s for short clips
  for (const seek of ['3', '0.5']) {
    const r = spawnSync(ff, [
      '-ss', seek, '-i', videoPath,
      '-vframes', '1',
      '-vf', 'scale=480:-2',
      '-q:v', '3', '-y', tmpJpg,
    ], { stdio: ['ignore','ignore','ignore'] })
    if (r.status === 0 && existsSync(tmpJpg)) {
      const data = await readFile(tmpJpg)
      await unlink(tmpJpg).catch(() => {})
      return data
    }
  }
  return null
}

// Generate a small JPEG thumbnail for an image
async function makeThumbnail(imagePath) {
  const ff = findBin('ffmpeg')
  if (!ff) return await readFile(imagePath)
  const tmpJpg = join(tmpdir(), `imgthumb_${Date.now()}.jpg`)
  const r = spawnSync(ff, [
    '-i', imagePath,
    '-vf', 'scale=480:-2',
    '-q:v', '3', '-y', tmpJpg,
  ], { stdio: ['ignore','ignore','ignore'] })
  if (r.status !== 0) return await readFile(imagePath)
  const data = await readFile(tmpJpg)
  await unlink(tmpJpg).catch(() => {})
  return data
}

// ── Noise generation ───────────────────────────────────────────────────────────

// Fill a directory with encrypted noise files that are indistinguishable from
// real chunk files.  Count and size distribution mirror the real chunks.
// getRandomValues is limited to 65536 bytes per call
function randomBytes(size) {
  const buf = new Uint8Array(size)
  const BATCH = 65536
  for (let i = 0; i < size; i += BATCH) {
    getRandomValues(buf.subarray(i, Math.min(i + BATCH, size)))
  }
  return buf
}

// Chunks larger than this get exactly 1 noise file at the same size (no jitter),
// to avoid doubling storage for multi-hundred-MB videos.
const LARGE_FILE_THRESHOLD = 4 * 1024 * 1024 // 4 MB

async function writeNoiseFiles(albumDir, key1, key2, realSizes) {
  if (!realSizes.length) return
  let total = 0
  for (const realSize of realSizes) {
    const isLarge = realSize >= LARGE_FILE_THRESHOLD
    // Large files: 1 noise file at the same size (mirrors the real chunk 1:1)
    // Small files: 1-3 noise files with -90% … +200% size jitter
    const count = isLarge ? 1 : 1 + Math.floor(Math.random() * 3)
    for (let n = 0; n < count; n++) {
      const size = isLarge
        ? realSize
        : Math.max(16, Math.floor(realSize * (0.1 + Math.random() * 2.9)))
      const { enc } = await encryptDoubleBuffer(key1, key2, randomBytes(size))
      await writeFile(join(albumDir, randomName()), enc)
      total++
    }
  }
  process.stdout.write(`\n  Writing ${total} noise files… `)
  console.log('✓')
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  const { values } = parseArgs({
    options: {
      input:          { type: 'string',  short: 'i' },
      output:         { type: 'string',  short: 'o', default: '.' },
      'album-id':     { type: 'string',  short: 'a' },
      title:          { type: 'string',  short: 't', default: '' },
      description:    { type: 'string',  short: 'd', default: '' },
      'no-compress':  { type: 'boolean', default: false },
    },
    strict: true,
  })

  if (!values.input) {
    console.error('Usage: node scripts/create-album.mjs --input <dir> [--title <title>] [--no-compress] [--album-id <id>] [--output <dir>]')
    console.error('       --album-id is optional; a random hex ID is generated when omitted')
    process.exit(1)
  }

  // Album ID is the only thing visible as a directory name in the repo.
  // Title/filenames/dates are all encrypted inside config.enc.
  // Default: random 16-char hex — use --album-id only when you need a stable path.
  const albumId = values['album-id'] || Buffer.from(getRandomValues(new Uint8Array(8))).toString('hex')
  const inputDir  = values.input
  const outputBase = join(values.output, 'public')

  const compress = !values['no-compress']
  console.log(`\n📷  Album ID:  ${albumId}  (only this is visible in the repo — title/filenames are encrypted)`)
  console.log(`📁  Input:     ${inputDir}`)
  console.log(`📦  Output:    ${outputBase}`)
  console.log(`🎬  Compress:  ${compress ? 'yes (FullHD H.264)' : 'no (fragment only)'}\n`)

  const allFiles = await readdir(inputDir)
  const mediaFiles = allFiles
    .filter(f => { const e = extname(f).toLowerCase(); return IMAGE_EXTS.has(e) || VIDEO_EXTS.has(e) })
    .sort()

  if (!mediaFiles.length) { console.error('No media files found in', inputDir); process.exit(1) }
  console.log(`Found ${mediaFiles.length} media files\n`)

  const albumKey1  = await generateKey()
  const albumKey2  = await generateKey()
  const key1Base64 = await exportKeyB64(albumKey1)
  const key2Base64 = await exportKeyB64(albumKey2)
  // Flat directory — all files (chunks, thumbs, config, noise) share the same dir
  // with random names, so there is no structural signal about file roles.
  const albumDir = join(outputBase, 'albums', albumId)
  await ensureDir(albumDir)

  const mediaEntries = []
  // Track all real encrypted file sizes for noise calibration
  const realFileSizes = []

  for (let i = 0; i < mediaFiles.length; i++) {
    const filename = mediaFiles[i]
    const ext      = extname(filename).toLowerCase()
    const mimeType = MIME_MAP[ext] || 'application/octet-stream'
    const isVideo  = VIDEO_EXTS.has(ext)

    console.log(`  [${i+1}/${mediaFiles.length}] ${filename}`)

    // ── 1. Prepare raw data + thumbnail ──────────────────────────────────────
    let raw, fragmented = false, codecString = null, duration = null, thumbRaw = null

    if (isVideo) {
      const original = probeVideoInfo(join(inputDir, filename))
      console.log(`    probe  codec=${original.codecString || '?'} duration=${original.duration?.toFixed(1) ?? '?'}s`)

      if (values['no-compress']) {
        // Fragment only — copy streams, no re-encode
        process.stdout.write('    fragment (no compress) → ')
        const ff = findBin('ffmpeg')
        if (ff) {
          const tmpOut = join(tmpdir(), `frag_${Date.now()}.mp4`)
          const r = spawnSync(ff, [
            '-i', join(inputDir, filename),
            '-c', 'copy',
            '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
            '-f', 'mp4', '-y', tmpOut,
          ], { stdio: ['ignore','ignore','pipe'] })
          if (r.status === 0) {
            raw = await readFile(tmpOut)
            await unlink(tmpOut).catch(() => {})
            fragmented = true
          } else {
            raw = await readFile(join(inputDir, filename))
          }
        } else {
          raw = await readFile(join(inputDir, filename))
        }
        codecString = original.codecString
        duration    = original.duration
        console.log(`✓  ${(raw.length/1024/1024).toFixed(1)} MB`)
      } else {
        process.stdout.write('    compress → ')
        const compressed = await compressAndFragment(join(inputDir, filename))
        if (compressed) {
          ;({ data: raw, codecString, duration, fragmented } = compressed)
          const originalSize = (await readFile(join(inputDir, filename))).length
          const ratio = (raw.length / originalSize * 100).toFixed(0)
          console.log(`✓  ${(raw.length/1024/1024).toFixed(1)} MB (${ratio}% of original)  codec=${codecString}`)
        } else {
          process.stdout.write('failed, using original\n')
          raw = await readFile(join(inputDir, filename))
          codecString = original.codecString
          duration    = original.duration
        }
      }

      process.stdout.write('    thumbnail → ')
      thumbRaw = await extractVideoFrame(join(inputDir, filename))
      console.log(thumbRaw ? `✓  ${(thumbRaw.length/1024).toFixed(0)} KB` : 'none')

    } else {
      raw = await readFile(join(inputDir, filename))
      process.stdout.write('    thumbnail → ')
      thumbRaw = await makeThumbnail(join(inputDir, filename))
      console.log(thumbRaw ? `✓  ${(thumbRaw.length/1024).toFixed(0)} KB` : 'none')
    }

    // ── 2. Encrypt chunks (double AES-GCM, random filenames, flat dir) ──────
    process.stdout.write('    encrypt  → ')
    const plainChunks  = splitIntoChunks(raw)
    const chunkEntries = []
    for (const plain of plainChunks) {
      const { enc, iv1, iv2 } = await encryptDoubleBuffer(albumKey1, albumKey2, plain)
      const name = randomName()
      await writeFile(join(albumDir, name), enc)
      chunkEntries.push({ path: `albums/${albumId}/${name}`, iv1: ivToHex(iv1), iv2: ivToHex(iv2) })
      realFileSizes.push(enc.length)
    }
    console.log(`✓  ${plainChunks.length} chunk${plainChunks.length !== 1 ? 's' : ''}`)

    // ── 3. Encrypt thumbnail (double AES-GCM, flat dir) ───────────────────────
    let thumbEntry
    if (thumbRaw) {
      const { enc, iv1, iv2 } = await encryptDoubleBuffer(albumKey1, albumKey2, thumbRaw)
      const name = randomName()
      await writeFile(join(albumDir, name), enc)
      thumbEntry = { iv1: ivToHex(iv1), iv2: ivToHex(iv2), chunk: `albums/${albumId}/${name}` }
      realFileSizes.push(enc.length)
    }

    mediaEntries.push({
      id:          randomName(),
      type:        isVideo ? 'video/mp4' : mimeType,
      name:        filename,
      date:        new Date().toISOString(),
      chunks:      chunkEntries,
      totalSize:   raw.length,
      fragmented:  fragmented || undefined,
      codecString: codecString || undefined,
      duration:    duration    || undefined,
      thumbnail:   thumbEntry,
    })
  }

  // ── 4. Noise files (same flat dir, same count as real files) ────────────────
  await writeNoiseFiles(albumDir, albumKey1, albumKey2, realFileSizes)

  // ── 5. Write double-encrypted config (random filename, flat dir) ──────────
  const configName = randomName()
  process.stdout.write(`\n  Writing config (double AES-GCM)… `)
  const config = { title: values.title || albumId, description: values.description, created: new Date().toISOString(), media: mediaEntries }
  await writeFile(join(albumDir, configName), await encryptDoubleJSON(albumKey1, albumKey2, config))
  console.log('✓')

  const token = encodeToken(`albums/${albumId}/${configName}`, key1Base64, key2Base64)

  console.log('\n' + '─'.repeat(60))
  console.log('✅  Album created!\n')
  console.log('Token:\n\n' + token + '\n')
  console.log('─'.repeat(60))
  console.log(`\n  git add public/albums/${albumId}`)
  console.log(`  git commit -m "Add album: ${albumId}"`)
  console.log('  git push\n')
}

main().catch(e => { console.error(e); process.exit(1) })
