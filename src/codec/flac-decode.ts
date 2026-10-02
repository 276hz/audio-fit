import { crc16 } from './crc.ts';

export interface FlacTags { vendor: string; comments: string[]; }
export interface FlacFile {
  sampleRate: number; channels: number; bits: number; totalSamples: number;
  ch: Int32Array[]; tags: FlacTags; pictures: Uint8Array[]; // raw PICTURE block bodies
}

class BitReader {
  pos = 0; // bit position
  buf: Uint8Array;
  constructor(buf: Uint8Array) { this.buf = buf; }
  bits(n: number): number { // n <= 32, unsigned
    let v = 0;
    while (n > 0) {
      const byte = this.buf[this.pos >> 3];
      if (byte === undefined) throw new Error('FLAC_TRUNCATED');
      const avail = 8 - (this.pos & 7), take = n < avail ? n : avail;
      v = v * (1 << take) + ((byte >> (avail - take)) & ((1 << take) - 1));
      this.pos += take; n -= take;
    }
    return v;
  }
  signed(n: number): number { const v = this.bits(n); return n === 32 ? v | 0 : v >= 2 ** (n - 1) ? v - 2 ** n : v; }
  unary(): number { let q = 0; for (;;) { const byte = this.buf[this.pos >> 3]; if (byte === undefined) throw new Error('FLAC_TRUNCATED'); const bit = (byte >> (7 - (this.pos & 7))) & 1; this.pos++; if (bit) return q; q++; } }
  align() { this.pos = (this.pos + 7) & ~7; }
}

function utf8Num(r: BitReader): number {
  const b0 = r.bits(8);
  if (b0 < 0x80) return b0;
  let n = b0 >= 0xfc ? 5 : b0 >= 0xf8 ? 4 : b0 >= 0xf0 ? 3 : b0 >= 0xe0 ? 2 : 1;
  let v = b0 & (0x3f >> n);
  while (n--) v = v * 64 + (r.bits(8) & 0x3f);
  return v;
}

function residual(r: BitReader, out: Int32Array, order: number, N: number): void {
  const method = r.bits(2); if (method > 1) throw new Error('FLAC_BAD_RESIDUAL');
  const po = r.bits(4), pb = method ? 5 : 4, esc = (1 << pb) - 1;
  let idx = order;
  for (let p = 0; p < 1 << po; p++) {
    const cnt = (N >> po) - (p === 0 ? order : 0);
    if (cnt < 0) throw new Error('FLAC_BAD_RESIDUAL');
    const k = r.bits(pb);
    if (k === esc) { const nb = r.bits(5); for (let i = 0; i < cnt; i++) out[idx++] = nb ? r.signed(nb) : 0; continue; }
    for (let i = 0; i < cnt; i++) {
      const q = r.unary(), u = k ? q * 2 ** k + r.bits(k) : q;
      out[idx++] = u % 2 ? -(u + 1) / 2 : u / 2;
    }
  }
}

function subframe(r: BitReader, N: number, bps: number): Int32Array {
  if (r.bits(1)) throw new Error('FLAC_BAD_SUBFRAME');
  const type = r.bits(6);
  let wasted = 0; if (r.bits(1)) wasted = r.unary() + 1;
  bps -= wasted;
  const out = new Int32Array(N);
  if (type === 0) out.fill(r.signed(bps));
  else if (type === 1) for (let i = 0; i < N; i++) out[i] = r.signed(bps);
  else if (type >= 8 && type <= 12) {
    const o = type - 8; for (let i = 0; i < o; i++) out[i] = r.signed(bps);
    residual(r, out, o, N);
    for (let i = o; i < N; i++) {
      const a = out[i - 1] ?? 0, b = out[i - 2] ?? 0, c = out[i - 3] ?? 0, d = out[i - 4] ?? 0;
      out[i] = out[i]! + (o === 0 ? 0 : o === 1 ? a : o === 2 ? 2 * a - b : o === 3 ? 3 * a - 3 * b + c : 4 * a - 6 * b + 4 * c - d);
    }
  } else if (type >= 32) {
    const o = type - 31; for (let i = 0; i < o; i++) out[i] = r.signed(bps);
    const prec = r.bits(4) + 1; if (prec === 16) throw new Error('FLAC_BAD_SUBFRAME');
    const shift = r.signed(5), co = new Array<number>(o);
    for (let j = 0; j < o; j++) co[j] = r.signed(prec);
    residual(r, out, o, N);
    const div = 2 ** shift;
    for (let i = o; i < N; i++) { let s = 0; for (let j = 0; j < o; j++) s += co[j]! * out[i - 1 - j]!; out[i] = out[i]! + Math.floor(s / div); }
  } else throw new Error('FLAC_BAD_SUBFRAME');
  if (wasted) for (let i = 0; i < N; i++) out[i] = out[i]! * 2 ** wasted;
  return out;
}

const BLK = [0, 192, 576, 1152, 2304, 4608, 0, 0, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768];
const SS = [0, 8, 12, 0, 16, 20, 24, 32];

export function decodeFlac(u8: Uint8Array): FlacFile {
  if (u8.length < 42 || u8[0] !== 0x66 || u8[1] !== 0x4c || u8[2] !== 0x61 || u8[3] !== 0x43) throw new Error('FLAC_INVALID');
  let o = 4, last = false, si: { sr: number; ch: number; bits: number; total: number } | null = null;
  const tags: FlacTags = { vendor: '', comments: [] }, pictures: Uint8Array[] = [];
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  while (!last) {
    if (o + 4 > u8.length) throw new Error('FLAC_TRUNCATED');
    last = (u8[o]! & 0x80) !== 0; const type = u8[o]! & 0x7f, len = (u8[o + 1]! << 16) | (u8[o + 2]! << 8) | u8[o + 3]!; o += 4;
    if (o + len > u8.length) throw new Error('FLAC_TRUNCATED');
    if (type === 0) {
      const hi = dv.getUint32(o + 10); const lo = dv.getUint32(o + 14);
      si = { sr: hi >>> 12, ch: ((hi >>> 9) & 7) + 1, bits: ((hi >>> 4) & 31) + 1, total: (hi & 15) * 2 ** 32 + lo };
    } else if (type === 4) {
      let p = o; const vl = dv.getUint32(p, true); p += 4; tags.vendor = new TextDecoder().decode(u8.subarray(p, p + vl)); p += vl;
      const n = dv.getUint32(p, true); p += 4;
      for (let i = 0; i < n; i++) { const l = dv.getUint32(p, true); p += 4; tags.comments.push(new TextDecoder().decode(u8.subarray(p, p + l))); p += l; }
    } else if (type === 6) pictures.push(u8.slice(o, o + len));
    o += len;
  }
  if (!si) throw new Error('FLAC_INVALID');
  if (si.bits !== 16 && si.bits !== 24) throw new Error('FLAC_UNSUPPORTED');
  const ch = Array.from({ length: si.ch }, () => new Int32Array(si!.total));
  let done = 0;
  while (done < si.total) {
    const fs = o; const r = new BitReader(u8); r.pos = o * 8;
    if (r.bits(14) !== 0x3ffe) throw new Error('FLAC_SYNC_LOST');
    r.bits(1); const blockingVar = r.bits(1); void blockingVar;
    const bc = r.bits(4), sc = r.bits(4), ca = r.bits(4), sz = r.bits(3); r.bits(1);
    utf8Num(r);
    const N = bc === 6 ? r.bits(8) + 1 : bc === 7 ? r.bits(16) + 1 : BLK[bc]!;
    if (!N) throw new Error('FLAC_BAD_HEADER');
    if (sc === 12) r.bits(8); else if (sc === 13 || sc === 14) r.bits(16);
    r.bits(8); // header CRC-8 (frame CRC-16 below covers corruption)
    const bps = sz === 0 ? si.bits : SS[sz]!;
    const nch = ca < 8 ? ca + 1 : 2;
    const subs: Int32Array[] = [];
    for (let c = 0; c < nch; c++) { const extra = (ca === 8 && c === 1) || (ca === 9 && c === 0) || (ca === 10 && c === 1) ? 1 : 0; subs.push(subframe(r, N, bps + extra)); }
    r.align(); const end = r.pos >> 3;
    const crc = (u8[end]! << 8) | u8[end + 1]!;
    if (crc16(u8, fs, end) !== crc) throw new Error('FLAC_CRC');
    o = end + 2;
    const n = Math.min(N, si.total - done);
    if (ca < 8) for (let c = 0; c < nch; c++) ch[c]!.set(subs[c]!.subarray(0, n), done);
    else {
      const a = subs[0]!, b = subs[1]!, L = ch[0]!, R = ch[1]!;
      for (let i = 0; i < n; i++) {
        if (ca === 8) { L[done + i] = a[i]!; R[done + i] = a[i]! - b[i]!; }
        else if (ca === 9) { L[done + i] = a[i]! + b[i]!; R[done + i] = b[i]!; }
        else { const side = b[i]!, mid = (a[i]! * 2) | (side & 1); L[done + i] = (mid + side) >> 1; R[done + i] = (mid - side) >> 1; }
      }
    }
    done += n;
  }
  return { sampleRate: si.sr, channels: si.ch, bits: si.bits, totalSamples: si.total, ch, tags, pictures };
}
