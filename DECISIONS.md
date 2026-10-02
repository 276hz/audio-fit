# DECISIONS

## Status legend
VERIFIED = run/observed in this repo's sandbox. SOURCED = read from docs during research. UNVERIFIED = must be checked before relying on it.

## Research (step 1)
- SOURCED: @ffmpeg/ffmpeg latest 0.12.15, @ffmpeg/util 0.12.2 (npm); project is effectively in maintenance. core-mt needs ffmpeg >= 0.12.10 and core >= 0.12.4.
- SOURCED: archived core build config (branch n4.3.1) enables --enable-gpl and --enable-nonfree (fdk-aac). UNVERIFIED for current 0.12.x core.
- SOURCED: Vercel Hobby: 100 MB static upload via CLI, 100 GB/month bandwidth, 100 deploys/day. Non-commercial use restriction UNVERIFIED against official terms.
- UNVERIFIED: real core size, COEP `credentialless` support on Safari/Firefox, Cloudflare Pages bandwidth limits.

## Decisions (defaults taken because user said "continue" without choosing)
1. Custom LGPL-only, audio-only ffmpeg core (FLAC/WAV/AIFF/ALAC/native AAC + lame/opus/vorbis). Reason: license + bandwidth. Cost: needs Docker+emscripten build; NOT done yet.
2. Lossless split/hash path should not require the 30MB+ core (light FLAC codec). Not implemented yet.
3. Primary host Cloudflare Pages, Vercel compatible. Reason: Hobby 100 GB cap vs multi-MB wasm per new visitor.
4. Platform profiles: only `distribution-generic` (from the user's own requirement text, marked not-verified). No other platform invented.
5. Planner is pure TS, i18n keys instead of prose, WAV/AIFF never planned for splitting (never smaller than FLAC).
6. Split model is proportional bytes/sample; a real run must re-check each part (planned: sampled trial encodes).

## Spike results
- (b) sample-accurate split — VERIFIED with NATIVE ffmpeg on 11:42 synthetic fixture: cut at sample 15333570 in a 1.4 s silence.
- (c) bit-exact — VERIFIED natively: SHA-256 of PCM identical before/after split+concat.
- (a) ffmpeg.wasm in Worker, (d) real deploy headers — NOT DONE: sandbox has no network/browser.
- Fixture is 81.3 MB FLAC, not 72.6 MB (synthetic noise ratio differs). Planner golden test uses the spec's numbers directly.
- Planner: 7/7 tests pass (`node --experimental-strip-types --test tests/planner.test.ts`).

## Round 2 (no-network work)
- Added `analysis/` (silence finder, dual-mono, wasted bits, DC offset, clipping, lossy-cutoff detector with own radix-2 FFT — no dependency), `engine/types.ts` (MediaEngine plugin contract), `i18n/{en,vi}.json` (planner reason keys; test enforces parity).
- Lossy-cutoff detector reports likelihood (none/low/medium/high) from cutoff frequency + spectral drop; never "certain". VERIFIED only on synthetic low-passed noise (16 kHz, 19.5 kHz found within 1.2 kHz; full-band noise not flagged). UNVERIFIED on real music: natural roll-offs and old recordings may false-positive. Needs a corpus of real files locally before trusting thresholds.
- Cross-check on the 11:42 fixture: silence finder located all 3 gaps (142 ms); planner cut at 347.695 s, predicted 40.3+41.0 MB = actual ffmpeg output 40.3+41.0 MB. Caveat: the fixture is stationary noise+tones, so the proportional size model is best-case; real music varies in density. Keep the planned trial-encode step.
- Tests: 16/16 pass (`node --experimental-strip-types --test tests/planner.test.ts tests/analysis.test.ts`). Not yet: tsc strict, ESLint, Vitest (need npm).
- Known gaps: findSilences resolution is the 10 ms window (cut still lands on an exact sample index inside the silence); no LUFS/true-peak; no waveform; no decoding yet (inputs are assumed already decoded to PCM).

## Round 3 (full vertical slice, no network)
- **Own FLAC codec** (decoder: all subframe types, stereo modes, wasted bits, CRC-16 check; encoder: fixed + LPC 8/12, Rice partitions, constant subframes, stereo mode choice). No dependency, no 30 MB core. VERIFIED: interop with native ffmpeg both directions (16/24-bit, levels 0/5/8/12, block sizes 1152/4096/4608), 11:42 fixture split → ffmpeg hash of concatenated parts equals original.
- Size cost vs `ffmpeg -12` on the fixture: +1.7%. Speed after optimisation (single thread, JS): ≈16× realtime in Node.
- **Zero-dependency build** (`build.mjs` via `module.stripTypeScriptTypes`) instead of Vite, because `npm install` was impossible. Consequences: no `tsc --strict` check was run on this code; no hashed asset names (we use revalidation + SW cache); Node ≥ 22.13 required. Replace with Vite when possible (ROADMAP 3).
- **No ffmpeg.wasm in this version** → no lossy export, no MP3/AAC/OGG input. COOP/COEP headers are still sent so `crossOriginIsolated` is ready for a multi-thread core later; nothing needs them today.
- Verification design: decode the *produced bytes* (not the encoder's internal buffers), join, hash. Passthrough (FLAC already under the limit) returns the original bytes untouched.
- Estimator: 5×10 s trial encodes; real run re-checks and re-plans up to 3 times. Golden-size run predicted 40.0+40.7 MB, actual 41.0+41.7 MB (+2.5%), still under the limit thanks to the 2% safety margin.
- Cancel = `worker.terminate()` (instant, frees memory); the file is re-read and re-analysed afterwards.
- Service worker: no `skipWaiting`, so an open page never mixes old main.js with a new worker.js. Unverified: update behaviour across real deployments.
- Presets "25/50/100 MB" are plain size buttons, not platform claims. No Discord/WhatsApp/Telegram/Email profiles were added: none could be verified from official docs here.
- Name "Audio Fit" is a placeholder; no trademark check.

## Measurements (this sandbox only: 1 vCPU, Intel Xeon @ 2.80 GHz)
- 11:42, 16-bit stereo FLAC 81.3 MB → 50 MB limit, headless Chromium: total 56 s (read+decode+analyse+estimate+split+encode+verify). Run phase reported 22.9× realtime. Node: encode 60 s excerpt 3.7 s.
- App code: 94 KB raw / 33 KB gzip (budget 200 KB gzip). No ffmpeg core.

## Definition of Done, honest status
- Golden case unit test: PASS. Golden-size e2e (Chromium, real headers): PASS, ffmpeg independent hash MATCH.
- Bit-exact verified in UI: PASS (Chromium).
- Single-thread / multi-thread: N/A (no ffmpeg.wasm).
- No network requests with user data: PASS in Chromium e2e (zero external requests). Not audited in other browsers.
- Lighthouse ≥ 90: NOT RUN. Firefox, Safari, mobile browsers: NOT RUN (only Chromium available). CI: written, never executed. a11y: keyboard/labels/contrast designed in, no axe/screen-reader test run. ESLint/Prettier/tsc strict: NOT RUN. SEO: meta + JSON-LD only; no sitemap (needs the real domain).
