// ====================================================================
// probe 3: the material model behind a texture-less material. READ-ONLY.
// Probe 2 showed the Kalibr colors sit on an ANCESTOR node (named like
// "Material #92") whose stateset holds a Sketchfab material attribute
// (_attributeArray[0], with _materialModel and _channelMapping) plus a
// plain osg.Material at [17]. This prints the channel data itself
// (colors, factors, enable flags). Paste into the viewer iframe console.
// Output also kept in window.__matModelProbe (join with "\n").
// ====================================================================
(function () {
    var TAG = '[MatModelProbe]';
    var lines = window.__matModelProbe = [];
    function L(s) { lines.push(s); console.log(TAG, s); }

    var am = window.allmodel || [];
    L('allmodel length = ' + am.length);
    if (!am.length) { L('empty: wrong frame or model not loaded'); return lines.join('\n'); }

    // JSON that survives cycles, long strings and typed arrays, depth limited
    function safe(v, depth) {
        if (v === null || v === undefined || typeof v === 'number' || typeof v === 'boolean') return v;
        if (typeof v === 'string') return v.length > 60 ? v.slice(0, 60) + '...' : v;
        if (typeof v === 'function') return undefined;
        if (ArrayBuffer.isView(v)) return Array.prototype.slice.call(v, 0, 8).map(function (n) { return Math.round(n * 10000) / 10000; });
        if (depth <= 0) return Array.isArray(v) ? 'Array(' + v.length + ')' : '{...}';
        if (Array.isArray(v)) return v.slice(0, 8).map(function (x) { return safe(x, depth - 1); });
        var out = {};
        Object.keys(v).slice(0, 30).forEach(function (k) {
            if (/^(_parents|_events|_graphicContext)$/.test(k)) return;
            try { var s = safe(v[k], depth - 1); if (s !== undefined) out[k] = s; } catch (e) {}
        });
        return out;
    }
    function J(v, depth, max) {
        var s;
        try { s = JSON.stringify(safe(v, depth)); } catch (e) { s = '(unprintable ' + e.message + ')'; }
        return s && s.length > max ? s.slice(0, max) + '...' : s;
    }

    function unwrap(w) { return w && (w._object || w.attribute || w._attribute || w); }

    // Matcap: the image and its colours (centre = a surface facing the camera, average = overall tint).
    function matcapInfo(o) {
        var cur = o, d = 0;
        while (cur && d++ <= 12) {
            var ta = cur.stateset && cur.stateset._textureAttributeArrayList;
            for (var s = 0; ta && s < ta.length; s++) {
                var tex = ta[s] && ta[s][0] && ta[s][0]._object;
                var pk = tex && tex._packedTextures && tex._packedTextures.Matcap;
                if (!pk || !pk.texture) continue;
                var im = pk.texture._image, el = im && (im._imageObject || im._image || im._canvas || im);
                var info = 'matcap url=' + (im && (im._url || im.url)) + ' element=' + (el && el.constructor && el.constructor.name);
                try {
                    var w = el.naturalWidth || el.width, h = el.naturalHeight || el.height;
                    var c = document.createElement('canvas'); c.width = w; c.height = h;
                    var g = c.getContext('2d'); g.drawImage(el, 0, 0);
                    var px = g.getImageData(0, 0, w, h).data, ci = ((h >> 1) * w + (w >> 1)) * 4, sum = [0, 0, 0], n = 0;
                    for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) {
                        var dx = x - w / 2, dy = y - h / 2;
                        if (dx * dx + dy * dy > (w / 2) * (w / 2) * 0.81) continue;   // inside the sphere only
                        var i = (y * w + x) * 4; sum[0] += px[i]; sum[1] += px[i + 1]; sum[2] += px[i + 2]; n++;
                    }
                    info += ' size=' + w + 'x' + h + ' centre=' + [px[ci], px[ci + 1], px[ci + 2]].join(',') +
                            ' average=' + sum.map(function (v) { return Math.round(v / Math.max(1, n)); }).join(',');
                } catch (e) { info += ' (cannot read pixels: ' + e.message + ')'; }
                return info;
            }
            cur = cur._parents && cur._parents[0];
        }
        return 'no Matcap texture found on the mesh or its ancestors';
    }

    // first mesh of each of the first 4 distinct material ancestors
    var seen = [], shown = 0;
    am.forEach(function (o, i) {
        if (shown >= 4) return;
        // The mesh itself or an ancestor; newer viewers wrap the attribute (AttributePair._object).
        var cur = o, depth = 0, ss = null, holder = null, mat = null;
        while (cur && depth <= 12) {
            var s2 = cur.stateset || cur._stateSet;
            var a0 = unwrap(s2 && s2._attributeArray && s2._attributeArray[0]);
            if (a0 && a0._materialModel) { ss = s2; holder = cur; mat = a0; break; }
            cur = cur._parents && cur._parents[0];
            depth++;
        }
        if (!ss || seen.indexOf(ss) !== -1) return;
        seen.push(ss);
        shown++;
        var mm = mat._materialModel, at = mm.attributes || {};
        L('--- ' + (holder._name || 'material') + ' (first mesh ' + i + ' ' + (o._name || '') + ') ---');
        L('  channelMapping: ' + J(mat._channelMapping, 1, 500));
        L('  activeChannels: ' + J(mat._activeChannels, 1, 200));
        L('  model attribute keys: ' + Object.keys(at).join(','));
        var ch = at.channels || {};
        Object.keys(ch).forEach(function (k) {
            L('  channel ' + k + ': ' + J(ch[k], 3, 400));
        });
        ['name', 'blendType', 'alphaMode', 'doubleSided', 'cullFace', 'useLight', 'flipTangent'].forEach(function (k) {
            if (at[k] !== undefined) L('  ' + k + ' = ' + J(at[k], 1, 100));
        });
        var osgMat = unwrap(ss._attributeArray[17]);
        if (osgMat) L('  osg.Material diffuse=' + J(osgMat._diffuse, 1, 80) + ' ambient=' + J(osgMat._ambient, 1, 80) +
                      ' specular=' + J(osgMat._specular, 1, 80) + ' shininess=' + osgMat._shininess);
        if (ch.Matcap) L('  ' + matcapInfo(o));
        var atlas = mat._stateSetContext && mat._stateSetContext._colorAtlas;
        if (atlas) L('  colorAtlas keys: ' + Object.keys(atlas).slice(0, 25).join(','));
    });
    if (!shown) L('no material model found on any mesh or its ancestors');
    return lines.join('\n');   // the console shows this text: copy it and send it
})();
