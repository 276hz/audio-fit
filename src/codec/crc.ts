const T8 = new Uint8Array(256), T16 = new Uint16Array(256);
for (let i = 0; i < 256; i++) {
  let c = i; for (let k = 0; k < 8; k++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 255 : (c << 1) & 255; T8[i] = c;
  let d = i << 8; for (let k = 0; k < 8; k++) d = d & 0x8000 ? ((d << 1) ^ 0x8005) & 0xffff : (d << 1) & 0xffff; T16[i] = d;
}
export function crc8(b: Uint8Array, s = 0, e = b.length): number { let c = 0; for (let i = s; i < e; i++) c = T8[c ^ b[i]!]!; return c; }
export function crc16(b: Uint8Array, s = 0, e = b.length): number { let c = 0; for (let i = s; i < e; i++) c = ((c << 8) & 0xffff) ^ T16[(c >> 8) ^ b[i]!]!; return c; }
const T32 = new Uint32Array(256);
for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1; T32[i] = c >>> 0; }
export function crc32(b: Uint8Array, prev = 0): number { let c = ~prev >>> 0; for (let i = 0; i < b.length; i++) c = T32[(c ^ b[i]!) & 255]! ^ (c >>> 8); return ~c >>> 0; }
