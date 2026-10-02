# Roadmap (priority order)
1. **Codec engine (lossy export + more inputs).** Custom LGPL, audio-only ffmpeg.wasm core (FLAC/WAV/AIFF/ALAC, native AAC, lame, opus, vorbis). Blockers: needs Docker + Emscripten and licence review; keep the core < 25 MiB per file for Cloudflare Pages.
2. **Real-music calibration** of the lossy-cutoff detector and the size estimator (needs a local corpus).
3. **Vite + TypeScript strict + ESLint/Prettier/Vitest** replacing the zero-dependency build, with hashed assets and 1-year immutable caching.
4. **Playwright on Firefox and WebKit**, real iOS/Android memory limits, Lighthouse and axe runs.
5. **A/B listening** (loudness-matched), cut-point dragging with audition, LUFS / true peak.
6. **Batch queue**, folder drop, name templates, metadata editor, cover-art optimiser.
7. **Mono fold** when L = R bit-exact (verified by re-expanding), wasted-bits trimming.
8. **Streaming decode** to lift the RAM ceiling (process in blocks; WORKERFS/OPFS for big files); parallel encoding across workers.
9. **Verified platform profiles** (each with source URL + date); user-defined profiles saved locally, JSON import/export.
10. Other engines: images, PDF, video via the `MediaEngine` contract.
