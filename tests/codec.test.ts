import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Sha256, PcmHasher } from '../src/codec/sha256.ts';
import { encodeFlac } from '../src/codec/flac-encode.ts';
import { decodeFlac } from '../src/codec/flac-decode.ts';
import { parseWav } from '../src/codec/wav.ts';
import { crc32 } from '../src/codec/crc.ts';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
let seed = 5; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const SR = 44100;

function synth(n: number, bits: 16 | 24, stereo = true) {
  const amp = bits === 16 ? 12000 : 3_000_000, mk = (f: number) => Int32Array.from({ length: n }, (_, i) => Math.round(Math.sin(i * f) * amp + (rnd() - 0.5) * amp * 0.05));
  const L = mk(0.05); const R = stereo ? mk(0.031) : L;
  L.fill(0, Math.floor(n * 0.4), Math.floor(n * 0.5)); if (stereo) R.fill(0, Math.floor(n * 0.4), Math.floor(n * 0.5));
  return stereo ? [L, R] : [L];
}
const pcmHash = (ch: Int32Array[], bits: 16 | 24) => { const h = new PcmHasher(bits, ch.length); h.addFrames(ch, 0, ch[0]!.length); return h.hex(); };

test('sha256 matches node:crypto (various lengths)', () => {
  for (const len of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000, 100000]) {
    const b = Uint8Array.from({ length: len }, () => Math.floor(rnd() * 256));
    const h = new Sha256(); h.update(b.subarray(0, len >> 1)); h.update(b.subarray(len >> 1));
    assert.equal(h.hex(), createHash('sha256').update(b).digest('hex'), `len ${len}`);
  }
});

test('crc32 known value', () => assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926));

for (const [bits, stereo, n] of [[16, true, 100_000], [24, true, 50_000], [16, false, 30_001], [16, true, 4096], [16, true, 5], [16, true, 1]] as const) {
  test(`own roundtrip ${bits}-bit ${stereo ? 'stereo' : 'mono'} n=${n}`, () => {
    const ch = synth(n, bits, stereo);
    const f = encodeFlac({ sampleRate: SR, bits, ch });
    const d = decodeFlac(f);
    assert.equal(d.totalSamples, n);
    assert.equal(pcmHash(d.ch, bits), pcmHash(ch, bits));
  });
}

test('decoder rejects corruption (CRC) instead of returning garbage', () => {
  const f = encodeFlac({ sampleRate: SR, bits: 16, ch: synth(20000, 16) });
  f[Math.floor(f.length / 2)]! ^= 0x10;
  assert.throws(() => decodeFlac(f));
});

test('start/end slicing is sample-accurate', () => {
  const ch = synth(30000, 16);
  const d = decodeFlac(encodeFlac({ sampleRate: SR, bits: 16, ch, start: 1234, end: 22222 }));
  assert.equal(d.totalSamples, 22222 - 1234);
  assert.deepEqual(Array.from(d.ch[1]!.subarray(0, 50)), Array.from(ch[1]!.subarray(1234, 1284)));
});

test('tags and pictures are carried', () => {
  const d = decodeFlac(encodeFlac({ sampleRate: SR, bits: 16, ch: synth(5000, 16), tags: { vendor: 'x', comments: ['TITLE=Ünï 🎵', 'ARTIST=A'] }, pictures: [new Uint8Array([1, 2, 3, 4])] }));
  assert.deepEqual(d.tags.comments, ['TITLE=Ünï 🎵', 'ARTIST=A']);
  assert.deepEqual(Array.from(d.pictures[0]!), [1, 2, 3, 4]);
});

test('wav parse (16/24-bit)', () => {
  for (const bits of [16, 24] as const) {
    const ch = synth(3000, bits), bps = bits / 8, data = new Uint8Array(3000 * 2 * bps), dv = new DataView(new ArrayBuffer(44 + data.length));
    const w4 = (o: number, s: string) => [...s].forEach((c, i) => dv.setUint8(o + i, c.charCodeAt(0)));
    w4(0, 'RIFF'); dv.setUint32(4, 36 + data.length, true); w4(8, 'WAVE'); w4(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 2, true);
    dv.setUint32(24, SR, true); dv.setUint32(28, SR * 2 * bps, true); dv.setUint16(32, 2 * bps, true); dv.setUint16(34, bits, true); w4(36, 'data'); dv.setUint32(40, data.length, true);
    let p = 44; for (let i = 0; i < 3000; i++) for (let c = 0; c < 2; c++) { const v = ch[c]![i]!; for (let b = 0; b < bps; b++) dv.setUint8(p++, (v >> (8 * b)) & 255); }
    const r = parseWav(new Uint8Array(dv.buffer)); assert.equal(r.bits, bits); assert.equal(pcmHash(r.ch, bits), pcmHash(ch, bits));
  }
});

test('INTEROP: ffmpeg decodes our FLAC bit-exact, and we decode ffmpeg FLAC (all levels) bit-exact', { skip: !hasFfmpeg }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'as-'));
  for (const bits of [16, 24] as const) {
    const ch = synth(300_000, bits), ref = pcmHash(ch, bits);
    const mine = join(dir, `m${bits}.flac`); writeFileSync(mine, encodeFlac({ sampleRate: SR, bits, ch }));
    const fmt = bits === 16 ? 'pcm_s16le' : 'pcm_s24le';
    const viaFfmpeg = execFileSync('ffmpeg', ['-v', 'error', '-i', mine, '-map', '0:a', '-c:a', fmt, '-f', 'hash', '-hash', 'sha256', '-']).toString().trim().replace('SHA256=', '');
    assert.equal(viaFfmpeg, ref, `ffmpeg decode of our ${bits}-bit file`);
    // other direction: raw pcm -> ffmpeg flac at several levels/block sizes -> our decoder
    const raw = join(dir, `r${bits}.raw`); const bps = bits / 8, buf = Buffer.alloc(300_000 * 2 * bps); let p = 0;
    for (let i = 0; i < 300_000; i++) for (let c = 0; c < 2; c++) { const v = ch[c]![i]!; for (let b = 0; b < bps; b++) buf[p++] = (v >> (8 * b)) & 255; }
    writeFileSync(raw, buf);
    for (const [lvl, bsz] of [[0, 4096], [5, 4096], [8, 4096], [12, 4608], [8, 1152]]) {
      const out = join(dir, `f${bits}_${lvl}_${bsz}.flac`);
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', bits === 16 ? 's16le' : 's24le', '-ar', String(SR), '-ac', '2', '-i', raw, '-c:a', 'flac', '-compression_level', String(lvl), '-frame_size', String(bsz), ...(bits === 24 ? ['-sample_fmt', 's32'] : []), out]);
      const d = decodeFlac(new Uint8Array(readFileSync(out)));
      assert.equal(d.bits, bits, `bits level ${lvl}`);
      assert.equal(pcmHash(d.ch, bits), ref, `our decode of ffmpeg -${lvl} ${bsz} ${bits}-bit`);
    }
  }
});
