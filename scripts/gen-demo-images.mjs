#!/usr/bin/env node
// Generates colorful demo PNG images for testing
import { writeFile, mkdir } from 'node:fs/promises'
import { deflateSync } from 'node:zlib'

function crc32(buf) {
  let crc = 0xFFFFFFFF
  const table = (() => {
    const t = new Uint32Array(256)
    for (let i = 0; i < 256; i++) {
      let c = i
      for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
      t[i] = c
    }
    return t
  })()
  for (const b of buf) crc = table[(crc ^ b) & 0xFF] ^ (crc >>> 8)
  return (crc ^ 0xFFFFFFFF) >>> 0
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii')
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])))
  return Buffer.concat([len, typeBytes, data, crcBuf])
}

function makePNG(width, height, pixels) {
  const rows = []
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3)
    row[0] = 0 // filter: None
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3
      row[1 + x * 3]     = pixels[i]
      row[1 + x * 3 + 1] = pixels[i + 1]
      row[1 + x * 3 + 2] = pixels[i + 2]
    }
    rows.push(row)
  }
  const compressed = deflateSync(Buffer.concat(rows), { level: 6 })
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8; ihdr[9] = 2 // 8-bit RGB
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

function generatePixels(width, height, colors) {
  const pixels = new Uint8Array(width * height * 3)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const t = x / width, u = y / height
      const [c0, c1, c2] = colors
      const wave = 18 * Math.sin(x * 0.04) * Math.cos(y * 0.04)
      const i = (y * width + x) * 3
      pixels[i]   = Math.max(0, Math.min(255, Math.round(c0[0]*(1-t)*(1-u) + c1[0]*t*(1-u) + c2[0]*u + wave)))
      pixels[i+1] = Math.max(0, Math.min(255, Math.round(c0[1]*(1-t)*(1-u) + c1[1]*t*(1-u) + c2[1]*u + wave)))
      pixels[i+2] = Math.max(0, Math.min(255, Math.round(c0[2]*(1-t)*(1-u) + c1[2]*t*(1-u) + c2[2]*u + wave)))
    }
  }
  return pixels
}

const IMAGES = [
  { name: 'sunset.png',   w: 1200, h: 800,  colors: [[255,100,30],[255,60,0],[200,40,80]] },
  { name: 'ocean.png',    w: 1000, h: 750,  colors: [[0,120,200],[0,80,180],[30,160,220]] },
  { name: 'forest.png',   w: 900,  h: 1200, colors: [[20,120,40],[10,80,30],[60,160,60]] },
  { name: 'mountain.png', w: 1400, h: 900,  colors: [[150,150,170],[100,100,130],[200,200,220]] },
  { name: 'desert.png',   w: 800,  h: 600,  colors: [[220,180,80],[200,140,50],[240,200,100]] },
  { name: 'city.png',     w: 1100, h: 700,  colors: [[80,80,120],[60,60,100],[120,120,180]] },
  { name: 'flowers.png',  w: 700,  h: 900,  colors: [[220,60,140],[180,40,120],[255,100,160]] },
  { name: 'aurora.png',   w: 1300, h: 850,  colors: [[40,200,160],[20,160,200],[80,240,180]] },
]

const outDir = 'demo-input'
await mkdir(outDir, { recursive: true })
console.log('Generating demo images...')
for (const { name, w, h, colors } of IMAGES) {
  const pixels = generatePixels(w, h, colors)
  const buf = makePNG(w, h, pixels)
  await writeFile(`${outDir}/${name}`, buf)
  console.log(`  ✓ ${name} (${w}×${h}, ${(buf.length/1024).toFixed(0)} KB)`)
}
console.log(`\nDone! Images saved to ./${outDir}/`)
