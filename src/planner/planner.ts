import { LOSSLESS, type AudioInfo, type Constraints, type PlanOption, type PlanResult, type SilenceCandidate, type Fmt } from './types.ts';

const SAFETY = 0.98; // never plan to land within 2% of the limit; estimates are estimates
const MAX_PARTS = 32;
export const LOSSY_LADDER: { format: Fmt; kbps: number }[] = [
  { format: 'mp3', kbps: 320 },
  { format: 'aac', kbps: 256 },
  { format: 'mp3', kbps: 192 },
  { format: 'opus', kbps: 128 },
];

export const cbrBytes = (kbps: number, sec: number) => Math.round((kbps * 1000 * sec) / 8);
const mid = (s: SilenceCandidate) => Math.floor((s.startSample + s.endSample) / 2);

/** Nearest silence to `ideal` within window; depth/length only break near-ties. Returns the sample index in the middle of it. */
export function snapToSilence(ideal: number, silences: SilenceCandidate[], windowSamples: number): number | null {
  let best: { s: SilenceCandidate; score: number } | null = null;
  for (const s of silences) {
    const dist = Math.abs(mid(s) - ideal);
    if (dist > windowSamples) continue;
    const score = dist - -s.depthDb * 50 - (s.endSample - s.startSample) * 0.01;
    if (!best || score < best.score) best = { s, score };
  }
  return best ? mid(best.s) : null;
}

function lossyReasons(fmt: Fmt, info: AudioInfo, c: Constraints): string[] {
  const r: string[] = [];
  if (!c.allowedFormats.includes(fmt)) r.push('reason.formatNotAllowed');
  if (!c.allowLossy) r.push('reason.lossyNotAllowed');
  if (info.sampleRate < c.minSampleRate) r.push('reason.sampleRateBelowMin');
  return r;
}

/** Smallest number of parts whose every part fits. Bytes are modelled proportional to length; the real run re-checks. */
export function planSplit(info: AudioInfo, losslessTotal: number, maxBytes: number, silences: SilenceCandidate[]) {
  const totalSamples = Math.round(info.durationSec * info.sampleRate);
  const bytesPerSample = losslessTotal / totalSamples;
  for (let n = 2; n <= MAX_PARTS; n++) {
    const cuts: number[] = [];
    for (let k = 1; k < n; k++) {
      const ideal = Math.round((k * totalSamples) / n);
      const snapped = snapToSilence(ideal, silences, Math.round((totalSamples / n) * 0.25));
      cuts.push(snapped ?? ideal); // no silence nearby: exact ideal point (still sample-accurate)
    }
    const bounds = [0, ...cuts, totalSamples];
    const partBytes = bounds.slice(1).map((b, i) => Math.round((b - bounds[i]!) * bytesPerSample));
    if (partBytes.every((b) => b <= maxBytes * SAFETY)) return { splitSamples: cuts, partBytes };
  }
  return null;
}

export function plan(info: AudioInfo, c: Constraints, silences: SilenceCandidate[]): PlanResult {
  const options: PlanOption[] = [];
  const inputBelowMinimum = info.sampleRate < c.minSampleRate || info.bitDepth < c.minBitDepth;
  const lossless = info.flacBytesEstimate;
  const limit = c.maxBytes * SAFETY;
  const losslessFmt = (['flac', 'wav', 'aiff', 'alac'] as Fmt[]).find((f) => c.allowedFormats.includes(f));
  const rawPcm = Math.round(info.durationSec * info.sampleRate * info.channels * (info.bitDepth / 8));
  const inMinReasons = inputBelowMinimum ? ['reason.inputBelowMinimum'] : [];

  // Prefer FLAC when allowed (smallest lossless); WAV/AIFF are raw PCM and never smaller.
  const singleFmt: Fmt | undefined = c.allowedFormats.includes('flac') ? 'flac' : losslessFmt;
  const singleBytes = singleFmt === 'flac' ? lossless : rawPcm;
  const singlePossible = singleFmt !== undefined && singleBytes <= limit;

  if (singleFmt && singlePossible) {
    options.push({ id: 'ls', kind: 'lossless-single', format: singleFmt, parts: 1, splitSamples: [], partBytes: [Math.round(singleBytes)],
      totalBytes: Math.round(singleBytes), lossless: true, validForTarget: !inputBelowMinimum, reasons: inMinReasons });
  } else if (c.allowSplit && c.allowedFormats.includes('flac')) {
    const sp = planSplit(info, lossless, c.maxBytes, silences);
    if (sp) options.push({ id: `sp${sp.partBytes.length}`, kind: 'lossless-split', format: 'flac', parts: sp.partBytes.length,
      splitSamples: sp.splitSamples, partBytes: sp.partBytes, totalBytes: sp.partBytes.reduce((a, b) => a + b, 0),
      lossless: true, validForTarget: !inputBelowMinimum, reasons: ['reason.mustBeSplit', ...inMinReasons] });
  }

  for (const { format, kbps } of LOSSY_LADDER) {
    const bytes = cbrBytes(kbps, info.durationSec);
    const reasons = lossyReasons(format, info, c);
    if (bytes > limit) reasons.push('reason.tooBig');
    options.push({ id: `${format}${kbps}`, kind: 'lossy', format, bitrateKbps: kbps, parts: 1, splitSamples: [], partBytes: [bytes],
      totalBytes: bytes, lossless: false, validForTarget: reasons.length === 0, reasons });
  }

  options.sort((a, b) => Number(b.validForTarget) - Number(a.validForTarget) || Number(b.lossless) - Number(a.lossless) || a.parts - b.parts || a.totalBytes - b.totalBytes);
  return { singleLosslessPossible: singlePossible, inputBelowMinimum, losslessSingleBytes: lossless, options: options.slice(0, 5) };
}
