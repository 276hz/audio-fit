"""Edge cases in a real browser. Server must be running on :4173."""
import os, subprocess
from playwright.sync_api import sync_playwright
BASE='http://localhost:4173/'
ok=True
def check(name, cond, extra=''):
    global ok; ok &= bool(cond); print(('PASS ' if cond else 'FAIL ')+name, extra)

# fixtures
os.makedirs('/tmp/e2e/edge', exist_ok=True)
subprocess.run(['ffmpeg','-v','error','-y','-ss','100','-t','20','-i','/home/claude/spike/golden.wav','-c:a','flac','/tmp/e2e/edge/Bài hát 🎵 [live].flac'],check=True)
subprocess.run(['ffmpeg','-v','error','-y','-f','lavfi','-i','sine=d=2','-c:a','libmp3lame','/tmp/e2e/edge/song.mp3'],check=True)
open('/tmp/e2e/edge/empty.flac','wb').close()
d=bytearray(open('/tmp/e2e/edge/Bài hát 🎵 [live].flac','rb').read()); d[len(d)//2]^=0x20; open('/tmp/e2e/edge/corrupt.flac','wb').write(d)

with sync_playwright() as p:
    b=p.chromium.launch(); ctx=b.new_context(locale='en-US',accept_downloads=True); page=ctx.new_page(); logs=[]
    page.on('pageerror',lambda e:logs.append(str(e))); page.on('console',lambda m: logs.append(m.text) if m.type=='error' else None)
    page.goto(BASE+'?nosw'); page.wait_for_selector('html[data-ready="1"]')
    def feed(path, err=True):
        page.set_input_files('#file', path)
        page.wait_for_selector('#error:not([hidden])' if err else '#fileinfo:not([hidden])', timeout=60000)
    for f,code in (('empty.flac','empty'),('song.mp3','only reads FLAC and WAV'),('corrupt.flac','damaged')):
        feed(f'/tmp/e2e/edge/{f}'); txt=page.inner_text('#error')
        check(f'error for {f}', code in txt and 'Technical details' in txt, '→ '+txt.replace('\n',' | ')[:110])
        page.evaluate("document.getElementById('error').hidden=true")
    # unicode/emoji name + filename sanitising in output
    feed('/tmp/e2e/edge/Bài hát 🎵 [live].flac', err=False)
    page.click('#modes button[data-mode=custom]'); page.fill('#c-mb','1.5'); page.wait_for_timeout(300)
    page.click('#run'); page.wait_for_selector('#result .badge.good', timeout=120000)
    names=page.eval_on_selector_all('#result .files a','els=>els.map(e=>e.download)'); check('unicode names kept, safe', all('Bài hát 🎵' in n for n in names), str(names))
    # cancel mid-run on a big file: terminate must be instant and page must recover
    page.set_input_files('#file','/home/claude/spike/golden.flac'); page.wait_for_selector('#fileinfo:not([hidden])',timeout=180000)
    page.click('#modes button[data-mode=custom]'); page.fill('#c-mb','50'); page.wait_for_timeout(300)
    page.click('#run'); page.wait_for_selector('#cancel:not([hidden])'); page.wait_for_timeout(4000)
    import time; t=time.time(); page.click('#cancel'); page.wait_for_selector('#busy:not([hidden])',timeout=3000)  # re-analysis starts
    check('cancel responded <1s', time.time()-t<1.0, f'{time.time()-t:.2f}s')
    check('stale UI cleared during re-analysis', page.locator('#options .opt').count()==0 and page.is_hidden('#run-wrap'))
    page.wait_for_selector('#run:not([disabled])',timeout=180000); check('page usable after cancel (re-analysed)', page.is_enabled('#run'))
    check('no JS errors', not logs, str(logs)[:200]); b.close()

    # offline: service worker caches the shell
    b=p.chromium.launch(); ctx=b.new_context(); page=ctx.new_page(); page.goto(BASE); page.wait_for_selector('html[data-ready="1"]')
    page.wait_for_function("navigator.serviceWorker.ready.then(()=>true)"); page.wait_for_timeout(1500); page.reload(); page.wait_for_selector('html[data-ready="1"]')
    check('SW controls page', page.evaluate('!!navigator.serviceWorker.controller'))
    ctx.set_offline(True); page.reload(); page.wait_for_selector('html[data-ready="1"]',timeout=15000)
    check('app loads offline', 'Audio Fit' in page.title()); b.close()
print('ALL PASS' if ok else 'SOME FAILED'); raise SystemExit(0 if ok else 1)
