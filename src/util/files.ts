/** Safe output file names: no paths, no control chars, no Windows-reserved names, bounded length. */
export function sanitizeName(raw: string, fallback = 'audio'): string {
  let s = raw.normalize('NFC').replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '_').replace(/\.\.+/g, '.').replace(/^[\s.]+|[\s.]+$/g, '');
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(s)) s = '_' + s;
  const chars = Array.from(s); // by code point so emoji are never cut in half
  if (chars.length > 100) s = chars.slice(0, 100).join('').trim();
  return s || fallback;
}
export const stripExt = (n: string) => n.replace(/\.[A-Za-z0-9]{1,5}$/, '');
export function uniqueNames(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((n) => {
    const key = n.toLowerCase(), c = seen.get(key) ?? 0; seen.set(key, c + 1);
    if (!c) return n; const dot = n.lastIndexOf('.'); return dot > 0 ? `${n.slice(0, dot)} (${c + 1})${n.slice(dot)}` : `${n} (${c + 1})`;
  });
}
