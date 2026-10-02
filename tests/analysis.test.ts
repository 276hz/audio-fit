import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { findSilences, isDualMono, wastedBits, effectiveBitDepth, dcOffset, clippedSamples, detectLossyCutoff } from '../src/analysis/analysis.ts';

const SR = 44100;
let seed = 99;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
const noise = (n: number, amp = 0.1) => Float32Array.from({ length: n }, () => gauss() * amp);

/** Windowed-sinc FIR low-pass (Blackman), 511 taps. */
function lowpass(x: Float32Array, fc: number): Float32Array {
  const M = 510, h = new Float64Array(M + 1); let sum = 0;
  for (let n = 0; n <= M; n++) {
    const t = n - M / 2, s = t === 0 ? 2 * fc / SR : Math.sin(2 * Math.PI * fc / SR * t) / (Math.PI * t);
    h[n] = s * (0.42 - 0.5 * Math.cos((2 * Math.PI * n) / M) + 0.08 * Math.cos((4 * Math.PI * n) / M)); sum += h[n]!;
  }
  const y = new Float32Array(x.length);
  for (let i = M; i < x.length; i++) { let a = 0; for (let k = 0; k <= M; k++) a += h[k]! * x[i - k]!; y[i] = a / sum; }
  return y;
}

test('findSilences: finds sample-boundaries of digital silence, ignores short gaps', () => {
  const n = SR * 10, l = noise(n), r = noise(n);
  for (const [a, b] of [[SR * 3, Math.round(SR * 4.4)], [SR * 7, Math.round(SR * 7.1)]]) { l.fill(0, a, b); r.fill(0, a, b); }
  const s = findSilences([l, r], SR);
  assert.equal(s.length, 1); // 0.1 s gap is shorter than minSec
  assert.ok(Math.abs(s[0]!.startSample - SR * 3) <= 441 && Math.abs(s[0]!.endSample - SR * 4.4) <= 441);
  assert.ok(s[0]!.depthDb <= -100);
});

test('findSilences: one channel loud => not silence', () => {
  const l = noise(SR * 2), r = new Float32Array(SR * 2);
  assert.equal(findSilences([l, r], SR).length, 0);
});

test('dual mono is only true for bit-exact equality', () => {
  const a = Int32Array.from({ length: 1000 }, (_, i) => (i * 37) % 2000 - 1000);
  const b = Int32Array.from(a);
  assert.equal(isDualMono(a, b), true);
  b[500]! += 1; assert.equal(isDualMono(a, b), false);
});

test('wasted bits / effective bit depth: 24-bit container holding 16-bit data', () => {
  const x = Int32Array.from({ length: 500 }, (_, i) => ((i * 91) % 60000 - 30000) << 8);
  assert.equal(wastedBits(x), 8);
  assert.equal(effectiveBitDepth(24, x), 16);
  assert.equal(wastedBits(new Int32Array(10)), 0);
});

test('DC offset and clipping', () => {
  const x = new Float32Array(1000).fill(0.02);
  assert.ok(Math.abs(dcOffset(x) - 0.02) < 1e-6);
  const c = new Float32Array(100); c.fill(1, 10, 15); c[50] = 1; // run of 5 counts, lone peak does not
  assert.equal(clippedSamples(c), 5);
});

test('fake lossless: 16 kHz low-passed noise is flagged with a cutoff near 16 kHz', () => {
  const r = detectLossyCutoff(lowpass(noise(SR * 4, 0.3), 16000), SR);
  assert.ok(r.cutoffHz !== null && Math.abs(r.cutoffHz - 16000) < 1200, `cutoff ${r.cutoffHz}`);
  assert.ok(r.confidence === 'high' || r.confidence === 'medium');
});

test('fake lossless: 20 kHz cutoff is also found', () => {
  const r = detectLossyCutoff(lowpass(noise(SR * 4, 0.3), 19500), SR);
  assert.ok(r.cutoffHz !== null && Math.abs(r.cutoffHz - 19500) < 1200, `cutoff ${r.cutoffHz}`);
});

test('full-band noise is NOT flagged', () => {
  const r = detectLossyCutoff(noise(SR * 4, 0.3), SR);
  assert.equal(r.confidence, 'none');
});

test('i18n: every reason key used by the planner exists in en and vi', () => {
  const src = readFileSync(new URL('../src/planner/planner.ts', import.meta.url), 'utf8');
  const keys = [...new Set(src.match(/reason\.[A-Za-z]+/g))];
  for (const f of ['en', 'vi']) {
    const d = JSON.parse(readFileSync(new URL(`../src/i18n/${f}.json`, import.meta.url), 'utf8'));
    for (const k of keys) assert.ok(k in d, `${f} missing ${k}`);
  }
  assert.ok(readdirSync(new URL('../src/i18n', import.meta.url)).length >= 2);
});
