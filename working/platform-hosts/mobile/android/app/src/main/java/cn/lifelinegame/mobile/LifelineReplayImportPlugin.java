package cn.lifelinegame.mobile;

import android.content.Intent;
import android.net.Uri;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebView;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.WebViewListener;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import androidx.activity.result.ActivityResult;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.Objects;

@CapacitorPlugin(name = "LifelineReplayImport")
public final class LifelineReplayImportPlugin extends Plugin {
    private static final int MAX_BYTES = 4_000_000;
    private boolean pickerActive;
    private String activeCallId;
    private PluginCall activePickerCall;
    private boolean pageReady;
    private long pageGeneration;
    private long pickerGeneration;
    private WebViewListener webViewListener;

    @Override
    public void load() {
        super.load();
        webViewListener = new WebViewListener() {
            @Override public void onPageStarted(WebView webView) { synchronized (LifelineReplayImportPlugin.this) { pageGeneration += 1; pageReady = false; } }
            @Override public void onPageLoaded(WebView webView) { synchronized (LifelineReplayImportPlugin.this) { pageReady = true; } }
            @Override public boolean onRenderProcessGone(WebView webView, RenderProcessGoneDetail detail) {
                synchronized (LifelineReplayImportPlugin.this) { pageGeneration += 1; pageReady = false; }
                return false;
            }
        };
        getBridge().addWebViewListener(webViewListener);
    }

    @PluginMethod
    public synchronized void selectReplay(PluginCall call) {
        if (pickerActive) {
            call.reject("Replay file selection is already active.", "busy");
            return;
        }
        if (!pageReady) {
            call.reject("Replay import is unavailable for this page.", "read-failed");
            return;
        }
        if (call.getData().length() != 0) {
            call.reject("Invalid replay import request.", "invalid-request");
            return;
        }
        pickerActive = true;
        activePickerCall = call;
        activeCallId = call.getCallbackId();
        pickerGeneration = pageGeneration;
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("*/*");
        intent.putExtra(Intent.EXTRA_MIME_TYPES, new String[] { "application/json", "text/json", "text/plain", "application/octet-stream" });
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        try {
            startActivityForResult(call, intent, "handleDocumentPicker");
        } catch (Exception error) {
            if (activePickerCall == call && Objects.equals(activeCallId, call.getCallbackId())) {
                pickerActive = false;
                activePickerCall = null;
                activeCallId = null;
                call.reject("Could not open the system file picker. Please try again.", "read-failed");
            }
        }
    }

    @ActivityCallback
    private synchronized void handleDocumentPicker(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (!pickerActive || activePickerCall != call || !Objects.equals(activeCallId, call.getCallbackId())) {
            if (getBridge() != null) call.release(getBridge());
            return;
        }
        long callbackGeneration = pickerGeneration;
        pickerActive = false;
        activePickerCall = null;
        activeCallId = null;
        if (!pageReady || callbackGeneration != pageGeneration) {
            if (getBridge() != null) call.release(getBridge());
            return;
        }
        if (result == null || result.getResultCode() != android.app.Activity.RESULT_OK) {
            JSObject cancelled = new JSObject();
            cancelled.put("status", "cancelled");
            call.resolve(cancelled);
            return;
        }
        Intent data = result.getData();
        Uri uri = data == null ? null : data.getData();
        if (uri == null) {
            call.reject("Could not read the selected replay file.", "read-failed");
            return;
        }
        try (InputStream input = getContext().getContentResolver().openInputStream(uri)) {
            if (input == null) throw new IllegalStateException("File stream unavailable.");
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int total = 0;
            int count;
            while ((count = input.read(buffer)) != -1) {
                total += count;
                if (total > MAX_BYTES) {
                    JSObject tooLarge = new JSObject();
                    tooLarge.put("status", "too-large");
                    call.resolve(tooLarge);
                    return;
                }
                bytes.write(buffer, 0, count);
            }
            String text;
            try {
                text = StandardCharsets.UTF_8.newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(bytes.toByteArray())).toString();
            } catch (CharacterCodingException error) {
                throw new IllegalArgumentException("Invalid UTF-8 replay file.");
            }
            JSObject selected = new JSObject();
            selected.put("status", "selected");
            selected.put("text", text);
            call.resolve(selected);
        } catch (Exception error) {
            call.reject("Could not read the selected replay file. Please choose it again.", "read-failed");
        }
    }

    @Override
    public synchronized void handleOnDestroy() {
        pickerActive = false;
        if (activePickerCall != null && getBridge() != null) activePickerCall.release(getBridge());
        activePickerCall = null;
        activeCallId = null;
        if (webViewListener != null && getBridge() != null) {
            getBridge().removeWebViewListener(webViewListener);
            webViewListener = null;
        }
        super.handleOnDestroy();
    }
}
