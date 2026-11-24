# Test harness page

`index.html` is a stand-in for the Sketchfab viewer frame. It loads `web/dist/geom-v2.js`, a tiny fake viewer bundle that contains the anchor the script patches. The script then adds its panel and its hooks (`window.attachbody` and others), so tests can feed mock geometry to `attachbody` and run an export without Sketchfab.

Used by `tools/screenshots/ui_update.py` and the tests in `tests/`.
