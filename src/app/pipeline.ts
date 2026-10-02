import { decodeFlac, type FlacTags } from '../codec/flac-decode.ts';
import { encodeFlac } from '../codec/flac-encode.ts';
import { parseWav } from '../codec/wav.ts';
import { PcmHasher } from '../codec/sha256.ts';
import { findSilences, isDualMono, effectiveBitDepth, dcOffset, clippedSamples, detectLossyCutoff } from '../analysis/analysis.ts';
import { plan, planSplit } from '../planner/planner.ts';
import type { AudioInfo, Constraints, PlanOption, PlanResult, SilenceCandidate } from '../planner/types.ts';
import { sanitizeName, stripExt, uniqueNames } from '../util/files.ts';

export class AppError extends Error { code: string; constructor(code: string, detail?: string) { super(detail ? `${code}: ${detail}` : code); this.code = code; } }

export interface Loaded {
  name: string; kind: 'flac' | 'wav'; sampleRate: number; bits: 16 | 24; ch: Int32Array[]; total: number;
  tags: FlacTags; pictures: Uint8Array[]; sizeBytes: number; original?: Uint8Array;
}
export interface Insight { key: string; params?: Record<string, string | number> }
export interface Analysis { info: AudioInfo; silences: SilenceCandidate[]; insights: Insight[]; peaks: Float32Array; tags: string[]; pictureBytes: number }
export interface OutFile { name: string; bytes: Uint8Array }
export interface RunResult {
  files: OutFile[];
  verification: { ok: boolean; method: 'pcm-sha256'; inputHash: string; outputHash: string; lossless: true };
  sizesOk: boolean; passthrough: boolean; report: Record<string, unknown>;
}
export interface Hooks { onProgress?: (ratio: number, phase: string) => void; isCancelled?: () => boolean }

const MAX_PCM_BYTES = 1.6e9; // Int32 working copy; beyond this mobile/desktop tabs commonly die

export function loadAudio(name: string, bytes: Uint8Array): Loaded {
  if (bytes.length === 0) throw new AppError('EMPTY_FILE');
  const isFlac = bytes.length > 4 && bytes[0] === 0x66 && bytes[1] === 0x4c && bytes[2] === 0x61 && bytes[3] === 0x43;
  const isWav = bytes.length > 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46;
  if (!isFlac && !isWav) throw new AppError('UNSUPPORTED_FORMAT');
  try {
    if (isFlac) {
      const d = decodeFlac(bytes);
      if (d.channels > 2) throw new AppError('UNSUPPORTED_CHANNELS');
      return { name, kind: 'flac', sampleRate: d.sampleRate, bits: d.bits as 16 | 24, ch: d.ch, total: d.totalSamples, tags: d.tags, pictures: d.pictures, sizeBytes: bytes.length, original: bytes };
    }
    const w = parseWav(bytes);
    return { name, kind: 'wav', sampleRate: w.sampleRate, bits: w.bits, ch: w.ch, total: w.ch[0]!.length, tags: { vendor: '', comments: [] }, pictures: [], sizeBytes: bytes.length };
  } catch (e) {
    if (e instanceof AppError) throw e;
    const m = (e as Error).message;
    if (m === 'FLAC_UNSUPPORTED' || m === 'WAV_UNSUPPORTED') throw new AppError('UNSUPPORTED_BITS_OR_CHANNELS', m);
    if (m === 'FLAC_CRC' || m === 'FLAC_SYNC_LOST' || m === 'FLAC_TRUNCATED' || m.startsWith('FLAC_BAD') || m === 'WAV_INVALID' || m === 'FLAC_INVALID') throw new AppError('FILE_CORRUPT', m);
    if (e instanceof RangeError) throw new AppError('OUT_OF_MEMORY', m);
    throw new AppError('DECODE_FAILED', m);
  }
}

export function checkMemory(sizeBytes: number, channelsGuess = 2, ratio = 2.2): void {
  if (sizeBytes * ratio * (channelsGuess / 2) * 2 > MAX_PCM_BYTES * 2) throw new AppError('TOO_LARGE');
}

const tagBytes = (a: Loaded) => a.tags.comments.reduce((s, c) => s + c.length + 8, 64) + a.pictures.reduce((s, p) => s + p.length + 4, 0);

/** Trial-encode ~5x10 s evenly spread (whole file if short) and scale. The real run re-checks every part. */
export function estimateFlacBytes(a: Loaded): number {
  const seg = 10 * a.sampleRate;
  if (a.total <= seg * 6) return encodeFlac({ sampleRate: a.sampleRate, bits: a.bits, ch: a.ch, tags: a.tags, pictures: a.pictures }).length;
  let bytes = 0;
  for (let i = 0; i < 5; i++) { const s = Math.floor(((i + 0.5) / 5) * a.total - seg / 2); bytes += encodeFlac({ sampleRate: a.sampleRate, bits: a.bits, ch: a.ch, start: s, end: s + seg }).length; }
  return Math.round((bytes / (5 * seg)) * a.total + tagBytes(a));
}

export function analyze(a: Loaded, hooks: Hooks = {}): Analysis {
  hooks.onProgress?.(0.1, 'analyze');
  const f = a.ch.map((c) => { const o = new Float32Array(c.length), sc = 1 / 2 ** (a.bits - 1); for (let i = 0; i < c.length; i++) o[i] = c[i]! * sc; return o; });
  const silences = findSilences(f, a.sampleRate);
  const insights: Insight[] = [];
  if (a.ch.length === 2 && isDualMono(a.ch[0]!, a.ch[1]!)) insights.push({ key: 'insight.dualMono' });
  const eff = effectiveBitDepth(a.bits, ...a.ch);
  if (eff < a.bits) insights.push({ key: 'insight.wastedBits', params: { used: eff, container: a.bits } });
  const dc = Math.max(...f.map((c) => Math.abs(dcOffset(c))));
  if (dc > 0.005) insights.push({ key: 'insight.dcOffset', params: { pct: (dc * 100).toFixed(2) } });
  const clip = f.reduce((s, c) => s + clippedSamples(c), 0);
  if (clip > 10) insights.push({ key: 'insight.clipping', params: { n: clip } });
  const L = Math.min(a.total, a.sampleRate * 30), s0 = Math.max(0, Math.floor((a.total - L) / 2));
  const mono = new Float32Array(L); for (let i = 0; i < L; i++) { let v = 0; for (const c of f) v += c[s0 + i]!; mono[i] = v / f.length; }
  const cut = detectLossyCutoff(mono, a.sampleRate);
  if (cut.cutoffHz !== null && cut.confidence !== 'none') insights.push({ key: 'insight.lossyCutoff', params: { khz: (cut.cutoffHz / 1000).toFixed(1), level: cut.confidence } });
  hooks.onProgress?.(0.5, 'analyze');
  const B = 1000, peaks = new Float32Array(B * 2), per = Math.max(1, Math.floor(a.total / B));
  for (let b = 0; b < B; b++) { let mn = 0, mx = 0; for (let i = b * per; i < Math.min(a.total, (b + 1) * per); i += 8) for (const c of f) { const v = c[i]!; if (v < mn) mn = v; if (v > mx) mx = v; } peaks[2 * b] = mn; peaks[2 * b + 1] = mx; }
  hooks.onProgress?.(0.7, 'estimate');
  const est = estimateFlacBytes(a);
  hooks.onProgress?.(1, 'done');
  const info: AudioInfo = { durationSec: a.total / a.sampleRate, sampleRate: a.sampleRate, bitDepth: a.bits, channels: a.ch.length, sizeBytes: a.sizeBytes, format: a.kind, flacBytesEstimate: est };
  return { info, silences, insights, peaks, tags: a.tags.comments, pictureBytes: a.pictures.reduce((s, p) => s + p.length, 0) };
}

export const makePlan = (an: Analysis, c: Constraints): PlanResult => plan(an.info, c, an.silences);

function partTags(a: Loaded, base: string, i: number, n: number): FlacTags {
  const drop = /^(TRACKNUMBER|TRACKTOTAL|TOTALTRACKS|TITLE)=/i;
  const title = a.tags.comments.find((c) => /^TITLE=/i.test(c))?.slice(6) ?? base;
  return { vendor: a.tags.vendor, comments: [...a.tags.comments.filter((c) => !drop.test(c)), `TITLE=${title} (Part ${i + 1})`, `TRACKNUMBER=${i + 1}`, `TRACKTOTAL=${n}`] };
}

export function hashPcm(ch: Int32Array[], bits: 16 | 24, ranges: [number, number][]): string {
  const h = new PcmHasher(bits, ch.length); for (const [s, e] of ranges) h.addFrames(ch, s, e); return h.hex();
}

/** Run a lossless option, then PROVE it: decode what we produced and compare PCM SHA-256 with the input. */
export function execute(a: Loaded, an: Analysis, opt: PlanOption, c: Constraints, hooks: Hooks = {}): RunResult {
  if (!opt.lossless || opt.format !== 'flac') throw new AppError('ENGINE_REQUIRED');
  const base = sanitizeName(stripExt(a.name)), cancelled = hooks.isCancelled;
  hooks.onProgress?.(0, 'hash');
  const inputHash = hashPcm(a.ch, a.bits, [[0, a.total]]);
  const t0 = performance.now();
  let encoded: Uint8Array[] = [], bounds: number[] = [0, a.total], passthrough = false;

  if (opt.kind === 'lossless-single') {
    if (a.kind === 'flac' && a.original && a.original.length <= c.maxBytes) { encoded = [a.original]; passthrough = true; }
    else encoded = [encodeFlac({ sampleRate: a.sampleRate, bits: a.bits, ch: a.ch, tags: a.tags, pictures: a.pictures }, { isCancelled: cancelled, onProgress: (r) => hooks.onProgress?.(0.1 + r * 0.7, 'encode') })];
  } else {
    let est = an.info.flacBytesEstimate, attempt = 0;
    for (;;) {
      const sp = planSplit(an.info, est, c.maxBytes, an.silences);
      if (!sp) throw new AppError('SIZE_NOT_REACHABLE');
      bounds = [0, ...sp.splitSamples, a.total];
      const n = bounds.length - 1; encoded = [];
      for (let i = 0; i < n; i++) {
        encoded.push(encodeFlac({ sampleRate: a.sampleRate, bits: a.bits, ch: a.ch, start: bounds[i]!, end: bounds[i + 1]!, tags: partTags(a, base, i, n), pictures: a.pictures },
          { isCancelled: cancelled, onProgress: (r) => hooks.onProgress?.(0.1 + ((i + r) / n) * 0.7, 'encode') }));
      }
      const worst = encoded.reduce((m, b, i) => Math.max(m, b.length / sp.partBytes[i]!), 0);
      if (encoded.every((b) => b.length <= c.maxBytes) || ++attempt >= 3) break;
      est = est * worst * 1.03; // estimate was too optimistic: scale it and re-plan with more/other parts
    }
  }
  // ---- verification: decode the produced bytes, concatenate parts, compare ----
  hooks.onProgress?.(0.85, 'verify');
  const parts = passthrough ? [a] : encoded.map((b) => decodeFlac(b));
  const h = new PcmHasher(a.bits, a.ch.length);
  for (const p of parts) h.addFrames(p.ch, 0, 'totalSamples' in p ? (p as { totalSamples: number }).totalSamples : (p as Loaded).total);
  const outputHash = h.hex();
  const names = encoded.length === 1 ? [`${base}.flac`] : encoded.map((_, i) => `${base} (Part ${i + 1}).flac`);
  const files = uniqueNames(names).map((name, i) => ({ name, bytes: encoded[i]! }));
  const sizesOk = files.every((f) => f.bytes.length <= c.maxBytes);
  const ok = outputHash === inputHash;
  const seconds = (performance.now() - t0) / 1000;
  hooks.onProgress?.(1, 'done');
  return {
    files, passthrough, sizesOk,
    verification: { ok, method: 'pcm-sha256', inputHash, outputHash, lossless: true },
    report: { tool: 'audio-shrinker', createdAt: new Date().toISOString(), input: { name: a.name, bytes: a.sizeBytes, sampleRate: a.sampleRate, bits: a.bits, channels: a.ch.length, durationSec: a.total / a.sampleRate, pcmSha256: inputHash },
      option: { id: opt.id, kind: opt.kind, parts: files.length, splitSamples: bounds.slice(1, -1) }, constraints: c,
      outputs: files.map((f) => ({ name: f.name, bytes: f.bytes.length })), verification: { ok, method: 'pcm-sha256', outputPcmSha256: outputHash, note: 'Outputs were decoded again and their concatenated PCM was hashed.' },
      processingSeconds: Math.round(seconds * 10) / 10, speedXRealtime: Math.round((a.total / a.sampleRate / seconds) * 10) / 10 },
  };
}
