// Runs all heavy work off the main thread. Cancel = main thread terminates this worker (instant, frees all memory).
import { loadAudio, analyze, execute, AppError, type Loaded, type Analysis } from './pipeline.ts';
import type { Constraints, PlanOption } from '../planner/types.ts';

let loaded: Loaded | null = null, analysis: Analysis | null = null;
const post = (m: unknown, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer);

self.onmessage = (e: MessageEvent) => {
  const m = e.data;
  try {
    if (m.type === 'analyze') {
      loaded = null; analysis = null;
      const bytes = new Uint8Array(m.buffer);
      loaded = loadAudio(m.name, bytes);
      post({ type: 'progress', ratio: 0.05, phase: 'analyze' });
      analysis = analyze(loaded, { onProgress: (r, phase) => post({ type: 'progress', ratio: r, phase }) });
      const { info, silences, insights, peaks, tags, pictureBytes } = analysis;
      post({ type: 'analysis', info, silences, insights, peaks, tags, pictureBytes, name: loaded.name, kind: loaded.kind });
    } else if (m.type === 'run') {
      if (!loaded || !analysis) throw new AppError('NOT_LOADED');
      const r = execute(loaded, analysis, m.option as PlanOption, m.constraints as Constraints, { onProgress: (ratio, phase) => post({ type: 'progress', ratio, phase }) });
      post({ type: 'result', files: r.files, verification: r.verification, sizesOk: r.sizesOk, passthrough: r.passthrough, report: r.report }, r.files.map((f) => f.bytes.buffer as ArrayBuffer));
    }
  } catch (err) {
    const code = err instanceof AppError ? err.code : err instanceof RangeError ? 'OUT_OF_MEMORY' : 'UNEXPECTED';
    post({ type: 'error', code, detail: (err as Error).message ?? String(err) });
  }
};
