// Probe: how the viewer's playback speed (x0.1 / x0.5 / x1 / x2) reaches the animation manager.
// Paste into the DevTools console of the viewer frame (pick the frame whose URL has /embed
// in the console's context menu) while a clip plays. Run once at x1 and once at x0.5.
// It prints which manager fields hold the speed, and how fast getSimulationTime() runs
// against wall-clock time for 2 seconds.
(() => {
    let cur = window.allmodel && window.allmodel[0], mgr = null, guard = 0;
    while (cur && !mgr && guard++ < 64) {
        (cur._updateCallbacks || []).forEach((c) => { if (!mgr && c && c._instanceAnimations && c.stopAllAnimation) mgr = c; });
        cur = cur._parents && cur._parents[0];
    }
    if (!mgr) { console.log('[probe] no animation manager (is a model with clips loaded, and is this the viewer frame?)'); return; }

    const own = {};
    for (const k in mgr) {
        const v = mgr[k];
        if (/time|factor|speed|scale|rate/i.test(k) && (typeof v === 'number' || typeof v === 'boolean')) own[k] = v;
    }
    const fns = [];
    for (const k in mgr) if (typeof mgr[k] === 'function' && /time|factor|speed|rate/i.test(k)) fns.push(k);
    console.log('[probe] manager number fields:', JSON.stringify(own));
    console.log('[probe] manager time/speed methods:', fns.join(', '));

    const act = (mgr._activeAnimationList || []).map((a) => a.name);
    const inst = act.length ? mgr._instanceAnimations[act[0]] : null;
    const instNums = () => {
        const o = {};
        if (inst) for (const k in inst) if (typeof inst[k] === 'number') o[k] = +inst[k].toFixed(4);
        return o;
    };
    console.log('[probe] active clip:', act.join(',') || '(none)', 'instance numbers at start:', JSON.stringify(instNums()));

    const w0 = performance.now() / 1000;
    const s0 = typeof mgr.getSimulationTime === 'function' ? mgr.getSimulationTime() : NaN;
    setTimeout(() => {
        const dw = performance.now() / 1000 - w0;
        const ds = typeof mgr.getSimulationTime === 'function' ? mgr.getSimulationTime() - s0 : NaN;
        console.log(`[probe] wall ${dw.toFixed(3)} s, getSimulationTime advanced ${ds.toFixed(3)} s, ratio ${(ds / dw).toFixed(3)}`);
        console.log('[probe] instance numbers after 2 s:', JSON.stringify(instNums()));
        const after = {};
        for (const k in own) after[k] = mgr[k];
        console.log('[probe] manager number fields after:', JSON.stringify(after));
        console.log('[probe] copy all [probe] lines and send them.');
    }, 2000);
})();
