import { crc32 } from '../codec/crc.ts';
/** Minimal STORE-only ZIP writer (audio is already compressed). Names are UTF-8, flagged per spec. Limited to <4 GB total (no ZIP64). */
export function buildZip(files: { name: string; bytes: Uint8Array }[]): Uint8Array {
  const te = new TextEncoder(), now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const parts: Uint8Array[] = [], central: Uint8Array[] = []; let offset = 0, total = 0;
  for (const f of files) total += f.bytes.length;
  if (total > 0xfff00000 || files.length > 65000) throw new Error('ZIP_TOO_LARGE');
  for (const f of files) {
    const name = te.encode(f.name), crc = crc32(f.bytes);
    const lh = new DataView(new ArrayBuffer(30)); lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);
    lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true); lh.setUint32(14, crc, true); lh.setUint32(18, f.bytes.length, true); lh.setUint32(22, f.bytes.length, true); lh.setUint16(26, name.length, true);
    const ch = new DataView(new ArrayBuffer(46)); ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
    ch.setUint16(12, dosTime, true); ch.setUint16(14, dosDate, true); ch.setUint32(16, crc, true); ch.setUint32(20, f.bytes.length, true); ch.setUint32(24, f.bytes.length, true); ch.setUint16(28, name.length, true); ch.setUint32(42, offset, true);
    parts.push(new Uint8Array(lh.buffer), name, f.bytes); central.push(new Uint8Array(ch.buffer), name);
    offset += 30 + name.length + f.bytes.length;
  }
  const cdSize = central.reduce((a, b) => a + b.length, 0), end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true); end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)], out = new Uint8Array(all.reduce((a, b) => a + b.length, 0)); let p = 0;
  for (const a of all) { out.set(a, p); p += a.length; }
  return out;
}
