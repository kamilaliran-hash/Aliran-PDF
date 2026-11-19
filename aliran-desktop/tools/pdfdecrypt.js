/* PDF password removal (Standard Security Handler, R2–R6: RC4 40/128, AES-128, AES-256).
   decryptPdf(PDFLib, bytes, password) -> Promise<Uint8Array> (unencrypted PDF)
   Throws Error with .code = 'BAD_PASSWORD' | 'UNSUPPORTED'. */
const PDFDecrypt = (() => {
  const PAD = new Uint8Array([0x28, 0xBF, 0x4E, 0x5E, 0x4E, 0x75, 0x8A, 0x41, 0x64, 0x00, 0x4E, 0x56, 0xFF, 0xFA, 0x01, 0x08, 0x2E, 0x2E, 0x00, 0xB6, 0xD0, 0x68, 0x3E, 0x80, 0x2F, 0x0C, 0xA9, 0xFE, 0x64, 0x53, 0x69, 0x7A]);
  const subtle = globalThis.crypto && globalThis.crypto.subtle;
  const cat = (...a) => { const n = a.reduce((s, x) => s + x.length, 0), o = new Uint8Array(n); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };
  const eq = (a, b, n) => { for (let i = 0; i < n; i++) if (a[i] !== b[i]) return false; return true; };
  const le32 = v => new Uint8Array([v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255]);
  const fail = (code, msg) => { const e = new Error(msg); e.code = code; return e; };

  /* ---- MD5 ---- */
  function md5(data) {
    const K = new Int32Array(64), S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
    for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0;
    const len = data.length, nBlk = ((len + 8) >> 6) + 1, m = new Uint8Array(nBlk * 64);
    m.set(data); m[len] = 0x80;
    const bits = len * 8; for (let i = 0; i < 8; i++) m[nBlk * 64 - 8 + i] = i < 4 ? (bits >>> (8 * i)) & 255 : Math.floor(bits / 2 ** (8 * i)) & 255;
    let a0 = 0x67452301, b0 = 0xefcdab89 | 0, c0 = 0x98badcfe | 0, d0 = 0x10325476;
    const W = new Int32Array(16);
    for (let o = 0; o < m.length; o += 64) {
      for (let i = 0; i < 16; i++) W[i] = m[o + i * 4] | (m[o + i * 4 + 1] << 8) | (m[o + i * 4 + 2] << 16) | (m[o + i * 4 + 3] << 24);
      let A = a0, B = b0, C = c0, D = d0;
      for (let i = 0; i < 64; i++) {
        let F, g;
        if (i < 16) { F = (B & C) | (~B & D); g = i; } else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) & 15; }
        else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) & 15; } else { F = C ^ (B | ~D); g = (7 * i) & 15; }
        const s = S[(i >> 4) * 4 + (i & 3)];
        const t = (A + F + K[i] + W[g]) | 0;
        A = D; D = C; C = B; B = (B + ((t << s) | (t >>> (32 - s)))) | 0;
      }
      a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
    }
    return cat(le32(a0), le32(b0), le32(c0), le32(d0));
  }
  /* ---- RC4 ---- */
  function rc4(key, data) {
    const s = new Uint8Array(256); for (let i = 0; i < 256; i++) s[i] = i;
    for (let i = 0, j = 0; i < 256; i++) { j = (j + s[i] + key[i % key.length]) & 255; const t = s[i]; s[i] = s[j]; s[j] = t; }
    const out = new Uint8Array(data.length);
    for (let k = 0, i = 0, j = 0; k < data.length; k++) { i = (i + 1) & 255; j = (j + s[i]) & 255; const t = s[i]; s[i] = s[j]; s[j] = t; out[k] = data[k] ^ s[(s[i] + s[j]) & 255]; }
    return out;
  }
  /* ---- AES via WebCrypto ---- */
  const aesKey = k => subtle.importKey('raw', k, 'AES-CBC', false, ['encrypt', 'decrypt']);
  async function aesEncNoPad(key, iv, data) { const c = await subtle.encrypt({ name: 'AES-CBC', iv }, await aesKey(key), data); return new Uint8Array(c, 0, data.length); }
  async function aesDecNoPad(key, iv, data) {
    if (!data.length) return data;
    const k = await aesKey(key);
    const last = data.slice(data.length - 16);
    const extra = new Uint8Array(await subtle.encrypt({ name: 'AES-CBC', iv: last }, k, new Uint8Array(16).fill(16)), 0, 16);
    return new Uint8Array(await subtle.decrypt({ name: 'AES-CBC', iv }, k, cat(data, extra)));
  }
  async function aesDecrypt(key, data) { // IV prefix + PKCS#7
    if (data.length < 32 || data.length % 16) { if (data.length < 16) return new Uint8Array(0); data = data.slice(0, 16 + Math.floor((data.length - 16) / 16) * 16); if (data.length < 32) return new Uint8Array(0); }
    const iv = data.slice(0, 16), body = data.slice(16);
    try { return new Uint8Array(await subtle.decrypt({ name: 'AES-CBC', iv }, await aesKey(key), body)); }
    catch (e) { const p = await aesDecNoPad(key, iv, body); const n = p[p.length - 1]; return n > 0 && n <= 16 ? p.slice(0, p.length - n) : p; }
  }
  const sha = async (alg, d) => new Uint8Array(await subtle.digest(alg, d));

  /* ---- key derivation ---- */
  function padPw(pw) { const o = new Uint8Array(32); const n = Math.min(32, pw.length); o.set(pw.slice(0, n)); o.set(PAD.slice(0, 32 - n), n); return o; }
  function keyR4(pw32, E) {
    let h = md5(cat(pw32, E.O, le32(E.P), E.id, (E.R >= 4 && !E.encMeta) ? new Uint8Array([255, 255, 255, 255]) : new Uint8Array(0)));
    const n = E.R === 2 ? 5 : E.len;
    if (E.R >= 3) for (let i = 0; i < 50; i++) h = md5(h.slice(0, n));
    return h.slice(0, n);
  }
  function checkUser(key, E) {
    if (E.R === 2) return eq(rc4(key, PAD), E.U, 32);
    let x = rc4(key, md5(cat(PAD, E.id)));
    for (let i = 1; i <= 19; i++) x = rc4(key.map(b => b ^ i), x);
    return eq(x, E.U, 16);
  }
  function userFromOwner(pw, E) {
    let h = md5(padPw(pw)); const n = E.R === 2 ? 5 : E.len;
    if (E.R >= 3) for (let i = 0; i < 50; i++) h = md5(h);
    const k = h.slice(0, n);
    if (E.R === 2) return rc4(k, E.O);
    let x = E.O.slice(0, 32);
    for (let i = 19; i >= 0; i--) x = rc4(k.map(b => b ^ i), x);
    return x;
  }
  async function hash2B(pw, salt, udata, R) {
    let K = await sha('SHA-256', cat(pw, salt, udata));
    if (R === 5) return K;
    for (let i = 0; ; i++) {
      const one = cat(pw, K, udata); const K1 = new Uint8Array(one.length * 64);
      for (let j = 0; j < 64; j++) K1.set(one, j * one.length);
      const E = await aesEncNoPad(K.slice(0, 16), K.slice(16, 32), K1);
      let sum = 0; for (let j = 0; j < 16; j++) sum += E[j];
      K = await sha(['SHA-256', 'SHA-384', 'SHA-512'][sum % 3], E);
      if (i >= 63 && E[E.length - 1] <= i - 31) break;
    }
    return K.slice(0, 32);
  }
  async function fileKey(pwStr, E) {
    if (E.R >= 5) {
      let pw = new TextEncoder().encode(pwStr.normalize ? pwStr.normalize('NFKC') : pwStr).slice(0, 127);
      const U48 = E.U.slice(0, 48);
      if (eq(await hash2B(pw, E.U.slice(32, 40), new Uint8Array(0), E.R), E.U, 32))
        return aesDecNoPad(await hash2B(pw, E.U.slice(40, 48), new Uint8Array(0), E.R), new Uint8Array(16), E.UE.slice(0, 32));
      if (eq(await hash2B(pw, E.O.slice(32, 40), U48, E.R), E.O, 32))
        return aesDecNoPad(await hash2B(pw, E.O.slice(40, 48), U48, E.R), new Uint8Array(16), E.OE.slice(0, 32));
      return null;
    }
    const pw = new Uint8Array([...pwStr].map(c => c.charCodeAt(0) & 255));
    let k = keyR4(padPw(pw), E); if (checkUser(k, E)) return k;
    const up = userFromOwner(pw, E); k = keyR4(up, E); if (checkUser(k, E)) return k;
    return null;
  }

  async function decryptPdf(L, bytes, password) {
    if (!subtle) throw fail('UNSUPPORTED', 'Secure cryptography is not available in this window');
    const N = n => L.PDFName.of(n);
    const deferred = [];
    const P = L.PDFParser.prototype, orig = P.parseIndirectObject;
    const ENDOBJ = [...'endobj'].map(c => c.charCodeAt(0));
    P.parseIndirectObject = async function () {
      const ref = this.parseIndirectObjectHeader(); this.skipWhitespaceAndComments();
      const obj = this.parseObject(); this.skipWhitespaceAndComments(); this.matchKeyword(ENDOBJ);
      const type = obj instanceof L.PDFRawStream ? obj.dict.lookup(N('Type')) : null;
      if (type === N('ObjStm')) deferred.push({ ref, obj });
      else if (type === N('XRef')) L.PDFXRefStreamParser.forStream(obj).parseIntoContext();
      else this.context.assign(ref, obj);
      return ref;
    };
    let ctx;
    try { ctx = await L.PDFParser.forBytesWithOptions(bytes).parseDocument(); }
    finally { P.parseIndirectObject = orig; }

    const encRef = ctx.trailerInfo.Encrypt;
    const enc = encRef instanceof L.PDFRef ? ctx.lookup(encRef) : encRef;
    if (!(enc instanceof L.PDFDict)) throw fail('UNSUPPORTED', 'This PDF is not encrypted');
    const num = k => { const v = enc.lookup(N(k)); return v ? v.asNumber() : undefined; };
    const strB = v => v ? v.asBytes() : new Uint8Array(0);
    const filter = enc.lookup(N('Filter'));
    if (filter && filter !== N('Standard')) throw fail('UNSUPPORTED', 'This PDF uses certificate or custom encryption, which cannot be removed here');
    let idArr = ctx.trailerInfo.ID; if (idArr instanceof L.PDFRef) idArr = ctx.lookup(idArr);
    const E = {
      V: num('V') || 0, R: num('R') || 2, len: Math.floor((num('Length') || 40) / 8), P: num('P') | 0,
      O: strB(enc.lookup(N('O'))), U: strB(enc.lookup(N('U'))), OE: strB(enc.lookup(N('OE'))), UE: strB(enc.lookup(N('UE'))),
      id: idArr instanceof L.PDFArray && idArr.size() ? strB(idArr.lookup(0)) : new Uint8Array(0),
      encMeta: enc.lookup(N('EncryptMetadata')) !== L.PDFBool.False,
    };
    if (E.V < 4) E.len = E.R === 2 ? 5 : Math.min(16, Math.max(5, E.len));
    // crypt filters
    let stmM = E.V >= 4 ? 'V2' : 'V2', strM = stmM;
    if (E.V >= 4) {
      const cf = enc.lookup(N('CF'));
      const methodOf = nm => {
        if (!nm || nm === N('Identity')) return 'None';
        const d = cf instanceof L.PDFDict ? cf.lookup(nm) : null; const m = d && d.lookup(N('CFM'));
        if (d && d.lookup(N('Length'))) { const l = d.lookup(N('Length')).asNumber(); if (E.V === 4) E.len = l > 32 ? l / 8 : l; }
        return m === N('AESV2') ? 'AESV2' : m === N('AESV3') ? 'AESV3' : m === N('None') ? 'None' : 'V2';
      };
      stmM = methodOf(enc.lookup(N('StmF'))); strM = methodOf(enc.lookup(N('StrF')));
      if (E.V === 4) E.len = 16;
    }
    if (E.R > 6 || E.V > 5) throw fail('UNSUPPORTED', 'Unsupported encryption version');
    let key = null;
    for (const pw of [password || '', ''].filter((v, i, a) => a.indexOf(v) === i)) { key = await fileKey(pw, E); if (key) break; }
    if (!key) throw fail('BAD_PASSWORD', 'The password is incorrect');

    const objKey = (ref, aes) => {
      if (E.R >= 5) return key;
      const n = ref.objectNumber, g = ref.generationNumber;
      const extra = new Uint8Array([n & 255, (n >> 8) & 255, (n >> 16) & 255, g & 255, (g >> 8) & 255]);
      return md5(cat(key, extra, aes ? new Uint8Array([0x73, 0x41, 0x6C, 0x54]) : new Uint8Array(0))).slice(0, Math.min(key.length + 5, 16));
    };
    const decData = async (data, ref, method) => {
      if (method === 'None') return data;
      if (method === 'AESV2' || method === 'AESV3') return aesDecrypt(objKey(ref, true), data);
      return rc4(objKey(ref, false), data);
    };
    const toHex = b => { let s = ''; for (const x of b) s += (x < 16 ? '0' : '') + x.toString(16); return s; };
    const walk = async (o, ref) => {
      if (o instanceof L.PDFDict) {
        const isSig = o.lookup(N('Type')) === N('Sig') || o.lookup(N('ByteRange'));
        for (const [k, v] of o.entries()) {
          if (isSig && k === N('Contents')) continue;
          const nv = await walk(v, ref); if (nv !== v) o.set(k, nv);
        }
        return o;
      }
      if (o instanceof L.PDFArray) { for (let i = 0; i < o.size(); i++) { const v = o.get(i), nv = await walk(v, ref); if (nv !== v) o.set(i, nv); } return o; }
      if (o instanceof L.PDFString || o instanceof L.PDFHexString) return L.PDFHexString.of(toHex(await decData(o.asBytes(), ref, strM)));
      return o;
    };
    const decStream = async (s, ref) => {
      const t = s.dict.lookup(N('Type'));
      if (t === N('XRef')) return;
      if (t === N('Metadata') && !E.encMeta) return;
      const f = s.dict.lookup(N('Filter'));
      if (f === N('Crypt') || (f instanceof L.PDFArray && f.size() && f.get(0) === N('Crypt'))) return;
      s.contents = await decData(s.contents, ref, stmM);
    };
    let n = 0;
    for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
      if (encRef instanceof L.PDFRef && ref === encRef) continue;
      if (obj instanceof L.PDFRawStream) { await walk(obj.dict, ref); await decStream(obj, ref); }
      else await walk(obj, ref);
      if (++n % 200 === 0) await new Promise(r => setTimeout(r, 0));
    }
    for (const { ref, obj } of deferred) { await decStream(obj, ref); await L.PDFObjectStreamParser.forStream(obj).parseIntoContext(); }
    if (encRef instanceof L.PDFRef) ctx.delete(encRef);
    ctx.trailerInfo.Encrypt = undefined;
    // Re-open the catalog if it lived inside an object stream.
    const root = ctx.lookup(ctx.trailerInfo.Root);
    if (!(root instanceof L.PDFDict)) for (const [r, o] of ctx.enumerateIndirectObjects()) if (o instanceof L.PDFDict && o.lookup(N('Type')) === N('Catalog')) ctx.trailerInfo.Root = r;
    let maxN = 0; for (const [r] of ctx.enumerateIndirectObjects()) maxN = Math.max(maxN, r.objectNumber);
    ctx.largestObjectNumber = maxN;
    return await L.PDFWriter.forContext(ctx, 50).serializeToBuffer();
  }
  /* ---- Protect with password: AES-256 (PDF 2.0 / Acrobat X+, revision 6) ----
     opts: { user, owner, print, copy, modify, annot } */
  async function encryptPdf(L, bytes, opts) {
    if (!subtle) throw fail('UNSUPPORTED', 'Secure cryptography is not available in this window');
    const N = n => L.PDFName.of(n);
    const plain = await (await L.PDFDocument.load(bytes, { updateMetadata: false })).save({ useObjectStreams: false });
    const ctx = await L.PDFParser.forBytesWithOptions(plain).parseDocument();
    if (ctx.trailerInfo.Encrypt) throw fail('UNSUPPORTED', 'This PDF is already encrypted');
    { // renumber objects 1..n without gaps (some readers dislike gaps in the cross-reference table)
      const old = [...ctx.enumerateIndirectObjects()].sort((a, b) => a[0].objectNumber - b[0].objectNumber);
      const map = new Map(); old.forEach(([r], i) => map.set(r, L.PDFRef.of(i + 1, 0)));
      const fix = o => {
        if (o instanceof L.PDFRef) return map.get(o) || o;
        if (o instanceof L.PDFDict) { for (const [k, v] of o.entries()) { const nv = fix(v); if (nv !== v) o.set(k, nv); } return o; }
        if (o instanceof L.PDFArray) { for (let i = 0; i < o.size(); i++) { const v = o.get(i), nv = fix(v); if (nv !== v) o.set(i, nv); } return o; }
        if (o instanceof L.PDFRawStream) { fix(o.dict); return o; }
        return o;
      };
      ctx.indirectObjects = new Map(old.map(([r, o]) => [map.get(r), fix(o)]));
      ctx.largestObjectNumber = old.length;
      for (const k of ['Root', 'Info']) if (ctx.trailerInfo[k] instanceof L.PDFRef) ctx.trailerInfo[k] = map.get(ctx.trailerInfo[k]) || ctx.trailerInfo[k];
    }
    const rnd = n => globalThis.crypto.getRandomValues(new Uint8Array(n));
    const te = new TextEncoder(), nf = s => (s.normalize ? s.normalize('NFKC') : s);
    const up = te.encode(nf(opts.user || '')).slice(0, 127);
    const op = te.encode(nf(opts.owner || opts.user || '')).slice(0, 127);
    const key = rnd(32), zero = new Uint8Array(0), iv0 = new Uint8Array(16);
    const uvs = rnd(8), uks = rnd(8);
    const U = cat(await hash2B(up, uvs, zero, 6), uvs, uks);
    const UE = await aesEncNoPad(await hash2B(up, uks, zero, 6), iv0, key);
    const ovs = rnd(8), oks = rnd(8);
    const O = cat(await hash2B(op, ovs, U, 6), ovs, oks);
    const OE = await aesEncNoPad(await hash2B(op, oks, U, 6), iv0, key);
    // permission bits (1-based): 3 print, 4 modify, 5 copy, 6 annotate, 9 fill forms, 10 accessibility, 11 assemble, 12 hi-res print
    const bit = n => 1 << (n - 1);
    let P = ~(bit(1) | bit(2) | bit(3) | bit(4) | bit(5) | bit(6) | bit(9) | bit(10) | bit(11) | bit(12));
    if (opts.print !== false) P |= bit(3) | bit(12);
    if (opts.modify !== false) P |= bit(4) | bit(11);
    P |= bit(10); // screen readers stay allowed (like Acrobat)
    if (opts.copy !== false) P |= bit(5);
    if (opts.annot !== false) P |= bit(6) | bit(9);
    P |= 0; P &= ~3;
    const perms = cat(le32(P), new Uint8Array([255, 255, 255, 255, 0x54, 0x61, 0x64, 0x62]), rnd(4));
    const Perms = await aesEncNoPad(key, iv0, perms);
    const ak = await aesKey(key);
    const encData = async d => { const iv = rnd(16); return cat(iv, new Uint8Array(await subtle.encrypt({ name: 'AES-CBC', iv }, ak, d))); };
    const toHex = b => { let s = ''; for (const x of b) s += (x < 16 ? '0' : '') + x.toString(16); return s; };
    const walk = async o => {
      if (o instanceof L.PDFDict) {
        const isSig = o.lookup(N('Type')) === N('Sig') || o.lookup(N('ByteRange'));
        for (const [k, v] of o.entries()) { if (isSig && k === N('Contents')) continue; const nv = await walk(v); if (nv !== v) o.set(k, nv); }
        return o;
      }
      if (o instanceof L.PDFArray) { for (let i = 0; i < o.size(); i++) { const v = o.get(i), nv = await walk(v); if (nv !== v) o.set(i, nv); } return o; }
      if (o instanceof L.PDFString || o instanceof L.PDFHexString) return L.PDFHexString.of(toHex(await encData(o.asBytes())));
      return o;
    };
    let n = 0;
    for (const [, obj] of ctx.enumerateIndirectObjects()) {
      if (obj instanceof L.PDFRawStream) {
        await walk(obj.dict);
        if (obj.dict.lookup(N('Type')) !== N('XRef')) obj.contents = await encData(obj.contents);
      } else await walk(obj);
      if (++n % 200 === 0) await new Promise(r => setTimeout(r, 0));
    }
    const H = b => L.PDFHexString.of(toHex(b));
    const enc = ctx.obj({
      Filter: 'Standard', V: 5, R: 6, Length: 256, P,
      CF: { StdCF: { AuthEvent: 'DocOpen', CFM: 'AESV3', Length: 32 } }, StmF: 'StdCF', StrF: 'StdCF',
    });
    enc.set(N('O'), H(O)); enc.set(N('U'), H(U)); enc.set(N('OE'), H(OE)); enc.set(N('UE'), H(UE)); enc.set(N('Perms'), H(Perms));
    enc.set(N('EncryptMetadata'), L.PDFBool.True);
    ctx.trailerInfo.Encrypt = ctx.register(enc);
    const id = H(rnd(16)); ctx.trailerInfo.ID = ctx.obj([id, id]);
    return await L.PDFWriter.forContext(ctx, 50).serializeToBuffer();
  }
  return { decryptPdf, encryptPdf };
})();
if (typeof module !== 'undefined') module.exports = PDFDecrypt;
