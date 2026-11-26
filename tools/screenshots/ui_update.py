#!/usr/bin/env python3
"""Build docs/images/ui-update.png: the panel before and after the UI update, rendered from the code.

Old = the script at OLD_REF (the last version with the old look), New = the working copy.
Both are loaded on the test harness page (tests/harness) with default settings, the settings
list is opened, and the two panels are placed side by side.

Usage (from the repo root):
    python3 tools/screenshots/ui_update.py [--lang en] [--out docs/images/ui-update.png]
Needs: pip install playwright pillow; playwright install chromium (or set CHROME_PATH).
"""
import argparse, base64, functools, http.server, os, subprocess, sys, tempfile, threading
from playwright.sync_api import sync_playwright
from PIL import Image

OLD_REF = 'v1.4.0'          # v1.5.0 brought the new look
SCRIPT = 'src/Sketchfab-ripper.user.js'
BG = '#16171b'

ap = argparse.ArgumentParser()
ap.add_argument('--lang', default='en', help='panel language of the new panel (the old one has English only)')
ap.add_argument('--out', default='docs/images/ui-update.png')
args = ap.parse_args()

root = subprocess.check_output(['git', 'rev-parse', '--show-toplevel'], text=True).strip()
os.chdir(root)
old_js = subprocess.check_output(['git', 'show', f'{OLD_REF}:{SCRIPT}'], text=True)
new_js = open(SCRIPT, encoding='utf-8').read()

# ====================================================================
# Harness server
# ====================================================================
class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Quiet, directory='tests/harness'))
threading.Thread(target=srv.serve_forever, daemon=True).start()
url = f'http://127.0.0.1:{srv.server_address[1]}/models/04457756416044c5af23f71849232428/embed/'   # a viewer frame URL

launch = {'args': ['--no-sandbox']}
if os.environ.get('CHROME_PATH'): launch['executable_path'] = os.environ['CHROME_PATH']

# ====================================================================
# Panel screenshots
# ====================================================================
def panel(pw, js, path):
    """Load the script on the harness page, open the settings and save the panel as PNG."""
    stub = ("window.unsafeWindow=window; window.GM_info={script:{version:'t'}};"
            "try{sessionStorage.setItem('ripper_reloaded','1');"
            f"localStorage.setItem('ripper_config_v1', JSON.stringify({{LANGUAGE:'{args.lang}'}}))}}catch(e){{}};")
    br = pw.chromium.launch(**launch)
    pg = br.new_page(viewport={'width': 900, 'height': 1100}, device_scale_factor=2, locale=args.lang)
    pg.add_init_script(stub); pg.add_init_script(js)
    pg.goto(url); pg.wait_for_selector('#ripper-panel', timeout=15000)
    pg.add_style_tag(content=f'html,body{{background:{BG} !important}}')   # rounded panel corners
    pg.wait_for_timeout(500)
    pg.locator('#ripper-panel span', has_text='⚙').first.click()
    pg.wait_for_timeout(400)
    pg.locator('#ripper-panel').screenshot(path=path)
    br.close()

# ====================================================================
# Composition
# ====================================================================
def compose(pw, old_png, new_png, out):
    b64 = lambda p: 'data:image/png;base64,' + base64.b64encode(open(p, 'rb').read()).decode()
    w = lambda p: Image.open(p).size[0] // 2   # screenshots are at device scale 2
    label = 'font-size:44px;font-weight:700;color:#ddd'
    html = f"""<!doctype html><html><body style="margin:0;background:{BG};font-family:'DejaVu Sans',Arial,sans-serif;color:#fff">
<div id="c" style="display:inline-block;padding:28px 48px 48px">
 <div style="text-align:center;font-size:64px;font-weight:700;margin-bottom:12px">UI update</div>
 <div style="display:grid;grid-template-columns:auto 110px auto;column-gap:40px;row-gap:24px;align-items:start;justify-items:center">
  <div style="{label}">Old</div><div></div><div style="{label}">New</div>
  <img src="{b64(old_png)}" style="width:{w(old_png)}px">
  <svg style="align-self:center" width="110" height="60" viewBox="0 0 110 60"><path d="M0 30H72" stroke="#2563eb" stroke-width="10"/><path d="M66 6L104 30L66 54Z" fill="#2563eb"/></svg>
  <img src="{b64(new_png)}" style="width:{w(new_png)}px">
 </div></div></body></html>"""
    br = pw.chromium.launch(**launch)
    pg = br.new_page(viewport={'width': 1400, 'height': 1600}, device_scale_factor=2)
    pg.set_content(html); pg.wait_for_timeout(200)
    pg.locator('#c').screenshot(path=out)
    br.close()

with tempfile.TemporaryDirectory() as tmp, sync_playwright() as pw:
    o, n = os.path.join(tmp, 'old.png'), os.path.join(tmp, 'new.png')
    panel(pw, old_js, o)
    panel(pw, new_js, n)
    compose(pw, o, n, args.out)
srv.shutdown()
print(f'wrote {args.out} (old: {OLD_REF}, new: working copy, language: {args.lang})')
