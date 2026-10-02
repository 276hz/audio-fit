import type { PlanResult } from '../planner/types.ts';
export interface EngineAnalysis { engineId: string; summary: Record<string, unknown>; insights: string[] /* i18n keys */ }
export interface RunHandle { jobId: string; cancel(): void; }
export interface VerifyReport { ok: boolean; method: 'pcm-sha256' | 'none'; inputHash?: string; outputHash?: string; lossless: boolean; }

/** Plugin contract. V1 ships one engine (audio); image/PDF/video can be added without touching UI or planner. */
export interface MediaEngine<Target = unknown> {
  id: string;
  accepts(file: { name: string; type: string; head: Uint8Array }): boolean;
  analyze(file: File, signal: AbortSignal): Promise<EngineAnalysis>;
  plan(analysis: EngineAnalysis, target: Target): PlanResult;
  run(file: File, choice: unknown, onProgress: (p: { ratio: number; speedX?: number }) => void, signal: AbortSignal): Promise<{ outputs: Blob[]; names: string[] }>;
  /** Must return lossless=true ONLY if hashes matched. Lossy outputs return method 'none', lossless=false. */
  verify(input: File, outputs: Blob[]): Promise<VerifyReport>;
}
