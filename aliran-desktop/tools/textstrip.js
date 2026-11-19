/* Remove specific text from a PDF page's content stream (Acrobat-style text editing).
   TextStrip.strip(PDFLib, pdfPage, targets) -> { removed: number[] }   (glyphs removed per target)
   A target is the user-space line box of a text run: { o:[x,y], d:[dx,dy] (unit), uw, fh }.
   Only the matching glyphs are taken out; paths, lines, images and other text are untouched. */
const TextStrip = (() => {
  const WS = new Set([0, 9, 10, 12, 13, 32]);
  const DELIM = new Set([...'()<>[]{}/%'].map(c => c.charCodeAt(0)));
  const asStr = (b, s, e) => { let o = ''; for (let i = s; i < e; i++) o += String.fromCharCode(b[i]); return o; };

  function tokenize(b) {
    const n = b.length, ins = []; let i = 0, args = [];
    const skipWS = () => { while (i < n) { const c = b[i]; if (WS.has(c)) i++; else if (c === 37) { while (i < n && b[i] !== 10 && b[i] !== 13) i++; } else break; } };
    const readObj = () => {
      const c = b[i], st = i;
      if (c === 40) {
        let depth = 1; i++; const out = [];
        while (i < n && depth > 0) {
          const ch = b[i++];
          if (ch === 92) {
            const nx = b[i++];
            if (nx === 110) out.push(10); else if (nx === 114) out.push(13); else if (nx === 116) out.push(9); else if (nx === 98) out.push(8); else if (nx === 102) out.push(12);
            else if (nx === 13) { if (b[i] === 10) i++; } else if (nx === 10) { }
            else if (nx >= 48 && nx <= 55) { let v = nx - 48; for (let k = 0; k < 2 && b[i] >= 48 && b[i] <= 55; k++) v = v * 8 + (b[i++] - 48); out.push(v & 255); }
            else out.push(nx);
          } else if (ch === 40) { depth++; out.push(ch); }
          else if (ch === 41) { depth--; if (depth > 0) out.push(ch); }
          else out.push(ch);
        }
        return { t: 'str', bytes: new Uint8Array(out), s: st, e: i };
      }
      if (c === 60 && b[i + 1] === 60) {
        let depth = 0;
        while (i < n) {
          if (b[i] === 60 && b[i + 1] === 60) { depth++; i += 2; }
          else if (b[i] === 62 && b[i + 1] === 62) { depth--; i += 2; if (depth === 0) break; }
          else if (b[i] === 40) readObj();
          else i++;
        }
        return { t: 'dict', s: st, e: i };
      }
      if (c === 60) {
        i++; let hs = '';
        while (i < n && b[i] !== 62) { const ch = b[i++]; if (!WS.has(ch)) hs += String.fromCharCode(ch); }
        i++; if (hs.length % 2) hs += '0';
        const out = new Uint8Array(hs.length / 2); for (let k = 0; k < out.length; k++) out[k] = parseInt(hs.substr(k * 2, 2), 16) || 0;
        return { t: 'str', bytes: out, s: st, e: i };
      }
      if (c === 91) {
        i++; const items = [];
        for (;;) { skipWS(); if (i >= n) break; if (b[i] === 93) { i++; break; } items.push(readObj()); }
        return { t: 'arr', items, s: st, e: i };
      }
      if (c === 47) { i++; while (i < n && !WS.has(b[i]) && !DELIM.has(b[i])) i++; return { t: 'name', v: asStr(b, st + 1, i), s: st, e: i }; }
      while (i < n && !WS.has(b[i]) && !DELIM.has(b[i])) i++;
      if (i === st) { i++; return { t: 'junk', s: st, e: i }; }
      const w = asStr(b, st, i);
      if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(w)) return { t: 'num', v: parseFloat(w), s: st, e: i };
      return { t: 'op', v: w, s: st, e: i };
    };
    for (;;) {
      skipWS(); if (i >= n) break;
      const tok = readObj();
      if (tok.t !== 'op') { args.push(tok); continue; }
      const s = args.length ? args[0].s : tok.s;
      if (tok.v === 'BI') {
        for (;;) { skipWS(); if (i >= n) break; const t2 = readObj(); if (t2.t === 'op' && t2.v === 'ID') break; }
        i++;
        while (i < n) { if (b[i] === 69 && b[i + 1] === 73 && WS.has(b[i - 1]) && (i + 2 >= n || WS.has(b[i + 2]) || DELIM.has(b[i + 2]))) { i += 2; break; } i++; }
        ins.push({ op: 'BI', args: [], s, e: i });
      } else ins.push({ op: tok.v, args, s, e: tok.e });
      args = [];
    }
    return ins;
  }

  const mul = (A, B) => [A[0] * B[0] + A[1] * B[2], A[0] * B[1] + A[1] * B[3], A[2] * B[0] + A[3] * B[2], A[2] * B[1] + A[3] * B[3], A[4] * B[0] + A[5] * B[2] + B[4], A[4] * B[1] + A[5] * B[3] + B[5]];
  const I = [1, 0, 0, 1, 0, 0];

  // ---- fonts: code length and glyph widths (only used to locate glyphs) ----
  const stdCache = {};
  async function stdWidths(L, base) {
    const b = (base || '').replace(/^[A-Z]{6}\+/, '');
    let fam = /courier|mono/i.test(b) ? 'Courier' : /times|roman|serif|georgia|garamond|minion/i.test(b) && !/sans/i.test(b) ? 'TimesRoman' : 'Helvetica';
    const bold = /bold|black|heavy|semibold|demi/i.test(b), it = /italic|oblique/i.test(b);
    const key = fam === 'TimesRoman' ? (bold && it ? 'TimesRomanBoldItalic' : bold ? 'TimesRomanBold' : it ? 'TimesRomanItalic' : 'TimesRoman')
      : (fam + (bold && it ? 'BoldOblique' : bold ? 'Bold' : it ? 'Oblique' : ''));
    if (!stdCache[key]) stdCache[key] = (async () => {
      const doc = await L.PDFDocument.create(); const f = await doc.embedFont(L.StandardFonts[key] || L.StandardFonts.Helvetica);
      const w = new Float64Array(256).fill(0.5);
      for (let c = 32; c < 256; c++) { if (c > 126 && c < 160) continue; try { w[c] = f.widthOfTextAtSize(String.fromCharCode(c), 1000) / 1000; } catch (e) { } }
      return w;
    })();
    return stdCache[key];
  }
  async function fontInfo(L, ctx, res, name) {
    const N = x => L.PDFName.of(x);
    const fonts = res && res.lookup(N('Font'));
    const fd = fonts instanceof L.PDFDict ? fonts.lookup(N(name)) : null;
    if (!(fd instanceof L.PDFDict)) return { bad: true };
    const sub = fd.lookup(N('Subtype'));
    const num = v => (v && v.asNumber) ? v.asNumber() : 0;
    if (sub === N('Type0')) {
      const enc = fd.lookup(N('Encoding'));
      if (enc !== N('Identity-H')) return { bad: true };
      const dfs = fd.lookup(N('DescendantFonts')); const df = dfs instanceof L.PDFArray ? dfs.lookup(0) : null;
      const DW = df && df.lookup(N('DW')) ? num(df.lookup(N('DW'))) : 1000;
      const W = new Map(); const wa = df && df.lookup(N('W'));
      if (wa instanceof L.PDFArray) {
        for (let k = 0; k < wa.size();) {
          const a = num(wa.lookup(k)), nx = wa.lookup(k + 1);
          if (nx instanceof L.PDFArray) { for (let j = 0; j < nx.size(); j++) W.set(a + j, num(nx.lookup(j))); k += 2; }
          else { const last = num(nx), w = num(wa.lookup(k + 2)); for (let c = a; c <= last && c - a < 65536; c++) W.set(c, w); k += 3; }
        }
      }
      return { bytes: 2, width: c => (W.has(c) ? W.get(c) : DW) / 1000 };
    }
    if (sub === N('Type3')) return { bad: true };
    const widths = fd.lookup(N('Widths'));
    if (widths instanceof L.PDFArray) {
      const fc = num(fd.lookup(N('FirstChar'))); const desc = fd.lookup(N('FontDescriptor'));
      const miss = desc instanceof L.PDFDict && desc.lookup(N('MissingWidth')) ? num(desc.lookup(N('MissingWidth'))) : 0;
      const arr = []; for (let k = 0; k < widths.size(); k++) arr.push(num(widths.lookup(k)));
      return { bytes: 1, width: c => ((c >= fc && c - fc < arr.length) ? arr[c - fc] : miss) / 1000 };
    }
    const base = fd.lookup(N('BaseFont')); const w = await stdWidths(L, base ? base.asString() : '');
    return { bytes: 1, width: c => w[c] };
  }

  function contentBytes(L, page) {
    const c = page.node.Contents(); const parts = [];
    const one = s => { if (s instanceof L.PDFRawStream) parts.push(L.decodePDFRawStream(s).decode()); else if (s && s.getContents) parts.push(s.getContents()); };
    if (c instanceof L.PDFArray) { for (let k = 0; k < c.size(); k++) one(c.lookup(k)); } else one(c);
    const total = parts.reduce((a, p) => a + p.length + 1, 0), out = new Uint8Array(total); let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; out[o++] = 10; }
    return out;
  }

  const hex = b => { let s = '<'; for (const x of b) s += (x < 16 ? '0' : '') + x.toString(16); return s + '>'; };
  const fmt = v => (Math.round(v * 1000) / 1000).toString();

  async function strip(L, page, targets) {
    const removed = targets.map(() => 0);
    if (!targets.length) return { removed };
    const ctx = page.doc.context; const res = page.node.Resources();
    const b = contentBytes(L, page); const ins = tokenize(b);
    const fonts = {};
    for (const it of ins) if (it.op === 'Tf' && it.args[0] && it.args[0].t === 'name' && !(it.args[0].v in fonts)) fonts[it.args[0].v] = await fontInfo(L, ctx, res, it.args[0].v);

    // which glyphs fall inside the targets
    const match = (gx, gy, ex, ey) => {
      const cx = (gx + ex) / 2, cy = (gy + ey) / 2, adx = ex - gx, ady = ey - gy, al = Math.hypot(adx, ady);
      for (let t = 0; t < targets.length; t++) {
        const T = targets[t], fh = T.fh || 10, dx = T.d[0], dy = T.d[1];
        if (al > 1e-6 && (adx * dx + ady * dy) / al < 0.9) continue;
        const rx = cx - T.o[0], ry = cy - T.o[1];
        const u = rx * dx + ry * dy, v = -rx * dy + ry * dx;
        if (u >= -0.2 * fh && u <= T.uw + 0.2 * fh && Math.abs(v) < 0.35 * fh) return t;
      }
      return -1;
    };
    let gs = { ctm: I, Tc: 0, Tw: 0, Th: 1, TL: 0, font: null, Tfs: 0, Ts: 0, Tr: 0 };
    const stack = []; let Tm = I, Tlm = I;
    const shows = []; // {k (instruction), elems:[{kind:'str'|'num', tok, glyphs:[{s,e,rm}]}], Tr}
    const td = (tx, ty) => { Tlm = mul([1, 0, 0, 1, tx, ty], Tlm); Tm = Tlm; };
    const showStr = (tok, gl) => {
      const f = gs.font; const bytes = tok.bytes;
      if (!f || f.bad) { gl.bad = true; return; }
      for (let p = 0; p + f.bytes <= bytes.length; p += f.bytes) {
        const code = f.bytes === 2 ? (bytes[p] << 8) | bytes[p + 1] : bytes[p];
        const trm = mul([gs.Tfs * gs.Th, 0, 0, gs.Tfs, 0, gs.Ts], mul(Tm, gs.ctm));
        const tx = (f.width(code) * gs.Tfs + gs.Tc + (f.bytes === 1 && code === 32 ? gs.Tw : 0)) * gs.Th;
        Tm = mul([1, 0, 0, 1, tx, 0], Tm);
        const trm2 = mul([gs.Tfs * gs.Th, 0, 0, gs.Tfs, 0, gs.Ts], mul(Tm, gs.ctm));
        const t = gs.Tr === 3 ? -1 : match(trm[4], trm[5], trm2[4], trm2[5]);
        if (t >= 0) removed[t]++;
        gl.push({ s: p, e: p + f.bytes, rm: t >= 0 });
      }
    };
    for (let k = 0; k < ins.length; k++) {
      const { op, args } = ins[k]; const a = i => (args[i] && args[i].t === 'num') ? args[i].v : 0;
      switch (op) {
        case 'q': stack.push({ ...gs }); break;
        case 'Q': if (stack.length) gs = stack.pop(); break;
        case 'cm': gs.ctm = mul([a(0), a(1), a(2), a(3), a(4), a(5)], gs.ctm); break;
        case 'BT': Tm = Tlm = I; break;
        case 'Tm': Tm = Tlm = [a(0), a(1), a(2), a(3), a(4), a(5)]; break;
        case 'Td': td(a(0), a(1)); break;
        case 'TD': gs.TL = -a(1); td(a(0), a(1)); break;
        case 'T*': td(0, -gs.TL); break;
        case 'Tc': gs.Tc = a(0); break;
        case 'Tw': gs.Tw = a(0); break;
        case 'Tz': gs.Th = a(0) / 100; break;
        case 'TL': gs.TL = a(0); break;
        case 'Ts': gs.Ts = a(0); break;
        case 'Tr': gs.Tr = a(0); break;
        case 'Tf': gs.font = args[0] && fonts[args[0].v] || { bad: true }; gs.Tfs = a(1); break;
        case 'Tj': case "'": case '"': case 'TJ': {
          if (op === "'") td(0, -gs.TL);
          if (op === '"') { gs.Tw = a(0); gs.Tc = a(1); td(0, -gs.TL); }
          const sh = { k, op, elems: [], Tr: gs.Tr };
          const strTok = op === 'TJ' ? null : args[args.length - 1];
          const list = op === 'TJ' ? ((args[0] && args[0].t === 'arr') ? args[0].items : []) : (strTok ? [strTok] : []);
          for (const tok of list) {
            if (tok.t === 'num') { Tm = mul([1, 0, 0, 1, -tok.v / 1000 * gs.Tfs * gs.Th, 0], Tm); sh.elems.push({ kind: 'num', tok }); }
            else if (tok.t === 'str') { const gl = []; showStr(tok, gl); sh.elems.push({ kind: 'str', tok, glyphs: gl }); }
          }
          if (sh.elems.some(e => e.glyphs && !e.glyphs.bad && e.glyphs.some(g => g.rm))) shows.push(sh);
          break;
        }
      }
    }
    if (!shows.length) return { removed };

    // does any later text depend on where this instruction leaves the text cursor?
    const REPOS = new Set(['Td', 'TD', 'Tm', 'T*', 'ET', 'BT', "'", '"']);
    const dependsAfter = k => { for (let j = k + 1; j < ins.length; j++) { const o = ins[j].op; if (REPOS.has(o)) return false; if (o === 'Tj' || o === 'TJ') return true; } return false; };

    const repl = new Map();
    for (const sh of shows) {
      const dep = dependsAfter(sh.k);
      // flatten into a sequence of pieces: {num} or {bytes, rm}
      const seq = [];
      for (const el of sh.elems) {
        if (el.kind === 'num') { seq.push({ num: el.tok.v }); continue; }
        if (el.glyphs.bad) { seq.push({ bytes: el.tok.bytes, rm: false }); continue; }
        let cur = null;
        for (const g of el.glyphs) {
          if (!cur || cur.rm !== g.rm) { cur = { s: g.s, e: g.e, rm: g.rm, src: el.tok.bytes }; seq.push(cur); } else cur.e = g.e;
        }
      }
      for (const p of seq) if (p.src) p.bytes = p.src.slice(p.s, p.e);
      // trailing removable pieces can simply be dropped when nothing depends on them
      let lastKeep = -1; seq.forEach((p, i) => { if (p.bytes && !p.rm) lastKeep = i; });
      const out = [];
      if (sh.op === "'") out.push('T*');
      if (sh.op === '"') { const A = ins[sh.k].args; out.push(`${fmt(A[0].v)} Tw ${fmt(A[1].v)} Tc T*`); }
      let run = [], runRm = null;
      const flush = () => {
        if (!run.length) return;
        const body = '[' + run.map(p => p.num != null ? fmt(p.num) : hex(p.bytes)).join(' ') + '] TJ';
        out.push(runRm ? `3 Tr ${body} ${fmt(sh.Tr)} Tr` : body); run = [];
      };
      seq.forEach((p, i) => {
        if (!dep && i > lastKeep && (p.rm || p.num != null)) return; // nothing visible follows: drop
        const rm = p.num != null ? (runRm == null ? false : runRm) : p.rm;
        if (runRm !== null && rm !== runRm) flush();
        runRm = rm; run.push(p);
      });
      flush();
      repl.set(sh.k, out.join(' '));
    }
    // rebuild the content stream
    const enc = new TextEncoder(); const chunks = []; let cur = 0;
    for (let k = 0; k < ins.length; k++) {
      if (!repl.has(k)) continue;
      const it = ins[k]; chunks.push(b.subarray(cur, it.s)); chunks.push(enc.encode(repl.get(k))); cur = it.e;
    }
    chunks.push(b.subarray(cur));
    const len = chunks.reduce((s, c) => s + c.length, 0), nb = new Uint8Array(len); let o = 0;
    for (const c of chunks) { nb.set(c, o); o += c.length; }
    page.node.set(L.PDFName.of('Contents'), ctx.register(ctx.flateStream(nb)));
    return { removed };
  }
  // Make every piece of text invisible (render mode 3) while keeping lines, shapes and pictures.
  function hideBytes(b) {
    const ins = tokenize(b), enc = new TextEncoder(), chunks = []; let cur = 0;
    for (const it of ins) {
      const r = it.op === 'BT' ? 'BT 3 Tr' : it.op === 'Tr' ? '3 Tr' : null; if (!r) continue;
      chunks.push(b.subarray(cur, it.s), enc.encode(r)); cur = it.e;
    }
    chunks.push(b.subarray(cur));
    const len = chunks.reduce((s, c) => s + c.length, 0), nb = new Uint8Array(len); let o = 0;
    for (const c of chunks) { nb.set(c, o); o += c.length; }
    return nb;
  }
  function hideAll(L, page) {
    const ctx = page.doc.context, N = n => L.PDFName.of(n), seen = new Set();
    page.node.set(N('Contents'), ctx.register(ctx.flateStream(hideBytes(contentBytes(L, page)))));
    const walk = res => {
      if (!(res instanceof L.PDFDict)) return;
      const xo = res.lookup(N('XObject')); if (!(xo instanceof L.PDFDict)) return;
      for (const [, ref] of xo.entries()) {
        if (!(ref instanceof L.PDFRef) || seen.has(ref.tag)) continue; seen.add(ref.tag);
        const st = ctx.lookup(ref); if (!st || !st.dict || st.dict.lookup(N('Subtype')) !== N('Form')) continue;
        let raw; try { raw = st instanceof L.PDFRawStream ? L.decodePDFRawStream(st).decode() : st.getContents(); } catch (e) { continue; }
        const ns = ctx.flateStream(hideBytes(raw));
        for (const [k, v] of st.dict.entries()) if (k !== N('Filter') && k !== N('DecodeParms') && k !== N('Length')) ns.dict.set(k, v);
        ctx.assign(ref, ns);
        walk(st.dict.lookup(N('Resources')));
      }
    };
    walk(page.node.Resources());
  }
  return { strip, tokenize, hideAll };
})();
if (typeof module !== 'undefined') module.exports = TextStrip;
