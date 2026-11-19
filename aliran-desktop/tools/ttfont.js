/* Minimal TrueType / OpenType reader + PDF embedding (no fontkit needed).
   TTFont.parse(bytes) -> font { upm, ascent, descent, gid(cp), adv(gid), width(str,size), ... }
   TTFont.embed(PDFLib, pdfDoc, font, usedMap(gid->codepoint), ref?) -> PDFRef of a Type0 font
   TrueType outlines are subset (unused glyphs emptied); CFF fonts are embedded whole. */
const TTFont = (() => {
  function parse(bytes) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const u16 = o => dv.getUint16(o), i16 = o => dv.getInt16(o), u32 = o => dv.getUint32(o);
    const n = u16(4), T = {};
    for (let i = 0; i < n; i++) { const o = 12 + i * 16; T[String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3])] = { off: u32(o + 8), len: u32(o + 12) }; }
    const need = t => { if (!T[t]) throw new Error('font is missing the ' + t + ' table'); return T[t].off; };
    const head = need('head'), hhea = need('hhea'), maxp = need('maxp'), hmtx = need('hmtx');
    const f = { bytes: b, T, cff: !!T['CFF '] && !T.glyf };
    f.upm = u16(head + 18);
    f.bbox = [i16(head + 36), i16(head + 38), i16(head + 40), i16(head + 42)];
    f.locLong = i16(head + 50) === 1;
    f.ascent = i16(hhea + 4); f.descent = i16(hhea + 6);
    f.numGlyphs = u16(maxp + 4);
    const nh = u16(hhea + 34), adv = new Uint16Array(f.numGlyphs);
    for (let g = 0; g < f.numGlyphs; g++) adv[g] = u16(hmtx + 4 * Math.min(g, nh - 1));
    f.advs = adv;
    f.capHeight = f.ascent * 0.7; f.italicAngle = 0; f.fixed = false; f.weight = 400;
    if (T['OS/2']) { const o = T['OS/2'].off, ver = u16(o); f.weight = u16(o + 4); if (ver >= 2 && T['OS/2'].len >= 90) f.capHeight = i16(o + 88) || f.capHeight; }
    if (T.post) { f.italicAngle = dv.getInt32(T.post.off + 4) / 65536; f.fixed = u32(T.post.off + 12) !== 0; }
    // PostScript name
    f.psName = 'AliranFont';
    if (T.name) {
      const o = T.name.off, cnt = u16(o + 2), so = o + u16(o + 4);
      for (let i = 0; i < cnt; i++) {
        const r = o + 6 + i * 12; if (u16(r + 6) !== 6) continue;
        const plat = u16(r), len = u16(r + 8), off = so + u16(r + 10); let s = '';
        if (plat === 3 || plat === 0) for (let k = 0; k < len; k += 2) s += String.fromCharCode(u16(off + k)); else for (let k = 0; k < len; k++) s += String.fromCharCode(b[off + k]);
        s = s.replace(/[^\x21-\x7e]/g, '').replace(/[\[\](){}<>\/%#]/g, ''); if (s) { f.psName = s; if (plat === 3) break; }
      }
    }
    // cmap: prefer full Unicode (format 12), else BMP (format 4)
    const cm = need('cmap'), nt = u16(cm + 2); let sub4 = 0, sub12 = 0;
    for (let i = 0; i < nt; i++) {
      const r = cm + 4 + i * 8, p = u16(r), e = u16(r + 2), o = cm + u32(r + 4), fmt = u16(o);
      if (fmt === 12 && (p === 3 && e === 10 || p === 0)) sub12 = o;
      if (fmt === 4 && (p === 3 && (e === 1 || e === 0) || p === 0)) sub4 = sub4 || o;
    }
    const map = new Map();
    if (sub12) {
      const groups = u32(sub12 + 12);
      for (let i = 0; i < groups; i++) { const g = sub12 + 16 + i * 12, s = u32(g), e = u32(g + 4), sg = u32(g + 8); for (let c = s; c <= e && c - s < 70000; c++) map.set(c, sg + c - s); }
    } else if (sub4) {
      const segX2 = u16(sub4 + 6), ends = sub4 + 14, starts = ends + segX2 + 2, deltas = starts + segX2, ranges = deltas + segX2;
      for (let s = 0; s < segX2 / 2; s++) {
        const end = u16(ends + 2 * s), start = u16(starts + 2 * s), delta = i16(deltas + 2 * s), ro = u16(ranges + 2 * s);
        for (let c = start; c <= end && c !== 0xFFFF; c++) {
          let g;
          if (ro === 0) g = (c + delta) & 0xFFFF;
          else { const a = ranges + 2 * s + ro + 2 * (c - start); g = a + 1 < b.length ? u16(a) : 0; if (g) g = (g + delta) & 0xFFFF; }
          if (g) map.set(c, g);
        }
      }
    }
    f.cmap = map;
    f.gid = cp => map.get(cp) || 0;
    f.adv = g => f.advs[g] || 0;
    f.width = (str, size) => { let w = 0; for (const ch of str) w += f.advs[f.gid(ch.codePointAt(0))]; return w * size / f.upm; };
    f.has = str => { for (const ch of str) if (!/\s/.test(ch) && !map.has(ch.codePointAt(0))) return false; return true; };
    return f;
  }

  // ---- TrueType subsetting: keep glyph ids, empty glyphs that are not used ----
  function subset(f, used) {
    const b = f.bytes, dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const glyf = f.T.glyf.off, loca = f.T.loca.off;
    const locAt = g => f.locLong ? dv.getUint32(loca + 4 * g) : dv.getUint16(loca + 2 * g) * 2;
    const keep = new Set([0, ...used]);
    const stack = [...keep];
    while (stack.length) { // composite glyph components
      const g = stack.pop(); if (g >= f.numGlyphs) continue;
      const s = locAt(g), e = locAt(g + 1); if (e - s < 10 || dv.getInt16(glyf + s) >= 0) continue;
      let p = glyf + s + 10;
      for (;;) {
        const flags = dv.getUint16(p), cg = dv.getUint16(p + 2); p += 4;
        if (!keep.has(cg)) { keep.add(cg); stack.push(cg); }
        p += (flags & 1) ? 4 : 2;
        if (flags & 8) p += 2; else if (flags & 0x40) p += 4; else if (flags & 0x80) p += 8;
        if (!(flags & 0x20)) break;
      }
    }
    const parts = [], newLoca = new Uint32Array(f.numGlyphs + 1); let pos = 0;
    for (let g = 0; g < f.numGlyphs; g++) {
      newLoca[g] = pos;
      if (keep.has(g)) { const s = locAt(g), e = locAt(g + 1); if (e > s) { const d = b.subarray(glyf + s, glyf + e); parts.push(d); pos += d.length; const pad = (4 - (d.length % 4)) % 4; if (pad) { parts.push(new Uint8Array(pad)); pos += pad; } } }
    }
    newLoca[f.numGlyphs] = pos;
    const glyfNew = new Uint8Array(pos); let o = 0; for (const p of parts) { glyfNew.set(p, o); o += p.length; }
    const locaNew = new Uint8Array(4 * (f.numGlyphs + 1)); const ldv = new DataView(locaNew.buffer); newLoca.forEach((v, i) => ldv.setUint32(4 * i, v));
    const headNew = b.slice(f.T.head.off, f.T.head.off + f.T.head.len); new DataView(headNew.buffer).setInt16(50, 1); new DataView(headNew.buffer).setUint32(8, 0);
    const tables = { glyf: glyfNew, loca: locaNew, head: headNew };
    for (const t of ['cmap', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'prep', 'gasp']) if (f.T[t]) tables[t] = b.subarray(f.T[t].off, f.T[t].off + f.T[t].len);
    return buildSfnt(tables, 0x00010000);
  }
  function buildSfnt(tables, version) {
    const tags = Object.keys(tables).sort(), n = tags.length;
    let pos = 12 + 16 * n; const offs = [];
    for (const t of tags) { offs.push(pos); pos += (tables[t].length + 3) & ~3; }
    const out = new Uint8Array(pos), dv = new DataView(out.buffer);
    dv.setUint32(0, version); dv.setUint16(4, n);
    let es = 0; while ((1 << (es + 1)) <= n) es++;
    dv.setUint16(6, (1 << es) * 16); dv.setUint16(8, es); dv.setUint16(10, n * 16 - (1 << es) * 16);
    tags.forEach((t, i) => {
      const d = tables[t], r = 12 + 16 * i;
      for (let k = 0; k < 4; k++) out[r + k] = t.charCodeAt(k);
      out.set(d, offs[i]);
      let sum = 0; for (let k = 0; k < ((d.length + 3) & ~3); k += 4) sum = (sum + dv.getUint32(offs[i] + k)) >>> 0;
      dv.setUint32(r + 4, sum); dv.setUint32(r + 8, offs[i]); dv.setUint32(r + 12, d.length);
    });
    return out;
  }

  const hex4 = n => n.toString(16).padStart(4, '0');
  function toUnicodeCMap(used) {
    const ents = [...used.entries()].sort((a, b) => a[0] - b[0]);
    let body = '';
    for (let i = 0; i < ents.length; i += 100) {
      const chunk = ents.slice(i, i + 100);
      body += `${chunk.length} beginbfchar\n` + chunk.map(([g, cp]) => {
        const s = String.fromCodePoint(cp); let h = ''; for (let k = 0; k < s.length; k++) h += hex4(s.charCodeAt(k));
        return `<${hex4(g)}> <${h}>`;
      }).join('\n') + '\nendbfchar\n';
    }
    return `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n${body}endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend`;
  }
  function embed(L, doc, f, used, ref) {
    const ctx = doc.context, N = x => L.PDFName.of(x);
    const tag = Array.from({ length: 6 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('');
    const base = `${tag}+${f.psName}`, k = 1000 / f.upm;
    const prog = f.cff ? f.bytes : subset(f, [...used.keys()]);
    const fileStream = ctx.flateStream(prog, f.cff ? { Subtype: 'OpenType' } : { Length1: prog.length });
    const flags = (f.fixed ? 1 : 0) | 32 | (f.italicAngle ? 64 : 0);
    const desc = ctx.obj({
      Type: 'FontDescriptor', FontName: base, Flags: flags,
      FontBBox: f.bbox.map(v => Math.round(v * k)), ItalicAngle: f.italicAngle,
      Ascent: Math.round(f.ascent * k), Descent: Math.round(f.descent * k), CapHeight: Math.round(f.capHeight * k), StemV: f.weight > 600 ? 140 : 80,
    });
    desc.set(N(f.cff ? 'FontFile3' : 'FontFile2'), ctx.register(fileStream));
    const W = []; const gids = [...used.keys()].sort((a, b) => a - b);
    for (const g of gids) W.push(g, [Math.round(f.adv(g) * k)]);
    const cid = ctx.obj({
      Type: 'Font', Subtype: f.cff ? 'CIDFontType0' : 'CIDFontType2', BaseFont: base,
      CIDSystemInfo: { Registry: L.PDFString.of('Adobe'), Ordering: L.PDFString.of('Identity'), Supplement: 0 },
      FontDescriptor: ctx.register(desc), DW: Math.round(f.adv(0) * k) || 1000, W,
    });
    if (!f.cff) cid.set(N('CIDToGIDMap'), N('Identity'));
    const tu = ctx.flateStream(new TextEncoder().encode(toUnicodeCMap(used)));
    const t0 = ctx.obj({ Type: 'Font', Subtype: 'Type0', BaseFont: base, Encoding: 'Identity-H', DescendantFonts: [ctx.register(cid)], ToUnicode: ctx.register(tu) });
    if (ref) { ctx.assign(ref, t0); return ref; }
    return ctx.register(t0);
  }
  // Encode a string as 2-byte glyph ids, recording what was used (for subsetting and copy/search).
  function encode(f, str, used) {
    let h = '';
    for (const ch of str) { const cp = ch.codePointAt(0), g = f.gid(cp); if (!used.has(g)) used.set(g, g ? cp : 0xFFFD); h += hex4(g); }
    return h;
  }
  return { parse, embed, encode, subset };
})();
if (typeof module !== 'undefined') module.exports = TTFont;
