// Converts a GLB made by the userscript to FBX with the FBX writer inside the userscript.
// usage: node tools/fbx/glb2fbx.js in.glb out.fbx
// Writes out.fbx and out.fbx.json (metal/rough splits, warnings, counts).
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const [, , inp, out] = process.argv;
const us = fs.readFileSync(path.join(__dirname, '../../src/Sketchfab-ripper.user.js'), 'utf8');
const a = us.indexOf('    // ====================================================================\n    // FBX export: binary FBX 7.4');
const b = us.indexOf('    // ====================================================================\n    // Script interceptor');
if (a < 0 || b < 0) throw new Error('FBX writer section not found in the userscript');
const FbxWriter = new Function(us.slice(a, b) + '\nreturn FbxWriter;')();
const buf = fs.readFileSync(inp);
const jl = buf.readUInt32LE(12);
const gltf = JSON.parse(buf.subarray(20, 20 + jl).toString('utf8'));
const bl = buf.readUInt32LE(20 + jl);
const bin = new Uint8Array(buf.buffer, buf.byteOffset + 28 + jl, bl);
const t0 = Date.now();
FbxWriter.gltfToFbx(gltf, bin, {
    creator: 'glb2fbx test',
    deflate: process.env.NOZ ? null : (u8) => Promise.resolve(new Uint8Array(zlib.deflateSync(u8))),
}).then((r) => {
    fs.writeFileSync(out, Buffer.from(r.fbx));
    fs.writeFileSync(out + '.json', JSON.stringify({ splits: r.splits, warnings: r.warnings, stats: r.stats }, null, 1));
    console.log(path.basename(out), (r.fbx.byteLength / 1e6).toFixed(2) + ' MB', (Date.now() - t0) + ' ms', JSON.stringify(r.stats), 'warnings', r.warnings);
});
