"""Compile and exercise the actual Android replay-import plugin with small host stubs.

Run with --java-bin pointing to a JDK bin directory. This verifies plugin Java
behavior on the host; it does not compile against the Android SDK or prove
picker behavior on an Android device.
"""
from pathlib import Path
import argparse
import hashlib
import json
import shutil
import subprocess
import tempfile
import sys


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--java-bin', type=Path, required=True)
args = parser.parse_args()
root = Path(__file__).resolve().parents[2]
source = root / 'mobile/android/app/src/main/java/cn/lifelinegame/mobile/LifelineReplayImportPlugin.java'
source_bytes = source.read_bytes()
sha = lambda value: hashlib.sha256(value).hexdigest()

stubs = {
    'android/content/Context.java': r'''package android.content;
public class Context {
  public static final ContentResolver RESOLVER = new ContentResolver();
  public ContentResolver getContentResolver() { return RESOLVER; }
}''',
    'android/content/ContentResolver.java': r'''package android.content;
import android.net.Uri;
import java.io.InputStream;
public class ContentResolver {
  public static InputStream stream;
  public static RuntimeException failure;
  public static Uri lastUri;
  public InputStream openInputStream(Uri uri) {
    lastUri = uri;
    if (failure != null) throw failure;
    return stream;
  }
}''',
    'android/content/Intent.java': r'''package android.content;
import android.net.Uri;
import java.util.HashMap;
import java.util.Map;
public class Intent {
  public static final String ACTION_OPEN_DOCUMENT = "android.intent.action.OPEN_DOCUMENT";
  public static final String CATEGORY_OPENABLE = "android.intent.category.OPENABLE";
  public static final String EXTRA_MIME_TYPES = "android.intent.extra.MIME_TYPES";
  public static final int FLAG_GRANT_READ_URI_PERMISSION = 1;
  private final String action;
  private final Map<String,Object> extras = new HashMap<>();
  private String type; private android.net.Uri data;
  private int flags;
  public Intent(String action) { this.action = action; }
  public Intent addCategory(String category) { extras.put("category", category); return this; }
  public Intent setType(String value) { type = value; return this; }
  public Intent setData(android.net.Uri value) { data = value; return this; }
  public Intent putExtra(String key, String[] value) { extras.put(key, value); return this; }
  public Intent addFlags(int value) { flags |= value; return this; }
  public String getAction() { return action; }
  public String getCategory() { return (String) extras.get("category"); }
  public String getType() { return type; }
  public String[] getStringArrayExtra(String key) { return (String[]) extras.get(key); }
  public int getFlags() { return flags; }
  public android.net.Uri getData() { return data; }
}''',
    'android/net/Uri.java': r'''package android.net;
public final class Uri {
  private final String value;
  private Uri(String value) { this.value = value; }
  public static Uri parse(String value) { return new Uri(value); }
  @Override public String toString() { return value; }
}''',
    'android/webkit/WebView.java': r'''package android.webkit; public class WebView {}''',
    'android/webkit/RenderProcessGoneDetail.java': r'''package android.webkit; public class RenderProcessGoneDetail {}''',
    'android/app/Activity.java': r'''package android.app; public class Activity { public static final int RESULT_OK = -1; }''',
    'androidx/activity/result/ActivityResult.java': r'''package androidx.activity.result;
import android.content.Intent;
public class ActivityResult {
  private final int resultCode; private final Intent data;
  public ActivityResult(int resultCode, Intent data) { this.resultCode = resultCode; this.data = data; }
  public int getResultCode() { return resultCode; }
  public Intent getData() { return data; }
}''',
    'com/getcapacitor/JSObject.java': r'''package com.getcapacitor;
import java.util.LinkedHashMap;
import java.util.Map;
public class JSObject {
  private final Map<String,Object> values = new LinkedHashMap<>();
  public JSObject put(String key, Object value) { values.put(key, value); return this; }
  public int length() { return values.size(); }
  public Object get(String key) { return values.get(key); }
  public boolean has(String key) { return values.containsKey(key); }
  public java.util.Set<String> keySet() { return values.keySet(); }
}''',
    'com/getcapacitor/PluginCall.java': r'''package com.getcapacitor;
public class PluginCall {
  private final String callbackId;
  private final JSObject data;
  public JSObject result; public String error; public String errorCode; public int releaseCount;
  public PluginCall(String callbackId) { this(callbackId, new JSObject()); }
  public PluginCall(String callbackId, JSObject data) { this.callbackId = callbackId; this.data = data; }
  public JSObject getData() { return data; }
  public String getCallbackId() { return callbackId; }
  public void resolve(JSObject value) { result = value; }
  public void reject(String message, String code) { error = message; errorCode = code; }
  public void release(Bridge bridge) { releaseCount++; }
}''',
    'com/getcapacitor/Bridge.java': r'''package com.getcapacitor;
import android.content.Intent;
import android.webkit.WebView;
import java.util.ArrayList;
import java.util.List;
public class Bridge {
  public final WebView webView = new WebView();
  public final List<WebViewListener> listeners = new ArrayList<>();
  public PluginCall startedCall; public Intent startedIntent; public String callbackName;
  public RuntimeException startFailure;
  public void addWebViewListener(WebViewListener value) { listeners.add(value); }
  public void removeWebViewListener(WebViewListener value) { listeners.remove(value); }
  public void startActivityForResult(PluginCall call, Intent intent, String callback) {
    if (startFailure != null) throw startFailure;
    startedCall = call; startedIntent = intent; callbackName = callback;
  }
}''',
    'com/getcapacitor/Plugin.java': r'''package com.getcapacitor;
import android.content.Context;
import android.content.Intent;
public class Plugin {
  private final Bridge bridge = new Bridge(); private final Context context = new Context();
  public Bridge getBridge() { return bridge; }
  public Context getContext() { return context; }
  public void load() {}
  public void handleOnDestroy() {}
  protected void startActivityForResult(PluginCall call, Intent intent, String callback) {
    bridge.startActivityForResult(call, intent, callback);
  }
}''',
    'com/getcapacitor/PluginMethod.java': r'''package com.getcapacitor; public @interface PluginMethod {}''',
    'com/getcapacitor/WebViewListener.java': r'''package com.getcapacitor;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebView;
public class WebViewListener {
  public void onPageStarted(WebView view) {}
  public void onPageLoaded(WebView view) {}
  public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) { return false; }
}''',
    'com/getcapacitor/annotation/ActivityCallback.java': r'''package com.getcapacitor.annotation; public @interface ActivityCallback {}''',
    'com/getcapacitor/annotation/CapacitorPlugin.java': r'''package com.getcapacitor.annotation; public @interface CapacitorPlugin { String name(); }''',
    'AndroidReplayImportProbe.java': r'''import android.app.Activity;
import android.content.ContentResolver;
import android.content.Intent;
import android.net.Uri;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebView;
import androidx.activity.result.ActivityResult;
import cn.lifelinegame.mobile.LifelineReplayImportPlugin;
import com.getcapacitor.Bridge;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import com.getcapacitor.WebViewListener;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Collections;

public final class AndroidReplayImportProbe {
  private static int failures, sequence;
  private static void check(boolean condition, String message) { if (!condition) throw new AssertionError(message); }
  private static void test(String name, Runnable body) {
    try { resetResolver(); body.run(); System.out.println("PASS\t" + name); }
    catch (Throwable error) { failures++; System.out.println("FAIL\t" + name + "\t" + error.getClass().getSimpleName() + ": " + error.getMessage()); }
  }
  private static void resetResolver() { ContentResolver.stream = null; ContentResolver.failure = null; ContentResolver.lastUri = null; }
  private static final class Fixture {
    final LifelineReplayImportPlugin plugin = new LifelineReplayImportPlugin();
    final Bridge bridge;
    Fixture() { plugin.load(); bridge = plugin.getBridge(); }
    WebViewListener listener() { return bridge.listeners.get(0); }
    void ready() { listener().onPageLoaded(bridge.webView); }
    PluginCall select(String id) { PluginCall call = new PluginCall(id); plugin.selectReplay(call); return call; }
    void complete(PluginCall call, ActivityResult result) {
      try {
        Method method = LifelineReplayImportPlugin.class.getDeclaredMethod("handleDocumentPicker", PluginCall.class, ActivityResult.class);
        method.setAccessible(true); method.invoke(plugin, call, result);
      } catch (ReflectiveOperationException error) { throw new AssertionError("Could not invoke actual activity callback", error); }
    }
    void choose(PluginCall call, String uri) {
      complete(call, new ActivityResult(Activity.RESULT_OK, new Intent("selected").setData(Uri.parse(uri))));
    }
  }
  private static byte[] bytes(int length) { byte[] value = new byte[length]; Arrays.fill(value, (byte)'x'); return value; }
  private static final class ChunkedInput extends InputStream {
    private final byte[] value; private int offset; int reads; int largestRequest;
    ChunkedInput(byte[] value) { this.value = value; }
    @Override public int read() { reads++; return offset == value.length ? -1 : value[offset++] & 255; }
    @Override public int read(byte[] target, int start, int length) {
      reads++; largestRequest = Math.max(largestRequest, length);
      if (offset == value.length) return -1;
      int count = Math.min(length, value.length - offset); System.arraycopy(value, offset, target, start, count); offset += count; return count;
    }
  }
  private static final class ShortReadInput extends InputStream {
    private final byte[] value; private int offset; int reads; int bytesRead;
    ShortReadInput(byte[] value) { this.value = value; }
    @Override public int read() { reads++; if (offset == value.length) return -1; bytesRead++; return value[offset++] & 255; }
    @Override public int read(byte[] target, int start, int length) {
      reads++; if (offset == value.length) return -1;
      int count = Math.min(Math.min(length, 3), value.length - offset);
      System.arraycopy(value, offset, target, start, count); offset += count; bytesRead += count; return count;
    }
  }
  private static void withSelected(Fixture f, PluginCall call, String uri, byte[] payload) {
    ContentResolver.stream = new ChunkedInput(payload); f.choose(call, uri);
  }
  private static boolean hasMime(String[] values, String sought) { return values != null && Arrays.asList(values).contains(sought); }

  public static void main(String[] args) {
    test("not-ready page rejects import", () -> {
      Fixture f = new Fixture(); PluginCall call = f.select("not-ready");
      check(call.error != null && "read-failed".equals(call.errorCode) && f.bridge.startedCall == null, "not-ready call was not rejected before opening picker");
    });
    test("picker uses ACTION_OPEN_DOCUMENT, OPENABLE and JSON MIME filter", () -> {
      Fixture f = new Fixture(); f.ready(); PluginCall call = f.select("intent");
      check(call.error == null && f.bridge.startedCall == call, "picker did not start");
      check(Intent.ACTION_OPEN_DOCUMENT.equals(f.bridge.startedIntent.getAction()), "wrong picker action");
      check(Intent.CATEGORY_OPENABLE.equals(f.bridge.startedIntent.getCategory()), "picker is not openable");
      check("*/*".equals(f.bridge.startedIntent.getType()), "picker main MIME type changed");
      check(hasMime(f.bridge.startedIntent.getStringArrayExtra(Intent.EXTRA_MIME_TYPES), "application/json"), "JSON MIME filter missing");
      check(f.bridge.startedIntent.getFlags() == Intent.FLAG_GRANT_READ_URI_PERMISSION, "picker flags differ from the temporary read-grant contract");
      check("handleDocumentPicker".equals(f.bridge.callbackName), "unexpected host callback route");
    });
    test("only one picker is active", () -> {
      Fixture f = new Fixture(); f.ready(); PluginCall first = f.select("first"); PluginCall second = f.select("second");
      check(f.bridge.startedCall == first, "second call replaced active picker");
      check("busy".equals(second.errorCode) && second.result == null, "concurrent picker was not rejected as busy");
    });
    test("picker cancellation resolves without exposing a URI", () -> {
      Fixture f = new Fixture(); f.ready(); PluginCall call = f.select("cancel");
      f.complete(call, new ActivityResult(0, null));
      check("cancelled".equals(call.result.get("status")) && call.error == null, "cancel was not a clean result");
      check(call.result.length() == 1 && call.result.keySet().equals(Collections.singleton("status")), "cancel result schema contains unexpected fields");
      check(ContentResolver.lastUri == null, "cancel unexpectedly opened a content URI");
      PluginCall next = f.select("next");
      check(next.error == null && f.bridge.startedCall == next, "picker lock was not released after cancellation");
    });
    test("exact 4,000,000-byte file succeeds through multiple bounded reads", () -> {
      Fixture f = new Fixture(); f.ready(); PluginCall call = f.select("exact"); byte[] payload = bytes(4_000_000);
      ChunkedInput input = new ChunkedInput(payload); ContentResolver.stream = input; f.choose(call, "content://provider/private/replay.json");
      check("selected".equals(call.result.get("status")), "exact limit was rejected");
      check(((String)call.result.get("text")).length() == 4_000_000, "exact payload length changed");
      check(input.reads > 1 && input.largestRequest <= 8192, "file was not consumed in bounded chunks");
      check(!call.result.has("uri") && !call.result.has("path"), "selected response exposed storage location");
    });
    test("short reads before EOF are accumulated into complete content", () -> {
      Fixture f = new Fixture(); f.ready(); PluginCall call = f.select("short-read");
      byte[] payload = "{\"replay\":\"complete\"}".getBytes(StandardCharsets.UTF_8);
      ShortReadInput input = new ShortReadInput(payload); ContentResolver.stream = input;
      f.choose(call, "content://provider/short-read.json");
      check("selected".equals(call.result.get("status")), "short-read payload was rejected");
      check(payload.length == input.bytesRead && input.reads > 2, "plugin stopped before EOF across short reads");
      check(new String(payload, StandardCharsets.UTF_8).equals(call.result.get("text")), "short-read content was truncated or changed");
    });
    test("4,000,001-byte file is rejected without returning content", () -> {
      Fixture f = new Fixture(); f.ready(); PluginCall call = f.select("oversize");
      withSelected(f, call, "content://provider/private/oversize.json", bytes(4_000_001));
      check("too-large".equals(call.result.get("status")) && !call.result.has("text"), "oversized payload was not bounded");
    });
    test("too-large result schema contains only status", () -> {
      Fixture f = new Fixture(); f.ready(); PluginCall call = f.select("oversize-schema");
      withSelected(f, call, "content://provider/private/oversize-schema.json", bytes(4_000_001));
      check("too-large".equals(call.result.get("status")), "oversized result status is incorrect");
      check(call.result.length() == 1 && call.result.keySet().equals(Collections.singleton("status")), "too-large result schema contains unexpected fields");
    });
    test("malformed UTF-8 is rejected with a generic message", () -> {
      Fixture f = new Fixture(); f.ready(); PluginCall call = f.select("utf8");
      withSelected(f, call, "content://provider/private/bad.json", new byte[] {(byte)0xc3, 0x28});
      check(call.result == null && call.error != null, "malformed UTF-8 was accepted");
      check(!call.error.contains("content:") && !call.error.contains("private") && !call.error.contains("bad.json"), "error leaked selected URI");
    });
    test("provider read errors do not expose content URI or local path", () -> {
      Fixture f = new Fixture(); f.ready(); PluginCall call = f.select("read-error");
      ContentResolver.failure = new IllegalStateException("content://secret/private/device/path.json");
      f.choose(call, "content://secret/private/device/path.json");
      check(call.error != null && call.result == null, "provider failure was not rejected");
      check(!call.error.contains("content:") && !call.error.contains("secret") && !call.error.contains("path.json"), "provider detail escaped");
    });
    test("page-start invalidates and releases the old picker callback", () -> {
      Fixture f = new Fixture(); f.ready(); PluginCall old = f.select("page-start");
      f.listener().onPageStarted(f.bridge.webView); f.listener().onPageLoaded(f.bridge.webView);
      ChunkedInput input = new ChunkedInput(bytes(2)); ContentResolver.stream = input;
      f.choose(old, "content://private/old.json");
      check(old.result == null && old.error == null && old.releaseCount > 0, "stale callback published a result instead of releasing");
      check(ContentResolver.lastUri == null && input.reads == 0, "page-start stale callback opened the selected content URI");
    });
    test("renderer loss invalidates and releases the old picker callback", () -> {
      Fixture f = new Fixture(); f.ready(); PluginCall old = f.select("renderer-gone");
      f.listener().onRenderProcessGone(f.bridge.webView, new RenderProcessGoneDetail());
      f.listener().onPageLoaded(f.bridge.webView);
      ChunkedInput input = new ChunkedInput(bytes(2)); ContentResolver.stream = input;
      f.choose(old, "content://private/old.json");
      check(old.result == null && old.error == null && old.releaseCount > 0, "renderer-stale callback published a result instead of releasing");
      check(ContentResolver.lastUri == null && input.reads == 0, "renderer-stale callback opened the selected content URI");
    });
    test("destroy releases pending callback and ignores its late result", () -> {
      Fixture f = new Fixture(); f.ready(); PluginCall old = f.select("destroy"); f.plugin.handleOnDestroy();
      withSelected(f, old, "content://private/old.json", bytes(2));
      check(old.result == null && old.error == null && old.releaseCount > 0, "destroyed callback published a result");
    });
    test("page transition drains old callback before new owner starts and isolates its duplicate", () -> {
      Fixture f = new Fixture(); f.ready(); PluginCall old = f.select("old-owner");
      f.listener().onPageStarted(f.bridge.webView); f.listener().onPageLoaded(f.bridge.webView);
      PluginCall premature = f.select("before-old-result");
      check("busy".equals(premature.errorCode) && f.bridge.startedCall == old, "new picker bypassed the outstanding old owner");

      ChunkedInput oldInput = new ChunkedInput(bytes(2)); ContentResolver.stream = oldInput;
      f.choose(old, "content://private/old.json");
      check(old.result == null && old.error == null && old.releaseCount > 0, "first stale callback did not release its old owner");
      check(ContentResolver.lastUri == null && oldInput.reads == 0, "first stale callback opened its content URI");

      PluginCall current = f.select("new-owner");
      check(current.error == null && f.bridge.startedCall == current, "new owner could not start after old callback drained");
      f.complete(old, new ActivityResult(Activity.RESULT_OK, new Intent("selected").setData(Uri.parse("content://private/late.json"))));
      check(f.bridge.startedCall == current && current.result == null && current.error == null, "duplicate stale callback changed the current owner");
      check(ContentResolver.lastUri == null, "duplicate stale callback opened its content URI");
      withSelected(f, current, "content://private/current.json", bytes(2));
      check("selected".equals(current.result.get("status")), "new owner lost callback after stale completion");
    });
    test("picker launch error is generic and active lock is released", () -> {
      Fixture f = new Fixture(); f.ready(); f.bridge.startFailure = new IllegalStateException("content://private/launch/path");
      PluginCall failed = f.select("launch-error");
      check(failed.error != null && "read-failed".equals(failed.errorCode), "launch failure did not reject generically");
      check(!failed.error.contains("content:") && !failed.error.contains("private"), "launch detail escaped");
      f.bridge.startFailure = null; PluginCall next = f.select("after-launch-error");
      check(f.bridge.startedCall == next && next.error == null, "failed launch retained picker lock");
    });
    if (failures > 0) System.exit(1);
  }
}''',
}

def run(command, cwd):
    return subprocess.run(command, cwd=cwd, capture_output=True, text=True,
                          encoding='utf-8', errors='replace', timeout=90)


java_bin = args.java_bin.resolve()
if not (java_bin / ('javac.exe' if sys.platform == 'win32' else 'javac')).is_file():
    raise SystemExit(f'JDK compiler not found under {java_bin}')
if not (java_bin / ('java.exe' if sys.platform == 'win32' else 'java')).is_file():
    raise SystemExit(f'JDK runtime not found under {java_bin}')

checks = []
with tempfile.TemporaryDirectory(prefix='lifeline-android-replay-import-') as temporary:
    work = Path(temporary)
    source_root = work / 'src'
    for relative, content in stubs.items():
        destination = source_root / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(content, encoding='utf-8', newline='\n')
    classes = work / 'classes'
    classes.mkdir()
    actual_java = source_root / 'cn/lifelinegame/mobile/LifelineReplayImportPlugin.java'
    actual_java.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, actual_java)
    compile_result = run([str(java_bin / ('javac.exe' if sys.platform == 'win32' else 'javac')),
                          '-encoding', 'UTF-8', '-d', str(classes),
                          *map(str, source_root.rglob('*.java'))], work)
    sys.stdout.write(compile_result.stdout)
    sys.stderr.write(compile_result.stderr)
    if compile_result.returncode != 0:
        raise SystemExit(compile_result.returncode)
    execute_result = run([str(java_bin / ('java.exe' if sys.platform == 'win32' else 'java')),
                          '-cp', str(classes), 'AndroidReplayImportProbe'], work)
    sys.stdout.write(execute_result.stdout)
    sys.stderr.write(execute_result.stderr)
    for line in execute_result.stdout.splitlines():
        parts = line.split('\t', 2)
        if parts[0] in ('PASS', 'FAIL'):
            checks.append({'status': parts[0], 'name': parts[1],
                           **({'error': parts[2]} if len(parts) > 2 else {})})
    if execute_result.returncode != 0:
        raise SystemExit(execute_result.returncode)

if source.read_bytes() != source_bytes:
    raise SystemExit('Production Java source changed during verification.')
if len(checks) != 15 or any(item['status'] != 'PASS' for item in checks):
    raise SystemExit(f'Expected 15 passing actual-plugin checks, got {len(checks)}.')
print(json.dumps({
    'status': 'PASS-SCOPED',
    'plugin': str(source.relative_to(root)),
    'pluginSha256': sha(source_bytes),
    'checks': checks,
    'scope': 'Actual Java plugin executed with host stubs; not Android SDK/device acceptance.',
}, ensure_ascii=False, indent=2))
