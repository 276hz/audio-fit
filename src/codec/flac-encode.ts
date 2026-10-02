import { BitWriter } from './bitwriter.ts';
import { crc8, crc16 } from './crc.ts';
import type { FlacTags } from './flac-decode.ts';

export interface EncodeInput { sampleRate: number; bits: 16 | 24; ch: Int32Array[]; start?: number; end?: number; tags?: FlacTags; pictures?: Uint8Array[]; }
export interface EncodeOpts { blockSize?: number; onProgress?: (ratio: number) => void; isCancelled?: () => boolean; }

const BLOCK = 4096;

// ---- residual coding -------------------------------------------------------
interface RicePlan { bits: number; po: number; ks: number[]; method: 0 | 1 }

function planRice(res: Int32Array, order: number, N: number): RicePlan {
  // One pass at the finest partitioning, then merge pairs for coarser orders (avoids re-reading the residual 9 times).
  let maxPo = 0; while (maxPo < 8 && N % (1 << (maxPo + 1)) === 0 && (N >> (maxPo + 1)) > order) maxPo++;
  let parts = 1 << maxPo, sums = new Float64Array(parts), cnts = new Float64Array(parts), idx = order;
  for (let p = 0; p < parts; p++) {
    const cnt = (N >> maxPo) - (p === 0 ? order : 0); let sum = 0;
    for (let i = 0; i < cnt; i++) { const r = res[idx + i]!; sum += r < 0 ? -2 * r - 1 : 2 * r; }
    idx += cnt; sums[p] = sum; cnts[p] = cnt;
  }
  let best: RicePlan | null = null;
  for (let po = maxPo; po >= 0; po--) {
    const ks: number[] = []; let bits = 6, maxk = 0;
    for (let p = 0; p < parts; p++) {
      const cnt = cnts[p]!, sum = sums[p]!, est = sum > cnt ? Math.floor(Math.log2(sum / cnt)) : 0;
      let bk = 0, bb = Infinity;
      for (let k = Math.max(0, est - 2); k <= Math.min(30, est + 2); k++) { const b = cnt * (k + 1) + Math.floor(sum / 2 ** k); if (b < bb) { bb = b; bk = k; } }
      ks.push(bk); bits += 4 + bb; if (bk > maxk) maxk = bk;
    }
    const method: 0 | 1 = maxk > 14 ? 1 : 0;
    bits += method ? parts : 0;
    if (!best || bits < best.bits) best = { bits, po, ks, method };
    if (po > 0) { const ns = new Float64Array(parts / 2), nc = new Float64Array(parts / 2); for (let p = 0; p < parts / 2; p++) { ns[p] = sums[2 * p]! + sums[2 * p + 1]!; nc[p] = cnts[2 * p]! + cnts[2 * p + 1]!; } sums = ns; cnts = nc; parts /= 2; }
  }
  return best!;
}

function writeResidual(w: BitWriter, res: Int32Array, order: number, N: number, rp: RicePlan): void {
  w.bits(rp.method, 2); w.bits(rp.po, 4);
  const parts = 1 << rp.po; let idx = order;
  for (let p = 0; p < parts; p++) {
    const cnt = (N >> rp.po) - (p === 0 ? order : 0), k = rp.ks[p]!;
    w.bits(k, rp.method ? 5 : 4);
    for (let i = 0; i < cnt; i++) {
      const r = res[idx + i]!, u = r < 0 ? -2 * r - 1 : 2 * r;
      const q = Math.floor(u / 2 ** k);
      w.unary(q);
      if (k) w.bits(u - q * 2 ** k, k);
    }
    idx += cnt;
  }
}

// ---- predictors ------------------------------------------------------------
function fixedResidual(x: Int32Array, order: number, out: Int32Array): void {
  const n = x.length;
  for (let i = order; i < n; i++) {
    out[i] = order === 0 ? x[i]! : order === 1 ? x[i]! - x[i - 1]! : order === 2 ? x[i]! - 2 * x[i - 1]! + x[i - 2]!
      : order === 3 ? x[i]! - 3 * x[i - 1]! + 3 * x[i - 2]! - x[i - 3]! : x[i]! - 4 * x[i - 1]! + 6 * x[i - 2]! - 4 * x[i - 3]! + x[i - 4]!;
  }
}

function lpcCoefs(x: Int32Array, maxOrder: number): Float64Array[] | null {
  const n = x.length, w = new Float64Array(n);
  for (let i = 0; i < n; i++) { const t = (2 * i) / (n - 1) - 1; w[i] = x[i]! * (1 - t * t); } // Welch window
  const r = new Float64Array(maxOrder + 1);
  for (let l = 0; l <= maxOrder; l++) { let s = 0; for (let i = l; i < n; i++) s += w[i]! * w[i - l]!; r[l] = s; }
  if (r[0]! <= 0) return null;
  r[0] = r[0]! * (1 + 1e-9);
  const sets: Float64Array[] = []; let a = new Float64Array(0), e = r[0]!;
  for (let i = 0; i < maxOrder; i++) {
    let acc = r[i + 1]!; for (let j = 0; j < i; j++) acc -= a[j]! * r[i - j]!;
    const k = acc / e, na = new Float64Array(i + 1);
    for (let j = 0; j < i; j++) na[j] = a[j]! - k * a[i - 1 - j]!;
    na[i] = k; a = na; e *= 1 - k * k; if (e <= 0) break;
    sets.push(a);
  }
  return sets; // sets[o-1] = coefficients of order o
}

interface Quant { co: Int32Array; shift: number; prec: number }
function quantize(a: Float64Array, prec: number): Quant | null {
  let mx = 0; for (const c of a) mx = Math.max(mx, Math.abs(c));
  if (!(mx > 0) || !isFinite(mx)) return null;
  const lim = 2 ** (prec - 1) - 1;
  let shift = Math.min(15, prec - 1 - Math.max(0, Math.ceil(Math.log2(mx)))); if (shift < 0) return null;
  while (shift > 0 && Math.round(mx * 2 ** shift) > lim) shift--;
  const co = new Int32Array(a.length); let err = 0;
  for (let j = 0; j < a.length; j++) { err += a[j]! * 2 ** shift; const q = Math.max(-lim - 1, Math.min(lim, Math.round(err))); co[j] = q; err -= q; }
  return { co, shift, prec };
}

function lpcResidual(x: Int32Array, q: Quant, out: Int32Array): void {
  const o = q.co.length, div = 2 ** q.shift, n = x.length;
  for (let i = o; i < n; i++) { let s = 0; for (let j = 0; j < o; j++) s += q.co[j]! * x[i - 1 - j]!; out[i] = x[i]! - Math.floor(s / div); }
}

// ---- subframe --------------------------------------------------------------
interface Sub { bits: number; write(w: BitWriter): void }

function bestSubframe(x: Int32Array, bps: number): Sub {
  const N = x.length;
  let allSame = true; for (let i = 1; i < N; i++) if (x[i] !== x[0]) { allSame = false; break; }
  if (allSame) return { bits: 8 + bps, write: (w) => { w.bits(0, 8); w.signed(x[0]!, bps); } };
  let best: Sub = { bits: 8 + N * bps, write: (w) => { w.bits(2, 8); for (let i = 0; i < N; i++) w.signed(x[i]!, bps); } };
  const res = new Int32Array(N);
  // cheap pre-selection: the fixed order with the smallest sum|residual| is the only one worth a full Rice plan
  let bo = 0, bsum = Infinity;
  for (let o = 0; o <= 4 && o < N; o++) { fixedResidual(x, o, res); let sm = 0; for (let i = o; i < N; i++) sm += Math.abs(res[i]!); if (sm < bsum) { bsum = sm; bo = o; } }
  for (const o of [bo]) {
    fixedResidual(x, o, res); const rp = planRice(res, o, N), bits = 8 + o * bps + rp.bits;
    if (bits < best.bits) { const copy = Int32Array.from(res); best = { bits, write: (w) => { w.bits(0x10 | (o << 1), 8) /* type 8+o: 001000+o */; for (let i = 0; i < o; i++) w.signed(x[i]!, bps); writeResidual(w, copy, o, N, rp); } }; }
  }
  if (N >= 64) {
    const sets = lpcCoefs(x, 12);
    if (sets) for (const o of [8, 12]) {
      const a = sets[o - 1]; if (!a) continue;
      const q = quantize(a, 15); if (!q) continue;
      lpcResidual(x, q, res); const rp = planRice(res, o, N), bits = 8 + o * bps + 9 + o * q.prec + rp.bits;
      if (bits < best.bits) {
        const copy = Int32Array.from(res);
        best = { bits, write: (w) => {
          w.bits(((32 + o - 1) << 1) & 0xff, 8); for (let i = 0; i < o; i++) w.signed(x[i]!, bps);
          w.bits(q.prec - 1, 4); w.signed(q.shift, 5); for (let j = 0; j < o; j++) w.signed(q.co[j]!, q.prec);
          writeResidual(w, copy, o, N, rp);
        } };
      }
    }
  }
  return best;
}

/** FLAC's UTF-8-style variable-length number (frame index). */
function utf8(n: number): number[] {
  if (n < 0x80) return [n];
  const len = n < 0x800 ? 2 : n < 0x10000 ? 3 : n < 0x200000 ? 4 : n < 0x4000000 ? 5 : 6;
  const out: number[] = [];
  for (let i = len - 1; i > 0; i--) { out.unshift(0x80 | (n % 64)); n = Math.floor(n / 64); }
  out.unshift(((0xff << (8 - len)) & 0xff) | n);
  return out;
}

// ---- stream ----------------------------------------------------------------
export function encodeFlac(inp: EncodeInput, opts: EncodeOpts = {}): Uint8Array {
  const start = inp.start ?? 0, end = inp.end ?? inp.ch[0]!.length, total = end - start, nch = inp.ch.length;
  if (nch < 1 || nch > 2) throw new Error('FLAC_CHANNELS');
  const bs = opts.blockSize ?? BLOCK, bps = inp.bits;
  const w = new BitWriter();
  w.bytes(new Uint8Array([0x66, 0x4c, 0x61, 0x43]));
  const meta = metaBlocks(inp, total, bs);
  w.bytes(meta.head); const siPos = 8; // STREAMINFO body starts at byte 8
  let minF = Infinity, maxF = 0;
  const frames = Math.ceil(total / bs);
  for (let f = 0; f < frames; f++) {
    if (opts.isCancelled?.()) throw new Error('CANCELLED');
    const s = start + f * bs, e = Math.min(end, s + bs), N = e - s;
    const chans = inp.ch.map((c) => c.subarray(s, e));
    let assign = nch - 1, subs: Int32Array[] = chans, extra = [0, 0];
    if (nch === 2) {
      const L = chans[0]!, R = chans[1]!, M = new Int32Array(N), S = new Int32Array(N);
      for (let i = 0; i < N; i++) { M[i] = (L[i]! + R[i]!) >> 1; S[i] = L[i]! - R[i]!; }
      const cost = (x: Int32Array) => { let c = 0; for (let i = 2; i < N; i++) c += Math.abs(x[i]! - 2 * x[i - 1]! + x[i - 2]!); return c; };
      const cL = cost(L), cR = cost(R), cM = cost(M), cS = cost(S);
      const opt = [[cL + cR, 1, 0], [cL + cS, 8, 1], [cS + cR, 9, 0], [cM + cS, 10, 1]].sort((a, b) => a[0]! - b[0]!)[0]!;
      assign = opt[1]!;
      subs = assign === 1 ? [L, R] : assign === 8 ? [L, S] : assign === 9 ? [S, R] : [M, S];
      extra = assign === 8 ? [0, 1] : assign === 9 ? [1, 0] : assign === 10 ? [0, 1] : [0, 0];
      if (assign === 1) assign = 1; // independent: code = nch-1 = 1
    }
    const fw = new BitWriter();
    fw.bits(0xfff8, 16);
    fw.bits(N === bs && bs === 4096 ? 12 : 7, 4); fw.bits(0, 4); fw.bits(assign, 4); fw.bits(bps === 16 ? 4 : 6, 3); fw.bits(0, 1);
    for (const b of utf8(f)) fw.bits(b, 8);
    if (!(N === bs && bs === 4096)) fw.bits(N - 1, 16);
    fw.bits(crc8(fw.result()), 8);
    for (let c = 0; c < subs.length; c++) { const sub = bestSubframe(subs[c]!, bps + extra[c]!); sub.write(fw); }
    fw.align(); fw.bits(crc16(fw.result()), 16);
    const fb = fw.result(); minF = Math.min(minF, fb.length); maxF = Math.max(maxF, fb.length);
    w.bytes(fb);
    if (f % 64 === 0) opts.onProgress?.(f / frames);
  }
  const out = w.result();
  // patch STREAMINFO: min/max blocksize, min/max framesize
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  dv.setUint16(siPos, Math.min(bs, total) || bs); dv.setUint16(siPos + 2, bs);
  const mn = isFinite(minF) ? minF : 0;
  out[siPos + 4] = (mn >> 16) & 255; out[siPos + 5] = (mn >> 8) & 255; out[siPos + 6] = mn & 255;
  out[siPos + 7] = (maxF >> 16) & 255; out[siPos + 8] = (maxF >> 8) & 255; out[siPos + 9] = maxF & 255;
  opts.onProgress?.(1);
  return out.slice();
}

function metaBlocks(inp: EncodeInput, total: number, bs: number): { head: Uint8Array } {
  const blocks: { type: number; body: Uint8Array }[] = [];
  const si = new Uint8Array(34), dv = new DataView(si.buffer);
  dv.setUint16(0, Math.min(bs, total) || bs); dv.setUint16(2, bs);
  const hi = ((inp.sampleRate << 12) | ((inp.ch.length - 1) << 9) | ((inp.bits - 1) << 4) | (Math.floor(total / 2 ** 32) & 15)) >>> 0;
  dv.setUint32(10, hi); dv.setUint32(14, total >>> 0); // MD5 left as zeros = "not computed" (allowed by spec)
  blocks.push({ type: 0, body: si });
  const te = new TextEncoder(), vendor = te.encode('audio-shrinker'), cs = (inp.tags?.comments ?? []).map((c) => te.encode(c));
  if (cs.length) {
    const body = new Uint8Array(8 + vendor.length + cs.reduce((a, c) => a + 4 + c.length, 0)), d = new DataView(body.buffer);
    let p = 0; d.setUint32(p, vendor.length, true); p += 4; body.set(vendor, p); p += vendor.length; d.setUint32(p, cs.length, true); p += 4;
    for (const c of cs) { d.setUint32(p, c.length, true); p += 4; body.set(c, p); p += c.length; }
    blocks.push({ type: 4, body });
  }
  for (const pic of inp.pictures ?? []) blocks.push({ type: 6, body: pic });
  const out: number[] = [];
  blocks.forEach((b, i) => { const last = i === blocks.length - 1; out.push((last ? 0x80 : 0) | b.type, (b.body.length >> 16) & 255, (b.body.length >> 8) & 255, b.body.length & 255); });
  const head = new Uint8Array(blocks.reduce((a, b) => a + 4 + b.body.length, 0)); let p = 0;
  blocks.forEach((b, i) => { head.set(out.slice(i * 4, i * 4 + 4), p); p += 4; head.set(b.body, p); p += b.body.length; });
  return { head };
}
