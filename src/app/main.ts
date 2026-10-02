import { loadLang, t, getLang } from './i18n.ts';
import { fmtMB, fmtDur } from './format.ts';
import { plan } from '../planner/planner.ts';
import { buildZip } from '../util/zip.ts';
import type { AudioInfo, Constraints, Fmt, PlanOption, PlanResult, SilenceCandidate } from '../planner/types.ts';

interface AnalysisMsg { info: AudioInfo; silences: SilenceCandidate[]; insights: { key: string; params?: Record<string, string | number> }[]; peaks: Float32Array; tags: string[]; pictureBytes: number; name: string; kind: string }
interface Profile { id: string; name: string; allowedFormats: Fmt[]; minSampleRate: number; minBitDepth: number; maxBytes: number; allowLossy: boolean; source: string; verified: string; note: string }
interface ResultMsg { files: { name: string; bytes: Uint8Array }[]; verification: { ok: boolean; inputHash: string; outputHash: string }; sizesOk: boolean; passthrough: boolean; report: Record<string, unknown> }

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
type Kid = string | Node | null | false;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...kids: Kid[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = String(v); else if (k.startsWith('on')) el.addEventListener(k.slice(2), v as EventListener); else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const k of kids) if (k !== null && k !== false) el.append(k); // strings become text nodes: never parsed as HTML
  return el;
}

const S = {
  file: null as File | null, an: null as AnalysisMsg | null, profiles: [] as Profile[], mode: 'profile' as 'profile' | 'custom',
  profileId: '', plan: null as PlanResult | null, optionId: '' as string, worker: null as Worker | null, running: false,
  urls: [] as string[], result: null as ResultMsg | null,
};
const lang = () => getLang();
const safe = (k: string, fn: () => void) => { try { fn(); } catch (e) { console.error(k, e); } };
const store = { get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* storage may be blocked: fine */ } } };

// ---------- worker plumbing ----------
function newWorker(): Worker {
  S.worker?.terminate();
  const w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  w.onmessage = (e) => onWorker(e.data);
  w.onerror = () => showError('WORKER_CRASH', 'worker error');
  S.worker = w; return w;
}
function onWorker(m: { type: string } & Record<string, unknown>): void {
  if (m.type === 'progress') setProgress(m.ratio as number, m.phase as string);
  else if (m.type === 'analysis') { S.an = m as unknown as AnalysisMsg; S.running = false; hideBusy(); renderAll(); }
  else if (m.type === 'result') { S.running = false; hideBusy(); onResult(m as unknown as ResultMsg); }
  else if (m.type === 'error') { S.running = false; hideBusy(); showError(m.code as string, m.detail as string); }
}

async function onFile(file: File, keep = false): Promise<void> {
  clearResult(); clearError();
  S.file = file; S.an = null; S.plan = null;
  if (!keep) $('stage-name').textContent = file.name;
  renderAll(); showBusy('phase.reading');
  try {
    const buffer = await file.arrayBuffer();
    showBusy('phase.analyze'); newWorker().postMessage({ type: 'analyze', name: file.name, buffer }, [buffer]);
  } catch { hideBusy(); showError('READ_FAILED', 'file.arrayBuffer failed'); }
}

// ---------- constraints ----------
function constraints(): Constraints {
  if (S.mode === 'profile') {
    const p = S.profiles.find((x) => x.id === S.profileId) ?? S.profiles[0]!;
    return { maxBytes: p.maxBytes, allowedFormats: p.allowedFormats, minSampleRate: p.minSampleRate, minBitDepth: p.minBitDepth, allowLossy: p.allowLossy, allowSplit: $<HTMLInputElement>('allow-split').checked };
  }
  const mb = Math.max(0.1, parseFloat($<HTMLInputElement>('c-mb').value.replace(',', '.')) || 50);
  const fmts = Array.from(document.querySelectorAll<HTMLInputElement>('#c-formats input:checked')).map((i) => i.value as Fmt);
  return { maxBytes: Math.round(mb * 1e6), allowedFormats: fmts.length ? fmts : ['flac'], minSampleRate: +$<HTMLSelectElement>('c-sr').value, minBitDepth: +$<HTMLSelectElement>('c-bits').value,
    allowLossy: $<HTMLInputElement>('c-lossy').checked, allowSplit: $<HTMLInputElement>('allow-split').checked };
}
const isRunnable = (o: PlanOption) => o.lossless && o.format === 'flac';

function recompute(): void {
  if (!S.an) return;
  S.plan = plan(S.an.info, constraints(), S.an.silences);
  const runnable = S.plan.options.filter(isRunnable);
  const best = runnable.find((o) => o.validForTarget) ?? runnable[0];
  if (!S.plan.options.some((o) => o.id === S.optionId && isRunnable(o))) S.optionId = best?.id ?? '';
  clearResult(); renderVerdict(); renderOptions(); drawWave();
}

// ---------- rendering ----------
function renderAll(): void {
  $('target').hidden = !S.an; $('fileinfo').hidden = !S.an; $('stage').classList.toggle('loaded', !!S.an);
  if (!S.an) { // nothing analysed yet (or being re-analysed): never leave stale options/buttons on screen
    $('verdict').replaceChildren(); $('options').replaceChildren(); $('run-wrap').hidden = true; $('preview-wrap').hidden = true; drawWave(); return;
  }
  renderInfo(); recompute();
}

function renderInfo(): void {
  const a = S.an!, i = a.info, box = $('fileinfo'); box.replaceChildren();
  const row = (k: string, v: string) => [h('dt', {}, t(k)), h('dd', {}, v)];
  box.append(h('h2', {}, t('info.title')), h('dl', { class: 'facts' },
    ...row('info.format', `${a.kind.toUpperCase()} · ${i.bitDepth}-bit`), ...row('info.rate', `${(i.sampleRate / 1000).toLocaleString(lang())} kHz`), ...row('info.channels', i.channels === 1 ? t('info.mono') : t('info.stereo')),
    ...row('info.duration', fmtDur(i.durationSec)), ...row('info.size', fmtMB(i.sizeBytes, lang())), ...row('info.flacEst', `≈ ${fmtMB(i.flacBytesEstimate, lang())}`)));
  if (a.tags.length) box.append(h('details', { class: 'tags' }, h('summary', {}, t('info.tags', { n: a.tags.length })), h('ul', {}, ...a.tags.map((x) => h('li', {}, x)))));
  const ins = a.insights;
  box.append(h('h3', {}, t('insight.title')), ins.length ? h('ul', { class: 'insights' }, ...ins.map((x) => h('li', {}, t(x.key, { ...x.params, level: x.params?.level ? t(`level.${x.params.level}`) : '' })))) : h('p', { class: 'muted' }, t('insight.none')));
  const src = $<HTMLAudioElement>('preview'); if (S.file) { if (src.dataset.url) URL.revokeObjectURL(src.dataset.url); const u = URL.createObjectURL(S.file); src.dataset.url = u; src.src = u; }
  $('preview-wrap').hidden = false;
}

function row(ok: 'ok' | 'warn' | 'fail', label: string, detail: string): HTMLElement {
  return h('li', { class: `check ${ok}` }, h('span', { class: 'mark', 'aria-hidden': 'true' }, ok === 'ok' ? '✓' : ok === 'warn' ? '!' : '✕'), h('span', { class: 'sr' }, t(`status.${ok}`)), h('span', { class: 'lbl' }, label), h('span', { class: 'det' }, detail));
}

function renderVerdict(): void {
  const box = $('verdict'); box.replaceChildren(); if (!S.an || !S.plan) return;
  const c = constraints(), i = S.an.info, p = S.plan, L = lang();
  const fits = p.singleLosslessPossible;
  const head = p.inputBelowMinimum ? t('verdict.belowMin') : fits ? t('verdict.fits', { size: fmtMB(p.losslessSingleBytes, L), max: fmtMB(c.maxBytes, L) }) : t('verdict.nofit', { size: fmtMB(p.losslessSingleBytes, L), max: fmtMB(c.maxBytes, L) });
  const fmtOk = c.allowedFormats.includes(S.an.kind as Fmt);
  box.append(h('h2', {}, t('verdict.title')), h('p', { class: `headline ${p.inputBelowMinimum || (!fits && !p.options.some((o) => o.validForTarget)) ? 'bad' : fits ? 'good' : 'mixed'}`, role: 'status' }, head),
    h('ul', { class: 'checks' },
      row(fits ? 'ok' : 'fail', t('check.size'), `${fmtMB(p.losslessSingleBytes, L)} / ${fmtMB(c.maxBytes, L)}`),
      row(fmtOk ? 'ok' : c.allowedFormats.includes('flac') ? 'warn' : 'fail', t('check.format'), fmtOk ? S.an.kind.toUpperCase() : t('check.formatConvert')),
      row(i.sampleRate >= c.minSampleRate ? 'ok' : 'fail', t('check.rate'), `${(i.sampleRate / 1000).toLocaleString(L)} kHz` + (c.minSampleRate ? ` ≥ ${(c.minSampleRate / 1000).toLocaleString(L)} kHz` : '')),
      row(i.bitDepth >= c.minBitDepth ? 'ok' : 'fail', t('check.depth'), `${i.bitDepth}` + (c.minBitDepth ? ` ≥ ${c.minBitDepth}` : ''))));
  if (S.mode === 'profile') { const pr = S.profiles.find((x) => x.id === S.profileId); if (pr) box.append(h('p', { class: 'muted small' }, t('profile.note'), ' ', pr.verified.startsWith('not') ? t('profile.unverified') : '')); }
}

function optTitle(o: PlanOption): string {
  if (o.kind === 'lossless-split') return t('opt.split', { n: o.parts });
  if (o.kind === 'lossless-single') return t('opt.single', { fmt: o.format.toUpperCase() });
  return t('opt.lossy', { fmt: o.format.toUpperCase(), kbps: o.bitrateKbps ?? 0 });
}

function renderOptions(): void {
  const box = $('options'); box.replaceChildren(); if (!S.plan) return;
  box.append(h('h2', {}, t('opt.title')));
  const L = lang(), valid = S.plan.options.filter((o) => o.validForTarget), invalid = S.plan.options.filter((o) => !o.validForTarget);
  const card = (o: PlanOption) => {
    const run = isRunnable(o), id = `opt-${o.id}`;
    const radio = h('input', { type: 'radio', name: 'opt', id, value: o.id, disabled: !run, checked: run && o.id === S.optionId, onchange: () => { S.optionId = o.id; drawWave(); updateRunBtn(); } });
    const sizeTxt = o.parts > 1 ? o.partBytes.map((b) => fmtMB(b, L)).join(' + ') : fmtMB(o.totalBytes, L);
    const cutTxt = o.splitSamples.length && S.an ? t('opt.cutAt', { t: o.splitSamples.map((s) => fmtDur(s / S.an!.info.sampleRate)).join(', ') }) : '';
    return h('label', { class: `opt ${o.validForTarget ? 'valid' : 'invalid'}`, for: id }, radio,
      h('span', { class: 'optbody' }, h('span', { class: 'opttitle' }, optTitle(o)), h('span', { class: 'optmeta' }, sizeTxt, ' · ', o.lossless ? t('tag.lossless') : t('tag.lossy'), cutTxt && ` · ${cutTxt}`),
        h('span', { class: `optvalid ${o.validForTarget ? 'good' : 'bad'}` }, o.validForTarget ? t('opt.valid') : t('opt.invalid')),
        o.reasons.length ? h('span', { class: 'optwhy' }, o.reasons.map((r) => t(r)).join(' ')) : null,
        !run ? h('span', { class: 'optwhy' }, t('opt.needsEngine')) : null));
  };
  const group = (list: PlanOption[]) => h('div', { class: 'optlist', role: 'radiogroup', 'aria-label': t('opt.title') }, ...list.map(card));
  if (valid.length) box.append(group(valid));
  if (invalid.length) box.append(h('details', { class: 'more', open: valid.length === 0 }, h('summary', {}, t('opt.hidden', { n: invalid.length })), group(invalid)));
  if (!S.plan.options.some((o) => o.validForTarget)) box.append(h('p', { class: 'callout' }, t('opt.noneValid')));
  updateRunBtn();
}

function updateRunBtn(): void {
  const b = $<HTMLButtonElement>('run'); const o = S.plan?.options.find((x) => x.id === S.optionId);
  b.disabled = !o || S.running; b.textContent = o?.kind === 'lossless-split' ? t('run.split') : t('run.go');
  $('run-wrap').hidden = !S.plan;
}

function drawWave(): void {
  const cv = $<HTMLCanvasElement>('wave'), ctx = cv.getContext('2d')!, dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, hgt = cv.clientHeight; cv.width = Math.round(w * dpr); cv.height = Math.round(hgt * dpr); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, hgt);
  const css = getComputedStyle(document.documentElement), ink = css.getPropertyValue('--wave').trim(), cutc = css.getPropertyValue('--cut').trim();
  const a = S.an; if (!a) return;
  const n = a.peaks.length / 2, mid = hgt / 2;
  ctx.fillStyle = ink;
  for (let x = 0; x < w; x++) { const b = Math.min(n - 1, Math.floor((x / w) * n)); const top = mid - a.peaks[2 * b + 1]! * mid * 0.95, bot = mid - a.peaks[2 * b]! * mid * 0.95; ctx.fillRect(x, top, 1, Math.max(1, bot - top)); }
  const o = S.plan?.options.find((x) => x.id === S.optionId);
  if (o?.splitSamples.length) {
    const total = a.info.durationSec * a.info.sampleRate; ctx.fillStyle = cutc; ctx.strokeStyle = cutc; ctx.lineWidth = 2;
    for (const s of o.splitSamples) { const x = Math.round((s / total) * w); ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, hgt); ctx.stroke(); }
    ctx.font = '600 12px system-ui, sans-serif'; const bounds = [0, ...o.splitSamples, total];
    o.partBytes.forEach((b, i) => { const x0 = (bounds[i]! / total) * w, x1 = (bounds[i + 1]! / total) * w, label = fmtMB(b, lang()); ctx.fillText(label, Math.max(4, (x0 + x1) / 2 - ctx.measureText(label).width / 2), hgt - 6); });
  }
}

// ---------- run / results ----------
function run(): void {
  const o = S.plan?.options.find((x) => x.id === S.optionId); if (!o || !S.worker || S.running) return;
  clearResult(); clearError(); S.running = true; updateRunBtn(); showBusy('phase.encode', true);
  S.worker.postMessage({ type: 'run', option: o, constraints: constraints() });
}
function cancel(): void {
  S.worker?.terminate(); S.worker = null; S.running = false; hideBusy();
  $('live').textContent = t('run.cancelled'); $('status-line').textContent = t('run.cancelled');
  if (S.file) void onFile(S.file, true); // memory was freed by terminate(); re-read quietly so the page stays usable
}
function dl(name: string, bytes: Uint8Array | Blob, type: string): HTMLAnchorElement {
  const u = URL.createObjectURL(bytes instanceof Blob ? bytes : new Blob([bytes], { type })); S.urls.push(u);
  return h('a', { class: 'btn', href: u, download: name }, name);
}
function onResult(r: ResultMsg): void {
  S.result = r; const box = $('result'); box.replaceChildren(); box.hidden = false; updateRunBtn();
  const L = lang(), total = r.files.reduce((s, f) => s + f.bytes.length, 0), orig = S.an!.info.sizeBytes;
  if (!r.verification.ok) { box.append(h('h2', {}, t('result.title')), h('p', { class: 'headline bad', role: 'alert' }, t('result.verifyFail'))); showError('VERIFY_FAILED', `in=${r.verification.inputHash} out=${r.verification.outputHash}`); return; }
  box.append(h('h2', {}, t('result.title')),
    h('p', { class: 'badge good', role: 'status' }, h('span', { 'aria-hidden': 'true' }, '✓ '), t('result.bitexact')),
    h('p', { class: 'muted small' }, t('result.hashnote'), ' ', h('code', {}, r.verification.outputHash.slice(0, 16) + '…')),
    h('p', {}, t('result.sizes', { before: fmtMB(orig, L), after: r.files.length > 1 ? r.files.map((f) => fmtMB(f.bytes.length, L)).join(' + ') : fmtMB(total, L) })));
  if (r.passthrough) box.append(h('p', { class: 'muted' }, t('result.passthrough')));
  if (!r.sizesOk) box.append(h('p', { class: 'callout' }, t('result.oversize')));
  const files = h('ul', { class: 'files' });
  for (const f of r.files) { const u = URL.createObjectURL(new Blob([f.bytes], { type: 'audio/flac' })); S.urls.push(u); files.append(h('li', {}, dl(f.name, new Blob([f.bytes], { type: 'audio/flac' }), 'audio/flac'), h('span', { class: 'muted small' }, fmtMB(f.bytes.length, L)), h('audio', { controls: true, preload: 'none', src: u, 'aria-label': f.name }))); }
  const report = JSON.stringify(r.report, null, 2), repBytes = new TextEncoder().encode(report);
  const actions = h('div', { class: 'actions' });
  if (r.files.length > 1) { const z = buildZip([...r.files, { name: 'verification-report.json', bytes: repBytes }]); actions.append(dl('audio-shrinker.zip', z, 'application/zip')); }
  actions.append(dl('verification-report.json', repBytes, 'application/json'));
  box.append(files, actions); box.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'nearest' });
}
function clearResult(): void { S.urls.forEach((u) => URL.revokeObjectURL(u)); S.urls = []; S.result = null; const b = $('result'); b.hidden = true; b.replaceChildren(); }

// ---------- busy / errors ----------
function showBusy(phaseKey: string, cancellable = false): void { $('busy').hidden = false; $('phase').textContent = t(phaseKey); $<HTMLProgressElement>('prog').removeAttribute('value'); $('cancel').hidden = !cancellable; $('prog-pct').textContent = ''; }
function hideBusy(): void { $('busy').hidden = true; }
const phaseKey: Record<string, string> = { hash: 'phase.hash', encode: 'phase.encode', verify: 'phase.verify', analyze: 'phase.analyze', estimate: 'phase.estimate', done: 'phase.done' };
let t0 = 0, lastLive = 0;
function setProgress(r: number, phase: string): void {
  if (!t0 || r === 0) t0 = performance.now();
  const p = $<HTMLProgressElement>('prog'); p.value = r; $('phase').textContent = t(phaseKey[phase] ?? 'phase.analyze'); $('prog-pct').textContent = `${Math.round(r * 100)}%`;
  if (S.running && r > 0.12 && r < 0.85) { const el = (performance.now() - t0) / 1000, eta = Math.max(0, Math.round((el / r) * (1 - r))); $('eta').textContent = t('run.eta', { s: eta }); }
  if (performance.now() - lastLive > 4000) { lastLive = performance.now(); $('live').textContent = `${t(phaseKey[phase] ?? 'phase.analyze')} ${Math.round(r * 100)}%`; }
}
function clearError(): void { $('error').hidden = true; $('error').replaceChildren(); }
function showError(code: string, detail: string): void {
  const box = $('error'); box.hidden = false; box.replaceChildren(
    h('h2', {}, t('err.title')), h('p', { role: 'alert' }, t(`err.${code}`) === `err.${code}` ? t('err.UNEXPECTED') : t(`err.${code}`)),
    h('p', { class: 'muted' }, t(`err.${code}.fix`) === `err.${code}.fix` ? t('err.UNEXPECTED.fix') : t(`err.${code}.fix`)),
    h('details', {}, h('summary', {}, t('err.details')), h('pre', {}, `${code}\n${detail}`), h('button', { class: 'btn small', type: 'button', onclick: () => void navigator.clipboard?.writeText(`${code}\n${detail}`) }, t('err.copy'))));
  box.scrollIntoView({ block: 'nearest' });
}

// ---------- setup ----------
function setupTarget(): void {
  const sel = $<HTMLSelectElement>('profile'); sel.replaceChildren(...S.profiles.map((p) => h('option', { value: p.id }, `${p.name} (${fmtMB(p.maxBytes, lang())})`)));
  S.profileId = S.profiles[0]?.id ?? '';
  const fm = $('c-formats'); fm.replaceChildren(...(['flac', 'wav', 'aiff', 'mp3', 'aac', 'opus'] as Fmt[]).map((f) => h('label', { class: 'chip' }, h('input', { type: 'checkbox', value: f, checked: ['flac', 'wav', 'aiff'].includes(f) }), f.toUpperCase())));
  const setMode = (m: 'profile' | 'custom') => { S.mode = m; $('mode-profile').hidden = m !== 'profile'; $('mode-custom').hidden = m !== 'custom'; document.querySelectorAll<HTMLButtonElement>('#modes button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === m))); recompute(); };
  document.querySelectorAll<HTMLButtonElement>('#modes button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode as 'profile' | 'custom')));
  sel.addEventListener('change', () => { S.profileId = sel.value; recompute(); });
  document.querySelectorAll('#target input, #target select').forEach((el) => el.addEventListener('change', () => { if (el !== sel) recompute(); }));
  $('c-mb').addEventListener('input', () => recompute());
  document.querySelectorAll<HTMLButtonElement>('#presets button').forEach((b) => b.addEventListener('click', () => { $<HTMLInputElement>('c-mb').value = b.dataset.mb!; recompute(); }));
}

function setupDrop(): void {
  const strip = $('stage'), input = $<HTMLInputElement>('file');
  const pick = () => input.click();
  strip.addEventListener('click', pick); strip.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
  input.addEventListener('change', () => { if (input.files?.[0]) void onFile(input.files[0]); input.value = ''; });
  for (const ev of ['dragenter', 'dragover']) strip.addEventListener(ev, (e) => { e.preventDefault(); strip.classList.add('over'); });
  for (const ev of ['dragleave', 'drop']) strip.addEventListener(ev, (e) => { e.preventDefault(); strip.classList.remove('over'); });
  strip.addEventListener('drop', (e) => { const f = (e as DragEvent).dataTransfer?.files?.[0]; if (f) void onFile(f); });
  window.addEventListener('paste', (e) => { const f = e.clipboardData?.files?.[0]; if (f) void onFile(f); });
}

async function main(): Promise<void> {
  const pref = store.get('lang') ?? (navigator.language.toLowerCase().startsWith('vi') ? 'vi' : 'en');
  await loadLang(pref); $<HTMLSelectElement>('lang').value = pref;
  const theme = store.get('theme'); if (theme) document.documentElement.dataset.theme = theme;
  try { S.profiles = ((await (await fetch('./platforms.json')).json()) as { profiles: Profile[] }).profiles; } catch { S.profiles = []; showError('ASSET_FAILED', 'platforms.json'); }
  setupTarget(); setupDrop();
  $('lang').addEventListener('change', async () => { const l = $<HTMLSelectElement>('lang').value; store.set('lang', l); await loadLang(l); setupTarget(); renderAll(); });
  $('theme').addEventListener('click', () => { const cur = document.documentElement.dataset.theme === 'dark' || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches) ? 'light' : 'dark'; document.documentElement.dataset.theme = cur; store.set('theme', cur); drawWave(); });
  $('run').addEventListener('click', run); $('cancel').addEventListener('click', cancel);
  window.addEventListener('resize', () => safe('resize', drawWave));
  if ('serviceWorker' in navigator && location.protocol.startsWith('http') && !location.search.includes('nosw')) navigator.serviceWorker.register('./sw.js').catch(() => { /* offline cache is optional */ });
  document.documentElement.dataset.ready = '1';
}
void main();
