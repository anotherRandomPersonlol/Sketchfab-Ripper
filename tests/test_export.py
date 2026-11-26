"""Export tests on mock viewer data. Run from the repo root: python -m pytest tests"""
import json
import pytest
from conftest import validate, world_bounds

I = '[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]'

# A mesh builder shared by the scenes: mk(positions, indices, parent, extra) -> mock viewer geometry.
MK = f"""const I={I};
  const mk = (v, idx, parent, extra) => Object.assign({{ _name:null, matrix:I, _parents:[parent],
    _attributes:{{ Vertex:{{_elements:new Float32Array(v)}}, Normal:{{_elements:new Float32Array(v.length).map((_, i) => i % 3 === 2 ? 1 : 0)}} }},
    _primitives:[{{mode:4, indices:{{_elements:new Uint16Array(idx)}}}}] }}, extra || {{}});
  window._anyAnchorsMatched = true;"""


def ok(res, r):
    """Common checks: no page errors, GLB passes the validator without errors."""
    assert not r.errors(), r.errors()
    v = validate(res['glb'])
    assert v['errors'] == 0, v['messages']
    return v


# ====================================================================
# Basic export (#18 Anatomy: unnamed mesh, triangle strip, hotspot quad)
# ====================================================================
STRIP_SCENE = f"""() => {{ {MK}
  const chain = (names) => {{ let top=null; for (let k=names.length-1;k>=0;k--) top={{_name:names[k], matrix:I, _parents: top?[top]:[]}}; return top; }};
  const v=[], n=[], strip=[];
  for (let j=0;j<20;j++) for (let i=0;i<20;i++){{ v.push(i*0.1, j*0.1, Math.sin(i*0.3+j*0.2)*0.2); n.push(0,0,1); }}
  for (let j=0;j<19;j++){{ for (let i=0;i<20;i++) strip.push(j*20+i, (j+1)*20+i); strip.push(65535); }}
  const body = {{ _name:null, matrix:I, _parents:[chain([null,'Scene - RootModel','Feature - Orientation','Feature - Hotspot'])],
    _attributes:{{ Vertex:{{_elements:new Float32Array(v)}}, Normal:{{_elements:new Float32Array(n)}} }},
    _primitives:[{{mode:5, indices:{{_elements:new Uint16Array(strip)}}}}] }};
  const quad = mk([0,0,0,1,0,0,1,1,0,0,1,0], [0,1,2,0,2,3], chain([null,null,'Hotspot - Proxy','Feature - Hotspot']));
  for (let f=0; f<3; f++) {{ window.attachbody(body); window.attachbody(quad); }}
  return window.allmodel.length; }}"""


def test_strip_mesh_and_hotspot(ripper):
    r = ripper()
    r.scene(STRIP_SCENE)
    res = r.export()
    ok(res, r)
    g = res['gltf']
    assert len(g['meshes']) == 1, 'the hotspot marker quad must not be exported'
    tris = g['accessors'][g['meshes'][0]['primitives'][0]['indices']]['count'] // 3
    assert tris == 19 * 19 * 2, 'strip converted to a triangle list'


def test_fbx_builds(ripper):
    r = ripper()
    r.scene(STRIP_SCENE)
    res = r.export('fbx')
    assert any(f.endswith('.fbx') for f in res['files'])
    assert not r.errors(), r.errors()


# ====================================================================
# Materials
# ====================================================================
def test_matcap_colour(ripper):
    """A matcap-only material gets the mean matcap colour as base colour (#18 Anatomy)."""
    r = ripper()
    r.scene(f"""() => {{ {MK}
      const c = document.createElement('canvas'); c.width = c.height = 256; const g = c.getContext('2d');
      g.fillStyle = 'rgb(40,40,40)'; g.fillRect(0,0,256,256); g.fillStyle = 'rgb(214,178,175)';
      g.beginPath(); g.arc(128,128,100,0,7); g.fill();
      const tex = {{ _channels: ['Matcap'], _packedTextures: {{ Matcap: {{ texture: {{ _image: {{ _url: 'https://media.sketchfab.com/matcaps/x/y.jpeg', _imageObject: c }} }} }} }} }};
      const ch = (a) => ({{ attributes: a }});
      const mm = {{ attributes: {{ cullFace: 0, channels: {{ Matcap: ch({{enable:true, factor:1, color:[1,1,1]}}), AlbedoPBR: ch({{enable:true, factor:1, color:[1,1,1]}}),
                   RoughnessPBR: ch({{enable:true, factor:0.6}}), MetalnessPBR: ch({{enable:true, factor:0}}) }} }} }};
      const root = {{_name:'Scene - RootModel', matrix:I, _parents:[]}};
      const holder = {{_name:null, matrix:I, _parents:[root], stateset:{{ _attributeArray:[{{_object:{{_materialModel:mm, _channelMapping:{{Matcap:0, AlbedoPBR:-1, Inspector:-1}}}}}}], _textureAttributeArrayList:[[{{_object:tex}}]] }}}};
      window.attachbody(mk([0,0,0,1,0,0,0,1,0], [0,1,2], holder)); }}""")
    res = r.export()
    ok(res, r)
    col = res['gltf']['materials'][0]['pbrMetallicRoughness']['baseColorFactor']
    # sRGB (214,178,175) -> linear about (0.67, 0.45, 0.43); the sample mixes in a little of the edge.
    assert col[0] > col[1] > 0.3 and col[0] > 0.6, col


TEX_SCENE = """(B, additive) => {
  window._anyAnchorsMatched = true;
  const plain = additive
    ? { attributes: { name: 'OscarBill.png', images: [ { url: B + 'oscar.png', width: 64, height: 64, size: 900, pk: null } ] } }
    : { attributes: { name: 'TextureArch.png', images: [
        { url: B + 'arch_orig.png', width: 50, height: 153, size: 900, pk: null },
        { url: B + 'arch_32.png', width: 32, height: 128, size: 500, pk: null, options: { format: 'RGB', quality: 95 } } ] } };
  const keyed = { attributes: { name: 'Keyed.png', images: [
     { url: B + 'keyed_64.png', width: 64, height: 64, size: 700, pk: 12345, options: { format: 'RGB' } } ] } };
  const chosen = additive ? { url: B + 'oscar.png', width: 64, height: 64 } : { url: B + 'arch_32.png', width: 32, height: 128 };
  const r1 = window.drawhookcanvas(Object.assign(chosen, { options: { format: 'RGB' } }), plain);
  window.drawhookcanvas({ url: B + 'keyed_64.png', width: 64, height: 64, options: { format: 'RGB' } }, keyed);
  const I=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
  const root = {_name:'Scene - RootModel', matrix:I, _parents:[]};
  const tex = { _channels: ['AlbedoPBR'], _packedTextures: { AlbedoPBR: { texture: { _image: { _url: r1.url } } } } };
  const channels = { AlbedoPBR: { attributes: { enable: true, factor: 1, color: [1,1,1] } } };
  if (additive) channels.Opacity = { attributes: { enable: true, factor: 1, type: 'additive' } };
  const holder = {_name:'Mat', matrix:I, _parents:[root], stateset:{ _attributeArray:[{_object:{_materialModel:{ attributes: { channels } }, _channelMapping:{AlbedoPBR:0}}}], _textureAttributeArrayList:[[{_object:tex}]] }};
  window.attachbody({ _name:'Mat', matrix:I, _parents:[holder],
    _attributes:{ Vertex:{_elements:new Float32Array([0,0,0,1,0,0,0,1,0])}, Normal:{_elements:new Float32Array([0,0,1,0,0,1,0,0,1])}, TexCoord0:{_elements:new Float32Array([0,0,1,0,0,1])} },
    _primitives:[{mode:4, indices:{_elements:new Uint16Array([0,1,2])}}] }); }"""


def test_plain_texture_downloaded(ripper, base_url):
    """A texture without a protection key is downloaded (original file first); a keyed one is not (issue #5)."""
    r = ripper()
    r.page.evaluate(f'([B, a]) => ({TEX_SCENE})(B, a)', [base_url + '/tex/', False])
    r.page.wait_for_timeout(300)
    res = r.export()
    ok(res, r)
    assert any('arch_orig.png' in u for u in r.requests), 'the original unkeyed file is downloaded'
    assert not any('keyed_64.png' in u for u in r.requests), 'keyed images are never downloaded'
    assert any(f.startswith('textures/') for f in res['files'])
    assert 'baseColorTexture' in res['gltf']['materials'][0]['pbrMetallicRoughness']


def test_additive_opacity(ripper, base_url):
    """Additive opacity without an opacity image: alpha from the colour brightness, BLEND (Oscars statue cards)."""
    r = ripper()
    r.page.evaluate(f'([B, a]) => ({TEX_SCENE})(B, a)', [base_url + '/tex/', True])
    r.page.wait_for_timeout(300)
    res = r.export()
    ok(res, r)
    assert res['gltf']['materials'][0].get('alphaMode') == 'BLEND'
    assert 'alpha' in res, 'a merged _Alpha texture is written'
    assert res['alpha']['corner'] < 10, 'black background is clear'


# ====================================================================
# Split into loose parts (issue #3, teeth)
# ====================================================================
SPLIT_SCENE = f"""() => {{ {MK}
  const root = {{_name:'Scene - RootModel', matrix:I, _parents:[]}};
  const parent = {{_name:null, matrix:I, _parents:[root]}};
  // piece 1: half of a quad + a separate triangle; piece 2: the other half of the quad (shared positions)
  window.attachbody(mk([0,0,0, 1,0,0, 1,1,0, 5,0,0, 6,0,0, 5,1,0], [0,1,2, 3,4,5], parent));
  window.attachbody(mk([0,0,0, 1,1,0, 0,1,0], [0,1,2], parent)); }}"""


@pytest.mark.parametrize('on', [True, False])
def test_split_loose_parts(ripper, on):
    r = ripper(config={'SPLIT_LOOSE_PARTS': on})
    r.scene(SPLIT_SCENE)
    res = r.export()
    ok(res, r)
    names = [n.get('name') for n in res['gltf']['nodes']]
    if on:
        assert len(res['gltf']['meshes']) == 2, 'quad (joined over the cut) + triangle'
        assert sum('_part_' in (n or '') for n in names) == 2
    else:
        assert len(res['gltf']['meshes']) == 2, 'the two viewer pieces stay as they are'
        assert not any('_part_' in (n or '') for n in names)


# ====================================================================
# Centre at origin
# ====================================================================
OFFSET_SCENE = f"""() => {{ {MK}
  const root = {{_name:'Scene - RootModel', matrix:I, _parents:[]}};
  const parent = {{_name:null, matrix:I, _parents:[root]}};
  window.attachbody(mk([10,5,-3, 11,5,-3, 11,6,-1, 15,5,-3, 16,5,-3, 15,6,-1], [0,1,2, 3,4,5], parent));
  window.attachbody(mk([10,5,-3, 11,6,-1, 10,6,-1], [0,1,2], parent)); }}"""


@pytest.mark.parametrize('split', [False, True])
def test_centre_at_origin(ripper, split):
    r = ripper(config={'CENTRE_AT_ORIGIN': True, 'EXPORT_SCALE': 2, 'SPLIT_LOOSE_PARTS': split})
    r.scene(OFFSET_SCENE)
    res = r.export()
    ok(res, r)
    lo, hi = world_bounds(res['gltf'])
    assert abs(lo[0] + hi[0]) < 1e-4 and abs(lo[2] + hi[2]) < 1e-4, (lo, hi)
    assert abs(lo[1]) < 1e-4, (lo, hi)
    assert abs((hi[0] - lo[0]) - 12) < 1e-3, 'size 6 x export scale 2'
    g = res['gltf']
    root = g['nodes'][g['scenes'][0]['nodes'][0]]
    m = root.get('matrix', [0] * 16)
    assert m[12:15] == [0, 0, 0], 'scene_root stays at the origin'
    assert any('baked into' in l for l in r.logs), 'static model: offset baked into the vertices'


# ====================================================================
# Annotations (issue #3)
# ====================================================================
POS = [-3.5934016282425496, 0.16699245071902186, 1.3866552191700023]
HOTSPOTS = """window.__fetched=[]; const _f = window.fetch; window.fetch = (u, o) => {
  if (String(u).includes('/hotspots')) { window.__fetched.push(String(u));
    return Promise.resolve({ ok: true, json: async () => ({ results: [{ name: 'Mesiobuccal Cusp', content: { raw: 'Cusp *text*' },
      position: %s, eye: [2.8,-21.5,3.1], target: [0,8.67,0] }] }) }); }
  return _f(u, o); };""" % json.dumps(POS)


@pytest.mark.parametrize('on', [True, False])
def test_annotations(ripper, on):
    r = ripper(config={'EXPORT_ANNOTATIONS': on}, extra_stub=HOTSPOTS)
    r.scene(f"""() => {{ {MK}
      const rm = {{_name:'Scene - RootModel', matrix: I, _parents: [{{_name:'Feature - Orientation', matrix: I, _parents: []}}]}};
      window.attachbody(mk([0,0,0,1,0,0,0,1,0], [0,1,2], {{_name:null, matrix:I, _parents:[rm]}}, {{_name:'Body'}})); }}""")
    res = r.export()
    ok(res, r)
    ann = [n for n in res['gltf']['nodes'] if 'extras' in n]
    if on:
        assert len(ann) == 1 and ann[0]['name'] == '1. Mesiobuccal Cusp'
        assert ann[0]['extras']['sketchfabAnnotation']['text'] == 'Cusp *text*'
    else:
        assert ann == [] and r.page.evaluate('window.__fetched.length') == 0, 'off: no request, no nodes'


# ====================================================================
# Texture wait and panel layout
# ====================================================================
def test_matcap_and_atlas_do_not_wait(ripper):
    """Matcap and colour-atlas textures are not exported, so the export must not wait for them (#18)."""
    r = ripper()
    r.scene(f"""() => {{ {MK}
      const pk = (url, atlas) => ({{ texture: {{ _image: {{ _url: url }}, _isColorAtlas: atlas }} }});
      const tex = {{ _channels: ['Matcap','AlbedoPBR'], _packedTextures: {{ Matcap: pk('https://static.sketchfab.com/matcaps/pink.png', false), AlbedoPBR: pk('https://x/atlas.png', true) }} }};
      const root = {{_name:'Scene - RootModel', matrix:I, _parents:[]}};
      window.attachbody(mk([0,0,0,1,0,0,0,1,0], [0,1,2], {{_name:null, matrix:I, _parents:[root]}}, {{ stateset: {{ _textureAttributeArrayList: [[{{ _object: tex }}]] }} }})); }}""")
    r.export(timeout_s=8)
    assert not any('textures still loading' in l for l in r.logs)


def test_panel_fits_small_window(ripper):
    """On a short window the panel stays inside it and the settings list scrolls."""
    r = ripper(viewport={'width': 900, 'height': 380})
    r.page.click('#ripper-panel .rp-gear')
    r.page.wait_for_timeout(200)
    geo = r.page.evaluate("""() => { const p = document.getElementById('ripper-panel').getBoundingClientRect();
        const c = document.getElementById('ripper-config');
        return { top: p.top, bottom: p.bottom, vh: innerHeight, scrolls: c.scrollHeight > c.clientHeight }; }""")
    assert geo['top'] >= 0 and geo['bottom'] <= geo['vh'], geo
    assert geo['scrolls'], geo


# ====================================================================
# Sandboxed userscript manager (Firefox, issue: viewer stuck loading)
# ====================================================================
# In a sandbox the page cannot call functions set by the script ("Permission denied").
# Simulated: the probe function throws when the page calls it.
SANDBOX = """Object.defineProperty(window, '__ripperProbe', { configurable: true,
  set(v) { this.__p = () => { throw new Error('Permission denied to access property'); }; }, get() { return this.__p; } });"""


def test_sandbox_leaves_viewer_alone(ripper):
    r = ripper(extra_stub=SANDBOX)
    r.page.wait_for_timeout(500)
    assert not any(l.startswith('[Ripper] patched') for l in r.logs), 'no bundle is patched in a sandbox'
    assert any('isolated sandbox' in l for l in r.logs)
    status = r.page.text_content('#ripper-status')
    assert 'sandbox' in status, status
