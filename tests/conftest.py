"""Shared fixtures for the export tests.

Each test loads the userscript on the harness page (tests/harness), feeds mock viewer objects to
the script's hooks (attachbody, drawhookcanvas), clicks GLB or FBX, and reads the saved zip.
Needs: pip install -r tests/requirements.txt; python -m playwright install chromium;
npm install (in tests/). Set CHROME_PATH to use an installed Chrome instead.
"""
import functools, http.server, json, os, struct, subprocess, tempfile, threading
import pytest
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SCRIPT = os.environ.get('RIPPER_SCRIPT') or os.path.join(ROOT, 'src', 'Sketchfab-ripper.user.js')   # RIPPER_SCRIPT: test another copy
JSZIP = os.path.join(HERE, 'node_modules', 'jszip', 'dist', 'jszip.min.js')
EMBED = '/models/04457756416044c5af23f71849232428/embed/'   # viewer frame URL (embed/index.html)


# ====================================================================
# Server and browser (one per test session)
# ====================================================================
class _Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass


@pytest.fixture(scope='session')
def base_url():
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0),
                                          functools.partial(_Quiet, directory=os.path.join(HERE, 'harness')))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f'http://127.0.0.1:{srv.server_address[1]}'
    srv.shutdown()


@pytest.fixture(scope='session')
def browser():
    opts = {'args': ['--no-sandbox']}
    if os.environ.get('CHROME_PATH'):
        opts['executable_path'] = os.environ['CHROME_PATH']
    with sync_playwright() as pw:
        br = pw.chromium.launch(**opts)
        yield br
        br.close()


# ====================================================================
# Ripper page helper
# ====================================================================
class Ripper:
    """One page with the userscript loaded. config: settings saved before the script starts."""

    def __init__(self, browser, base_url, config=None, extra_stub='', path='/index.html', viewport=None):
        self.base = base_url
        self.page = browser.new_page(viewport=viewport or {'width': 1100, 'height': 900})
        self.logs, self.requests = [], []
        self.page.on('console', lambda m: self.logs.append(m.text))
        self.page.on('pageerror', lambda e: self.logs.append('PAGEERROR ' + str(e)))
        self.page.on('request', lambda r: self.requests.append(r.url))
        stub = ("window.unsafeWindow=window; window.GM_info={script:{version:'test'}};"
                "try{sessionStorage.setItem('ripper_reloaded','1');"
                f"localStorage.setItem('ripper_config_v1', {json.dumps(json.dumps(config or {}))})}}catch(e){{}};"
                "window.__saved=[]; window.saveAs=(b,n)=>window.__saved.push(b);" + extra_stub)
        self.page.add_init_script(stub)
        self.page.add_init_script(open(JSZIP, encoding='utf-8').read())
        self.page.add_init_script(open(SCRIPT, encoding='utf-8').read())
        self.page.goto(base_url + path)
        self.page.wait_for_selector('#dlGlbBtn', timeout=15000)

    def scene(self, js, arg=None):
        """Run a scene builder (JS arrow function) in the page; returns its result."""
        out = self.page.evaluate(js, arg)
        self.page.wait_for_timeout(300)
        return out

    def export(self, fmt='glb', timeout_s=20):
        """Click GLB or FBX and return the saved zip: {files, gltf, glb(bytes), alpha(...)}."""
        self.page.evaluate('window.__saved=[]')
        self.page.click('#dlGlbBtn' if fmt == 'glb' else '#dlFbxBtn')
        for _ in range(timeout_s * 10):
            self.page.wait_for_timeout(100)
            if self.page.evaluate('window.__saved.length'):
                break
        res = self.page.evaluate("""async () => {
            if (!window.__saved.length) return null;
            const z = await JSZip.loadAsync(window.__saved[0]); const out = { files: Object.keys(z.files) };
            const g = out.files.find((f) => f.endsWith('.glb'));
            if (g) out.glb = Array.from(await z.files[g].async('uint8array'));
            const f = out.files.find((n) => /_Alpha/.test(n));
            if (f) {
                const bm = await createImageBitmap(await z.files[f].async('blob'));
                const c = document.createElement('canvas'); c.width = bm.width; c.height = bm.height;
                const ctx = c.getContext('2d'); ctx.drawImage(bm, 0, 0);
                const d = ctx.getImageData(0, 0, bm.width, bm.height).data, ci = ((bm.height >> 1) * bm.width + (bm.width >> 1)) * 4;
                out.alpha = { corner: d[3], centre: d[ci + 3] };
            }
            return out; }""")
        assert res is not None, 'no zip saved. Log:\n' + '\n'.join(self.logs[-30:])
        if 'glb' in res:
            res['glb'] = bytes(res['glb'])
            jl = struct.unpack_from('<I', res['glb'], 12)[0]
            res['gltf'] = json.loads(res['glb'][20:20 + jl])
        return res

    def errors(self):
        return [l for l in self.logs if l.startswith('PAGEERROR') or 'export failed' in l]

    def close(self):
        self.page.close()


@pytest.fixture
def ripper(browser, base_url):
    pages = []

    def make(**kw):
        r = Ripper(browser, base_url, **kw)
        pages.append(r)
        return r
    yield make
    for r in pages:
        r.close()


# ====================================================================
# glTF helpers
# ====================================================================
def validate(glb):
    """Khronos glTF validator result for GLB bytes: {errors, warnings, messages}."""
    with tempfile.NamedTemporaryFile(suffix='.glb', delete=False) as f:
        f.write(glb)
    try:
        out = subprocess.check_output(['node', os.path.join(HERE, 'validate.js'), f.name], text=True, cwd=HERE)
    finally:
        os.unlink(f.name)
    return json.loads(out)


def _mat(n):
    if 'matrix' in n:
        m = n['matrix']
        return [[m[c * 4 + r] for c in range(4)] for r in range(4)]
    t = n.get('translation', [0, 0, 0]); q = n.get('rotation', [0, 0, 0, 1]); s = n.get('scale', [1, 1, 1])
    x, y, z, w = q
    R = [[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
         [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
         [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]]
    return [[R[r][0] * s[0], R[r][1] * s[1], R[r][2] * s[2], t[r]] for r in range(3)] + [[0, 0, 0, 1]]


def _mul(a, b):
    return [[sum(a[r][k] * b[k][c] for k in range(4)) for c in range(4)] for r in range(4)]


def world_matrices(g):
    """Node index -> world matrix (4x4 row lists), from the scene roots."""
    out = {}

    def visit(i, parent):
        out[i] = _mul(parent, _mat(g['nodes'][i]))
        for c in g['nodes'][i].get('children', []):
            visit(c, out[i])
    eye = [[1 if r == c else 0 for c in range(4)] for r in range(4)]
    for r in g['scenes'][g.get('scene', 0)]['nodes']:
        visit(r, eye)
    return out


def world_bounds(g):
    """World-space bounds (lo, hi) of all mesh nodes, from the POSITION accessor min/max."""
    W = world_matrices(g)
    lo, hi = [float('inf')] * 3, [float('-inf')] * 3
    for i, n in enumerate(g['nodes']):
        if 'mesh' not in n or i not in W:
            continue
        for pr in g['meshes'][n['mesh']]['primitives']:
            a = g['accessors'][pr['attributes']['POSITION']]
            for c in range(8):
                p = [a['max'][k] if c >> k & 1 else a['min'][k] for k in range(3)] + [1]
                w = [sum(W[i][r][k] * p[k] for k in range(4)) for r in range(3)]
                lo = [min(lo[k], w[k]) for k in range(3)]; hi = [max(hi[k], w[k]) for k in range(3)]
    return lo, hi
