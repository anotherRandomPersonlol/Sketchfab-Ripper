// Probe: which scene space the annotation positions from /i/models/<uid>/hotspots are in.
// The viewer draws each annotation marker at a world position (under "Hotspot - Proxy"); the
// exported model is in the same world space. This finds the node whose world matrix maps the
// API positions onto the markers, and shows how the markers are laid out in the scene.
// Paste into the DevTools console of the viewer frame (the frame with /embed in its URL) after the
// model has loaded, as one block. Best on a model with several annotations.
// It returns one line of text (JSON): copy it and send it.
await (async () => {
    const model = (window.allmodel || [])[0];
    if (!model) return 'no captured mesh: wrong console context, or drag the model once and run it again';
    const uid = location.pathname.split('/')[2];
    let api = [];
    try { api = (await (await fetch('/i/models/' + uid + '/hotspots', { credentials: 'include' })).json()).results || []; }
    catch (e) { return 'hotspots request failed: ' + e.message; }

    const r3 = (a) => a.map((x) => Math.round(x * 1000) / 1000);
    const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const matOf = (n) => {
        try { if (typeof n.getMatrix === 'function') { const m = n.getMatrix(); const a = m && (m._elements || m); if (a && a.length === 16) return Array.from(a); } } catch (e) {}
        const m = n && (n.matrix || n._matrix);
        const a = m && (m._elements || m.elements || m);
        return a && a.length === 16 ? Array.from(a) : null;
    };
    const mul = (a, b) => {
        const o = new Array(16);
        for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
            let s = 0;
            for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
            o[c * 4 + r] = s;
        }
        return o;
    };
    const world = (n) => {
        const chain = [];
        let c = n, g = 0;
        while (c && g++ < 64) { chain.unshift(matOf(c) || I); c = c._parents && c._parents[0]; }
        return chain.reduce(mul, I);
    };
    const xf = (m, p) => [0, 1, 2].map((r) => m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r]);
    const kids = (n) => n.children || n._children || [];
    const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

    // Markers: every node under "Hotspot - Proxy" that has its own matrix, with its world origin.
    let top = model, g = 0;
    while (top._parents && top._parents[0] && g++ < 64) top = top._parents[0];
    let proxy = null;
    (function find(n, d) { if (!n || proxy || d > 40) return; if (n._name === 'Hotspot - Proxy') { proxy = n; return; } kids(n).forEach((c) => find(c, d + 1)); })(top, 0);
    const markers = [];
    if (proxy) (function walk(n, d, path) {
        if (d > 6 || markers.length > 60) return;
        if (n !== proxy && matOf(n)) markers.push({ path, world: r3(xf(world(n), [0, 0, 0])) });
        kids(n).forEach((c, i) => walk(c, d + 1, path + '/' + i + (c._name ? ':' + c._name : '')));
    })(proxy, 0, 'proxy');

    // Candidate spaces: each ancestor of the model mesh (and the mesh itself).
    const cands = [];
    let c = model, depth = 0;
    while (c && depth < 24) { cands.push({ node: c, name: c._name || '(no name)', depth }); c = c._parents && c._parents[0]; depth++; }
    cands.push({ node: null, name: '(viewer world = identity)', depth: -1 });
    const spaces = cands.map((cd) => {
        const W = cd.node ? world(cd.node) : I;
        let err = 0;
        const mapped = api.map((a) => {
            const p = xf(W, a.position || [0, 0, 0]);
            const near = markers.reduce((b, m) => Math.min(b, dist(p, m.world)), Infinity);
            err = Math.max(err, near);
            return r3(p);
        });
        return { name: cd.name, depth: cd.depth, maxErrorToNearestMarker: Math.round(err * 1000) / 1000, firstMapped: mapped[0] };
    }).sort((a, b) => a.maxErrorToNearestMarker - b.maxErrorToNearestMarker);

    return JSON.stringify({
        annotations: api.length, apiFirst: api[0] && { name: api[0].name, position: api[0].position, keys: Object.keys(api[0]) },
        proxyFound: !!proxy, markers: markers.slice(0, 20), bestSpaces: spaces.slice(0, 6),
    });
})();
