export class BitWriter {
  buf = new Uint8Array(1 << 16); pos = 0; private cur = 0; private nb = 0;
  private ensure(n: number) { if (this.pos + n > this.buf.length) { const b = new Uint8Array(Math.max(this.buf.length * 2, this.pos + n)); b.set(this.buf); this.buf = b; } }
  /** v unsigned, n <= 32 */
  bits(v: number, n: number): void {
    if (n > 16) { this.bits(Math.floor(v / 65536), n - 16); this.bits(v & 0xffff, 16); return; }
    if (n === 0) return;
    this.ensure(4);
    this.cur = ((this.cur << n) | (v & ((1 << n) - 1))) >>> 0; this.nb += n;
    while (this.nb >= 8) { this.buf[this.pos++] = (this.cur >>> (this.nb - 8)) & 255; this.nb -= 8; }
    this.cur &= (1 << this.nb) - 1;
  }
  signed(v: number, n: number): void { this.bits(v < 0 ? v + 2 ** n : v, n); }
  unary(q: number): void { while (q >= 16) { this.bits(0, 16); q -= 16; } this.bits(1, q + 1); }
  align(): void { if (this.nb) this.bits(0, 8 - this.nb); }
  bytesAligned(): boolean { return this.nb === 0; }
  bytes(b: Uint8Array): void { this.ensure(b.length); this.buf.set(b, this.pos); this.pos += b.length; }
  result(): Uint8Array { return this.buf.subarray(0, this.pos); }
}
