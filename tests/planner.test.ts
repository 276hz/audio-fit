import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { plan, cbrBytes, planSplit } from '../src/planner/planner.ts';
import type { AudioInfo, Constraints, SilenceCandidate } from '../src/planner/types.ts';

const profile = JSON.parse(readFileSync(new URL('../src/presets/platforms.json', import.meta.url), 'utf8')).profiles[0];
const constraints: Constraints = { ...profile, allowSplit: true };
const SR = 44100;
const dur = 11 * 60 + 42; // 702 s
const info: AudioInfo = { durationSec: dur, sampleRate: SR, bitDepth: 16, channels: 2, format: 'flac',
  sizeBytes: 72_600_000, flacBytesEstimate: 71_900_000 };
// silence around 5:47 (347 s), plus decoys far from the middle
const sil = (t: number, d: number, db = -70): SilenceCandidate => ({ startSample: Math.round(t * SR), endSample: Math.round((t + d) * SR), depthDb: db });
const silences = [sil(120, 0.6), sil(347, 1.4), sil(500, 0.8)];

test('golden: cannot fit in 1 file, splits into 2 near the middle, MP3 320 flagged invalid', () => {
  const r = plan(info, constraints, silences);
  assert.equal(r.singleLosslessPossible, false);
  const top = r.options[0]!;
  assert.equal(top.kind, 'lossless-split');
  assert.equal(top.parts, 2);
  assert.ok(top.partBytes.every((b) => b < 50_000_000));
  assert.ok(top.partBytes.every((b) => b > 33e6 && b < 39e6), `parts ~36MB, got ${top.partBytes}`);
  // cut lands inside the 347–348.4 s silence
  const cut = top.splitSamples[0]!;
  assert.ok(cut >= 347 * SR && cut <= 348.4 * SR);
  const mp3 = r.options.find((o) => o.id === 'mp3320')!;
  assert.equal(mp3.validForTarget, false);
  assert.ok(mp3.reasons.includes('reason.formatNotAllowed'));
  assert.ok(mp3.reasons.includes('reason.lossyNotAllowed'));
  assert.ok(Math.abs(mp3.totalBytes / 1e6 - 28.08) < 0.05);
  assert.equal(r.options.filter((o) => o.validForTarget).length, 1); // only the split is valid
});

test('CBR size formula matches spec numbers', () => {
  assert.ok(Math.abs(cbrBytes(320, dur) / 1e6 - 28.1) < 0.1);
  assert.ok(Math.abs(cbrBytes(256, dur) / 1e6 - 22.5) < 0.4);
});

test('small file fits in a single lossless file', () => {
  const r = plan({ ...info, flacBytesEstimate: 30e6 }, constraints, silences);
  assert.equal(r.singleLosslessPossible, true);
  assert.equal(r.options[0]!.kind, 'lossless-single');
});

test('no silence nearby: falls back to exact sample point, still fits', () => {
  const r = plan(info, constraints, []);
  const top = r.options[0]!;
  assert.equal(top.parts, 2);
  assert.equal(top.splitSamples[0], Math.round((dur * SR) / 2));
});

test('splitting disallowed and lossy disallowed => no valid option, honest result', () => {
  const r = plan(info, { ...constraints, allowSplit: false }, silences);
  assert.equal(r.options.filter((o) => o.validForTarget).length, 0);
});

test('input below platform minimum is never marked valid', () => {
  const r = plan({ ...info, sampleRate: 22050 }, constraints, silences);
  assert.equal(r.inputBelowMinimum, true);
  assert.ok(r.options.every((o) => !o.validForTarget));
});

test('property: for random inputs, parts are contiguous, ordered, cover the whole file and each fits', () => {
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  for (let i = 0; i < 300; i++) {
    const d = 60 + rnd() * 3600;
    const total = Math.round(d * SR);
    const est = 20e6 + rnd() * 400e6;
    const max = 10e6 + rnd() * 60e6;
    const ss = Array.from({ length: Math.floor(rnd() * 8) }, () => {
      const t = rnd() * d;
      return sil(t, 0.2 + rnd() * 2, -40 - rnd() * 40);
    });
    const sp = planSplit({ ...info, durationSec: d, flacBytesEstimate: est }, est, max, ss);
    if (!sp) continue;
    const cuts = sp.splitSamples;
    const b = [0, ...cuts, total];
    for (let k = 1; k < b.length; k++) assert.ok(b[k]! > b[k - 1]!, 'strictly increasing');
    assert.equal(sp.partBytes.length, cuts.length + 1);
    assert.ok(sp.partBytes.every((x) => x <= max));
    assert.ok(Math.abs(sp.partBytes.reduce((a, c) => a + c, 0) - est) <= sp.partBytes.length); // rounding only
  }
});
