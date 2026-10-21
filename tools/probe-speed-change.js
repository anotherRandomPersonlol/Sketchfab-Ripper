// Probe: what the animation manager does when the playback speed changes while a clip plays.
// Paste into the DevTools console of the viewer frame (/embed) as one block, while a clip plays.
// During the 12 seconds after you press Enter, change the speed a few times (x1 -> x0.1 -> x2 -> x1).
// It returns one line of text (JSON): copy it and send it.
await (async () => {
    let cur = window.allmodel && window.allmodel[0], mgr = null, guard = 0;
    while (cur && !mgr && guard++ < 64) {
        (cur._updateCallbacks || []).forEach((c) => { if (!mgr && c && c._instanceAnimations && c.stopAllAnimation) mgr = c; });
        cur = cur._parents && cur._parents[0];
    }
    if (!window.allmodel) return 'wrong frame: pick the frame with /embed in the console context menu';
    if (!mgr) return 'no animation manager: load a model with clips and play one';
    const nums = (o, depth) => {
        const r = {};
        if (!o) return r;
        for (const k in o) {
            const v = o[k];
            if (typeof v === 'number' || typeof v === 'boolean') r[k] = typeof v === 'number' ? +v.toFixed(4) : v;
            else if (depth > 0 && v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Float32Array) && Object.keys(v).length < 40) {
                const sub = nums(v, depth - 1);
                for (const s in sub) r[`${k}.${s}`] = sub[s];
            }
        }
        return r;
    };
    // a value that moves with the animation: first palette entry of a skinned mesh, or a world matrix entry
    const sk = window.allmodel.find((o) => o._rigTransformImplementation && o._rigTransformImplementation._skinningAttribute);
    const motion = () => {
        try { const p = sk._rigTransformImplementation._skinningAttribute._matrixPalette; return +(p[3] + p[7] + p[11] + p[15] + p[19] + p[23]).toFixed(4); } catch (e) { return null; }
    };
    const rows = [], t0 = performance.now();
    let prev = null;
    await new Promise((done) => {
        (function tick() {
            const t = (performance.now() - t0) / 1000;
            const act = (mgr._activeAnimationList || [])[0];
            const row = { t: +t.toFixed(3), sim: mgr.getSimulationTime ? +mgr.getSimulationTime().toFixed(4) : null,
                          f: mgr.getTimeFactor ? mgr.getTimeFactor() : null, m: motion(), mgr: nums(mgr, 0), act: nums(act, 1) };
            // keep a row every 0.25 s, and every row where a number jumps or the speed changes
            let keep = !prev || row.f !== prev.f || Math.floor(t * 4) !== Math.floor(prev.t * 4);
            if (prev && !keep) for (const k in row.mgr) if (typeof row.mgr[k] === 'number' && Math.abs(row.mgr[k] - (prev.mgr[k] || 0)) > 0.2) keep = true;
            if (prev && !keep) for (const k in row.act) if (typeof row.act[k] === 'number' && Math.abs(row.act[k] - (prev.act[k] || 0)) > 0.2) keep = true;
            if (keep) {
                const slim = { t: row.t, sim: row.sim, f: row.f, m: row.m, mgr: {}, act: {} };
                for (const k in row.mgr) if (!prev || row.mgr[k] !== prev.mgr[k]) slim.mgr[k] = row.mgr[k];
                for (const k in row.act) if (!prev || row.act[k] !== prev.act[k]) slim.act[k] = row.act[k];
                rows.push(slim);
            }
            prev = row;
            if (t < 12) requestAnimationFrame(tick); else done();
        })();
    });
    return JSON.stringify({ clip: ((mgr._activeAnimationList || [])[0] || {}).name, rows });
})();
