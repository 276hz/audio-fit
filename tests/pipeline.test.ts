import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAudio, analyze, makePlan, execute, AppError } from '../src/app/pipeline.ts';
import { encodeFlac } from '../src/codec/flac-encode.ts';
import { decodeFlac } from '../src/codec/flac-decode.ts';
import { sanitizeName, uniqueNames } from '../src/util/files.ts';
import { buildZip } from '../src/util/zip.ts';
import type { Constraints } from '../src/planner/types.ts';

const SR = 44100;
let seed = 11; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
function song(sec: number) { // noisy tones with a clean silence in the middle
  const n = SR * sec, mk = (f: number) => Int32Array.from({ length: n }, (_, i) => Math.round(Math.sin(i * f) * 9000 + (rnd() - 0.5) * 6000));
  const L = mk(0.05), R = mk(0.033), a = Math.floor(n * 0.5) - SR, b = Math.floor(n * 0.5) + SR; L.fill(0, a, b); R.fill(0, a, b); return [L, R];
}
const C = (maxBytes: number): Constraints => ({ maxBytes, allowedFormats: ['flac', 'wav', 'aiff'], minSampleRate: 44100, minBitDepth: 16, allowSplit: true, allowLossy: false });
const tags = { vendor: 'x', comments: ['TITLE=Bài hát 🎵', 'ARTIST=Nhạc sĩ', 'TRACKNUMBER=7'] };

test('end-to-end: 60 s song, limit forces split; parts are verified bit-exact; tags renumbered', () => {
  const flac = encodeFlac({ sampleRate: SR, bits: 16, ch: song(60), tags });
  const a = loadAudio('Bài hát: "live"?.flac', flac), an = analyze(a);
  const limit = Math.round(flac.length * 0.62), c = C(limit);
  const p = makePlan(an, c); assert.equal(p.singleLosslessPossible, false);
  const top = p.options[0]!; assert.equal(top.kind, 'lossless-split');
  const r = execute(a, an, top, c);
  assert.equal(r.verification.ok, true); assert.equal(r.sizesOk, true);
  assert.ok(r.files.length >= 2 && r.files.every((f) => f.bytes.length <= limit));
  assert.ok(r.files[0]!.name.endsWith('(Part 1).flac') && !/[:"?]/.test(r.files[0]!.name));
  const d0 = decodeFlac(r.files[0]!.bytes);
  assert.ok(d0.tags.comments.includes('TITLE=Bài hát 🎵 (Part 1)') && d0.tags.comments.includes('TRACKNUMBER=1') && d0.tags.comments.includes('ARTIST=Nhạc sĩ'));
  assert.ok(!d0.tags.comments.includes('TRACKNUMBER=7'));
  const cut = (r.report.option as { splitSamples: number[] }).splitSamples[0]!;
  assert.ok(Math.abs(cut - SR * 30) < SR * 1.1, 'cut inside the 2 s silence at the middle');
});

test('fits already: a FLAC under the limit is passed through untouched', () => {
  const flac = encodeFlac({ sampleRate: SR, bits: 16, ch: song(20), tags });
  const a = loadAudio('a.flac', flac), an = analyze(a), c = C(flac.length * 2);
  const r = execute(a, an, makePlan(an, c).options[0]!, c);
  assert.equal(r.passthrough, true); assert.equal(r.verification.ok, true); assert.deepEqual(r.files[0]!.bytes, flac);
});

test('corrupt, empty, unsupported inputs give coded errors (never a crash)', () => {
  const flac = encodeFlac({ sampleRate: SR, bits: 16, ch: song(10) }); flac[flac.length >> 1]! ^= 1;
  const code = (f: () => unknown) => { try { f(); } catch (e) { return (e as AppError).code; } return 'none'; };
  assert.equal(code(() => loadAudio('x.flac', flac)), 'FILE_CORRUPT');
  assert.equal(code(() => loadAudio('x.flac', new Uint8Array(0))), 'EMPTY_FILE');
  assert.equal(code(() => loadAudio('x.mp3', new Uint8Array([0xff, 0xfb, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]))), 'UNSUPPORTED_FORMAT');
  assert.equal(code(() => loadAudio('x.flac', new Uint8Array([0x66, 0x4c, 0x61, 0x43, 0, 0]))), 'FILE_CORRUPT');
});

test('lossy option cannot be executed by this build (honest error)', () => {
  const a = loadAudio('a.flac', encodeFlac({ sampleRate: SR, bits: 16, ch: song(10) })), an = analyze(a), c = { ...C(1e9), allowLossy: true, allowedFormats: ['mp3' as const] };
  const lossy = makePlan(an, c).options.find((o) => o.kind === 'lossy')!;
  assert.throws(() => execute(a, an, lossy, c), (e: AppError) => e.code === 'ENGINE_REQUIRED');
});

test('cancel hook aborts encoding', () => {
  const a = loadAudio('a.flac', encodeFlac({ sampleRate: SR, bits: 16, ch: song(30) })), an = analyze(a), c = C(1e9);
  assert.throws(() => execute(a, an, makePlan(an, c).options[0]!, { ...c, maxBytes: 10 }, { isCancelled: () => true }), /CANCELLED|SIZE_NOT/);
});

test('analyze surfaces insights: dual mono, wasted bits', () => {
  const m = song(10)[0]!, w = Int32Array.from(m, (v) => v * 256);
  const flac = encodeFlac({ sampleRate: SR, bits: 24, ch: [w, Int32Array.from(w)] });
  const keys = analyze(loadAudio('m.flac', flac)).insights.map((i) => i.key);
  assert.ok(keys.includes('insight.dualMono') && keys.includes('insight.wastedBits'));
});

test('sanitizeName: traversal, reserved, controls, emoji-safe truncation', () => {
  assert.ok(!sanitizeName('../../etc/passwd').includes('/'));
  assert.equal(sanitizeName('CON.flac'), '_CON.flac');
  assert.equal(sanitizeName('a\u0000b\nc'), 'a_b_c');
  assert.equal(sanitizeName('   '), 'audio');
  const long = sanitizeName('🎵'.repeat(300)); assert.equal(Array.from(long).length, 100);
  assert.deepEqual(uniqueNames(['a.flac', 'A.flac', 'b.flac']), ['a.flac', 'A (2).flac', 'b.flac']);
});

test('zip: valid per unzip -t (if available), unicode names', { skip: spawnSync('unzip', ['-v']).status !== 0 }, () => {
  const z = buildZip([{ name: 'Bài hát (Part 1).flac', bytes: new Uint8Array(1000).fill(7) }, { name: 'b.json', bytes: new TextEncoder().encode('{}') }]);
  const f = join(mkdtempSync(join(tmpdir(), 'z-')), 't.zip'); writeFileSync(f, z);
  const r = spawnSync('unzip', ['-t', f]); assert.equal(r.status, 0, r.stdout.toString() + r.stderr.toString());
});
