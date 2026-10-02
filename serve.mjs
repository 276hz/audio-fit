// Tiny static server that APPLIES dist/_headers, so CSP/COOP/COEP are tested exactly as deployed. Usage: node serve.mjs [port]
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
const port = +(process.argv[2] ?? 4173), root = 'dist';
const rules = []; let cur = null;
for (const line of readFileSync(join(root, '_headers'), 'utf8').split('\n')) { if (!line.trim()) continue; if (!/^\s/.test(line)) { cur = { path: line.trim(), h: {} }; rules.push(cur); } else { const i = line.indexOf(':'); cur.h[line.slice(0, i).trim()] = line.slice(i + 1).trim(); } }
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain' };
createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname); if (p.endsWith('/')) p += 'index.html';
  const f = normalize(join(root, p)); if (!f.startsWith(root) || !existsSync(f) || statSync(f).isDirectory()) { res.writeHead(404); return res.end('not found'); }
  const h = { 'Content-Type': types[extname(f)] ?? 'application/octet-stream' };
  for (const r of rules) if (r.path === '/*' || r.path === p) Object.assign(h, r.h);
  res.writeHead(200, h); res.end(readFileSync(f));
}).listen(port, () => console.log(`http://localhost:${port}`));
