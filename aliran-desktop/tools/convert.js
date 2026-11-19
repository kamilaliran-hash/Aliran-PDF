/* ================= Convert: export PDF to Word, Excel, PowerPoint, images and other formats ================= */
const CV = { opts: null, fmt: 'word', sub: { word: 'docx', ppt: 'pptx', excel: 'xlsx', image: 'jpeg', other: 'rtf' } };
const CVFMT = {
  docx: { ext: 'docx', label: 'DOCX', name: 'Word Document' }, doc: { ext: 'doc', label: 'DOC', name: 'Word 97-2003 Document' },
  pptx: { ext: 'pptx', label: 'PPTX', name: 'PowerPoint Presentation' },
  xlsx: { ext: 'xlsx', label: 'XLSX', name: 'Excel Workbook' }, xml2003: { ext: 'xml', label: 'XML', name: 'XML Spreadsheet 2003' },
  jpeg: { ext: 'jpg', label: 'JPEG', name: 'JPEG image' }, png: { ext: 'png', label: 'PNG', name: 'PNG image' }, tiff: { ext: 'tif', label: 'TIFF', name: 'TIFF image' },
  rtf: { ext: 'rtf', label: 'RTF', name: 'Rich Text Format' }, html: { ext: 'html', label: 'HTML', name: 'HTML web page' },
  txt: { ext: 'txt', label: 'TXT', name: 'Text (plain)' }, txta: { ext: 'txt', label: 'TXT', name: 'Text (accessible)' },
  xml: { ext: 'xml', label: 'XML', name: 'XML 1.0' }, ps: { ext: 'ps', label: 'PS', name: 'PostScript' }, eps: { ext: 'eps', label: 'EPS', name: 'Encapsulated PostScript' },
};
function cvOpts() {
  if (!CV.opts) { let o = {}; try { o = JSON.parse(localStorage.getItem('aliran.cvopts') || '{}'); } catch (e) { } CV.opts = { layout: 'flow', dpi: 150, psdpi: 300, q: 0.9, sheet: 'page', images: true, ocr: true, lang: '', ...o }; }
  return CV.opts;
}
function saveCvOpts() { try { localStorage.setItem('aliran.cvopts', JSON.stringify(CV.opts)); } catch (e) { } }
const xe = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '');
const EMU = 12700, TW = 20;
const cvSay = m => { const e = $('#busyMsg'); if (e) e.textContent = m; };

/* ---------- reading the document ---------- */
function cvFont(it) {
  const n = (it.fname || '').replace(/^[A-Z]{6}\+/, '');
  const base = n.split(/[-,]/)[0].replace(/(PSMT|MT|PS)$/, '');
  const map = { TimesNewRoman: 'Times New Roman', Times: 'Times New Roman', TimesRoman: 'Times New Roman', Helvetica: 'Arial', Arial: 'Arial', ArialNarrow: 'Arial Narrow', CourierNew: 'Courier New', Courier: 'Courier New', Symbol: 'Symbol', ZapfDingbats: 'Wingdings' };
  if (map[base]) return map[base];
  if (!base || /^(g_|f\d|t\d|tt\d|c\d|font)/i.test(base) || base.length < 3) return it.fam === 'Times' ? 'Times New Roman' : it.fam === 'Courier' ? 'Courier New' : 'Arial';
  return base.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ');
}
async function cvRender(pg, sc, maxPx = 36e6) {
  let vp = pg.getViewport({ scale: sc });
  if (vp.width * vp.height > maxPx) vp = pg.getViewport({ scale: sc * Math.sqrt(maxPx / (vp.width * vp.height)) });
  const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(vp.width)); c.height = Math.max(1, Math.round(vp.height));
  const cx = c.getContext('2d', { willReadFrequently: true }); cx.fillStyle = '#fff'; cx.fillRect(0, 0, c.width, c.height);
  await pg.render({ canvasContext: cx, viewport: vp }).promise;
  c._sc = c.width / pg.getViewport({ scale: 1 }).width;
  return c;
}
function cvTextItems(pg, tc, vp) {
  const items = [];
  tc.items.forEach((it, k) => {
    if (!it.str || !it.str.trim()) return;
    const tx = pdfjsLib.Util.transform(vp.transform, it.transform);
    const fh = Math.hypot(tx[2], tx[3]); if (fh < 0.5) return;
    const st = tc.styles[it.fontName] || {};
    let fname = '', bold = false, italic = false;
    try { if (pg.commonObjs.has(it.fontName)) { const fo = pg.commonObjs.get(it.fontName); fname = fo.name || ''; bold = !!fo.bold; italic = !!fo.italic; } } catch (e) { }
    if (/bold|black|heavy|semibold|demi/i.test(fname)) bold = true;
    if (/italic|oblique/i.test(fname)) italic = true;
    let fam = 'Helvetica';
    if (/courier|mono|consol/i.test(fname) || st.fontFamily === 'monospace') fam = 'Courier';
    else if (/times|serif|roman|georgia|garamond|minion|cambria|book/i.test(fname.replace(/sans/i, '')) || st.fontFamily === 'serif') fam = 'Times';
    const o = { k, fname, str: it.str.replace(/\u0000/g, ''), x: tx[4], base: tx[5], fh, w: it.width * vp.scale, ang: Math.atan2(tx[1], tx[0]), asc: clamp(st.ascent || 0.8, 0.5, 1.1), desc: clamp(st.descent || -0.2, -0.5, 0), fam, bold, italic };
    o.font = cvFont(o); items.push(o);
  });
  return items;
}
const hex2 = v => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0');
function cvColors(P, c) {
  if (!P.items.length) return;
  const k = c._sc, W = c.width, H = c.height, d = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H).data;
  const L = i => d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
  for (const it of P.items) {
    const len = Math.abs(it.ang) < 0.05 ? 1 : 0; if (!len) { it.color = '000000'; it.bgc = 'ffffff'; continue; }
    const x0 = clamp(Math.floor(it.x * k), 1, W - 2), x1 = clamp(Math.ceil((it.x + it.w) * k), x0 + 1, W - 1);
    const y0 = clamp(Math.floor((it.base - it.fh * 0.8) * k), 1, H - 2), y1 = clamp(Math.ceil((it.base + it.fh * 0.1) * k), y0 + 1, H - 1);
    const ring = [], step = Math.max(1, Math.round((x1 - x0) / 60));
    for (let x = x0; x < x1; x += step) ring.push(((y0 - 1) * W + x) * 4, ((y1) * W + x) * 4);
    for (let y = y0; y < y1; y++) ring.push((y * W + x0 - 1) * 4, (y * W + x1) * 4);
    const ch = q => [0, 1, 2].map(o => { const v = q.map(i => d[i + o]).sort((a, b) => a - b); return v[v.length >> 1]; });
    const bg = ch(ring), bl = bg[0] * 0.299 + bg[1] * 0.587 + bg[2] * 0.114;
    const ink = []; const sy = Math.max(1, Math.round((y1 - y0) / 24)), sx = Math.max(1, Math.round((x1 - x0) / 160));
    for (let y = y0; y < y1; y += sy) for (let x = x0; x < x1; x += sx) { const i = (y * W + x) * 4; const dl = Math.abs(L(i) - bl); if (dl > 50) ink.push([dl, i]); }
    it.bgc = bg.map(hex2).join('');
    if (!ink.length) { it.color = bl < 100 ? 'ffffff' : '000000'; continue; }
    ink.sort((a, b) => b[0] - a[0]); const top = ink.slice(0, Math.max(1, Math.ceil(ink.length * 0.35))).map(x => x[1]);
    const col = ch(top);
    if (Math.max(...col) < 75 && Math.max(...col) - Math.min(...col) < 25) it.color = '000000';
    else it.color = col.map(hex2).join('');
  }
}
function cvImageBoxes(ol, vp) {
  const O = pdfjsLib.OPS, T = pdfjsLib.Util.transform, st = [], boxes = []; let m = vp.transform.slice();
  for (let i = 0; i < ol.fnArray.length; i++) {
    const f = ol.fnArray[i], a = ol.argsArray[i];
    if (f === O.save) st.push(m);
    else if (f === O.restore) m = st.pop() || m;
    else if (f === O.transform) m = T(m, a);
    else if (f === O.paintFormXObjectBegin) { st.push(m); if (a && a[0]) m = T(m, Array.from(a[0])); }
    else if (f === O.paintFormXObjectEnd) m = st.pop() || m;
    else if (f === O.paintImageXObject || f === O.paintInlineImageXObject || f === O.paintImageXObjectRepeat) {
      const pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]);
      const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
      const b = { x: clamp(Math.min(...xs), 0, vp.width), y: clamp(Math.min(...ys), 0, vp.height) };
      b.w = clamp(Math.max(...xs), 0, vp.width) - b.x; b.h = clamp(Math.max(...ys), 0, vp.height) - b.y;
      if (b.w >= 8 && b.h >= 8 && !boxes.some(o => Math.abs(o.x - b.x) < 2 && Math.abs(o.y - b.y) < 2 && Math.abs(o.w - b.w) < 2 && Math.abs(o.h - b.h) < 2)) boxes.push(b);
    }
  }
  return boxes;
}
async function cvCrop(c, b) {
  const k = c._sc, cw = Math.max(1, Math.round(b.w * k)), ch = Math.max(1, Math.round(b.h * k));
  const o = document.createElement('canvas'); o.width = cw; o.height = ch;
  o.getContext('2d').drawImage(c, Math.round(b.x * k), Math.round(b.y * k), cw, ch, 0, 0, cw, ch);
  const png = cw * ch < 250000;
  const data = await readBytes(await canvasBlob(o, png ? 'image/png' : 'image/jpeg', 0.9));
  return { ...b, data, type: png ? 'png' : 'jpeg', pw: cw, ph: ch };
}
async function cvOcrItems(pg, lang) {
  const c = await cvRender(pg, 300 / 72, 16e6);
  const blob = await canvasBlob(c, 'image/png');
  const r = await fetch('/api/ocr?lang=' + encodeURIComponent(lang || ''), { method: 'POST', body: blob });
  const j = await r.json(); if (j.error) throw new Error(j.error);
  const k = 1 / c._sc; c.width = 0;
  return (j.lines || []).filter(l => l.text && l.text.trim() && l.w > 0 && l.h > 0).map((l, i) => {
    const h0 = l.h * k;
    return { k: 'o' + i, fname: '', font: 'Arial', str: l.text.replace(/\s+/g, ' ').trim(), x: l.x * k, base: (l.y + l.h * 0.8) * k, fh: h0 * 0.95, w: l.w * k, ang: 0, asc: 0.8, desc: -0.2, fam: 'Helvetica', bold: false, italic: false, ocr: true };
  });
}
// Walk every page of the document (with all edits applied), handing each one to onPage.
async function cvRun(need, onPage) {
  const bytes = await buildPdf(S.pages);
  const task = pdfjsLib.getDocument({ data: bytes.slice(), isEvalSupported: false, ...DOCOPTS }); const pdf = await task.promise;
  let bgTask = null, bgPdf = null;
  try {
    if (need.bg) {
      cvSay('Separating text from graphics…');
      const d = await PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
      for (const pg of d.getPages()) { try { TextStrip.hideAll(PDFLib, pg); } catch (e) { console.warn('hide text', e); } }
      bgTask = pdfjsLib.getDocument({ data: await d.save(), isEvalSupported: false, ...DOCOPTS }); bgPdf = await bgTask.promise;
    }
    let ocrOk = need.ocr && LOCAL && cvOpts().ocr;
    for (let k = 0; k < pdf.numPages; k++) {
      cvSay(`Converting page ${k + 1} of ${pdf.numPages}…`);
      const pg = await pdf.getPage(k + 1), vp = pg.getViewport({ scale: 1 });
      const P = { n: k + 1, w: vp.width, h: vp.height, items: [], imgs: [] };
      const full = await cvRender(pg, need.scale || 2);
      if (need.text) {
        P.items = cvTextItems(pg, await pg.getTextContent(), vp);
        if (!P.items.length && ocrOk) {
          cvSay(`Recognizing text on page ${k + 1} of ${pdf.numPages}…`);
          try { P.items = await cvOcrItems(pg, cvOpts().lang); P.scanned = true; } catch (e) { console.warn('ocr', e); ocrOk = false; }
        }
        cvColors(P, full);
      }
      if (need.imgs && cvOpts().images) {
        const boxes = cvImageBoxes(await pg.getOperatorList(), vp).filter(b => !(P.scanned && b.w * b.h > P.w * P.h * 0.6));
        for (const b of boxes.slice(0, 60)) P.imgs.push(await cvCrop(full, b));
      }
      if (need.bg) P.bg = P.scanned ? full : await cvRender(await bgPdf.getPage(k + 1), need.bgScale || 2);
      P.full = full;
      await onPage(P);
      if (P.bg && P.bg !== full) P.bg.width = 0;
      full.width = 0;
    }
  } finally {
    try { await task.destroy(); } catch (e) { }
    if (bgTask) try { await bgTask.destroy(); } catch (e) { }
  }
}

/* ---------- layout analysis ---------- */
const BULLET = /^\s*([\u2022\u25cf\u25aa\u25e6\u2023\u2043\u25a0\u25a1\u2013\-*]|\(?\d{1,3}[.)]|\(?[a-zA-Z][.)])\s/;
function cvRuns(items) { // items of one segment, left to right → styled runs
  const runs = []; let prev = null;
  for (const it of items) {
    let t = it.str;
    if (prev) { const gap = it.x - (prev.x + prev.w); if (gap > Math.min(it.fh, prev.fh) * 0.18 && !/\s$/.test(prev.str) && !/^\s/.test(t)) t = ' ' + t; }
    const st = { font: it.font, size: Math.round(it.fh * 2) / 2, bold: it.bold, italic: it.italic, color: it.color || '000000' };
    const last = runs[runs.length - 1];
    if (last && last.font === st.font && last.size === st.size && last.bold === st.bold && last.italic === st.italic && last.color === st.color) last.t += t;
    else runs.push({ t, ...st });
    prev = it;
  }
  return runs;
}
function cvRows(items) {
  const its = items.filter(it => it.str.trim()).sort((a, b) => a.base - b.base || a.x - b.x);
  const rows = [];
  for (const it of its) {
    let r = null;
    for (let j = rows.length - 1; j >= 0 && j >= rows.length - 4; j--) { const q = rows[j]; if (Math.abs(q.base - it.base) < Math.min(q.fh, it.fh) * 0.4) { r = q; break; } }
    if (r) { r.items.push(it); r.fh = Math.max(r.fh, it.fh); } else rows.push({ base: it.base, fh: it.fh, items: [it] });
  }
  for (const r of rows) {
    r.items.sort((a, b) => a.x - b.x);
    const segs = []; let cur = null;
    for (const it of r.items) {
      if (cur && it.x - cur.x1 < Math.max(it.fh, cur.fh) * 1.0) { cur.items.push(it); cur.x1 = Math.max(cur.x1, it.x + it.w); }
      else { cur = { x: it.x, x1: it.x + it.w, fh: it.fh, items: [it] }; segs.push(cur); }
    }
    for (const s of segs) { s.runs = cvRuns(s.items); s.text = s.runs.map(x => x.t).join(''); }
    r.segs = segs; r.x0 = segs[0].x; r.x1 = Math.max(...segs.map(s => s.x1));
    r.top = Math.min(...r.items.map(i => i.base - i.fh * 0.8));
    const sz = {}; for (const it of r.items) { const s = Math.round(it.fh * 2) / 2; sz[s] = (sz[s] || 0) + it.str.length; }
    r.size = +Object.entries(sz).sort((a, b) => b[1] - a[1])[0][0];
    r.text = segs.map(s => s.text).join('\t');
  }
  rows.sort((a, b) => a.base - b.base);
  return rows;
}
function cvParas(rows, pageW) {
  const right = Math.max(0, ...rows.map(r => r.x1)), paras = [];
  for (const r of rows) {
    const cur = paras[paras.length - 1], L = cur && cur.rows[cur.rows.length - 1], d = L ? r.base - L.base : 0;
    const join = cur && r.segs.length === 1 && L.segs.length === 1 && Math.abs(r.x0 - L.x0) < r.fh * 1.2 && Math.abs(r.size - L.size) < 0.6
      && d > r.fh * 0.95 && d < r.fh * 1.8 && L.x1 > right - r.fh * 4 && !BULLET.test(r.text) && (cur.gap == null || Math.abs(d - cur.gap) < r.fh * 0.3);
    if (join) { cur.gap = cur.gap == null ? d : cur.gap; cur.rows.push(r); }
    else paras.push({ rows: [r], gap: null });
  }
  for (const p of paras) {
    const f = p.rows[0]; p.x0 = Math.min(...p.rows.map(r => r.x0)); p.x1 = Math.max(...p.rows.map(r => r.x1));
    p.top = f.top; p.base = f.base; p.last = p.rows[p.rows.length - 1].base; p.size = f.size;
    p.center = p.rows.every(r => r.segs.length === 1 && Math.abs((r.x0 + r.x1) / 2 - pageW / 2) < pageW * 0.025 && r.x0 > pageW * 0.15);
    // runs of the whole paragraph: wrapped lines joined with spaces, separate columns with tabs
    p.lines = p.rows.length === 1 || p.gap != null ? [p.rows.flatMap((r, i) => { const rs = r.segs.flatMap((s, j) => j ? [{ tab: s.x }, ...s.runs] : s.runs); if (i && rs[0] && !rs[0].tab) rs[0] = { ...rs[0], t: ' ' + rs[0].t.replace(/^\s+/, '') }; return rs; })] : [];
    p.text = p.rows.map(r => r.text).join(' ');
  }
  return paras;
}
function cvFlow(P) { // paragraphs and pictures in reading order, with vertical spacing
  const rows = cvRows(P.items), paras = cvParas(rows, P.w);
  const els = [...paras.map(p => ({ kind: 'p', ...p })), ...P.imgs.map(im => ({ kind: 'img', ...im, top: im.y, x0: im.x, x1: im.x + im.w, last: im.y + im.h }))].sort((a, b) => a.top - b.top);
  const xs = els.map(e => e.x0), xe1 = els.map(e => e.x1);
  const mL = clamp(xs.length ? Math.min(...xs) - 2 : 54, 14, P.w / 3), mR = clamp(xe1.length ? P.w - Math.max(...xe1) - 14 : 54, 10, P.w / 3);
  const mT = clamp(els.length ? els[0].top - 2 : 54, 10, P.h / 2);
  let prevBottom = mT;
  for (const e of els) {
    const lh = e.kind === 'p' ? (e.gap || e.size * 1.2) : 0;
    const top = e.kind === 'p' ? e.base - lh * 0.8 : e.top;
    e.before = Math.max(0, top - prevBottom); e.lh = lh;
    prevBottom = e.kind === 'p' ? e.last + lh * 0.2 : e.last;
  }
  return { els, mL, mR, mT, rows, paras };
}
function cvBlocks(P) { // positioned text boxes for exact-layout formats
  const flat = P.items.filter(it => Math.abs(it.ang) < 0.05), rot = P.items.filter(it => Math.abs(it.ang) >= 0.05);
  const blocks = textBlocks(flat, new Set()).map(B => {
    const lines = B.lines.map(l => cvRuns(l.items));
    const fh = B.fh, lh = B.gap || fh * 1.2;
    return { x: B.x0, y: B.lines[0].base - lh * 0.8, w: B.x1 - B.x0, h: (B.lines.length - 1) * lh + lh, lh, lines, ocr: B.ocr, bgc: B.items[0].bgc, rot: 0 };
  });
  for (const it of rot) {
    const fh = it.fh, w = it.w, h0 = fh * 1.2, c = Math.cos(it.ang), s = Math.sin(it.ang);
    const cx = it.x + (w / 2) * c - (-0.35 * fh) * s, cy = it.base + (w / 2) * s + (-0.35 * fh) * c;
    blocks.push({ x: cx - w / 2, y: cy - h0 / 2, w, h: h0, lh: h0, lines: [cvRuns([it])], rot: it.ang * 180 / Math.PI });
  }
  return blocks;
}

/* ---------- small writers ---------- */
async function cvZip(parts) { const z = new JSZip(); for (const [n, d] of Object.entries(parts)) z.file(n, d); return z.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 }, mimeType: 'application/zip' }); }
const cvXML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const ONS = {
  w: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main', r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  wp: 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing', a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  pic: 'http://schemas.openxmlformats.org/drawingml/2006/picture', wps: 'http://schemas.microsoft.com/office/word/2010/wordprocessingShape',
  p: 'http://schemas.openxmlformats.org/presentationml/2006/main', pr: 'http://schemas.openxmlformats.org/package/2006/relationships',
  ct: 'http://schemas.openxmlformats.org/package/2006/content-types', s: 'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
};
const RT = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
const rels = list => cvXML + `<Relationships xmlns="${ONS.pr}">` + list.map(([id, type, target]) => `<Relationship Id="${id}" Type="${type.includes('://') ? type : RT + type}" Target="${xe(target)}"/>`).join('') + '</Relationships>';
const coreXml = () => cvXML + `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xe(S.meta.title || S.name.replace(/\.pdf$/i, ''))}</dc:title><dc:creator>${xe(S.meta.author || '')}</dc:creator><cp:lastModifiedBy>Aliran PDF</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}</dcterms:created></cp:coreProperties>`;
const appXml = app => cvXML + `<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>${app}</Application></Properties>`;
const docPropsRels = main => rels([['rId1', 'officeDocument', main], ['rId2', 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties', 'docProps/core.xml'], ['rId3', 'extended-properties', 'docProps/app.xml']]);

/* ---------- Word (.docx) ---------- */
function wRun(r) {
  if (r.tab != null) return '<w:r><w:tab/></w:r>';
  const f = xe(r.font);
  return `<w:r><w:rPr><w:rFonts w:ascii="${f}" w:hAnsi="${f}" w:cs="${f}" w:eastAsia="${f}"/>${r.bold ? '<w:b/><w:bCs/>' : ''}${r.italic ? '<w:i/><w:iCs/>' : ''}${r.color && r.color !== '000000' ? `<w:color w:val="${r.color}"/>` : ''}<w:sz w:val="${Math.max(2, Math.round(r.size * 2))}"/><w:szCs w:val="${Math.max(2, Math.round(r.size * 2))}"/></w:rPr><w:t xml:space="preserve">${xe(r.t)}</w:t></w:r>`;
}
function wPic(rid, id, wpt, hpt, anchor) {
  const cx = Math.round(wpt * EMU), cy = Math.round(hpt * EMU);
  const g = `<a:graphic xmlns:a="${ONS.a}"><a:graphicData uri="${ONS.pic}"><pic:pic xmlns:pic="${ONS.pic}"><pic:nvPicPr><pic:cNvPr id="${id}" name="Picture ${id}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic>`;
  if (!anchor) return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${id}" name="Picture ${id}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="${ONS.a}" noChangeAspect="1"/></wp:cNvGraphicFramePr>${g}</wp:inline></w:drawing></w:r>`;
  return `<w:r><w:drawing><wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="${id}" behindDoc="1" locked="1" layoutInCell="1" allowOverlap="1"><wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="page"><wp:posOffset>0</wp:posOffset></wp:positionH><wp:positionV relativeFrom="page"><wp:posOffset>0</wp:posOffset></wp:positionV><wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapNone/><wp:docPr id="${id}" name="Page background ${id}"/><wp:cNvGraphicFramePr/>${g}</wp:anchor></w:drawing></w:r>`;
}
function wTextBox(B, id) {
  const pad = 2, cx = Math.round((B.w + pad * 2 + B.lines.reduce((m, l) => Math.max(m, l.reduce((s, r) => s + (r.t || '').length, 0)), 0) * 0.6) * EMU), cy = Math.round((B.h + pad) * EMU);
  const fill = B.ocr && B.bgc ? `<a:solidFill><a:srgbClr val="${B.bgc}"/></a:solidFill>` : '<a:noFill/>';
  const paras = B.lines.map(l => `<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="${Math.max(20, Math.round(B.lh * TW))}" w:lineRule="exact"/></w:pPr>${l.map(wRun).join('')}</w:p>`).join('');
  return `<w:r><w:drawing><wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="${1000 + id}" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1"><wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="page"><wp:posOffset>${Math.round((B.x - pad) * EMU)}</wp:posOffset></wp:positionH><wp:positionV relativeFrom="page"><wp:posOffset>${Math.round(B.y * EMU)}</wp:posOffset></wp:positionV><wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapNone/><wp:docPr id="${id}" name="Text ${id}"/><wp:cNvGraphicFramePr/><a:graphic xmlns:a="${ONS.a}"><a:graphicData uri="${ONS.wps}"><wps:wsp><wps:cNvSpPr txBox="1"/><wps:spPr><a:xfrm${B.rot ? ` rot="${Math.round(B.rot * 60000)}"` : ''}><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${fill}<a:ln><a:noFill/></a:ln></wps:spPr><wps:txbx><w:txbxContent>${paras}</w:txbxContent></wps:txbx><wps:bodyPr rot="0" vert="horz" wrap="none" lIns="${pad * EMU}" tIns="0" rIns="0" bIns="0" anchor="t" anchorCtr="0"><a:noAutofit/></wps:bodyPr></wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing></w:r>`;
}
function wSect(P, m) {
  const land = P.w > P.h;
  return `<w:sectPr><w:pgSz w:w="${Math.round(P.w * TW)}" w:h="${Math.round(P.h * TW)}"${land ? ' w:orient="landscape"' : ''}/><w:pgMar w:top="${Math.round(m.t * TW)}" w:right="${Math.round(m.r * TW)}" w:bottom="${Math.round(m.b * TW)}" w:left="${Math.round(m.l * TW)}" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr>`;
}
async function toDocx() {
  const exact = cvOpts().layout === 'exact', media = {}, relList = [['rId1', 'styles', 'styles.xml'], ['rId2', 'settings', 'settings.xml']];
  let nid = 10, body = '', prevSect = null;
  const addImg = (data, type) => { const rid = 'rId' + (relList.length + 1), n = `media/image${relList.length + 1}.${type === 'png' ? 'png' : 'jpeg'}`; media['word/' + n] = data; relList.push([rid, 'image', n]); return rid; };
  await cvRun({ text: true, ocr: true, imgs: !exact, bg: exact, bgScale: Math.max(2, cvOpts().dpi / 72) }, async P => {
    let xml = '';
    if (exact) {
      const bg = await readBytes(await canvasBlob(P.bg, 'image/jpeg', 0.88));
      let runs = wPic(addImg(bg, 'jpeg'), nid++, P.w, P.h, true);
      for (const B of cvBlocks(P)) runs += wTextBox(B, nid++);
      xml = `<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"/>${'%SECT%'}</w:pPr>${runs}</w:p>`;
      P.margins = { t: 0, r: 0, b: 0, l: 0 };
    } else {
      const F = cvFlow(P);
      P.margins = { t: F.mT, r: F.mR, b: 18, l: F.mL };
      const parts = [];
      for (const e of F.els) {
        const sp = `<w:spacing w:before="${Math.round(e.before * TW)}" w:after="0"${e.kind === 'p' ? ` w:line="${Math.max(20, Math.round(e.lh * TW))}" w:lineRule="exact"` : ''}/>`;
        const ind = Math.max(0, e.x0 - F.mL);
        if (e.kind === 'img') { parts.push(`<w:p><w:pPr>${sp}<w:ind w:left="${Math.round(ind * TW)}"/></w:pPr>${wPic(addImg(e.data, e.type), nid++, e.w, e.h)}</w:p>`); continue; }
        if (e.lines.length) {
          const tabs = [...new Set(e.lines[0].filter(r => r.tab != null).map(r => Math.round((r.tab - F.mL) * TW)))].filter(t => t > 0);
          parts.push(`<w:p><w:pPr>${tabs.length ? `<w:tabs>${tabs.map(t => `<w:tab w:val="left" w:pos="${t}"/>`).join('')}</w:tabs>` : ''}${sp}${e.center ? '' : `<w:ind w:left="${Math.round(ind * TW)}"/>`}${e.center ? '<w:jc w:val="center"/>' : ''}</w:pPr>${e.lines[0].map(wRun).join('')}</w:p>`);
        } else { // separate lines kept as line breaks
          const rs = e.rows.map(r => r.segs.flatMap((s, j) => j ? [{ tab: s.x }, ...s.runs] : s.runs).map(wRun).join('')).join('<w:r><w:br/></w:r>');
          parts.push(`<w:p><w:pPr>${sp}<w:ind w:left="${Math.round(ind * TW)}"/></w:pPr>${rs}</w:p>`);
        }
      }
      if (!parts.length) parts.push('<w:p/>');
      const lp = parts[parts.length - 1]; // sectPr must be the last child of the paragraph properties
      parts[parts.length - 1] = lp === '<w:p/>' ? '<w:p><w:pPr>%SECT%</w:pPr></w:p>' : lp.replace('</w:pPr>', '%SECT%</w:pPr>');
      xml = parts.join('');
    }
    // the section break of the previous page goes into that page's last paragraph
    if (prevSect) body = body.replace('%SECT%', prevSect);
    body += xml; prevSect = wSect(P, P.margins);
  });
  body = body.replace('%SECT%', '');
  const last = prevSect || '<w:sectPr/>';
  const doc = cvXML + `<w:document xmlns:w="${ONS.w}" xmlns:r="${ONS.r}" xmlns:wp="${ONS.wp}" xmlns:a="${ONS.a}" xmlns:pic="${ONS.pic}" xmlns:wps="${ONS.wps}"><w:body>${body}${last}</w:body></w:document>`;
  const styles = cvXML + `<w:styles xmlns:w="${ONS.w}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial" w:eastAsia="Arial"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style></w:styles>`;
  const settings = cvXML + `<w:settings xmlns:w="${ONS.w}"><w:defaultTabStop w:val="720"/><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>`;
  const ct = cvXML + `<Types xmlns="${ONS.ct}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`;
  return cvZip({ '[Content_Types].xml': ct, '_rels/.rels': docPropsRels('word/document.xml'), 'docProps/core.xml': coreXml(), 'docProps/app.xml': appXml('Aliran PDF'), 'word/document.xml': doc, 'word/styles.xml': styles, 'word/settings.xml': settings, 'word/_rels/document.xml.rels': rels(relList), ...media });
}

/* ---------- Rich Text Format (.rtf, also used for Word 97-2003 .doc) ---------- */
function rtfEsc(s) {
  let o = '';
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (ch === '\\' || ch === '{' || ch === '}') o += '\\' + ch;
    else if (ch === '\t') o += '\\tab ';
    else if (c < 128) o += ch;
    else if (c < 0x10000) o += `\\u${c > 32767 ? c - 65536 : c}?`;
    else { const hi = Math.floor((c - 0x10000) / 0x400) + 0xd800, lo = (c - 0x10000) % 0x400 + 0xdc00; o += `\\u${hi - 65536}?\\u${lo - 65536}?`; }
  }
  return o;
}
const bhex = b => { let s = ''; for (let i = 0; i < b.length; i++) { s += (b[i] < 16 ? '0' : '') + b[i].toString(16); if (i % 64 === 63) s += '\n'; } return s; };
async function toRtf() {
  const fonts = ['Arial'], colors = ['000000'], fi = f => { let i = fonts.indexOf(f); if (i < 0) { fonts.push(f); i = fonts.length - 1; } return i; }, ci = c => { let i = colors.indexOf(c); if (i < 0) { colors.push(c); i = colors.length - 1; } return i + 1; };
  const run = r => r.tab != null ? '\\tab ' : `{\\f${fi(r.font)}\\fs${Math.max(2, Math.round(r.size * 2))}${r.bold ? '\\b' : ''}${r.italic ? '\\i' : ''}\\cf${ci(r.color || '000000')} ${rtfEsc(r.t)}}`;
  let body = '', first = true;
  await cvRun({ text: true, ocr: true, imgs: true }, async P => {
    const F = cvFlow(P);
    body += (first ? '' : '\\sect') + `\\sectd\\sbknone\\pgwsxn${Math.round(P.w * TW)}\\pghsxn${Math.round(P.h * TW)}${P.w > P.h ? '\\lndscpsxn' : ''}\\marglsxn${Math.round(F.mL * TW)}\\margrsxn${Math.round(F.mR * TW)}\\margtsxn${Math.round(F.mT * TW)}\\margbsxn360${first ? '' : '\\sbkpage'}\n`;
    first = false;
    for (const e of F.els) {
      const ind = Math.round(Math.max(0, e.x0 - F.mL) * TW), sb = Math.round(e.before * TW);
      if (e.kind === 'img') { body += `\\pard\\plain\\li${ind}\\sb${sb} {\\pict\\${e.type === 'png' ? 'pngblip' : 'jpegblip'}\\picw${e.pw}\\pich${e.ph}\\picwgoal${Math.round(e.w * TW)}\\pichgoal${Math.round(e.h * TW)}\n${bhex(e.data)}}\\par\n`; continue; }
      const sl = `\\sl-${Math.max(20, Math.round(e.lh * TW))}\\slmult0`;
      if (e.lines.length) {
        const tabs = [...new Set(e.lines[0].filter(r => r.tab != null).map(r => Math.round((r.tab - F.mL) * TW)))].filter(t => t > 0).map(t => `\\tx${t}`).join('');
        body += `\\pard\\plain${e.center ? '\\qc' : `\\li${ind}`}\\sb${sb}${sl}${tabs} ${e.lines[0].map(run).join('')}\\par\n`;
      } else body += `\\pard\\plain\\li${ind}\\sb${sb}${sl} ` + e.rows.map(r => r.segs.flatMap((s, j) => j ? [{ tab: s.x }, ...s.runs] : s.runs).map(run).join('')).join('\\line ') + '\\par\n';
    }
  });
  const ft = fonts.map((f, i) => `{\\f${i}\\fnil ${rtfEsc(f)};}`).join(''), clr = colors.map(c => `\\red${parseInt(c.slice(0, 2), 16)}\\green${parseInt(c.slice(2, 4), 16)}\\blue${parseInt(c.slice(4, 6), 16)};`).join('');
  return new TextEncoder().encode(`{\\rtf1\\ansi\\ansicpg1252\\deff0\\uc1{\\fonttbl${ft}}{\\colortbl;${clr}}{\\info{\\title ${rtfEsc(S.meta.title || S.name)}}}\n${body}}`);
}

/* ---------- HTML ---------- */
const b64 = b => { let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(s); };
async function toHtml() {
  let out = '';
  const span = r => { const st = [`font-family:'${r.font.replace(/'/g, '')}',sans-serif`, `font-size:${r.size}pt`]; if (r.bold) st.push('font-weight:bold'); if (r.italic) st.push('font-style:italic'); if (r.color && r.color !== '000000') st.push('color:#' + r.color); return `<span style="${st.join(';')}">${xe(r.t)}</span>`; };
  const segHtml = (r) => r.segs.map((s, j) => { const nx = r.segs[j + 1]; const inner = s.runs.map(span).join(''); return nx ? `<span class="col" style="min-width:${(nx.x - s.x).toFixed(1)}pt">${inner}</span>` : inner; }).join('');
  await cvRun({ text: true, ocr: true, imgs: true }, async P => {
    const F = cvFlow(P); let sec = '';
    const big = Math.max(0, ...F.paras.map(p => p.size)), med = F.paras.length ? F.paras.map(p => p.size).sort((a, b) => a - b)[F.paras.length >> 1] : 11;
    for (const e of F.els) {
      const st = `margin:${e.before.toFixed(1)}pt 0 0 ${Math.max(0, e.x0 - F.mL).toFixed(1)}pt`;
      if (e.kind === 'img') { sec += `<p style="${st}"><img alt="" src="data:image/${e.type};base64,${b64(e.data)}" style="width:${e.w.toFixed(1)}pt;max-width:100%"></p>\n`; continue; }
      const tag = e.size >= med * 1.6 && e.size === big ? 'h1' : e.size >= med * 1.25 ? 'h2' : 'p';
      const inner = e.lines.length ? e.rows.map(segHtml).join(' ') : e.rows.map(segHtml).join('<br>');
      sec += `<${tag} style="${st};line-height:${(e.lh / e.size).toFixed(2)}${e.center ? ';text-align:center;margin-left:0' : ''}">${inner}</${tag}>\n`;
    }
    out += `<section class="page" style="width:${(P.w - F.mL - F.mR).toFixed(1)}pt;padding:${F.mT.toFixed(1)}pt ${F.mR.toFixed(1)}pt 24pt ${F.mL.toFixed(1)}pt">\n${sec}</section>\n`;
  });
  return new TextEncoder().encode(`<!DOCTYPE html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="generator" content="Aliran PDF"><title>${xe(S.meta.title || S.name.replace(/\.pdf$/i, ''))}</title>
<style>body{margin:0;background:#f2f3f5;font-family:Arial,sans-serif}.page{background:#fff;margin:16px auto;box-shadow:0 1px 4px rgba(0,0,0,.15);max-width:100%;box-sizing:content-box}h1,h2,p{font-weight:normal;font-size:inherit;white-space:pre-wrap}.col{display:inline-block}@media print{body{background:#fff}.page{box-shadow:none;margin:0;page-break-after:always}}</style></head><body>\n${out}</body></html>\n`);
}

/* ---------- Text ---------- */
async function toText(accessible) {
  const pages = [];
  await cvRun({ text: true, ocr: true }, async P => {
    const rows = cvRows(P.items);
    if (accessible) { pages.push(cvParas(rows, P.w).map(p => p.text.replace(/\s*\t\s*/g, '\t')).join('\n\n')); return; }
    const cws = P.items.filter(i => i.str.length > 1).map(i => i.w / i.str.length).sort((a, b) => a - b);
    const cw = Math.max(2, cws.length ? cws[cws.length >> 1] : 5.5), minX = Math.min(...rows.map(r => r.x0), 1e9);
    const lhs = rows.slice(1).map((r, i) => r.base - rows[i].base).filter(v => v > 1).sort((a, b) => a - b), lh = lhs.length ? lhs[lhs.length >> 1] : 14;
    const lines = []; let prev = null;
    for (const r of rows) {
      if (prev) { const blank = Math.min(3, Math.round((r.base - prev.base) / lh) - 1); for (let i = 0; i < blank; i++) lines.push(''); }
      let s = '';
      for (const sg of r.segs) { const col = Math.round((sg.x - minX) / cw); if (s.length < col) s += ' '.repeat(col - s.length); else if (s) s += '  '; s += sg.text; }
      lines.push(s.replace(/\s+$/, '')); prev = r;
    }
    pages.push(lines.join('\n'));
  });
  return new TextEncoder().encode('\ufeff' + pages.join(accessible ? '\n\n' : '\n\f').replace(/\n/g, '\r\n') + '\r\n');
}

/* ---------- XML 1.0 ---------- */
async function toXml() {
  let out = cvXML.replace(' standalone="yes"', '') + `<document title="${xe(S.meta.title || S.name)}" pages="${S.pages.length}" producer="Aliran PDF">\n`;
  await cvRun({ text: true, ocr: true, imgs: true }, async P => {
    const F = cvFlow(P);
    out += `  <page number="${P.n}" width="${P.w.toFixed(1)}" height="${P.h.toFixed(1)}"${P.scanned ? ' ocr="true"' : ''}>\n`;
    for (const e of F.els) {
      if (e.kind === 'img') { out += `    <image x="${e.x.toFixed(1)}" y="${e.y.toFixed(1)}" width="${e.w.toFixed(1)}" height="${e.h.toFixed(1)}"/>\n`; continue; }
      const runs = e.rows.flatMap(r => r.segs.flatMap(s => s.runs)), f = runs[0] || {};
      const attr = `x="${e.x0.toFixed(1)}" y="${e.top.toFixed(1)}" font="${xe(f.font || '')}" size="${f.size || ''}"${f.bold ? ' bold="true"' : ''}${f.italic ? ' italic="true"' : ''}${f.color && f.color !== '000000' ? ` color="#${f.color}"` : ''}`;
      const same = runs.every(r => r.font === f.font && r.size === f.size && r.bold === f.bold && r.italic === f.italic && r.color === f.color);
      out += same ? `    <p ${attr}>${xe(e.text)}</p>\n` : `    <p ${attr}>${runs.map(r => `<span font="${xe(r.font)}" size="${r.size}"${r.bold ? ' bold="true"' : ''}${r.italic ? ' italic="true"' : ''}${r.color !== '000000' ? ` color="#${r.color}"` : ''}>${xe(r.t)}</span>`).join('')}</p>\n`;
    }
    out += '  </page>\n';
  });
  return new TextEncoder().encode(out + '</document>\n');
}

/* ---------- Excel (.xlsx and XML Spreadsheet 2003) ---------- */
const colName = n => { let s = ''; n++; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
const NUMRE = /^[-+]?(\d{1,3}(,\d{3})+|\d+)(\.\d+)?$/;
function cvTable(pages) { // pages: [{rows}] → grid rows of cells
  const xs = pages.flatMap(p => p.rows.flatMap(r => r.segs.map(s => s.x))).sort((a, b) => a - b);
  const cols = []; for (const x of xs) { const c = cols[cols.length - 1]; if (c && x - c.x < 8) { c.n++; c.sum += x; } else cols.push({ x, n: 1, sum: x }); }
  const cx = cols.map(c => c.sum / c.n);
  const out = [];
  pages.forEach((p, pi) => {
    if (pi && pages.length > 1) out.push({ cells: [] });
    let prev = null;
    for (const r of p.rows) {
      if (prev && r.base - prev.base > Math.max(r.fh, prev.fh) * 2.6) out.push({ cells: [] });
      const cells = []; let used = -1;
      for (const s of r.segs) {
        let ci = 0, best = 1e9; cx.forEach((x, i) => { const d = Math.abs(x - s.x); if (d < best) { best = d; ci = i; } });
        if (ci <= used) ci = used + 1; used = ci;
        const t = s.text.trim(), num = NUMRE.test(t) && !/^0\d/.test(t) && t.replace(/\D/g, '').length < 15;
        cells.push({ c: ci, t, num, v: num ? parseFloat(t.replace(/,/g, '')) : null, bold: s.runs.length > 0 && s.runs.every(x => x.bold) });
      }
      out.push({ cells }); prev = r;
    }
  });
  const widths = cx.map((x, i) => clamp(((cx[i + 1] != null ? cx[i + 1] : x + 80) - x) / 5.2, 6, 70));
  return { rows: out, widths };
}
async function cvExcelPages() {
  const pages = [];
  await cvRun({ text: true, ocr: true, scale: 1.5 }, async P => { pages.push({ n: P.n, rows: cvRows(P.items) }); });
  return cvOpts().sheet === 'one' ? [{ name: 'Document', table: cvTable(pages) }] : pages.map(p => ({ name: 'Page ' + p.n, table: cvTable([p]) }));
}
async function toXlsx() {
  const sheets = await cvExcelPages(), parts = {};
  sheets.forEach((sh, i) => {
    const T = sh.table;
    const rowsXml = T.rows.map((r, ri) => r.cells.length ? `<row r="${ri + 1}">` + r.cells.map(c => { const ref = colName(c.c) + (ri + 1), s = c.bold ? ' s="1"' : ''; return c.num ? `<c r="${ref}"${s}><v>${c.v}</v></c>` : `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${xe(c.t)}</t></is></c>`; }).join('') + '</row>' : '').join('');
    const cols = T.widths.length ? '<cols>' + T.widths.map((w, ci) => `<col min="${ci + 1}" max="${ci + 1}" width="${w.toFixed(1)}" customWidth="1"/>`).join('') + '</cols>' : '';
    parts[`xl/worksheets/sheet${i + 1}.xml`] = cvXML + `<worksheet xmlns="${ONS.s}" xmlns:r="${ONS.r}">${cols}<sheetData>${rowsXml}</sheetData></worksheet>`;
  });
  const names = []; const wb = cvXML + `<workbook xmlns="${ONS.s}" xmlns:r="${ONS.r}"><sheets>${sheets.map((s, i) => { let n = s.name.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31); while (names.includes(n)) n = n.slice(0, 28) + ' ' + i; names.push(n); return `<sheet name="${xe(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`; }).join('')}</sheets></workbook>`;
  const styles = cvXML + `<styleSheet xmlns="${ONS.s}"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
  const ct = cvXML + `<Types xmlns="${ONS.ct}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`;
  const wbRels = rels([...sheets.map((s, i) => [`rId${i + 1}`, 'worksheet', `worksheets/sheet${i + 1}.xml`]), [`rId${sheets.length + 1}`, 'styles', 'styles.xml']]);
  return cvZip({ '[Content_Types].xml': ct, '_rels/.rels': docPropsRels('xl/workbook.xml'), 'docProps/core.xml': coreXml(), 'docProps/app.xml': appXml('Aliran PDF'), 'xl/workbook.xml': wb, 'xl/_rels/workbook.xml.rels': wbRels, 'xl/styles.xml': styles, ...parts });
}
async function toXml2003() {
  const sheets = await cvExcelPages(); const names = [];
  const ws = sheets.map((sh, i) => {
    let n = sh.name.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31); while (names.includes(n)) n = n.slice(0, 28) + ' ' + i; names.push(n);
    const cols = sh.table.widths.map(w => `<Column ss:Width="${(w * 5.6).toFixed(1)}"/>`).join('');
    const rows = sh.table.rows.map(r => '<Row>' + r.cells.map((c, j) => { const idx = (j === 0 ? c.c > 0 : c.c !== r.cells[j - 1].c + 1) ? ` ss:Index="${c.c + 1}"` : ''; return `<Cell${idx}${c.bold ? ' ss:StyleID="b"' : ''}><Data ss:Type="${c.num ? 'Number' : 'String'}">${c.num ? c.v : xe(c.t)}</Data></Cell>`; }).join('') + '</Row>').join('\n');
    return `<Worksheet ss:Name="${xe(n)}"><Table>${cols}\n${rows}</Table></Worksheet>`;
  }).join('\n');
  return new TextEncoder().encode(`<?xml version="1.0" encoding="UTF-8"?>\n<?mso-application progid="Excel.Sheet"?>\n<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><Styles><Style ss:ID="Default" ss:Name="Normal"><Font ss:FontName="Calibri" ss:Size="11"/></Style><Style ss:ID="b"><Font ss:FontName="Calibri" ss:Size="11" ss:Bold="1"/></Style></Styles>\n${ws}\n</Workbook>\n`);
}

/* ---------- PowerPoint (.pptx) ---------- */
const THEME = `<a:theme xmlns:a="${ONS.a}" name="Aliran"><a:themeElements><a:clrScheme name="Office"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2><a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2><a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4><a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme><a:fontScheme name="Office"><a:majorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Office"><a:fillStyleLst>${'<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'.repeat(3)}</a:fillStyleLst><a:lnStyleLst>${[6350, 12700, 19050].map(w => `<a:ln w="${w}"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>`).join('')}</a:lnStyleLst><a:effectStyleLst>${'<a:effectStyle><a:effectLst/></a:effectStyle>'.repeat(3)}</a:effectStyleLst><a:bgFillStyleLst>${'<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'.repeat(3)}</a:bgFillStyleLst></a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>`;
const GRP = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';
const PNS = `xmlns:a="${ONS.a}" xmlns:r="${ONS.r}" xmlns:p="${ONS.p}"`;
function pRun(r, k) {
  const f = xe(r.font);
  return `<a:r><a:rPr lang="en-US" sz="${Math.max(100, Math.round(r.size * k * 100))}"${r.bold ? ' b="1"' : ''}${r.italic ? ' i="1"' : ''} dirty="0"><a:solidFill><a:srgbClr val="${r.color || '000000'}"/></a:solidFill><a:latin typeface="${f}"/><a:cs typeface="${f}"/></a:rPr><a:t>${xe(r.t)}</a:t></a:r>`;
}
async function toPptx() {
  const slides = [], media = {}; let SW = 0, SH = 0;
  await cvRun({ text: true, ocr: true, bg: true, bgScale: Math.max(2, cvOpts().dpi / 72) }, async P => {
    if (!SW) { SW = P.w; SH = P.h; }
    const k = Math.min(SW / P.w, SH / P.h), ox = (SW - P.w * k) / 2, oy = (SH - P.h * k) / 2;
    const n = slides.length + 1, img = `ppt/media/page${n}.jpeg`;
    media[img] = await readBytes(await canvasBlob(P.bg, 'image/jpeg', 0.88));
    let id = 2, sp = `<p:pic><p:nvPicPr><p:cNvPr id="${id++}" name="Page ${n}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="${Math.round(ox * EMU)}" y="${Math.round(oy * EMU)}"/><a:ext cx="${Math.round(P.w * k * EMU)}" cy="${Math.round(P.h * k * EMU)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`;
    for (const B of cvBlocks(P)) {
      const fill = B.ocr && B.bgc ? `<a:solidFill><a:srgbClr val="${B.bgc}"/></a:solidFill>` : '<a:noFill/>';
      const paras = B.lines.map(l => `<a:p><a:pPr><a:lnSpc><a:spcPts val="${Math.round(B.lh * k * 100)}"/></a:lnSpc><a:spcBef><a:spcPts val="0"/></a:spcBef></a:pPr>${l.map(r => pRun(r, k)).join('')}</a:p>`).join('');
      sp += `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Text ${id++}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm${B.rot ? ` rot="${Math.round(((B.rot % 360) + 360) % 360 * 60000)}"` : ''}><a:off x="${Math.round((ox + B.x * k) * EMU)}" y="${Math.round((oy + B.y * k) * EMU)}"/><a:ext cx="${Math.round(Math.max(B.w + 4, 4) * k * EMU)}" cy="${Math.round(B.h * k * EMU)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${fill}</p:spPr><p:txBody><a:bodyPr wrap="none" lIns="0" tIns="0" rIns="0" bIns="0" rtlCol="0" anchor="t"><a:noAutofit/></a:bodyPr><a:lstStyle/>${paras}</p:txBody></p:sp>`;
    }
    slides.push({ xml: cvXML + `<p:sld ${PNS}><p:cSld><p:spTree>${GRP}${sp}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`, img: `../media/page${n}.jpeg` });
  });
  const cx = clamp(Math.round(SW * EMU), 914400, 51206400), cy = clamp(Math.round(SH * EMU), 914400, 51206400);
  const parts = {
    'ppt/presentation.xml': cvXML + `<p:presentation ${PNS} saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${slides.map((s, i) => `<p:sldId id="${256 + i}" r:id="rId${10 + i}"/>`).join('')}</p:sldIdLst><p:sldSz cx="${cx}" cy="${cy}"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`,
    'ppt/_rels/presentation.xml.rels': rels([['rId1', 'slideMaster', 'slideMasters/slideMaster1.xml'], ['rId2', 'theme', 'theme/theme1.xml'], ['rId3', 'presProps', 'presProps.xml'], ['rId4', 'viewProps', 'viewProps.xml'], ['rId5', 'tableStyles', 'tableStyles.xml'], ...slides.map((s, i) => [`rId${10 + i}`, 'slide', `slides/slide${i + 1}.xml`])]),
    'ppt/presProps.xml': cvXML + `<p:presentationPr ${PNS}/>`,
    'ppt/viewProps.xml': cvXML + `<p:viewPr ${PNS}><p:normalViewPr><p:restoredLeft sz="15620"/><p:restoredTop sz="94660"/></p:normalViewPr><p:gridSpacing cx="76200" cy="76200"/></p:viewPr>`,
    'ppt/tableStyles.xml': cvXML + `<a:tblStyleLst xmlns:a="${ONS.a}" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>`,
    'ppt/theme/theme1.xml': cvXML + THEME,
    'ppt/slideMasters/slideMaster1.xml': cvXML + `<p:sldMaster ${PNS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${GRP}</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>`,
    'ppt/slideMasters/_rels/slideMaster1.xml.rels': rels([['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'], ['rId2', 'theme', '../theme/theme1.xml']]),
    'ppt/slideLayouts/slideLayout1.xml': cvXML + `<p:sldLayout ${PNS} type="blank" preserve="1"><p:cSld name="Blank"><p:spTree>${GRP}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`,
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels': rels([['rId1', 'slideMaster', '../slideMasters/slideMaster1.xml']]),
    '[Content_Types].xml': cvXML + `<Types xmlns="${ONS.ct}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="jpeg" ContentType="image/jpeg"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/presProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presProps+xml"/><Override PartName="/ppt/viewProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.viewProps+xml"/><Override PartName="/ppt/tableStyles.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>${slides.map((s, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join('')}<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`,
    '_rels/.rels': docPropsRels('ppt/presentation.xml'), 'docProps/core.xml': coreXml(), 'docProps/app.xml': appXml('Aliran PDF'), ...media,
  };
  slides.forEach((s, i) => { parts[`ppt/slides/slide${i + 1}.xml`] = s.xml; parts[`ppt/slides/_rels/slide${i + 1}.xml.rels`] = rels([['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'], ['rId2', 'image', s.img]]); });
  return cvZip(parts);
}

/* ---------- images: JPEG, PNG, TIFF ---------- */
async function deflateBytes(u8) { const cs = new CompressionStream('deflate'); const w = cs.writable.getWriter(); w.write(u8); w.close(); return new Uint8Array(await new Response(cs.readable).arrayBuffer()); }
async function tiffWrite(pages, dpi) { // pages: [{w,h,rgb(Uint8Array)}] → multi-page TIFF (Adobe Deflate)
  const strips = []; for (const p of pages) strips.push(await deflateBytes(p.rgb));
  const N = 13, ifdSize = 2 + N * 12 + 4 + 6 + 16; // entries + next + bps + 2 rationals
  let size = 8; const offs = [];
  pages.forEach((p, i) => { offs.push({ data: size }); size += strips[i].length + (strips[i].length & 1); offs[i].ifd = size; size += ifdSize; });
  const buf = new Uint8Array(size), dv = new DataView(buf.buffer);
  buf.set([0x49, 0x49, 42, 0]); dv.setUint32(4, offs[0].ifd, true);
  pages.forEach((p, i) => {
    buf.set(strips[i], offs[i].data);
    let o = offs[i].ifd; const extra = o + 2 + N * 12 + 4; dv.setUint16(o, N, true); o += 2;
    const ent = (tag, type, count, val) => { dv.setUint16(o, tag, true); dv.setUint16(o + 2, type, true); dv.setUint32(o + 4, count, true); if (type === 3 && count === 1) dv.setUint16(o + 8, val, true); else dv.setUint32(o + 8, val, true); o += 12; };
    ent(256, 4, 1, p.w); ent(257, 4, 1, p.h); ent(258, 3, 3, extra); ent(259, 3, 1, 8); ent(262, 3, 1, 2); ent(273, 4, 1, offs[i].data); ent(277, 3, 1, 3);
    ent(278, 4, 1, p.h); ent(279, 4, 1, strips[i].length); ent(282, 5, 1, extra + 6); ent(283, 5, 1, extra + 14); ent(284, 3, 1, 1); ent(296, 3, 1, 2);
    dv.setUint32(o, i + 1 < pages.length ? offs[i + 1].ifd : 0, true);
    dv.setUint16(extra, 8, true); dv.setUint16(extra + 2, 8, true); dv.setUint16(extra + 4, 8, true);
    dv.setUint32(extra + 6, dpi, true); dv.setUint32(extra + 10, 1, true); dv.setUint32(extra + 14, dpi, true); dv.setUint32(extra + 18, 1, true);
  });
  return buf;
}
async function toImages(kind) {
  const dpi = cvOpts().dpi, files = [], tif = [];
  await cvRun({ scale: dpi / 72 }, async P => {
    const c = P.full;
    if (kind === 'tiff') {
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data, rgb = new Uint8Array(c.width * c.height * 3);
      for (let i = 0, j = 0; i < d.length; i += 4) { rgb[j++] = d[i]; rgb[j++] = d[i + 1]; rgb[j++] = d[i + 2]; }
      tif.push({ w: c.width, h: c.height, rgb });
    } else files.push({ name: `${safeName(S.name.replace(/\.pdf$/i, ''))}_page${P.n}.${kind === 'png' ? 'png' : 'jpg'}`, data: await readBytes(await canvasBlob(c, kind === 'png' ? 'image/png' : 'image/jpeg', cvOpts().q)) });
  });
  if (kind === 'tiff') { cvSay('Writing TIFF…'); return { single: await tiffWrite(tif, dpi) }; }
  return { files };
}

/* ---------- PostScript / EPS (pages as high-resolution images) ---------- */
function a85(b) {
  let out = '', line = 0; const push = s => { out += s; line += s.length; if (line >= 72) { out += '\n'; line = 0; } };
  for (let i = 0; i < b.length; i += 4) {
    const n = Math.min(4, b.length - i); let v = 0;
    for (let k = 0; k < 4; k++) v = v * 256 + (k < n ? b[i + k] : 0);
    if (v === 0 && n === 4) { push('z'); continue; }
    const c = []; for (let k = 0; k < 5; k++) { c.unshift(String.fromCharCode(33 + v % 85)); v = Math.floor(v / 85); }
    push(c.slice(0, n + 1).join(''));
  }
  return out + '~>';
}
async function toPostScript(eps) {
  const dpi = cvOpts().psdpi, pages = [];
  await cvRun({ scale: dpi / 72 }, async P => { pages.push({ w: P.w, h: P.h, pw: P.full.width, ph: P.full.height, jpg: await readBytes(await canvasBlob(P.full, 'image/jpeg', 0.9)) }); });
  const img = p => `gsave\n${p.w.toFixed(2)} ${p.h.toFixed(2)} scale\n/DeviceRGB setcolorspace\n<< /ImageType 1 /Width ${p.pw} /Height ${p.ph} /BitsPerComponent 8 /Decode [0 1 0 1 0 1] /ImageMatrix [${p.pw} 0 0 -${p.ph} 0 ${p.ph}] /DataSource currentfile /ASCII85Decode filter /DCTDecode filter >> image\n${a85(p.jpg)}\ngrestore\n`;
  const enc = s => new TextEncoder().encode(s), title = xe(S.meta.title || S.name);
  if (eps) return { files: pages.map((p, i) => ({ name: `${safeName(S.name.replace(/\.pdf$/i, ''))}${pages.length > 1 ? '_page' + (i + 1) : ''}.eps`, data: enc(`%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 ${Math.ceil(p.w)} ${Math.ceil(p.h)}\n%%HiResBoundingBox: 0 0 ${p.w.toFixed(2)} ${p.h.toFixed(2)}\n%%Title: ${title}\n%%Creator: Aliran PDF\n%%LanguageLevel: 2\n%%Pages: 1\n%%EndComments\n%%Page: 1 1\n${img(p)}showpage\n%%EOF\n`) })) };
  let ps = `%!PS-Adobe-3.0\n%%Title: ${title}\n%%Creator: Aliran PDF\n%%LanguageLevel: 2\n%%Pages: ${pages.length}\n%%BoundingBox: 0 0 ${Math.ceil(Math.max(...pages.map(p => p.w)))} ${Math.ceil(Math.max(...pages.map(p => p.h)))}\n%%EndComments\n`;
  pages.forEach((p, i) => { ps += `%%Page: ${i + 1} ${i + 1}\n%%PageBoundingBox: 0 0 ${Math.ceil(p.w)} ${Math.ceil(p.h)}\n<< /PageSize [${p.w.toFixed(2)} ${p.h.toFixed(2)}] >> setpagedevice\n${img(p)}showpage\n`; });
  return { single: enc(ps + '%%EOF\n') };
}

/* ---------- run a conversion ---------- */
async function runConvert(fmt) {
  if (!S.pages.length) { toast('Open a PDF first'); return; }
  finishEdit(); clearTextSel();
  const F = CVFMT[fmt]; if (!F) return;
  if (!window.JSZip && ['docx', 'xlsx', 'pptx'].includes(fmt)) { toast('The converter is still loading, try again in a moment', 'err'); return; }
  const base = safeName(S.name.replace(/\.pdf$/i, ''));
  busy(`Converting to ${F.name}…`);
  let res;
  try {
    switch (fmt) {
      case 'docx': res = await toDocx(); break;
      case 'doc': case 'rtf': res = await toRtf(); break;
      case 'pptx': res = await toPptx(); break;
      case 'xlsx': res = await toXlsx(); break;
      case 'xml2003': res = await toXml2003(); break;
      case 'html': res = await toHtml(); break;
      case 'txt': res = await toText(false); break;
      case 'txta': res = await toText(true); break;
      case 'xml': res = await toXml(); break;
      case 'jpeg': case 'png': case 'tiff': res = await toImages(fmt); break;
      case 'ps': res = await toPostScript(false); break;
      case 'eps': res = await toPostScript(true); break;
    }
  } catch (e) { unbusy(); console.error(e); toast('Conversion failed: ' + (e.message || e), 'err'); return; }
  unbusy();
  if (res instanceof Uint8Array) await saveFile(`${base}.${F.ext}`, res);
  else if (res.single) await saveFile(`${base}.${F.ext}`, res.single);
  else await deliver(res.files, `${base}_${fmt}.zip`);
}

/* ---------- Compress ---------- */
async function compressPdf(level) {
  const L = PDFLib, cfg = { low: { max: 1e9, q: 0.85 }, medium: { max: 2000, q: 0.72 }, high: { max: 1300, q: 0.6 } }[level];
  const before = await buildPdf(S.pages);
  const doc = await L.PDFDocument.load(before, { ignoreEncryption: true, updateMetadata: false }), ctx = doc.context, N = n => L.PDFName.of(n);
  let done = 0, seen = 0;
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof L.PDFRawStream)) continue;
    const d = obj.dict; if (d.lookup(N('Subtype')) !== N('Image') || d.lookup(N('ImageMask'))) continue;
    const W = d.lookup(N('Width')), H = d.lookup(N('Height')); if (!W || !H) continue;
    const w = W.asNumber(), hgt = H.asNumber(), raw = obj.getContents(); seen++;
    if (raw.length < 40000) continue;
    const f = d.lookup(N('Filter')), filt = f instanceof L.PDFArray ? (f.size() === 1 ? f.lookup(0) : null) : f;
    let cs = d.lookup(N('ColorSpace')); if (cs instanceof L.PDFArray && cs.lookup(0) === N('ICCBased')) { const n = cs.lookup(1).dict.lookup(N('N')); cs = n && n.asNumber() === 1 ? N('DeviceGray') : n && n.asNumber() === 3 ? N('DeviceRGB') : null; }
    if (cs !== N('DeviceRGB') && cs !== N('DeviceGray')) continue;
    if (d.lookup(N('Decode')) || (d.lookup(N('BitsPerComponent')) && d.lookup(N('BitsPerComponent')).asNumber() !== 8)) continue;
    let bmp = null;
    try {
      if (filt === N('DCTDecode')) bmp = await createImageBitmap(new Blob([raw], { type: 'image/jpeg' }));
      else if (filt === N('FlateDecode') && !d.lookup(N('DecodeParms'))) {
        const px = L.decodePDFRawStream(obj).decode(), n = cs === N('DeviceRGB') ? 3 : 1; if (px.length < w * hgt * n) continue;
        const id = new ImageData(w, hgt); for (let i = 0, j = 0; i < w * hgt; i++, j += n) { const o = i * 4; id.data[o] = px[j]; id.data[o + 1] = px[j + (n - 1 && 1)]; id.data[o + 2] = px[j + (n - 1 && 2)]; id.data[o + 3] = 255; }
        bmp = await createImageBitmap(id);
      } else continue;
    } catch (e) { continue; }
    const sc = Math.min(1, cfg.max / Math.max(w, hgt)), nw = Math.max(1, Math.round(w * sc)), nh = Math.max(1, Math.round(hgt * sc));
    const c = document.createElement('canvas'); c.width = nw; c.height = nh; const cx = c.getContext('2d'); cx.drawImage(bmp, 0, 0, nw, nh);
    const jpg = await readBytes(await canvasBlob(c, 'image/jpeg', cfg.q)); c.width = 0;
    if (jpg.length >= raw.length * 0.9) continue;
    const nd = { Type: 'XObject', Subtype: 'Image', Width: nw, Height: nh, ColorSpace: 'DeviceRGB', BitsPerComponent: 8, Filter: 'DCTDecode', Length: jpg.length };
    const ns = L.PDFRawStream.of(ctx.obj(nd), jpg);
    for (const k of ['SMask', 'Intent', 'Interpolate']) { const v = d.get(N(k)); if (v) ns.dict.set(N(k), v); }
    ctx.assign(ref, ns); done++;
  }
  const after = await doc.save({ useObjectStreams: true });
  return { before: before.length, after: after.length, bytes: after.length < before.length ? after : before, images: done, seen };
}
function openCompress() {
  if (!S.pages.length) { toast('Open a PDF first'); return; }
  finishEdit();
  const lv = h('select', { class: 'inp' }, h('option', { value: 'low' }, 'Low – best quality'), h('option', { value: 'medium', selected: true }, 'Medium – recommended'), h('option', { value: 'high' }, 'High – smallest file'));
  modal({
    title: 'Compress a PDF', body: h('div', {}, fld('Compression', lv), h('p', { class: 'hint' }, 'Large pictures are re-saved at a lower resolution and the file structure is packed tighter. Text and vector drawings are not changed.')),
    actions: [{ label: 'Cancel' }, {
      label: 'Compress', primary: true, onClick: async () => {
        busy('Compressing…'); let r;
        try { r = await compressPdf(lv.value); } catch (e) { unbusy(); toast('Compression failed: ' + e.message, 'err'); return; }
        unbusy();
        const mb = n => (n / 1048576).toFixed(2) + ' MB', pct = Math.round((1 - r.after / r.before) * 100);
        if (r.after >= r.before) { toast(`This PDF is already compact (${mb(r.before)}) – nothing to shrink`); return; }
        await saveFile(safeName(S.name.replace(/\.pdf$/i, '')) + '_compressed.pdf', r.bytes);
        toast(`Compressed ${mb(r.before)} → ${mb(r.after)} (${pct}% smaller${r.images ? `, ${r.images} picture${r.images > 1 ? 's' : ''} reduced` : ''})`);
      }
    }]
  });
}

/* ---------- Convert panel (Acrobat-style) ---------- */
async function cvLangs() {
  const sel = $('#cvLang'); if (!LOCAL) { $('#cvLangBox').hidden = true; return; }
  try {
    const info = await getOcrInfo(); if (!info || !info.available || !info.langs || !info.langs.length) { $('#cvLangBox').hidden = true; return; }
    const o = cvOpts(); let saved = o.lang; try { saved = saved || localStorage.getItem('aliran.ocrLang') || ''; } catch (e) { }
    sel.replaceChildren(...info.langs.map(l => h('option', { value: l.tag }, l.name)));
    sel.value = info.langs.some(l => l.tag === saved) ? saved : info.default; o.lang = sel.value;
  } catch (e) { $('#cvLangBox').hidden = true; }
}
function syncCvt() {
  const on = !!S.cvtOpen && !!S.pages.length;
  document.body.classList.toggle('cvton', on); $('#cvt').hidden = !on; $('#mConv').classList.toggle('on', on);
  if (!on) return;
  for (const r of $$('#cvt .cvopt')) { r.classList.toggle('on', r.dataset.k === CV.fmt); r.querySelector('.cvsub').value = CV.sub[r.dataset.k]; }
  $('#cvGo').textContent = 'Convert to ' + CVFMT[CV.sub[CV.fmt]].label;
}
function openConvert(fmt) {
  if (!S.pages.length) { toast('Open a PDF first'); return; }
  if (fmt) { const k = Object.keys(CV.sub).find(k => [...$(`#cvt .cvopt[data-k=${k}] .cvsub`).options].some(o => o.value === fmt)); if (k) { CV.fmt = k; CV.sub[k] = fmt; } }
  S.cvtOpen = true; S.fmtClosed = true; syncFmt(); syncCvt();
  if (!S._cvLangs) { S._cvLangs = true; cvLangs(); }
}
function openCvSettings() {
  const o = cvOpts();
  const lay = h('select', { class: 'inp' }, h('option', { value: 'flow' }, 'Flowing text – easy to edit'), h('option', { value: 'exact' }, 'Exact page layout – looks identical'));
  const dpi = h('select', { class: 'inp' }, [72, 96, 150, 200, 300, 600].map(v => h('option', { value: v }, v + ' DPI')));
  const psdpi = h('select', { class: 'inp' }, [150, 200, 300, 600].map(v => h('option', { value: v }, v + ' DPI')));
  const q = h('select', { class: 'inp' }, [['0.6', 'Low (smaller)'], ['0.75', 'Medium'], ['0.9', 'High'], ['1', 'Maximum']].map(([v, t]) => h('option', { value: v }, t)));
  const sheet = h('select', { class: 'inp' }, h('option', { value: 'page' }, 'One worksheet per page'), h('option', { value: 'one' }, 'One worksheet for the whole document'));
  const imgs = h('input', { type: 'checkbox' }), ocr = h('input', { type: 'checkbox' });
  lay.value = o.layout; dpi.value = o.dpi; psdpi.value = o.psdpi; q.value = String(o.q); sheet.value = o.sheet; imgs.checked = o.images; ocr.checked = o.ocr;
  modal({
    title: 'Conversion settings', body: h('div', {},
      fld('Word layout', lay, 'Flowing text gives normal paragraphs. Exact layout keeps lines, tables and pictures in place, with the text in editable text boxes (also used for PowerPoint).'),
      h('div', { class: 'row' }, fld('Image resolution', dpi), fld('JPEG quality', q)),
      h('div', { class: 'row' }, fld('PostScript / EPS resolution', psdpi), fld('Excel', sheet)),
      h('label', { class: 'chk' }, imgs, ' Include pictures (Word, RTF, HTML)'),
      LOCAL ? h('label', { class: 'chk' }, ocr, ' Recognize text on scanned pages (OCR)') : null),
    actions: [{ label: 'Cancel' }, { label: 'OK', primary: true, onClick: () => { Object.assign(o, { layout: lay.value, dpi: +dpi.value, psdpi: +psdpi.value, q: +q.value, sheet: sheet.value, images: imgs.checked, ocr: ocr.checked }); saveCvOpts(); } }]
  });
}
function cvHelp() {
  modal({
    title: 'Converting PDFs', body: h('div', {},
      h('p', {}, 'Pick a format and click Convert. Your edits, comments and signatures are included. Everything happens on this computer – nothing is uploaded.'),
      h('ul', { class: 'hint' },
        h('li', {}, 'Word / RTF / HTML: editable paragraphs with the original fonts, sizes and colours. Choose “Exact page layout” in settings to keep the page looking identical.'),
        h('li', {}, 'Excel: text is placed into rows and columns; numbers become real numbers.'),
        h('li', {}, 'PowerPoint: one slide per page with editable text boxes.'),
        h('li', {}, 'Image / PostScript / EPS: each page as a picture at the chosen resolution.'),
        h('li', {}, 'Scanned pages are read with OCR in the language shown (desktop app).'))),
    actions: [{ label: 'OK', primary: true }]
  });
}
function setupConvert() {
  for (const r of $$('#cvt .cvopt')) {
    r.querySelector('.rad').innerHTML = '';
    r.addEventListener('click', e => { if (e.target.closest('select')) return; CV.fmt = r.dataset.k; syncCvt(); });
    const s = r.querySelector('.cvsub');
    s.addEventListener('change', () => { CV.fmt = r.dataset.k; CV.sub[r.dataset.k] = s.value; syncCvt(); });
    s.addEventListener('mousedown', () => { if (CV.fmt !== r.dataset.k) { CV.fmt = r.dataset.k; syncCvt(); } });
  }
  $('#cvGo').onclick = () => runConvert(CV.sub[CV.fmt]);
  $('#cvClose').onclick = () => { S.cvtOpen = false; syncCvt(); syncFmt(); };
  $('#cvSet').innerHTML = icon('gear'); $('#cvSet').onclick = openCvSettings;
  $('#cvHelp').innerHTML = icon('help'); $('#cvHelp').onclick = cvHelp;
  $('#cvLang').onchange = e => { cvOpts().lang = e.target.value; saveCvOpts(); };
  $('#cvToPdf').prepend(h('span', { class: 'cvi', html: icon('pdfin') })); $('#cvToPdf').onclick = () => openPicker('images');
  $('#cvCompress').prepend(h('span', { class: 'cvi', html: icon('compress') })); $('#cvCompress').onclick = openCompress;
  $('#cvOcr').prepend(h('span', { class: 'cvi', html: icon('ocr') })); $('#cvOcr').onclick = openOCR;
  $('#mConv').innerHTML = icon('convert') + 'Convert';
  $('#mConv').onclick = () => { if (S.cvtOpen) { S.cvtOpen = false; syncCvt(); syncFmt(); } else { if (S.mode !== 'edit') setMode('edit'); openConvert(); } };
}
