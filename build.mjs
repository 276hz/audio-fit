// Zero-dependency build: strips TypeScript types (Node >= 22.13) and copies static assets into dist/.
// Deliberate stop-gap (see DECISIONS.md): swap for Vite once `npm install` is available.
import { stripTypeScriptTypes } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, statSync, cpSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

const OUT = 'dist';
rmSync(OUT, { recursive: true, force: true }); mkdirSync(OUT, { recursive: true });
const walk = (d) => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });

for (const f of walk('src').filter((x) => x.endsWith('.ts'))) {
  const rel = relative('src', f).replace(/\.ts$/, '.js');
  let js = stripTypeScriptTypes(readFileSync(f, 'utf8'), { mode: 'strip' });
  js = js.replace(/(\bfrom\s+['"])(\.[^'"]+)\.ts(['"])/g, '$1$2.js$3');
  mkdirSync(dirname(join(OUT, 'js', rel)), { recursive: true }); writeFileSync(join(OUT, 'js', rel), js);
}
cpSync('web', OUT, { recursive: true });
cpSync('src/i18n', join(OUT, 'i18n'), { recursive: true }); rmSync(join(OUT, 'js/i18n'), { recursive: true, force: true });
cpSync('src/presets/platforms.json', join(OUT, 'platforms.json'));
cpSync('_headers', join(OUT, '_headers'));

const files = walk(OUT).map((f) => relative(OUT, f)).filter((f) => !['_headers', 'sw.js'].includes(f)).sort();
const id = createHash('sha256').update(files.map((f) => readFileSync(join(OUT, f))).join('')).digest('hex').slice(0, 10);
writeFileSync(join(OUT, 'sw.js'), readFileSync('web-sw.template.js', 'utf8').replace('__BUILD__', id).replace('__FILES__', JSON.stringify(['./', ...files.map((f) => './' + f)])));

let raw = 0, gz = 0;
for (const f of files.filter((f) => f.startsWith('js/') || f.endsWith('.css') || f.endsWith('.html'))) { const b = readFileSync(join(OUT, f)); raw += b.length; gz += gzipSync(b).length; }
console.log(`build ${id}: ${files.length} files; app code ${(raw / 1024).toFixed(1)} KB raw, ${(gz / 1024).toFixed(1)} KB gzip (budget 200 KB gzip)`);
if (gz > 200 * 1024) { console.error('Bundle budget exceeded'); process.exit(1); }
