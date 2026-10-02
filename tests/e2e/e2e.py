"""Browser e2e (Chromium via Playwright). Serves dist/ with the real _headers (CSP/COOP/COEP) and checks:
upload -> analyse -> impossible-in-one-file verdict -> split -> bit-exact badge -> ZIP download -> independent ffmpeg hash check.
Usage: python3 tests/e2e/e2e.py input.flac LIMIT_MB   (server must be running on :4173)"""
import sys, subprocess, zipfile, os, re, hashlib, json
from playwright.sync_api import sync_playwright

src, limit = sys.argv[1], sys.argv[2]
shots = os.environ.get('SHOTS', '/tmp/e2e')
def ff_hash(args):
    out = subprocess.run(['ffmpeg','-v','error',*args,'-map','0:a','-c:a','pcm_s16le','-f','hash','-hash','sha256','-'],capture_output=True,text=True).stdout.strip()
    return out.replace('SHA256=','')

with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={'width':1100,'height':900}, accept_downloads=True, locale='en-US')
    page = ctx.new_page()
    problems, reqs = [], []
    page.on('console', lambda m: problems.append(f'console.{m.type}: {m.text}') if m.type in ('error','warning') else None)
    page.on('pageerror', lambda e: problems.append(f'pageerror: {e}'))
    page.on('request', lambda r: reqs.append(r.url))
    page.goto('http://localhost:4173/?nosw'); page.wait_for_selector('html[data-ready="1"]')
    print('crossOriginIsolated =', page.evaluate('crossOriginIsolated'))
    page.screenshot(path=f'{shots}/01-empty.png')
    page.set_input_files('#file', src)
    page.wait_for_selector('#fileinfo:not([hidden])', timeout=180000)
    print('facts:', page.inner_text('#fileinfo .facts').replace('\n',' | '))
    print('insights:', page.inner_text('#fileinfo .insights, #fileinfo p.muted').replace('\n',' / ')[:200])
    page.click('#modes button[data-mode=custom]'); page.fill('#c-mb', limit)
    page.wait_for_timeout(300)
    print('verdict:', page.inner_text('#verdict .headline'))
    print('checks:', page.inner_text('#verdict .checks').replace('\n',' | '))
    opts = page.eval_on_selector_all('#options .opt', 'els => els.map(e => e.innerText.replace(/\\n/g," · "))')
    for o in opts: print('  option:', o)
    page.screenshot(path=f'{shots}/02-plan.png', full_page=True)
    page.click('#run')
    page.wait_for_selector('#busy:not([hidden])', timeout=5000)
    page.wait_for_selector('#result .badge.good', timeout=600000)
    print('result:', page.inner_text('#result').replace('\n',' | ')[:300])
    page.screenshot(path=f'{shots}/03-result.png', full_page=True)
    with page.expect_download() as d: page.click('#result .actions a:has-text("zip")')
    zpath = f'{shots}/out.zip'; d.value.save_as(zpath)
    names = zipfile.ZipFile(zpath).namelist(); print('zip:', names)
    zipfile.ZipFile(zpath).extractall(f'{shots}/out')
    parts = sorted(n for n in names if n.endswith('.flac'))
    lst = f'{shots}/out/list.txt'; open(lst,'w').write(''.join(f"file '{os.path.abspath(f'{shots}/out/{n}')}'\n" for n in parts))
    orig = ff_hash(['-i', src]); joined = ff_hash(['-f','concat','-safe','0','-i', lst])
    print('INDEPENDENT ffmpeg: original', orig[:16], 'joined', joined[:16], 'MATCH' if orig == joined else 'MISMATCH')
    rep = json.load(open(f'{shots}/out/verification-report.json')); print('report ok:', rep['verification']['ok'], 'speed x', rep['speedXRealtime'])
    ext = [u for u in reqs if not u.startswith('http://localhost:4173/') and not u.startswith('blob:') and not u.startswith('data:')]
    print('external requests:', ext or 'none'); print('problems:', problems or 'none')
    b.close()
    sys.exit(0 if orig == joined and not ext and not problems else 1)
