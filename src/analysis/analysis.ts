import { fft } from './fft.ts';
import type { SilenceCandidate } from '../planner/types.ts';

/** Samples are normalized floats in [-1, 1] unless a function says Int32Array. */

export function findSilences(ch: Float32Array[], sampleRate: number, opts: { thresholdDb?: number; minSec?: number; windowMs?: number } = {}): SilenceCandidate[] {
  const thr = opts.thresholdDb ?? -60, minSec = opts.minSec ?? 0.3;
  const win = Math.max(1, Math.round(((opts.windowMs ?? 10) / 1000) * sampleRate));
  const n = ch[0]?.length ?? 0;
  const out: SilenceCandidate[] = [];
  let runStart = -1, sumDb = 0, cnt = 0;
  const flush = (end: number) => {
    if (runStart >= 0 && (end - runStart) / sampleRate >= minSec) out.push({ startSample: runStart, endSample: end, depthDb: sumDb / cnt });
    runStart = -1; sumDb = 0; cnt = 0;
  };
  for (let s = 0; s < n; s += win) {
    const e = Math.min(n, s + win);
    let peakPow = 0;
    for (const c of ch) { let acc = 0; for (let i = s; i < e; i++) acc += c[i]! * c[i]!; peakPow = Math.max(peakPow, acc / (e - s)); }
    const db = peakPow > 0 ? Math.max(-120, 10 * Math.log10(peakPow)) : -120;
    if (db < thr) { if (runStart < 0) runStart = s; sumDb += db; cnt++; } else flush(s);
  }
  flush(n);
  return out;
}

export function isDualMono(l: Int32Array, r: Int32Array): boolean {
  if (l.length !== r.length) return false;
  for (let i = 0; i < l.length; i++) if (l[i] !== r[i]) return false;
  return true; // bit-exact L==R only; "nearly equal" is NOT lossless-safe
}

/** Number of always-zero low bits ("wasted bits") across all samples. */
export function wastedBits(...chs: Int32Array[]): number {
  let acc = 0;
  for (const c of chs) for (let i = 0; i < c.length; i++) acc |= c[i]!;
  if (acc === 0) return 0; // pure silence: undefined, report 0
  let n = 0; while (((acc >> n) & 1) === 0) n++;
  return n;
}

/** Smallest bit depth (8/16/24/32) that holds every sample after removing wasted bits at the container depth. */
export function effectiveBitDepth(containerBits: number, ...chs: Int32Array[]): number {
  const w = wastedBits(...chs);
  return Math.max(1, containerBits - w);
}

export function dcOffset(x: Float32Array): number { let s = 0; for (let i = 0; i < x.length; i++) s += x[i]!; return x.length ? s / x.length : 0; }

/** Runs of >= minRun consecutive samples at/above `level` (e.g. 0.999) count as clipped. */
export function clippedSamples(x: Float32Array, level = 0.999, minRun = 3): number {
  let run = 0, total = 0;
  for (let i = 0; i <= x.length; i++) {
    if (i < x.length && Math.abs(x[i]!) >= level) run++;
    else { if (run >= minRun) total += run; run = 0; }
  }
  return total;
}

export interface CutoffResult { cutoffHz: number | null; confidence: 'none' | 'low' | 'medium' | 'high'; steepnessDbPerKhz: number; note: string }

/**
 * Heuristic "fake lossless" detector: MP3/AAC encoders low-pass at a fixed frequency (~16 kHz @128k, ~19-20 kHz @256-320k).
 * Averages a Hann-windowed spectrum, finds where energy drops far below the mid-band level and stays there up to Nyquist.
 * It reports LIKELIHOOD only. Natural roll-offs, old recordings and resampled files can look similar.
 */
export function detectLossyCutoff(mono: Float32Array, sampleRate: number, fftSize = 4096): CutoffResult {
  const none: CutoffResult = { cutoffHz: null, confidence: 'none', steepnessDbPerKhz: 0, note: 'no-cutoff' };
  const hop = fftSize, frames = Math.floor(mono.length / hop);
  if (frames < 4) return { ...none, note: 'too-short' };
  const bins = fftSize / 2, pow = new Float64Array(bins);
  const re = new Float64Array(fftSize), im = new Float64Array(fftSize);
  const hann = new Float64Array(fftSize).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (fftSize - 1)));
  const step = Math.max(1, Math.floor(frames / 200)); // cap work at ~200 frames
  let used = 0;
  for (let f = 0; f < frames; f += step) {
    for (let i = 0; i < fftSize; i++) { re[i] = mono[f * hop + i]! * hann[i]!; im[i] = 0; }
    fft(re, im);
    for (let k = 0; k < bins; k++) pow[k] += re[k]! * re[k]! + im[k]! * im[k]!;
    used++;
  }
  const hz = (k: number) => (k * sampleRate) / fftSize;
  const db = Array.from(pow, (p) => 10 * Math.log10(p / used + 1e-20));
  // smooth over ~200 Hz
  const sw = Math.max(1, Math.round(200 / hz(1)));
  const sm = db.map((_, k) => { let a = 0, c = 0; for (let j = Math.max(0, k - sw); j <= Math.min(bins - 1, k + sw); j++) { a += db[j]!; c++; } return a / c; });
  const lo = Math.floor(1000 / hz(1)), hi = Math.floor(Math.min(10000, sampleRate / 4) / hz(1));
  const ref = [...sm.slice(lo, hi)].sort((a, b) => a - b)[Math.floor((hi - lo) / 2)]!;
  if (!isFinite(ref) || ref < -150) return { ...none, note: 'silent' };
  // highest bin still within 30 dB of reference
  let top = bins - 1; while (top > hi && sm[top]! < ref - 30) top--;
  const cutoffHz = hz(top);
  const nyq = sampleRate / 2;
  if (cutoffHz > nyq - 1500) return none; // energy reaches near Nyquist: nothing suspicious
  const above = sm.slice(top + Math.round(500 / hz(1)), Math.min(bins, top + Math.round(1500 / hz(1))));
  const dropDb = ref - (above.length ? above.reduce((a, b) => a + b, 0) / above.length : ref);
  const steep = dropDb / 1.0;
  let confidence: CutoffResult['confidence'] = 'low';
  if (dropDb > 60) confidence = 'high'; else if (dropDb > 45) confidence = 'medium';
  return { cutoffHz, confidence, steepnessDbPerKhz: steep, note: 'cutoff-found' };
}
