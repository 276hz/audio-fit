# Audio Fit

Tells you whether your audio can meet a file-size limit, and does the rest in your browser. Nothing is uploaded.

The motivating case: a 16-bit / 44.1 kHz / stereo FLAC, 11:42, 72.6 MB, platform limit 50 MB, lossless required. Re-compressing FLAC saves under 1%, so no single lossless file can fit. The correct answer is to split at a quiet moment into parts that each fit, then prove with a hash that the parts rejoin to the exact original samples. That is what this app does.

## What this version does
- Reads **FLAC and WAV** (16/24-bit, mono/stereo). Writes **FLAC**.
- Analyses: waveform, silences, dual-mono, wasted bits, DC offset, clipping, "was this once MP3/AAC?" hint (likelihood only).
- **Target solver**: platform profile or custom limit → is it possible, and ranked options, with the reason each is or isn't valid.
- **Lossless split** at silence, sample-accurate, tags renumbered (`TITLE (Part n)`, `TRACKNUMBER`, `TRACKTOTAL`).
- **Verification after every run**: output is decoded again, parts are joined, SHA-256 of the PCM is compared with the input. Only an exact match is shown as bit-exact; on mismatch no download is offered.
- ZIP download + JSON verification report. Vietnamese / English. Light / dark. PWA offline shell. Cancel is instant (the worker is terminated).

## What it does NOT do yet (be aware)
- No lossy export (MP3/AAC/Opus), no other input formats, no ffmpeg.wasm. Those options are listed (flagged invalid when the target forbids them) but can't be run. See `DECISIONS.md` and `ROADMAP.md`.
- No A/B listening, LUFS, batch queue, metadata editor, mono-fold. Not started.
- Hash in the FLAC STREAMINFO is left as zeros (allowed by the spec); verification does not rely on it.

## Run
Needs Node ≥ 22.13 (uses the built-in type stripper; no `npm install`, no dependencies).
```bash
npm test          # unit + codec tests (interop tests use native ffmpeg if installed)
npm run build     # → dist/  (fails if app code > 200 KB gzip)
npm run serve     # http://localhost:4173, applies dist/_headers like production
pip install playwright && python -m playwright install chromium
python3 tests/e2e/e2e.py your.flac 50     # browser e2e; limit in MB (needs ffmpeg + running server)
python3 tests/e2e/edge.py                 # errors, unicode names, cancel, offline
```

## Deploy (static)
`dist/` is the whole site. Headers live in `_headers` (Cloudflare Pages, Netlify) and `vercel.json` (Vercel).
- **Cloudflare Pages**: connect the repo, build command `node build.mjs`, output `dist`, env `NODE_VERSION=22`. Or `npx wrangler pages deploy dist`.
- **Vercel**: `npx vercel --prod` (reads `vercel.json`).
- **Netlify**: reads `netlify.toml` and `_headers`.

After deploying, check: `crossOriginIsolated` is `true` in the console; Network tab shows only your own domain; drop a FLAC over the limit and confirm the split + bit-exact badge.

## Architecture
`src/planner` (pure solver) · `src/analysis` (pure DSP) · `src/codec` (FLAC read/write, WAV read, SHA-256, CRC) · `src/app/pipeline.ts` (DOM-free orchestration, verification) · `src/app/worker.ts` (runs it off-thread) · `src/app/main.ts` (UI) · `src/engine/types.ts` (plugin contract) · `src/i18n`.

## Measured (not estimated)
Sandbox: 1 vCPU Xeon 2.8 GHz, headless Chromium. 11:42 stereo 16-bit FLAC (81 MB), 50 MB limit: analyse + plan + split + encode + verify = 56 s end to end; encode+verify phase ≈ 23× realtime. Your device will differ; very large files need lots of RAM (decoded PCM is held as 32-bit integers).

## Privacy check
Build output has no analytics, no third-party hosts, CSP `default-src 'self'`. In the e2e run the browser made zero requests to any other origin. Verify yourself in the Network tab.
