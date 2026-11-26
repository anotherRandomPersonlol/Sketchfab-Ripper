# Tests

Export tests without Sketchfab. Each test loads the userscript on the harness page (`harness/`), feeds mock viewer objects to the script's hooks, clicks GLB or FBX, and checks the saved zip. Every GLB is also checked with the Khronos glTF validator.

The GitHub workflow `Tests` runs them on every push and pull request.

## Run locally

From the repo root:

```
npm install --prefix tests
pip install -r tests/requirements.txt
python -m playwright install chromium
python -m pytest tests
```

- `CHROME_PATH=/usr/bin/google-chrome` uses an installed Chrome instead of Playwright's Chromium.
- `RIPPER_SCRIPT=path/to/other.user.js` tests another copy of the script, for example an older version.

## What is covered

| Test | Checks |
|---|---|
| `test_strip_mesh_and_hotspot` | Triangle strip to triangle list; the hotspot marker quad is not exported (#18 Anatomy). |
| `test_fbx_builds` | FBX export writes a `.fbx` without errors. |
| `test_matcap_colour` | A matcap-only material gets the matcap colour as base colour. |
| `test_plain_texture_downloaded` | A texture without a protection key is downloaded, original file first; a keyed one is not (issue #5). |
| `test_additive_opacity` | Additive opacity: alpha from the colour brightness, `BLEND` (Oscars statue cards). |
| `test_split_loose_parts` | On: pieces joined over the cut and split into parts. Off: unchanged. |
| `test_centre_at_origin` | Bounds centred at X = Z = 0, lowest point at Y = 0, after the export scale; scene_root stays at 0. With and without split. |
| `test_annotations` | On: one empty node with title, text and camera. Off: no request, no nodes. |
| `test_matcap_and_atlas_do_not_wait` | The export does not wait for matcap or colour-atlas textures. |
| `test_panel_fits_small_window` | On a short window the panel stays inside it and the settings scroll. |

To add a test: build the mock objects in a scene function (see the existing ones), export, and assert on `res['gltf']`.
