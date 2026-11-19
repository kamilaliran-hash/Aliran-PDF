package com.kamil.aliranpdf;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.CancellationSignal;
import android.os.ParcelFileDescriptor;
import android.print.PageRange;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintDocumentInfo;
import android.print.PrintManager;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.view.View;
import android.view.WindowInsets;
import android.webkit.JavascriptInterface;
import android.webkit.MimeTypeMap;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Hosts the Aliran PDF editor (bundled in assets/web) in a WebView.
 * Pages are served from https://appassets.androidplatform.net/ so ES modules and
 * fetch() work and everything runs offline.
 */
public class MainActivity extends Activity {
    private static final String HOST = "appassets.androidplatform.net";
    private static final String ORIGIN = "https://" + HOST;
    private static final int REQ_OPEN = 1;
    private static final int REQ_SAVE = 2;

    private WebView web;
    private ValueCallback<Uri[]> fileCallback;
    private String saveId;
    private File saveFile;

    /** Uploads from JS in progress: id -> temp file. */
    private final Map<String, File> uploads = Collections.synchronizedMap(new HashMap<>());

    /** Files opened from other apps, waiting for the editor to pick them up. */
    private final List<JSONObject> pending = Collections.synchronizedList(new ArrayList<>());
    private int incomingSeq = 0;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#eceef3"));
        setContentView(web);
        applyInsets(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setMediaPlaybackRequiresUserGesture(true);

        web.addJavascriptInterface(new Bridge(), "AliranAndroid");
        web.setWebViewClient(new Client());
        web.setWebChromeClient(new Chrome());

        cleanCache();
        handleIntent(getIntent());
        if (savedInstanceState != null) web.restoreState(savedInstanceState);
        else web.loadUrl(ORIGIN + "/index.html");
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (handleIntent(intent)) web.evaluateJavascript("window.aliranOpenPending&&aliranOpenPending()", null);
    }

    @Override
    public void onBackPressed() {
        // Close an open dialog/menu in the editor first; otherwise leave the app (keeping it in memory).
        web.evaluateJavascript(
                "(function(){var m=document.querySelector('.mback,.mmenu');if(!m)return false;" +
                "document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));" +
                "return true;})()",
                v -> { if (!"true".equals(v)) moveTaskToBack(true); });
    }

    @Override
    protected void onDestroy() {
        if (web != null) web.destroy();
        super.onDestroy();
    }

    // ---------------------------------------------------------------- insets (Android 15 edge-to-edge)

    private void applyInsets(View v) {
        v.setOnApplyWindowInsetsListener((view, insets) -> {
            int l, t, r, b;
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets i = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.ime() | WindowInsets.Type.displayCutout());
                l = i.left; t = i.top; r = i.right; b = i.bottom;
            } else {
                l = insets.getSystemWindowInsetLeft(); t = insets.getSystemWindowInsetTop();
                r = insets.getSystemWindowInsetRight(); b = insets.getSystemWindowInsetBottom();
            }
            view.setPadding(l, t, r, b);
            return insets;
        });
    }

    // ---------------------------------------------------------------- serving the bundled editor

    private class Client extends WebViewClient {
        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
            Uri u = req.getUrl();
            if (!HOST.equals(u.getHost())) return null; // fonts etc. from the internet
            String path = u.getPath() == null ? "/" : u.getPath();
            try {
                if (path.equals("/__android/pending")) {
                    JSONArray a = new JSONArray();
                    synchronized (pending) {
                        for (JSONObject o : pending) a.put(o);
                        pending.clear();
                    }
                    return response("application/json", new java.io.ByteArrayInputStream(a.toString().getBytes("UTF-8")));
                }
                if (path.equals("/__android/file")) {
                    String i = u.getQueryParameter("i");
                    File f = new File(incomingDir(), i == null ? "" : i.replaceAll("[^0-9]", ""));
                    if (!f.isFile()) return notFound();
                    return response("application/octet-stream", new FileInputStream(f));
                }
                if (path.equals("/")) path = "/index.html";
                InputStream in = getAssets().open("web" + path);
                return response(mime(path), in);
            } catch (IOException e) {
                return notFound();
            } catch (Exception e) {
                return notFound();
            }
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
            Uri u = req.getUrl();
            if (HOST.equals(u.getHost())) return false;
            if ("blob".equals(u.getScheme()) || "data".equals(u.getScheme())) return true;
            try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (ActivityNotFoundException ignored) { }
            return true;
        }
    }

    private static WebResourceResponse response(String mime, InputStream in) {
        WebResourceResponse r = new WebResourceResponse(mime, mime.startsWith("text/") || mime.endsWith("json") ? "UTF-8" : null, in);
        Map<String, String> h = new HashMap<>();
        h.put("Cache-Control", "no-cache");
        h.put("Access-Control-Allow-Origin", ORIGIN);
        r.setResponseHeaders(h);
        return r;
    }

    private static WebResourceResponse notFound() {
        WebResourceResponse r = new WebResourceResponse("text/plain", "UTF-8", new java.io.ByteArrayInputStream(new byte[0]));
        r.setStatusCodeAndReasonPhrase(404, "Not Found");
        return r;
    }

    private static String mime(String path) {
        String p = path.toLowerCase();
        if (p.endsWith(".html")) return "text/html";
        if (p.endsWith(".js") || p.endsWith(".mjs")) return "text/javascript";
        if (p.endsWith(".css")) return "text/css";
        if (p.endsWith(".json")) return "application/json";
        if (p.endsWith(".wasm")) return "application/wasm";
        if (p.endsWith(".svg")) return "image/svg+xml";
        if (p.endsWith(".ico")) return "image/x-icon";
        String ext = MimeTypeMap.getFileExtensionFromUrl(p);
        String m = ext == null ? null : MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
        return m != null ? m : "application/octet-stream";
    }

    // ---------------------------------------------------------------- <input type=file>

    private class Chrome extends WebChromeClient {
        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> cb, FileChooserParams params) {
            if (fileCallback != null) fileCallback.onReceiveValue(null);
            fileCallback = cb;
            Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
            i.addCategory(Intent.CATEGORY_OPENABLE);
            String[] types = params.getAcceptTypes();
            List<String> mimes = new ArrayList<>();
            if (types != null) for (String t : types) {
                for (String one : t.split(",")) {
                    one = one.trim();
                    if (one.isEmpty()) continue;
                    if (one.startsWith(".")) {
                        String m = MimeTypeMap.getSingleton().getMimeTypeFromExtension(one.substring(1));
                        if (m != null) one = m; else continue;
                    }
                    if (!mimes.contains(one)) mimes.add(one);
                }
            }
            if (mimes.isEmpty()) i.setType("*/*");
            else if (mimes.size() == 1) i.setType(mimes.get(0));
            else { i.setType("*/*"); i.putExtra(Intent.EXTRA_MIME_TYPES, mimes.toArray(new String[0])); }
            i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
            try {
                startActivityForResult(i, REQ_OPEN);
            } catch (ActivityNotFoundException e) {
                fileCallback = null;
                return false;
            }
            return true;
        }
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        super.onActivityResult(req, res, data);
        if (req == REQ_OPEN) {
            if (fileCallback == null) return;
            Uri[] out = null;
            if (res == RESULT_OK && data != null) {
                ClipData clip = data.getClipData();
                if (clip != null && clip.getItemCount() > 0) {
                    out = new Uri[clip.getItemCount()];
                    for (int k = 0; k < out.length; k++) out[k] = clip.getItemAt(k).getUri();
                } else if (data.getData() != null) {
                    out = new Uri[]{data.getData()};
                }
            }
            fileCallback.onReceiveValue(out);
            fileCallback = null;
        } else if (req == REQ_SAVE) {
            final String id = saveId;
            final File src = saveFile;
            saveId = null;
            saveFile = null;
            if (id == null) return;
            if (res != RESULT_OK || data == null || data.getData() == null) {
                if (src != null) src.delete();
                done(id, "declined");
                return;
            }
            final Uri dst = data.getData();
            new Thread(() -> {
                String r = "ok";
                try (InputStream in = new FileInputStream(src); OutputStream out = getContentResolver().openOutputStream(dst, "wt")) {
                    if (out == null) throw new IOException("cannot open destination");
                    copy(in, out);
                } catch (Exception e) {
                    r = String.valueOf(e.getMessage());
                } finally {
                    src.delete();
                }
                done(id, r);
            }).start();
        }
    }

    // ---------------------------------------------------------------- JS bridge

    private class Bridge {
        @JavascriptInterface
        public void begin(String id) {
            try {
                File f = File.createTempFile("up", ".bin", uploadDir());
                uploads.put(id, f);
            } catch (IOException ignored) { }
        }

        @JavascriptInterface
        public void append(String id, String b64) {
            File f = uploads.get(id);
            if (f == null) return;
            try (FileOutputStream o = new FileOutputStream(f, true)) {
                o.write(Base64.decode(b64, Base64.DEFAULT));
            } catch (IOException ignored) { }
        }

        @JavascriptInterface
        public void save(String id, String name, String mime) {
            File f = uploads.remove(id);
            runOnUiThread(() -> {
                if (f == null) { done(id, "no data"); return; }
                if (saveId != null) { f.delete(); done(id, "busy"); return; }
                Intent i = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType(mime == null || mime.isEmpty() ? "application/octet-stream" : mime);
                i.putExtra(Intent.EXTRA_TITLE, name);
                saveId = id;
                saveFile = f;
                try {
                    startActivityForResult(i, REQ_SAVE);
                } catch (ActivityNotFoundException e) {
                    saveId = null; saveFile = null; f.delete();
                    done(id, "no file picker on this device");
                }
            });
        }

        @JavascriptInterface
        public void print(String id, String jobName) {
            File f = uploads.remove(id);
            runOnUiThread(() -> {
                if (f == null) { done(id, "no data"); return; }
                PrintManager pm = (PrintManager) getSystemService(Context.PRINT_SERVICE);
                String name = jobName == null || jobName.isEmpty() ? "Aliran PDF" : jobName;
                pm.print(name, new PdfAdapter(f, name + ".pdf"), new PrintAttributes.Builder().build());
                done(id, "ok");
            });
        }

        @JavascriptInterface
        public void exit() {
            runOnUiThread(MainActivity.this::finishAndRemoveTask);
        }

        @JavascriptInterface
        public void toast(String msg) {
            runOnUiThread(() -> Toast.makeText(MainActivity.this, msg, Toast.LENGTH_SHORT).show());
        }
    }

    private void done(String id, String result) {
        runOnUiThread(() -> web.evaluateJavascript(
                "window.__aliranDone&&__aliranDone(" + JSONObject.quote(id) + "," + JSONObject.quote(result) + ")", null));
    }

    /** Hands a finished PDF to the Android print framework. */
    private static class PdfAdapter extends PrintDocumentAdapter {
        private final File file;
        private final String name;

        PdfAdapter(File file, String name) { this.file = file; this.name = name; }

        @Override
        public void onLayout(PrintAttributes oldA, PrintAttributes newA, CancellationSignal cancel, LayoutResultCallback cb, Bundle extras) {
            if (cancel.isCanceled()) { cb.onLayoutCancelled(); return; }
            cb.onLayoutFinished(new PrintDocumentInfo.Builder(name)
                    .setContentType(PrintDocumentInfo.CONTENT_TYPE_DOCUMENT)
                    .setPageCount(PrintDocumentInfo.PAGE_COUNT_UNKNOWN).build(), true);
        }

        @Override
        public void onWrite(PageRange[] pages, ParcelFileDescriptor dest, CancellationSignal cancel, WriteResultCallback cb) {
            try (InputStream in = new FileInputStream(file); OutputStream out = new FileOutputStream(dest.getFileDescriptor())) {
                copy(in, out);
                cb.onWriteFinished(new PageRange[]{PageRange.ALL_PAGES});
            } catch (Exception e) {
                cb.onWriteFailed(e.getMessage());
            }
        }

        @Override
        public void onFinish() { file.delete(); }
    }

    // ---------------------------------------------------------------- files from other apps

    private boolean handleIntent(Intent intent) {
        if (intent == null) return false;
        List<Uri> uris = new ArrayList<>();
        String action = intent.getAction();
        if (Intent.ACTION_VIEW.equals(action) && intent.getData() != null) {
            uris.add(intent.getData());
        } else if (Intent.ACTION_SEND.equals(action)) {
            Uri u = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (u != null) uris.add(u);
        } else if (Intent.ACTION_SEND_MULTIPLE.equals(action)) {
            ArrayList<Uri> l = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            if (l != null) uris.addAll(l);
        }
        if (uris.isEmpty()) return false;
        intent.setAction(Intent.ACTION_MAIN); // don't reopen on rotation
        boolean any = false;
        for (Uri u : uris) {
            try {
                String name = displayName(u);
                String type = getContentResolver().getType(u);
                if (type == null && name.toLowerCase().endsWith(".pdf")) type = "application/pdf";
                int n = ++incomingSeq;
                File f = new File(incomingDir(), String.valueOf(n));
                try (InputStream in = getContentResolver().openInputStream(u); OutputStream out = new FileOutputStream(f)) {
                    if (in == null) continue;
                    copy(in, out);
                }
                JSONObject o = new JSONObject();
                o.put("i", n);
                o.put("name", name);
                o.put("type", type == null ? "" : type);
                pending.add(o);
                any = true;
            } catch (Exception e) {
                Toast.makeText(this, "Could not open file: " + e.getMessage(), Toast.LENGTH_LONG).show();
            }
        }
        return any;
    }

    private String displayName(Uri u) {
        String name = null;
        if ("content".equals(u.getScheme())) {
            try (Cursor c = getContentResolver().query(u, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
                if (c != null && c.moveToFirst()) name = c.getString(0);
            } catch (Exception ignored) { }
        }
        if (name == null) name = u.getLastPathSegment();
        if (name == null || name.isEmpty()) name = "document.pdf";
        return name;
    }

    // ---------------------------------------------------------------- helpers

    private File incomingDir() {
        File d = new File(getCacheDir(), "incoming");
        d.mkdirs();
        return d;
    }

    private File uploadDir() {
        File d = new File(getCacheDir(), "uploads");
        d.mkdirs();
        return d;
    }

    private void cleanCache() {
        for (File d : new File[]{incomingDir(), uploadDir()}) {
            File[] l = d.listFiles();
            if (l != null) for (File f : l) f.delete();
        }
    }

    private static void copy(InputStream in, OutputStream out) throws IOException {
        byte[] buf = new byte[64 * 1024];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        out.flush();
    }
}
