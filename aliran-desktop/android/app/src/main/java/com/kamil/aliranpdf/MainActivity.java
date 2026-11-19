package com.kamil.aliranpdf;

import android.app.Activity;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.CancellationSignal;
import android.os.Environment;
import android.os.ParcelFileDescriptor;
import android.print.PageRange;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintDocumentInfo;
import android.print.PrintManager;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.view.View;
import android.view.Window;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Aliran PDF for Android: the same editor as the Windows app, running in a WebView.
 * The web app is bundled in the APK (assets) and served from a private https origin,
 * so everything works offline. A small bridge ("AliranAndroid") lets the page save files
 * to Downloads, print through Android's print service and receive PDFs from other apps.
 */
public class MainActivity extends Activity {
    static final String HOST = "appassets.androidplatform.net";
    static final String START = "https://" + HOST + "/index.html";
    static final int REQ_OPEN = 7;

    WebView web;
    ValueCallback<Uri[]> fileCallback;
    volatile Uri pendingUri;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        Window w = getWindow();
        w.setStatusBarColor(0xFF1F2329);
        w.setNavigationBarColor(0xFFFFFFFF);

        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setMediaPlaybackRequiresUserGesture(true);
        s.setTextZoom(100);
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        web.addJavascriptInterface(new Bridge(), "AliranAndroid");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                if (!HOST.equals(u.getHost())) return null;
                String path = u.getPath();
                if (path == null || path.isEmpty() || path.equals("/")) path = "/index.html";
                Map<String, String> headers = new HashMap<>();
                headers.put("Access-Control-Allow-Origin", "*");
                headers.put("Cache-Control", "no-cache");
                try {
                    InputStream in = getAssets().open("web" + path);
                    String mime = mimeOf(path);
                    String enc = mime.startsWith("text/") || mime.contains("javascript") || mime.contains("json") ? "utf-8" : null;
                    return new WebResourceResponse(mime, enc, 200, "OK", headers, in);
                } catch (IOException e) {
                    return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", headers, new ByteArrayInputStream(new byte[0]));
                }
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                if (HOST.equals(u.getHost())) return false;
                try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception ignored) { }
                return true;
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> cb, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = cb;
                Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType("*/*");
                String[] mimes = mimesFor(params.getAcceptTypes());
                if (mimes.length > 0) i.putExtra(Intent.EXTRA_MIME_TYPES, mimes);
                if (params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                try {
                    startActivityForResult(i, REQ_OPEN);
                } catch (Exception e) {
                    fileCallback = null;
                    return false;
                }
                return true;
            }
        });

        setContentView(web);
        takeIntent(getIntent());
        if (state != null) web.restoreState(state);
        else web.loadUrl(START);
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        if (web != null) web.saveState(out);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        takeIntent(intent);
        if (pendingUri != null && web != null) web.evaluateJavascript("window.aliranOpenIntent && aliranOpenIntent()", null);
    }

    void takeIntent(Intent i) {
        if (i == null) return;
        Uri u = null;
        if (Intent.ACTION_VIEW.equals(i.getAction()) || Intent.ACTION_EDIT.equals(i.getAction())) u = i.getData();
        else if (Intent.ACTION_SEND.equals(i.getAction())) u = i.getParcelableExtra(Intent.EXTRA_STREAM);
        if (u != null) pendingUri = u;
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        super.onActivityResult(req, res, data);
        if (req != REQ_OPEN) return;
        Uri[] result = null;
        if (res == RESULT_OK && data != null) {
            ClipData cd = data.getClipData();
            if (cd != null && cd.getItemCount() > 0) {
                result = new Uri[cd.getItemCount()];
                for (int k = 0; k < cd.getItemCount(); k++) result[k] = cd.getItemAt(k).getUri();
            } else if (data.getData() != null) {
                result = new Uri[]{data.getData()};
            }
        }
        if (fileCallback != null) fileCallback.onReceiveValue(result);
        fileCallback = null;
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (web == null) { finish(); return; }
        web.evaluateJavascript("(window.aliranBack && aliranBack()) ? 'yes' : 'no'", v -> {
            if (v == null || !v.contains("yes")) finish();
        });
    }

    @Override
    protected void onDestroy() {
        if (web != null) { web.destroy(); web = null; }
        super.onDestroy();
    }

    static String mimeOf(String p) {
        String l = p.toLowerCase();
        if (l.endsWith(".html") || l.endsWith(".htm")) return "text/html";
        if (l.endsWith(".js") || l.endsWith(".mjs")) return "application/javascript";
        if (l.endsWith(".css")) return "text/css";
        if (l.endsWith(".json")) return "application/json";
        if (l.endsWith(".wasm")) return "application/wasm";
        if (l.endsWith(".png")) return "image/png";
        if (l.endsWith(".svg")) return "image/svg+xml";
        if (l.endsWith(".ico")) return "image/x-icon";
        if (l.endsWith(".ttf")) return "font/ttf";
        if (l.endsWith(".txt")) return "text/plain";
        return "application/octet-stream";
    }

    static String[] mimesFor(String[] accept) {
        List<String> out = new ArrayList<>();
        if (accept != null) {
            for (String a0 : accept) {
                if (a0 == null) continue;
                for (String a : a0.split(",")) {
                    a = a.trim().toLowerCase();
                    if (a.isEmpty()) continue;
                    String m;
                    if (a.contains("/")) m = a;
                    else if (a.equals(".pdf")) m = "application/pdf";
                    else if (a.equals(".png")) m = "image/png";
                    else if (a.equals(".jpg") || a.equals(".jpeg")) m = "image/jpeg";
                    else if (a.equals(".gif")) m = "image/gif";
                    else if (a.equals(".webp")) m = "image/webp";
                    else if (a.equals(".bmp")) m = "image/bmp";
                    else return new String[0]; // unknown extension: let the user pick any file
                    if (!out.contains(m)) out.add(m);
                }
            }
        }
        return out.toArray(new String[0]);
    }

    String displayName(Uri u) {
        String name = null;
        try (Cursor c = getContentResolver().query(u, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (c != null && c.moveToFirst()) name = c.getString(0);
        } catch (Exception ignored) { }
        if (name == null) name = u.getLastPathSegment();
        return name == null ? "document.pdf" : name;
    }

    static byte[] readAll(InputStream in) throws IOException {
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        byte[] buf = new byte[65536];
        int n;
        while ((n = in.read(buf)) > 0) bo.write(buf, 0, n);
        return bo.toByteArray();
    }

    /** Methods the page can call as window.AliranAndroid.*  (they run on a background thread). */
    class Bridge {
        @JavascriptInterface
        public String saveFile(String name, String mime, String b64) {
            JSONObject r = new JSONObject();
            try {
                byte[] data = Base64.decode(b64, Base64.DEFAULT);
                ContentResolver cr = getContentResolver();
                ContentValues v = new ContentValues();
                v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
                v.put(MediaStore.MediaColumns.MIME_TYPE, mime);
                v.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/Aliran PDF");
                v.put(MediaStore.MediaColumns.IS_PENDING, 1);
                Uri uri = cr.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                if (uri == null) throw new IOException("Android refused to create the file");
                try (OutputStream o = cr.openOutputStream(uri)) {
                    if (o == null) throw new IOException("Cannot write the file");
                    o.write(data);
                }
                ContentValues done = new ContentValues();
                done.put(MediaStore.MediaColumns.IS_PENDING, 0);
                cr.update(uri, done, null, null);
                r.put("path", "Download/Aliran PDF/" + displayName(uri));
                r.put("uri", uri.toString());
            } catch (Exception e) {
                try { r.put("error", String.valueOf(e.getMessage())); } catch (Exception ignored) { }
            }
            return r.toString();
        }

        @JavascriptInterface
        public String takeIntentFile() {
            Uri u = pendingUri;
            pendingUri = null;
            if (u == null) return "";
            JSONObject r = new JSONObject();
            try (InputStream in = getContentResolver().openInputStream(u)) {
                if (in == null) throw new IOException("Cannot read the file");
                byte[] data = readAll(in);
                r.put("name", displayName(u));
                r.put("mime", String.valueOf(getContentResolver().getType(u)));
                r.put("b64", Base64.encodeToString(data, Base64.NO_WRAP));
            } catch (Exception e) {
                try { r.put("error", String.valueOf(e.getMessage())); } catch (Exception ignored) { }
            }
            return r.toString();
        }

        @JavascriptInterface
        public void printPdf(String name, String b64) {
            final byte[] data = Base64.decode(b64, Base64.DEFAULT);
            final String job = name == null || name.isEmpty() ? "Aliran PDF" : name;
            runOnUiThread(() -> {
                PrintManager pm = (PrintManager) getSystemService(PRINT_SERVICE);
                if (pm == null) return;
                pm.print(job, new PrintDocumentAdapter() {
                    @Override
                    public void onLayout(PrintAttributes oldA, PrintAttributes newA, CancellationSignal cancel, LayoutResultCallback cb, Bundle extras) {
                        if (cancel.isCanceled()) { cb.onLayoutCancelled(); return; }
                        cb.onLayoutFinished(new PrintDocumentInfo.Builder(job + ".pdf").setContentType(PrintDocumentInfo.CONTENT_TYPE_DOCUMENT).build(), true);
                    }

                    @Override
                    public void onWrite(PageRange[] pages, ParcelFileDescriptor dest, CancellationSignal cancel, WriteResultCallback cb) {
                        try (OutputStream o = new FileOutputStream(dest.getFileDescriptor())) {
                            o.write(data);
                            cb.onWriteFinished(new PageRange[]{PageRange.ALL_PAGES});
                        } catch (Exception e) {
                            cb.onWriteFailed(e.getMessage());
                        }
                    }
                }, null);
            });
        }

        @JavascriptInterface
        public void share(String uri, String mime) {
            runOnUiThread(() -> {
                try {
                    Intent i = new Intent(Intent.ACTION_SEND);
                    i.setType(mime);
                    i.putExtra(Intent.EXTRA_STREAM, Uri.parse(uri));
                    i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                    startActivity(Intent.createChooser(i, "Share"));
                } catch (Exception ignored) { }
            });
        }

        @JavascriptInterface
        public String version() { return Build.VERSION.RELEASE; }

        @JavascriptInterface
        public void exit() { runOnUiThread(MainActivity.this::finish); }
    }
}
