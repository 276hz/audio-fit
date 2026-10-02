export interface Pcm { sampleRate: number; bits: 16 | 24; ch: Int32Array[]; }

export function parseWav(u8: Uint8Array): Pcm {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const tag = (o: number) => String.fromCharCode(u8[o]!, u8[o + 1]!, u8[o + 2]!, u8[o + 3]!);
  if (u8.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('WAV_INVALID');
  let o = 12, fmt: { tag: number; ch: number; sr: number; bits: number } | null = null, data: [number, number] | null = null;
  while (o + 8 <= u8.length) {
    const id = tag(o); let size = dv.getUint32(o + 4, true); const body = o + 8;
    if (id === 'fmt ') fmt = { tag: dv.getUint16(body, true), ch: dv.getUint16(body + 2, true), sr: dv.getUint32(body + 4, true), bits: dv.getUint16(body + 14, true) };
    if (id === 'data') { if (body + size > u8.length) size = u8.length - body; data = [body, size]; break; }
    o = body + size + (size & 1);
  }
  if (!fmt || !data) throw new Error('WAV_INVALID');
  if ((fmt.tag !== 1 && fmt.tag !== 0xfffe) || (fmt.bits !== 16 && fmt.bits !== 24) || fmt.ch < 1 || fmt.ch > 2) throw new Error('WAV_UNSUPPORTED');
  const bps = fmt.bits / 8, n = Math.floor(data[1] / (bps * fmt.ch));
  const ch = Array.from({ length: fmt.ch }, () => new Int32Array(n));
  let p = data[0];
  if (bps === 2 && ((u8.byteOffset + p) & 1) === 0) { // fast path (little-endian hosts: every browser/Node target)
    const v = new Int16Array(u8.buffer, u8.byteOffset + p, n * fmt.ch);
    for (let c = 0; c < fmt.ch; c++) { const o = ch[c]!; for (let i = 0, j = c; i < n; i++, j += fmt.ch) o[i] = v[j]!; }
    return { sampleRate: fmt.sr, bits: 16, ch };
  }
  for (let i = 0; i < n; i++) for (let c = 0; c < fmt.ch; c++) {
    ch[c]![i] = bps === 2 ? (u8[p]! | (u8[p + 1]! << 8)) << 16 >> 16 : (u8[p]! | (u8[p + 1]! << 8) | (u8[p + 2]! << 16)) << 8 >> 8;
    p += bps;
  }
  return { sampleRate: fmt.sr, bits: fmt.bits as 16 | 24, ch };
}
