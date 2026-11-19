// Probe: what Sketchfab's texture list (/i/models/<uid>/textures) offers for a model, compared with the
// images the viewer actually loaded. Used to decide whether the export can download textures directly
// (no wait for the viewer) and at which size.
// Paste into the DevTools console of the viewer frame (the frame with /embed in its URL) or of the model
// page, after the model has loaded, as one block. It does not change anything.
// It returns one line of text (JSON): copy it and send it.
await (async () => {
    const m = location.pathname.match(/[0-9a-f]{32}/gi);
    const uid = m ? m[m.length - 1] : null;
    if (!uid) return 'model id not found in the page address';
    const out = { uid, variants: {} };
    for (const suffix of ['?optimized=1', '']) {
        try {
            const r = await fetch(`/i/models/${uid}/textures${suffix}`, { credentials: 'omit' });
            out.variants[suffix || 'plain'] = { status: r.status, data: r.ok ? await r.json() : null };
        } catch (e) { out.variants[suffix || 'plain'] = { error: e.message }; }
    }
    const pick = out.variants['?optimized=1'].data || out.variants.plain.data;
    const loaded = performance.getEntriesByType('resource').map((e) => e.name).filter((u) => /\/textures\//.test(u));
    const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
    const keyOf = (im, tex) => (has(im, 'pk') ? im.pk : tex.pk);
    const textures = ((pick && pick.results) || []).map((t) => {
        const imgs = (t.images || []).slice().sort((a, b) => b.width * b.height - a.width * a.height);
        const open = imgs.filter((im) => keyOf(im, t) == null || keyOf(im, t) === '');
        const viewer = loaded.filter((u) => u.toLowerCase().includes(String(t.uid).toLowerCase()));
        const sizeOf = (u) => { const im = imgs.find((i) => u.split('?')[0] === String(i.url).split('?')[0]); return im ? `${im.width}x${im.height}` : '?'; };
        return {
            name: t.name, keysOnTexture: Object.keys(t).slice(0, 20), texturePk: has(t, 'pk') ? t.pk : '(none)',
            sizes: imgs.map((i) => `${i.width}x${i.height}${keyOf(i, t) != null && keyOf(i, t) !== '' ? ' pk' : ''}${i.options && Object.keys(i.options).length ? ' ' + JSON.stringify(i.options) : ''}`),
            largest: imgs[0] && `${imgs[0].width}x${imgs[0].height}`,
            largestWithoutKey: open[0] ? `${open[0].width}x${open[0].height}` : null,
            viewerLoaded: viewer.map(sizeOf),
        };
    });
    const first = pick && pick.results && pick.results[0];
    return JSON.stringify({
        uid,
        status: Object.fromEntries(Object.entries(out.variants).map(([k, v]) => [k, v.status || v.error])),
        count: textures.length,
        withKeyOnLargest: textures.filter((t) => t.largest && t.largestWithoutKey !== t.largest).length,
        noUnkeyedImage: textures.filter((t) => !t.largestWithoutKey).length,
        imageKeys: first && first.images && first.images[0] ? Object.keys(first.images[0]) : [],
        textures: textures.slice(0, 25),
    });
})();
