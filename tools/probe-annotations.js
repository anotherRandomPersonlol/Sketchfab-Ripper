// Probe: where the viewer keeps the annotations (titles, text, positions), for an "export annotations" option.
// Use a model that shows numbered annotation markers.
// Paste into the DevTools console of the viewer frame (the frame with /embed in its URL, or the
// model page itself when the console context is "top") after the model has loaded, as one block.
// For 5 seconds it watches the meshes the viewer draws. Keep dragging the model during that time:
// the viewer only draws while something changes.
// It returns one line of text (JSON): copy it and send it.
await (async () => {
    if (typeof window.attachbody !== 'function') return 'no attachbody: wrong console context, or the ripper is not running here';
    const r3 = (a) => a.map((x) => Math.round(x * 1000) / 1000);
    const matOf = (n) => {
        const m = n && (n.matrix || n._matrix);
        if (!m) return null;
        const a = m._elements || m.elements || m;
        return a && a.length === 16 ? Array.from(a) : null;
    };
    const mul = (a, b) => {   // column-major 4x4: a*b
        const o = new Array(16);
        for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
            let s = 0;
            for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
            o[c * 4 + r] = s;
        }
        return o;
    };
    const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const world = (n) => {
        const chain = [];
        let c = n, g = 0;
        while (c && g++ < 64) { chain.unshift(matOf(c) || I); c = c._parents && c._parents[0]; }
        return chain.reduce(mul, I);
    };
    const xf = (m, p) => [0, 1, 2].map((r) => m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r]);
    const names = (n) => {
        const out = [];
        let p = n && n._parents && n._parents[0], g = 0;
        while (p && g++ < 16) { out.push(p._name || '(no name)'); p = p._parents && p._parents[0]; }
        return out;
    };
    const centroid = (o) => {
        const v = o._attributes && o._attributes.Vertex && o._attributes.Vertex._elements;
        if (!v || !v.length) return null;
        const s = [0, 0, 0], n = v.length / 3;
        for (let i = 0; i < v.length; i += 3) { s[0] += v[i]; s[1] += v[i + 1]; s[2] += v[i + 2]; }
        return s.map((x) => x / n);
    };

    // 1) Meshes drawn for 5 s: the annotation markers and one model mesh (to find the scene root).
    const orig = window.attachbody, seen = new Set();
    window.attachbody = (t) => { try { if (t) seen.add(t); } catch (e) {} return orig(t); };
    await new Promise((r) => setTimeout(r, 5000));
    window.attachbody = orig;
    const all = [...seen];
    const isHot = (o) => names(o).some((s) => /hotspot|annotation/i.test(s));
    const hot = all.filter(isHot);
    const markers = hot.slice(0, 30).map((o) => {
        const c = centroid(o), w = world(o);
        return {
            parents: names(o), nParents: (o._parents || []).length,
            vertices: o._attributes && o._attributes.Vertex ? o._attributes.Vertex._elements.length / 3 : 0,
            localCenter: c && r3(c), worldCenter: c && r3(xf(w, c)), worldOrigin: r3(xf(w, [0, 0, 0])),
            parentMatrix: (o._parents && o._parents[0] && matOf(o._parents[0])) ? r3(matOf(o._parents[0])) : null,
        };
    });

    // 2) The scene graph from the top: every node whose name mentions hotspot/annotation, with its children.
    let top = all.find((o) => !isHot(o)) || all[0], g = 0;
    while (top && top._parents && top._parents[0] && g++ < 64) top = top._parents[0];
    const nodes = [], seenN = new Set();
    const kids = (n) => n.children || n._children || [];
    (function walk(n, depth) {
        if (!n || seenN.has(n) || depth > 40 || nodes.length > 60) return;
        seenN.add(n);
        const nm = n._name || '';
        if (/hotspot|annotation/i.test(nm)) {
            nodes.push({
                name: nm, depth, children: kids(n).length,
                childNames: kids(n).slice(0, 8).map((c) => c._name || '(no name)'),
                matrix: matOf(n) && r3(matOf(n)), worldOrigin: r3(xf(world(n), [0, 0, 0])),
                keys: Object.keys(n).filter((k) => !/^_?(children|parents|matrix)$/.test(k)).slice(0, 25),
            });
        }
        kids(n).forEach((c) => walk(c, depth + 1));
    })(top, 0);

    // 3) Model bounds in world space (to compare with the marker positions).
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    (window.allmodel || []).slice(0, 50).forEach((o) => {
        const v = o._attributes && o._attributes.Vertex && o._attributes.Vertex._elements;
        if (!v) return;
        const w = world(o);
        for (let i = 0; i < v.length; i += Math.max(3, Math.floor(v.length / 3000) * 3)) {
            const p = xf(w, [v[i], v[i + 1], v[i + 2]]);
            for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p[k]); hi[k] = Math.max(hi[k], p[k]); }
        }
    });

    // 4) Network: requests that may carry the annotation data.
    const urls = performance.getEntriesByType('resource').map((e) => e.name)
        .filter((u) => /hotspot|annotation|\/i\/models\//i.test(u)).slice(0, 20);
    const bodies = [];
    for (const u of urls.filter((u) => /hotspot|annotation/i.test(u)).slice(0, 3)) {
        try { const t = await (await fetch(u, { credentials: 'include' })).text(); bodies.push({ url: u, length: t.length, start: t.slice(0, 900) }); }
        catch (e) { bodies.push({ url: u, error: String(e) }); }
    }

    // 5) The page: annotation titles shown in the DOM (works only in the frame that shows them).
    const dom = [...document.querySelectorAll('[class*="annotation" i]')].slice(0, 200)
        .map((e) => (e.className && e.className.baseVal !== undefined ? e.className.baseVal : e.className) + ' :: ' + (e.textContent || '').trim().slice(0, 60))
        .filter((s, i, a) => a.indexOf(s) === i).slice(0, 25);

    // 6) Annotation data embedded in the page (prefetched JSON in <script> tags): objects with a
    //    position/eye/target or a name + content, anywhere in the parsed JSON.
    const found = [];
    const scan = (v, path, d) => {
        if (!v || typeof v !== 'object' || d > 14 || found.length > 12) return;
        const k = Array.isArray(v) ? [] : Object.keys(v);
        if (k.includes('position') && (k.includes('eye') || k.includes('target') || k.includes('content') || k.includes('name'))) {
            found.push({ path, keys: k.slice(0, 20), sample: JSON.stringify(v).slice(0, 500) });
            return;
        }
        (Array.isArray(v) ? v : k.map((x) => v[x])).forEach((c, i) => scan(c, path + '/' + (Array.isArray(v) ? i : k[i]), d + 1));
    };
    const scripts = [...document.querySelectorAll('script:not([src])')].map((e) => ({ id: e.id || e.type || '', t: e.textContent || '' }))
        .filter((e) => /annotation|hotspot/i.test(e.t));
    scripts.forEach((e) => {
        let j = null;
        try { j = JSON.parse(e.t); } catch (x) { /* not JSON */ }
        if (j) scan(j, '#' + e.id, 0);
    });
    const scriptHits = scripts.slice(0, 6).map((e) => {
        const i = e.t.search(/annotation|hotspot/i);
        return { id: e.id, length: e.t.length, around: e.t.slice(Math.max(0, i - 150), i + 350) };
    });

    return JSON.stringify({
        embedded: found, scriptHits,
        meshesSeen: all.length, markerMeshes: hot.length, markers, nodes,
        modelBounds: { min: r3(lo), max: r3(hi) }, urls, bodies, dom,
        location: location.href.slice(0, 120),
    });
})();
