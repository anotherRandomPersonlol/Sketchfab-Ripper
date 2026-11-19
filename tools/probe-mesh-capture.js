// Probe: why a visible model gives "objects: 0" (meshes: 0).
// Paste into the DevTools console of the viewer frame (the frame with /embed in its URL, or the
// model page itself when the console context is "top") after the model has loaded, as one block.
// For 5 seconds it watches every mesh the viewer draws and tells whether the ripper keeps it.
// Keep dragging the model during those 5 seconds: the viewer only draws while something changes.
// It returns one line of text (JSON): copy it and send it.
await (async () => {
    if (typeof window.attachbody !== 'function') return 'no attachbody: wrong console context, or the ripper is not running here';
    const orig = window.attachbody, seen = new Map();
    const desc = (o) => {
        const attrs = o._attributes ? Object.keys(o._attributes) : [];
        const v = o._attributes && o._attributes.Vertex && o._attributes.Vertex._elements;
        const chain = [];
        let p = o._parents && o._parents[0], g = 0;
        while (p && g++ < 12) { chain.push(p._name || '(no name)'); p = p._parents && p._parents[0]; }
        return {
            name: o._name || null, stateset: !!o.stateset, statesetName: (o.stateset && o.stateset._name) || null,
            parents: chain, faked: o._faked === true, vertices: v ? v.length / 3 : null, attrs,
            prims: (o._primitives || []).map((pr) => `${pr.mode}x${pr.indices && pr.indices._elements ? pr.indices._elements.length : (pr.count || '?')}`),
            type: o.constructor && o.constructor.name, typeID: o.typeID,
        };
    };
    window.attachbody = (t) => { try { if (t && !seen.has(t)) seen.set(t, desc(t)); } catch (e) {} return orig(t); };
    // WebGL draw calls in the same time: shows whether the viewer drew at all
    const gl = { drawElements: 0, drawArrays: 0, drawElementsInstanced: 0, drawArraysInstanced: 0 }, undo = [];
    [window.WebGLRenderingContext, window.WebGL2RenderingContext].forEach((C) => {
        if (!C) return;
        Object.keys(gl).forEach((fn) => {
            const f = C.prototype[fn];
            if (!f) return;
            C.prototype[fn] = function () { gl[fn]++; return f.apply(this, arguments); };
            undo.push(() => { C.prototype[fn] = f; });
        });
    });
    await new Promise((r) => setTimeout(r, 5000));
    window.attachbody = orig; undo.forEach((u) => u());
    const list = [...seen.values()];
    const kept = list.filter((d) => (window.allmodel || []).some((o) => o && desc(o).vertices === d.vertices && (o._name || null) === d.name));
    return JSON.stringify({
        glDraws: gl, meshesSeen: list.length, captured: (window.allmodel || []).length,
        noName: list.filter((d) => !d.name && !d.statesetName && !(d.parents[0] && d.parents[0] !== '(no name)')).length,
        meshes: list.slice(0, 25), keptSample: kept.length,
    });
})();
