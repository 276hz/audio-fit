const K = new Uint32Array([
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);

/** Incremental SHA-256 (crypto.subtle cannot stream, and PCM can be >100 MB). */
export class Sha256 {
  private h = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
  private buf = new Uint8Array(64);
  private bufLen = 0;
  private total = 0;
  private w = new Uint32Array(64);

  update(data: Uint8Array): this {
    this.total += data.length;
    let i = 0;
    if (this.bufLen) {
      while (i < data.length && this.bufLen < 64) this.buf[this.bufLen++] = data[i++]!;
      if (this.bufLen === 64) { this.block(this.buf, 0); this.bufLen = 0; }
    }
    for (; i + 64 <= data.length; i += 64) this.block(data, i);
    while (i < data.length) this.buf[this.bufLen++] = data[i++]!;
    return this;
  }

  hex(): string {
    const bits = this.total * 8, padLen = (this.bufLen < 56 ? 56 : 120) - this.bufLen;
    const pad = new Uint8Array(padLen + 8); pad[0] = 0x80;
    const dv = new DataView(pad.buffer);
    dv.setUint32(padLen, Math.floor(bits / 2 ** 32)); dv.setUint32(padLen + 4, bits >>> 0);
    const saveTotal = this.total; this.update(pad); this.total = saveTotal;
    return Array.from(this.h, (x) => x.toString(16).padStart(8, '0')).join('');
  }

  private block(d: Uint8Array, o: number): void {
    const w = this.w, h = this.h;
    for (let t = 0; t < 16; t++) w[t] = (d[o + 4 * t]! << 24) | (d[o + 4 * t + 1]! << 16) | (d[o + 4 * t + 2]! << 8) | d[o + 4 * t + 3]!;
    for (let t = 16; t < 64; t++) {
      const a = w[t - 15]!, b = w[t - 2]!;
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      w[t] = (w[t - 16]! + s0 + w[t - 7]! + s1) | 0;
    }
    let a = h[0]!, b = h[1]!, c = h[2]!, dd = h[3]!, e = h[4]!, f = h[5]!, g = h[6]!, hh = h[7]!;
    for (let t = 0; t < 64; t++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[t]! + w[t]!) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const mj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + mj) | 0;
      hh = g; g = f; f = e; e = (dd + t1) | 0; dd = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h[0] = h[0]! + a; h[1] = h[1]! + b; h[2] = h[2]! + c; h[3] = h[3]! + dd; h[4] = h[4]! + e; h[5] = h[5]! + f; h[6] = h[6]! + g; h[7] = h[7]! + hh;
  }
}

/** Hash interleaved little-endian PCM (2 bytes/sample for 16-bit, 3 for 24-bit): identical to `ffmpeg -f hash` over pcm_s16le/pcm_s24le. */
export class PcmHasher {
  private sha = new Sha256();
  private bits: 16 | 24; private channels: number;
  constructor(bits: 16 | 24, channels: number) { this.bits = bits; this.channels = channels; }
  addFrames(ch: Int32Array[], start: number, end: number): void {
    const bps = this.bits / 8, nc = this.channels, CH = 8192;
    for (let s = start; s < end; s += CH) {
      const e = Math.min(end, s + CH), out = new Uint8Array((e - s) * nc * bps);
      let p = 0;
      for (let i = s; i < e; i++) for (let c = 0; c < nc; c++) {
        const v = ch[c]![i]!;
        out[p++] = v & 255; out[p++] = (v >> 8) & 255; if (bps === 3) out[p++] = (v >> 16) & 255;
      }
      this.sha.update(out);
    }
  }
  hex(): string { return this.sha.hex(); }
}
