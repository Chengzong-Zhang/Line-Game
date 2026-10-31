"""Compile and exercise the pinned Capacitor Android SharePlugin with host stubs.

This covers the file-URL handoff used by ReplayCodec against the actual installed
SharePlugin.java source. It does not compile the Android app or prove OEM chooser,
FileProvider grants, or recipient-app behavior on an Android device.
"""
from pathlib import Path
import argparse
import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
import re


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--java-bin', type=Path, required=True)
args = parser.parse_args()
root = Path(__file__).resolve().parents[2]
mobile = root / 'mobile'
share_root = mobile / 'node_modules/@capacitor/share'
source = share_root / 'android/src/main/java/com/capacitorjs/plugins/share/SharePlugin.java'
version = json.loads((share_root / 'package.json').read_text(encoding='utf-8'))['version']
expected_version = json.loads((mobile / 'package.json').read_text(encoding='utf-8'))['dependencies']['@capacitor/share']
if version != expected_version or version != '8.0.3':
    raise SystemExit(f'Expected installed @capacitor/share {expected_version} (8.0.3), found {version}.')
source_bytes = source.read_bytes()
sha = lambda value: hashlib.sha256(value).hexdigest()
filesystem_root = mobile / 'node_modules/@capacitor/filesystem'
filesystem_version = json.loads((filesystem_root / 'package.json').read_text(encoding='utf-8'))['version']
expected_filesystem_version = json.loads((mobile / 'package.json').read_text(encoding='utf-8'))['dependencies']['@capacitor/filesystem']
if filesystem_version != expected_filesystem_version or filesystem_version != '8.1.4':
    raise SystemExit(f'Expected installed @capacitor/filesystem {expected_filesystem_version} (8.1.4), found {filesystem_version}.')
filesystem_sources = {
    'FilesystemPlugin.kt': filesystem_root / 'android/src/main/kotlin/com/capacitorjs/plugins/filesystem/FilesystemPlugin.kt',
    'FilesystemMethodOptions.kt': filesystem_root / 'android/src/main/kotlin/com/capacitorjs/plugins/filesystem/FilesystemMethodOptions.kt',
    'LegacyFilesystemImplementation.kt': filesystem_root / 'android/src/main/kotlin/com/capacitorjs/plugins/filesystem/LegacyFilesystemImplementation.kt',
}
filesystem_bytes = {name: path.read_bytes() for name, path in filesystem_sources.items()}
filesystem_text = {name: value.decode('utf-8') for name, value in filesystem_bytes.items()}


def require_source_contract(name, source_text, pattern, description):
    if not re.search(pattern, source_text, re.S):
        raise SystemExit(f'Filesystem native source contract missing: {description} ({name}).')
    print(f'PASS\t{description}')


require_source_contract('FilesystemPlugin.kt', filesystem_text['FilesystemPlugin.kt'],
                        r'fun writeFile\(call: PluginCall\).*?controller\.saveFile\(uri, input\.options\).*?createWriteResultObject\(uriSaved, input\.options\.mode\)',
                        'Filesystem.writeFile delegates to native controller and returns its saved URI')
require_source_contract('FilesystemPlugin.kt', filesystem_text['FilesystemPlugin.kt'],
                        r'fun getUri\(call: PluginCall\).*?controller\.getFileUri\(input\).*?resolvedUri\.toResultObject\(\)',
                        'Filesystem.getUri returns the native controller URI used by Share.share')
require_source_contract('FilesystemMethodOptions.kt', filesystem_text['FilesystemMethodOptions.kt'],
                        r'getWriteFileOptions\(\).*?IONFILESaveOptions\(.*?data = data,.*?encoding = encoding,.*?createFileRecursive = recursive',
                        'Filesystem.writeFile preserves UTF-8 data and recursive directory creation options')
require_source_contract('LegacyFilesystemImplementation.kt', filesystem_text['LegacyFilesystemImplementation.kt'],
                        r'"CACHE"\s*->\s*return c\.cacheDir',
                        'Filesystem Directory.Cache resolves to the private Android cache directory')

manifest = ET.parse(mobile / 'android/app/src/main/AndroidManifest.xml').getroot()
android_ns = '{http://schemas.android.com/apk/res/android}'
provider = next((node for node in manifest.find('application').findall('provider')
                 if node.get(android_ns + 'authorities') == '${applicationId}.fileprovider'), None)
if provider is None or provider.get(android_ns + 'exported') != 'false' or provider.get(android_ns + 'grantUriPermissions') != 'true':
    raise SystemExit('App FileProvider is missing the private authority or URI grant contract.')
metadata = next((node for node in provider.findall('meta-data')
                 if node.get(android_ns + 'name') == 'android.support.FILE_PROVIDER_PATHS'), None)
if metadata is None or metadata.get(android_ns + 'resource') != '@xml/file_paths':
    raise SystemExit('App FileProvider is not wired to @xml/file_paths.')
paths = ET.parse(mobile / 'android/app/src/main/res/xml/file_paths.xml').getroot()
cache_path = next((node for node in paths.findall('cache-path')
                   if node.get('path') == '.'), None)
if cache_path is None:
    raise SystemExit('FileProvider does not expose the app cache path used for replay share files.')

stubs = {
    'android/app/Activity.java': r'''package android.app;
public class Activity extends android.content.Context { public static final int RESULT_CANCELED = 0; }''',
    'android/app/PendingIntent.java': r'''package android.app;
import android.content.Context; import android.content.Intent;
public class PendingIntent {
 public static final int FLAG_UPDATE_CURRENT=1, FLAG_MUTABLE=2, FLAG_ALLOW_UNSAFE_IMPLICIT_INTENT=4;
 private final Intent intent; private PendingIntent(Intent value){intent=value;}
 public static PendingIntent getBroadcast(Context c,int code,Intent i,int flags){return new PendingIntent(i);}
 public IntentSender getIntentSender(){return new IntentSender(intent);}
}''',
    'android/app/IntentSender.java': r'''package android.app;
import android.content.Intent;
public class IntentSender { public final Intent intent; public IntentSender(Intent i){intent=i;} }''',
    'android/content/BroadcastReceiver.java': r'''package android.content;
public abstract class BroadcastReceiver { public abstract void onReceive(Context c,Intent i); }''',
    'android/content/ClipData.java': r'''package android.content;
import android.net.Uri;
public class ClipData { public final Uri uri; private ClipData(Uri u){uri=u;} public static ClipData newRawUri(String label,Uri u){return new ClipData(u);} }''',
    'android/content/ComponentName.java': r'''package android.content;
public class ComponentName { private final String packageName; public ComponentName(String p){packageName=p;} public String getPackageName(){return packageName;} }''',
    'android/content/Context.java': r'''package android.content;
public class Context { public String getPackageName(){return "cn.lifelinegame.mobile";} public Intent registerReceiver(BroadcastReceiver r,IntentFilter f){return null;} public void unregisterReceiver(BroadcastReceiver r){} }''',
    'android/content/IntentFilter.java': r'''package android.content;
public class IntentFilter { public IntentFilter(String s){} }''',
    'android/content/Intent.java': r'''package android.content;
import android.app.IntentSender; import android.net.Uri; import java.util.HashMap; import java.util.Map;
public class Intent {
 public static final String ACTION_SEND="android.intent.action.SEND", ACTION_SEND_MULTIPLE="android.intent.action.SEND_MULTIPLE";
 public static final String EXTRA_CHOSEN_COMPONENT="android.intent.extra.CHOSEN_COMPONENT", EXTRA_STREAM="android.intent.extra.STREAM", EXTRA_SUBJECT="android.intent.extra.SUBJECT", EXTRA_TEXT="android.intent.extra.TEXT", CATEGORY_DEFAULT="android.intent.category.DEFAULT";
 public static final int FLAG_GRANT_READ_URI_PERMISSION=1;
 public String action,type,chooserTitle,category; public int flags; public Uri clipUri; public Intent inner; public IntentSender sender; public final Map<String,Object> extras=new HashMap<>();
 public Intent(String a){action=a;} public Intent putExtra(String k,Object v){extras.put(k,v);return this;}
 public Intent setType(String v){type=v;return this;} public Intent setTypeAndNormalize(String v){type=v;return this;}
 public Intent setClipData(ClipData d){clipUri=d.uri;return this;} public Intent setFlags(int v){flags=v;return this;}
 public Intent addCategory(String v){category=v;return this;} public String getStringExtra(String k){return (String)extras.get(k);}
 @SuppressWarnings("unchecked") public <T> T getParcelableExtra(String k){return (T)extras.get(k);} public <T> T getParcelableExtra(String k,Class<T> c){return c.cast(extras.get(k));}
 public static Intent createChooser(Intent i,String title,IntentSender s){Intent c=new Intent("CHOOSER");c.inner=i;c.chooserTitle=title;c.sender=s;return c;}
}''',
    'android/content/ContextWrapper.java': r'''package android.content; public class ContextWrapper extends Context {}''',
    'android/net/Uri.java': r'''package android.net;
public class Uri { private final String value; private Uri(String v){value=v;} public static Uri parse(String v){return new Uri(v);} public String getPath(){try{return new java.net.URI(value).getPath();}catch(Exception e){throw new IllegalArgumentException(e);}} public String toString(){return value;} }''',
    'android/os/Build.java': r'''package android.os;
public class Build { public static class VERSION { public static int SDK_INT=35; } public static class VERSION_CODES { public static final int Q=29,S=31,TIRAMISU=33,UPSIDE_DOWN_CAKE=34; } }''',
    'android/webkit/MimeTypeMap.java': r'''package android.webkit;
public class MimeTypeMap { private static final MimeTypeMap M=new MimeTypeMap(); public static MimeTypeMap getSingleton(){return M;} public static String getFileExtensionFromUrl(String u){int i=u.lastIndexOf('.');return i<0?"":u.substring(i+1);} public String getMimeTypeFromExtension(String e){return "json".equals(e)?"application/json":null;} }''',
    'androidx/activity/result/ActivityResult.java': r'''package androidx.activity.result; public class ActivityResult { private final int code; public ActivityResult(int c){code=c;} public int getResultCode(){return code;} }''',
    'androidx/core/content/ContextCompat.java': r'''package androidx.core.content;
import android.content.*; public class ContextCompat { public static final int RECEIVER_EXPORTED=1; public static Intent registerReceiver(Context c,BroadcastReceiver r,IntentFilter f,int flags){return null;} }''',
    'androidx/core/content/FileProvider.java': r'''package androidx.core.content;
import android.content.Context; import android.net.Uri; import java.io.File;
public class FileProvider { public static RuntimeException failure; public static String authority,path; public static Uri getUriForFile(Context c,String a,File f){authority=a;path=f.getPath();if(failure!=null)throw failure;return Uri.parse("content://"+a+"/cache/"+f.getName());} }''',
    'com/getcapacitor/JSArray.java': r'''package com.getcapacitor;
import java.util.ArrayList; public class JSArray extends ArrayList<Object> { public void put(Object v){add(v);} public int length(){return size();} public java.util.List<Object> toList(){return this;} }''',
    'com/getcapacitor/JSObject.java': r'''package com.getcapacitor;
import java.util.HashMap; public class JSObject extends HashMap<String,Object> { public JSObject put(String k,Object v){super.put(k,v);return this;} }''',
    'com/getcapacitor/PluginCall.java': r'''package com.getcapacitor;
public class PluginCall { public final JSObject data=new JSObject(); public JSObject result; public String error; public PluginCall put(String k,Object v){data.put(k,v);return this;} public String getString(String k){return (String)data.get(k);} public String getString(String k,String d){String v=getString(k);return v==null?d:v;} public JSArray getArray(String k){return (JSArray)data.get(k);} public void reject(String e){error=e;} public void resolve(JSObject r){result=r;} }''',
    'com/getcapacitor/Plugin.java': r'''package com.getcapacitor;
import android.app.Activity; import android.content.Context; import android.content.Intent;
public class Plugin { public static final Context CONTEXT=new Context(); public static final Activity ACTIVITY=new Activity(); public Intent startedIntent; public PluginCall startedCall; public Context getContext(){return CONTEXT;} public Activity getActivity(){return ACTIVITY;} public void load(){} protected void startActivityForResult(PluginCall c,Intent i,String name){startedCall=c;startedIntent=i;} protected void handleOnStop(){} protected void handleOnDestroy(){} }''',
    'com/getcapacitor/PluginMethod.java': r'''package com.getcapacitor; public @interface PluginMethod {}''',
    'org/json/JSONException.java': r'''package org.json; public class JSONException extends Exception { private static final long serialVersionUID=1L; }''',
    'com/getcapacitor/annotation/ActivityCallback.java': r'''package com.getcapacitor.annotation; public @interface ActivityCallback {}''',
    'com/getcapacitor/annotation/CapacitorPlugin.java': r'''package com.getcapacitor.annotation; public @interface CapacitorPlugin {String name();}''',
    'AndroidReplayShareProbe.java': r'''import android.app.Activity; import android.content.Intent; import android.net.Uri; import androidx.activity.result.ActivityResult; import androidx.core.content.FileProvider;
import com.capacitorjs.plugins.share.SharePlugin; import com.getcapacitor.JSArray; import com.getcapacitor.JSObject; import com.getcapacitor.PluginCall; import java.lang.reflect.Method; import java.io.File;
public class AndroidReplayShareProbe {
 static int checks,failures; static void check(boolean x,String m){checks++;if(!x){failures++;System.out.println("FAIL\t"+m);}else System.out.println("PASS\t"+m);}
 static void testFileShare(){try{SharePlugin p=new SharePlugin();PluginCall c=new PluginCall().put("title","LIFELINE replay").put("dialogTitle","Share replay").put("url","file:///data/user/0/cn.lifelinegame.mobile/cache/lifeline-replay-share/replay-1234567890123-0123456789abcdef0123456789abcdef.json");p.share(c);Intent chooser=p.startedIntent;Intent send=chooser==null?null:chooser.inner;
 check(c.error==null&&p.startedCall==c,"valid cache file starts native chooser");check("CHOOSER".equals(chooser.action)&&"Share replay".equals(chooser.chooserTitle),"native chooser receives dialog title");check(Intent.ACTION_SEND.equals(send.action),"single replay uses ACTION_SEND");check("application/json".equals(send.type),".json replay is shared with JSON MIME type");String expected="content://cn.lifelinegame.mobile.fileprovider/cache/"+new File(FileProvider.path).getName();String actual=send.extras.get(Intent.EXTRA_STREAM).toString();check(expected.equals(actual),"cache file URI is translated to app FileProvider content URI");check(actual.startsWith("content://")&&!actual.startsWith("file://"),"EXTRA_STREAM shares a content URI rather than a private file URI");check("cn.lifelinegame.mobile.fileprovider".equals(FileProvider.authority),"share uses applicationId.fileprovider authority");check((send.flags&Intent.FLAG_GRANT_READ_URI_PERMISSION)!=0,"recipient receives temporary read permission");check(send.clipUri!=null&&send.clipUri.toString().equals(actual)&&send.clipUri.toString().startsWith("content://"),"Android Q+ ClipData carries the same content URI grant");
 Method callback=SharePlugin.class.getDeclaredMethod("activityResult",PluginCall.class,ActivityResult.class);callback.setAccessible(true);callback.invoke(p,c,new ActivityResult(-1));check(c.result!=null&&"".equals(c.result.get("activityType")),"native chooser completion with no chosen-component receipt returns empty activityType");
 }catch(Throwable e){failures++;System.out.println("FAIL\tfile share runtime: "+e);}}
 static void testInvalidInput(){SharePlugin p=new SharePlugin();PluginCall empty=new PluginCall();p.share(empty);check("Must provide a URL or Message or files".equals(empty.error),"empty share payload is rejected");PluginCall unsupported=new PluginCall().put("url","content://elsewhere/file.json");p.share(unsupported);check("Unsupported url".equals(unsupported.error),"non-file, non-HTTP URI is rejected");}
 static void testBusyAndCancel(){try{SharePlugin p=new SharePlugin();PluginCall first=new PluginCall().put("url","file:///data/user/0/app/cache/a.json");p.share(first);PluginCall second=new PluginCall().put("url","https://example.test");p.share(second);check("Can't share while sharing is in progress".equals(second.error),"second native chooser is rejected while first is active");Method callback=SharePlugin.class.getDeclaredMethod("activityResult",PluginCall.class,ActivityResult.class);callback.setAccessible(true);callback.invoke(p,first,new ActivityResult(Activity.RESULT_CANCELED));check("Share canceled".equals(first.error),"dismissed native chooser rejects the actual first PluginCall");PluginCall third=new PluginCall().put("url","file:///data/user/0/app/cache/after-cancel.json");p.share(third);check(third.error==null&&p.startedCall==third,"confirmed cancellation clears native busy state for the next share");}catch(Throwable e){failures++;System.out.println("FAIL\tbusy/cancel flow: "+e);}}
 public static void main(String[] args){testFileShare();testInvalidInput();testBusyAndCancel();System.out.println("RESULT\tchecks="+checks+"\tfailures="+failures);if(failures>0)System.exit(1);}
}''',
}


def run(command, cwd):
    return subprocess.run(command, cwd=cwd, text=True, encoding='utf-8', errors='replace',
                          stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=60)


java_bin = args.java_bin.resolve()
for executable in ('javac', 'java'):
    if not (java_bin / (executable + ('.exe' if sys.platform == 'win32' else ''))).is_file():
        raise SystemExit(f'JDK {executable} not found under {java_bin}')

with tempfile.TemporaryDirectory(prefix='lifeline-android-replay-share-') as directory:
    work = Path(directory)
    src = work / 'src'
    for relative, content in stubs.items():
        destination = src / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(content, encoding='utf-8')
    actual = src / 'com/capacitorjs/plugins/share/SharePlugin.java'
    actual.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, actual)
    classes = work / 'classes'
    classes.mkdir()
    compiled = run([str(java_bin / ('javac.exe' if sys.platform == 'win32' else 'javac')),
                    '-encoding', 'UTF-8', '-d', str(classes), *map(str, src.rglob('*.java'))], work)
    if compiled.returncode:
        print(compiled.stdout)
        raise SystemExit(f'javac failed with exit {compiled.returncode}')
    executed = run([str(java_bin / ('java.exe' if sys.platform == 'win32' else 'java')),
                    '-cp', str(classes), 'AndroidReplayShareProbe'], work)
    print(executed.stdout, end='')
    if executed.returncode:
        raise SystemExit(f'Actual SharePlugin host-stub probe failed with exit {executed.returncode}.')

if source.read_bytes() != source_bytes:
    raise SystemExit('Installed Capacitor SharePlugin source changed during verification.')
print(f'RECEIPT\tplugin=@capacitor/share@{version}\tsourceSha256={sha(source_bytes)}')
for name, value in filesystem_bytes.items():
    print(f'RECEIPT\tfilesystemSource={name}\tsha256={sha(value)}')
print(f'RECEIPT\tscope=actual SharePlugin Java source with Android/Capacitor host stubs; pinned Filesystem source wiring and app FileProvider XML contract')
