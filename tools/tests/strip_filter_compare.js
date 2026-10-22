// usage: node tools/tests/strip_filter_compare.js OLD.user.js NEW.user.js model1.glb [model2.glb ...]
// Runs primitiveTriangles() of two userscript versions on real GLB meshes, given as strips of
// single triangles separated by restart indices (65535 / 4294967295), and compares the results.
const fs = require('fs');
function load(file) {
    const src = fs.readFileSync(file, 'utf8'), i = src.indexOf('    function primitiveTriangles('), j = src.indexOf('\n    }\n', i) + 7;
    const logs = [];
    const f = new Function('CONFIG', 'log', 'warn', src.slice(i, j) + '; return primitiveTriangles;')({ DROP_STRIP_SLIVERS: true }, (...a) => logs.push(a.join(' ')), (...a) => logs.push(a.join(' ')));
    return { f, logs };
}
function glb(path) {
    const b = fs.readFileSync(path), jl = b.readUInt32LE(12), j = JSON.parse(b.slice(20, 20 + jl)), bin = b.slice(28 + jl);
    const acc = (i) => { const a = j.accessors[i], bv = j.bufferViews[a.bufferView], o = (bv.byteOffset || 0) + (a.byteOffset || 0), n = a.count * { SCALAR: 1, VEC3: 3 }[a.type];
        const T = { 5126: Float32Array, 5125: Uint32Array, 5123: Uint16Array }[a.componentType]; return new T(bin.buffer.slice(bin.byteOffset + o, bin.byteOffset + o + n * T.BYTES_PER_ELEMENT)); };
    return j.meshes.map((m) => ({ name: m.name, V: acc(m.primitives[0].attributes.POSITION), I: acc(m.primitives[0].indices) }));
}
const [oldF, newF] = [load(process.argv[2]), load(process.argv[3])];
for (const path of process.argv.slice(4)) {
    for (const m of glb(path)) {
        const vc = m.V.length / 3, R = vc < 65535 ? 65535 : 4294967295, pi = [];
        for (let t = 0; t < m.I.length; t += 3) pi.push(m.I[t], m.I[t + 1], m.I[t + 2], R);
        const a = oldF.f(5, pi, m.V, vc, m.name), b = newF.f(5, pi, m.V, vc, m.name);
        const sa = new Set(), sb = new Set(), key = (tl, k) => `${tl[k]},${tl[k + 1]},${tl[k + 2]}`;
        for (let k = 0; k < a.length; k += 3) sa.add(key(a, k));
        for (let k = 0; k < b.length; k += 3) sb.add(key(b, k));
        const onlyOld = [...sa].filter((x) => !sb.has(x)), onlyNew = [...sb].filter((x) => !sa.has(x));
        if (onlyOld.length || onlyNew.length) console.log(`${path.split('/').pop()} | ${m.name}: old ${a.length / 3} tris, new ${b.length / 3}; removed by new: ${onlyOld.slice(0, 4).join(' ; ')}${onlyNew.length ? ' ; ADDED ' + onlyNew.length : ''}`);
    }
}
console.log('new-version log lines with "separate parts":', newF.logs.filter((l) => l.includes('separate parts')));
