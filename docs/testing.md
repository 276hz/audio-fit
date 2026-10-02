# Tests
- `tests/planner.test.ts`, `analysis.test.ts`: pure logic incl. the golden case (72.6 MB, 11:42, 50 MB) and a split property test.
- `tests/codec.test.ts`: SHA-256 vs node:crypto, own round-trips, and **interop with native ffmpeg in both directions** (skipped if ffmpeg is absent).
- `tests/pipeline.test.ts`: end-to-end in Node (split, verify, tags, errors, ZIP via `unzip -t`).
- `tests/e2e/*.py`: real Chromium against `dist/` served with the real headers. Fixtures are generated at run time; no copyrighted audio is committed.
