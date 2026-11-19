// Aliran PDF — Android bridge. Loaded before the editor's own scripts.
// Connects the web editor to native Android: saving files (system "Save to" picker),
// printing (Android print service), files opened from other apps, and the Exit command.
(function () {
  'use strict';
  const A = window.AliranAndroid;
  if (!A) return;

  const CHUNK = 384 * 1024; // bytes per bridge call (base64 grows it by 4/3)
  const pending = new Map();
  let seq = 0;

  function b64(u8) {
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  }
  async function upload(data) {
    const u8 = data instanceof Uint8Array ? data
      : data instanceof ArrayBuffer ? new Uint8Array(data)
      : new Uint8Array(await data.arrayBuffer());
    const id = String(++seq);
    A.begin(id);
    for (let i = 0; i < u8.length; i += CHUNK) A.append(id, b64(u8.subarray(i, i + CHUNK)));
    return id;
  }
  function wait(id) { return new Promise(res => pending.set(id, res)); }

  // Called by the native side when the "Save to" picker / print job is done.
  window.__aliranDone = function (id, result) {
    const r = pending.get(String(id));
    if (r) { pending.delete(String(id)); r(result); }
  };

  const mimeOf = n => /\.pdf$/i.test(n) ? 'application/pdf' : /\.zip$/i.test(n) ? 'application/zip'
    : /\.png$/i.test(n) ? 'image/png' : /\.jpe?g$/i.test(n) ? 'image/jpeg' : /\.txt$/i.test(n) ? 'text/plain'
    : 'application/octet-stream';

  // The editor saves through window.claude.use('downloads').save({ filename, data }).
  const downloads = {
    async save({ filename, data }) {
      const id = await upload(data);
      const done = wait(id);
      A.save(id, filename || 'document.pdf', mimeOf(filename || ''));
      const r = await done;
      if (r !== 'ok') { const e = new Error(r === 'declined' ? 'Save cancelled' : 'Could not save: ' + r); e.code = r === 'declined' ? 'declined' : 'failed'; throw e; }
    }
  };
  window.claude = { use: name => name === 'downloads' ? Promise.resolve(downloads) : Promise.reject(new Error('not available')) };

  window.aliranAndroidPrint = async function (bytes, name) {
    const id = await upload(bytes);
    const done = wait(id);
    A.print(id, (name || 'Aliran PDF').replace(/\.pdf$/i, ''));
    return done;
  };

  window.close = function () { A.exit(); };

  // Files shared to / opened with Aliran PDF from other apps.
  let ready = false, busyOpen = false;
  window.aliranOpenPending = async function () {
    if (!ready || busyOpen || typeof handleFiles !== 'function') return;
    busyOpen = true;
    try {
      const list = await (await fetch('/__android/pending', { cache: 'no-store' })).json();
      if (!list.length) return;
      const files = await Promise.all(list.map(async f => {
        const b = await (await fetch('/__android/file?i=' + f.i, { cache: 'no-store' })).blob();
        return new File([b], f.name, { type: f.type || b.type });
      }));
      await handleFiles(files, { replace: true });
    } catch (e) { console.warn('open from Android failed', e); }
    finally { busyOpen = false; }
  };
  window.aliranAndroidReady = function () { ready = true; window.aliranOpenPending(); };
})();
