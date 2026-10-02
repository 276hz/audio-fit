import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const rd = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const en = JSON.parse(rd('../src/i18n/en.json')), vi = JSON.parse(rd('../src/i18n/vi.json'));
test('en and vi have identical keys and no empty strings', () => {
  assert.deepEqual(Object.keys(en).sort(), Object.keys(vi).sort());
  for (const d of [en, vi]) for (const [k, v] of Object.entries(d)) assert.ok((v as string).length > 0, k);
});
test('placeholders match between languages', () => {
  const ph = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join();
  for (const k of Object.keys(en)) assert.equal(ph(en[k]), ph(vi[k]), k);
});
test('every key referenced in code and HTML exists', () => {
  const code = rd('../src/app/main.ts') + rd('../src/planner/planner.ts'), html = rd('../web/index.html');
  const keys = new Set<string>([...code.matchAll(/\bt\('([A-Za-z0-9_.]+)'/g)].map((m) => m[1]!), ...(code.match(/reason\.[A-Za-z]+/g) ?? []), ...[...html.matchAll(/data-i18n(?:-aria)?="([^"]+)"/g)].map((m) => m[1]!));
  for (const c of ['EMPTY_FILE','UNSUPPORTED_FORMAT','FILE_CORRUPT','UNSUPPORTED_BITS_OR_CHANNELS','UNSUPPORTED_CHANNELS','OUT_OF_MEMORY','TOO_LARGE','DECODE_FAILED','SIZE_NOT_REACHABLE','ENGINE_REQUIRED','VERIFY_FAILED','NOT_LOADED','READ_FAILED','WORKER_CRASH','ASSET_FAILED','UNEXPECTED']) { keys.add(`err.${c}`); keys.add(`err.${c}.fix`); }
  for (const k of ['low','medium','high']) keys.add(`level.${k}`); for (const k of ['ok','warn','fail']) keys.add(`status.${k}`);
  for (const k of ['reading','analyze','estimate','hash','encode','verify','done']) keys.add(`phase.${k}`);
  const missing = [...keys].filter((k) => !(k in en)); assert.deepEqual(missing, []);
});
