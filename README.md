# AlbumsViewer

A self-hosted, end-to-end encrypted photo and video gallery that runs entirely on GitHub Pages. No server, no database — just static files and in-browser AES-GCM decryption.

## How it works

Albums are prepared locally with a CLI script and pushed to the repo. The browser fetches and decrypts them client-side using a token you share out-of-band (e.g. via message). No key ever touches a server.

### Encryption model

Every file in an album is encrypted with **double AES-256-GCM** (two independent keys, two independent IVs per chunk):

```
ciphertext = E(key2, iv2,  E(key1, iv1, plaintext))
```

Both keys are needed to decrypt anything. The album config (metadata, file names, dates) is encrypted the same way — nothing in the repository reveals what the album contains.

The **access token** is a base64-encoded JSON blob:

```json
{ "url": "albums/<id>/<random-config-name>", "key1": "<base64>", "key2": "<base64>" }
```

It is stored in `sessionStorage` only — never in the URL.

### Storage layout

```
public/albums/<album-id>/     ← only the album ID is visible
  <random-hex>                ← config (encrypted JSON)
  <random-hex>                ← media chunk
  <random-hex>                ← thumbnail
  <random-hex>                ← noise file
  ...                         ← all files look identical from outside
```

Every file has a random 32-char hex name. For each real file, 1–10 noise files are generated with sizes randomly between −90% and +200% of the original, making it impossible to infer the media item count, file roles, or sizes from the repository contents.

### Video streaming

Videos are stored as **fragmented MP4** (frag_keyframe+empty_moov). Each 8 MB chunk is independently encrypted, so the browser can decrypt and feed chunks one by one into the MediaSource API without downloading the whole file. A sliding buffer window (buffer 90 s ahead, evict 20 s behind) keeps memory use bounded.

HEVC/H.265 videos fall back to full download since Chrome does not support HEVC in MediaSource.

---

## Creating an album

Requirements: Node.js 18+, ffmpeg (for thumbnails and video fragmentation).

```bash
node scripts/create-album.mjs \
  --input  ./my-photos \
  --title  "Summer 2025" \
  [--album-id  my-album]       # optional; random hex ID if omitted
  [--no-compress]              # skip H.264 re-encode, fragment only
  [--output .]                 # defaults to current directory
```

The script will:
1. Compress videos to 1080p H.264 (skip with `--no-compress`)
2. Fragment videos for streaming
3. Extract JPEG thumbnails (ffmpeg) for every file
4. Double-encrypt all chunks and thumbnails with two fresh AES-256 keys
5. Write a double-encrypted config file with a random filename
6. Generate noise files to obfuscate the file count
7. Print the access token

```
Token:

eyJ1cmwiOi...(base64)...

  git add public/albums/<album-id>
  git commit -m "Add album: <album-id>"
  git push
```

Share the token with whoever should view the album. Anyone without the token cannot decrypt any file.

---

## Deploying to GitHub Pages

1. Fork or clone this repo.
2. Go to **Settings → Pages** and set source to **GitHub Actions**.
3. Push to `main` — the workflow in `.github/workflows/deploy.yml` builds the Vite app and deploys `dist/` automatically.
4. Create albums locally and push the `public/albums/<id>/` directory.

---

## Development

```bash
npm install          # also installs the git pre-commit hook
npm run dev          # Vite dev server at http://localhost:5173
npm run build        # production build → dist/
npm run preview      # preview the production build locally
```

### Pre-commit hook

`npm install` automatically installs a git hook (`scripts/hooks/pre-commit`) that blocks commits containing:

- Files under `public/albums/` (encrypted media data)
- AES-256 key patterns (`"key1":"<44-char-base64>"`)
- Album token prefixes

Override with `git commit --no-verify` only if you are certain it is a false positive.

---

## Security notes

- All decryption runs in the browser via the Web Crypto API (AES-GCM 256-bit). No key material is ever sent to a server.
- The repository contains only ciphertext. Without the token, files are indistinguishable from random bytes.
- Tokens should be shared through a separate secure channel (Signal, etc.), not via Git, email, or public URLs.
- Album IDs are visible as directory names in the repository. Use opaque random IDs (the default) rather than descriptive names.
