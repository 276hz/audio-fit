# Engine plugin contract
`src/engine/types.ts` defines `MediaEngine { id, accepts, analyze, plan, run, verify }`.
Today the audio engine is implemented as plain functions in `src/app/pipeline.ts` (`loadAudio`, `analyze`, `makePlan`, `execute`) and is not yet wrapped in the interface. To add an engine: implement the interface, register it where `main.ts` picks the engine from `accepts()`, keep heavy work in a worker, and make `verify()` return `lossless: true` only after a real comparison.
