"""Exercise unchanged Java plugin with JDK/JCA and controlled Android APIs.

Run from any directory with --java-bin pointing to an existing JDK bin and
--output naming a NEW evidence directory. No SDK, license or dependency install.
This is not Android SDK compilation, AndroidKeyStore or device acceptance.
"""
from pathlib import Path
import argparse
import hashlib
import json
import subprocess
import sys

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--java-bin', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
root = Path(__file__).resolve().parents[2]
out = args.output.resolve()
out.mkdir(parents=True, exist_ok=False)
source = root / 'mobile/android/app/src/main/java/cn/lifelinegame/mobile/LifelineStoragePlugin.java'
data = source.read_bytes()
sha = lambda value: hashlib.sha256(value).hexdigest()
# These substitutes deliberately expose queued UI evaluation, key failure and
# file-write failure. Real javax.crypto AES-GCM runs in the desktop JDK.
files = {
'android/content/Context.java': '''package android.content; import java.io.File;
public class Context {public File root; public File getNoBackupFilesDir(){return new File(root,"no-backup");} public File getFilesDir(){return new File(root,"files");}}''',
'android/net/Uri.java': '''package android.net; public class Uri {private final java.net.URI uri;private Uri(String s){uri=java.net.URI.create(s);}public static Uri parse(String s){return new Uri(s);}public String getHost(){return uri.getHost();}public String getScheme(){return uri.getScheme();}}''',
'android/util/Base64.java': '''package android.util; public class Base64 {public static final int NO_WRAP=2,NO_PADDING=1;public static String encodeToString(byte[] b,int flags){java.util.Base64.Encoder e=java.util.Base64.getEncoder();return ((flags&NO_PADDING)!=0?e.withoutPadding():e).encodeToString(b);}public static byte[] decode(String s,int flags){return java.util.Base64.getDecoder().decode(s);}}''',
'android/util/AtomicFile.java': '''package android.util;import java.io.*;import java.nio.file.*;
public class AtomicFile {private final File file;public static boolean failWrites,failExistingBaseFNF;public static int failAfter,failReadAfter;public AtomicFile(File f){file=f;}public File getBaseFile(){return file;}public FileInputStream openRead()throws FileNotFoundException{if(failReadAfter>0 && --failReadAfter==0)throw new FileNotFoundException("synthetic-readback-failure");if(failExistingBaseFNF&&file.exists())throw new FileNotFoundException("synthetic-existing-base-error");return new FileInputStream(file);}public FileOutputStream startWrite()throws IOException{if(failWrites || (failAfter>0 && --failAfter==0))throw new IOException("synthetic-private-write-error");return new FileOutputStream(file.toString()+".new");}public void finishWrite(FileOutputStream s)throws IOException{s.close();Files.move(Path.of(file+".new"),file.toPath(),StandardCopyOption.REPLACE_EXISTING);}public void failWrite(FileOutputStream s)throws IOException{s.close();Files.deleteIfExists(Path.of(file+".new"));}}''',
'android/security/keystore/KeyProperties.java': '''package android.security.keystore;public class KeyProperties{public static final int PURPOSE_ENCRYPT=1,PURPOSE_DECRYPT=2;public static final String BLOCK_MODE_GCM="GCM",ENCRYPTION_PADDING_NONE="NoPadding";}''',
'android/security/keystore/KeyGenParameterSpec.java': '''package android.security.keystore;public class KeyGenParameterSpec implements java.security.spec.AlgorithmParameterSpec {public final String alias;public int bits;public KeyGenParameterSpec(String a){alias=a;}public static class Builder {private final KeyGenParameterSpec spec;public Builder(String a,int purpose){spec=new KeyGenParameterSpec(a);}public Builder setBlockModes(String... mode){return this;}public Builder setEncryptionPaddings(String... padding){return this;}public Builder setKeySize(int n){spec.bits=n;return this;}public KeyGenParameterSpec build(){return spec;}}}''',
'android/webkit/ValueCallback.java': '''package android.webkit;public interface ValueCallback<T>{void onReceiveValue(T value);}''',
'android/webkit/RenderProcessGoneDetail.java': '''package android.webkit;public class RenderProcessGoneDetail{}''',
'android/webkit/WebView.java': '''package android.webkit;public class WebView {public String url="https://localhost/index.html",challenge="a".repeat(64);public java.util.List<ValueCallback<String>> callbacks=new java.util.ArrayList<>();public String getUrl(){if(!com.getcapacitor.Bridge.onUi)throw new IllegalStateException("WebView read off UI thread");return url;}public void evaluateJavascript(String script,ValueCallback<String> callback){if(!com.getcapacitor.Bridge.onUi)throw new IllegalStateException("evaluate off UI thread");callbacks.add(callback);}public void evaluate(){com.getcapacitor.Bridge.onUi=true;try{for(ValueCallback<String> c:new java.util.ArrayList<>(callbacks)){callbacks.remove(c);c.onReceiveValue(org.json.JSONObject.quote(challenge));}}finally{com.getcapacitor.Bridge.onUi=false;}}}''',
'com/getcapacitor/WebViewListener.java': '''package com.getcapacitor;public class WebViewListener{public void onPageStarted(android.webkit.WebView w){}public boolean onRenderProcessGone(android.webkit.WebView w,android.webkit.RenderProcessGoneDetail d){return false;}}''',
'com/getcapacitor/Bridge.java': '''package com.getcapacitor;public class Bridge{public static boolean onUi;public final android.webkit.WebView web=new android.webkit.WebView();public final java.util.List<Runnable> ui=new java.util.ArrayList<>();public final java.util.List<WebViewListener> listeners=new java.util.ArrayList<>();public android.webkit.WebView getWebView(){if(!onUi)throw new IllegalStateException("WebView accessed off UI thread");return web;}public void addWebViewListener(WebViewListener l){listeners.add(l);}public void removeWebViewListener(WebViewListener l){listeners.remove(l);}public void executeOnMainThread(Runnable r){ui.add(r);}public void drain(){onUi=true;try{for(Runnable r:new java.util.ArrayList<>(ui)){ui.remove(r);r.run();}}finally{onUi=false;}}}''',
'com/getcapacitor/Plugin.java': '''package com.getcapacitor;public class Plugin{public final Bridge bridge=new Bridge();public final android.content.Context context=new android.content.Context();public Bridge getBridge(){return bridge;}public android.content.Context getContext(){return context;}public void load(){}protected void handleOnDestroy(){}}''',
'com/getcapacitor/PluginMethod.java': '''package com.getcapacitor;public @interface PluginMethod{}''',
'com/getcapacitor/annotation/CapacitorPlugin.java': '''package com.getcapacitor.annotation;public @interface CapacitorPlugin{String name();}''',
'com/getcapacitor/JSObject.java': '''package com.getcapacitor;public class JSObject extends org.json.JSONObject{public JSObject(){}public JSObject(String s){super(s);}public JSObject put(String k,Object v){super.put(k,v);return this;}}''',
'com/getcapacitor/PluginCall.java': '''package com.getcapacitor;public class PluginCall{public JSObject data=new JSObject(),result;public String error;public JSObject getData(){return data;}public String getString(String k){return getString(k,null);}public String getString(String k,String fallback){Object v=data.opt(k);return v instanceof String?(String)v:fallback;}public Long getLong(String k,Long fallback){Object v=data.opt(k);return v instanceof Number?((Number)v).longValue():fallback;}public void resolve(JSObject v){result=v;}public void reject(String e){error=e;}public void reject(String e,Exception ignored){error=e;}}''',
'org/json/JSONObject.java': r'''package org.json;import java.util.*;
public class JSONObject {public static final Object NULL=new Object();private final Map<String,Object> values=new LinkedHashMap<>();public JSONObject(){}public JSONObject(String s){Object p=new JSONTokener(s).nextValue();if(!(p instanceof JSONObject))throw new IllegalArgumentException();values.putAll(((JSONObject)p).values);}public JSONObject put(String k,Object v){values.put(k,v);return this;}public int length(){return values.size();}public Object opt(String k){return values.get(k);}public boolean has(String k){return values.containsKey(k);}public String getString(String k){Object v=opt(k);if(!(v instanceof String))throw new IllegalArgumentException();return (String)v;}public JSONObject getJSONObject(String k){Object v=opt(k);if(!(v instanceof JSONObject))throw new IllegalArgumentException();return(JSONObject)v;}public static String quote(String s){StringBuilder b=new StringBuilder("\"");for(char c:s.toCharArray()){if(c=='"'||c=='\\')b.append('\\').append(c);else if(c=='\n')b.append("\\n");else if(c=='\r')b.append("\\r");else if(c=='\t')b.append("\\t");else b.append(c);}return b.append('"').toString();}public String toString(){StringJoiner j=new StringJoiner(",","{","}");for(var e:values.entrySet()){Object v=e.getValue();j.add(quote(e.getKey())+":"+(v==null||v==NULL?"null":v instanceof String?quote((String)v):v.toString()));}return j.toString();}}
''',
'org/json/JSONTokener.java': r'''package org.json;public class JSONTokener{private final String s;private int i;public JSONTokener(String value){s=value;}private void ws(){while(i<s.length()&&Character.isWhitespace(s.charAt(i)))i++;}public Object nextValue(){ws();char c=s.charAt(i++);if(c=='"'){StringBuilder b=new StringBuilder();while(i<s.length()){c=s.charAt(i++);if(c=='"')return b.toString();if(c=='\\'){c=s.charAt(i++);if(c=='n')c='\n';else if(c=='r')c='\r';else if(c=='t')c='\t';else if(c=='u'){c=(char)Integer.parseInt(s.substring(i,i+4),16);i+=4;}}b.append(c);}throw new IllegalArgumentException();}if(c=='{'){JSONObject o=new JSONObject();ws();if(s.charAt(i)=='}'){i++;return o;}while(true){String k=(String)nextValue();ws();if(s.charAt(i++)!=':')throw new IllegalArgumentException();o.put(k,nextValue());ws();char end=s.charAt(i++);if(end=='}')return o;if(end!=',')throw new IllegalArgumentException();}}int start=i-1;while(i<s.length()&&",} \n\r\t".indexOf(s.charAt(i))<0)i++;String v=s.substring(start,i);if(v.equals("null"))return JSONObject.NULL;if(v.equals("true"))return true;if(v.equals("false"))return false;return Long.valueOf(v);}}
''',
'testshim/Keys.java': '''package testshim;
import java.security.*;import java.security.cert.Certificate;import java.security.spec.AlgorithmParameterSpec;import java.util.*;import java.io.*;import javax.crypto.*;import android.security.keystore.KeyGenParameterSpec;
public class Keys {public static final Map<String,SecretKey> entries=new HashMap<>();public static boolean queryFails;public static int generated,queries;public static Runnable beforeGenerate;
public static void install(){Security.addProvider(new Provider("AndroidKeyStore","1.0","Synthetic desktop test provider"){ {put("KeyStore.AndroidKeyStore",Store.class.getName());put("KeyGenerator.AES",Generator.class.getName());} });}
public static void reset(){entries.clear();queryFails=false;generated=0;queries=0;beforeGenerate=null;}
public static class Store extends KeyStoreSpi {public Key engineGetKey(String a,char[] p){return entries.get(a);}public Certificate[] engineGetCertificateChain(String a){return null;}public Certificate engineGetCertificate(String a){return null;}public Date engineGetCreationDate(String a){return new Date();}public void engineSetKeyEntry(String a,Key k,char[] p,Certificate[] c){entries.put(a,(SecretKey)k);}public void engineSetKeyEntry(String a,byte[] k,Certificate[] c){throw new UnsupportedOperationException();}public void engineSetCertificateEntry(String a,Certificate c){}public void engineDeleteEntry(String a){entries.remove(a);}public Enumeration<String> engineAliases(){return Collections.enumeration(entries.keySet());}public boolean engineContainsAlias(String a){queries++;if(queryFails)throw new IllegalStateException("synthetic-private-key-error");return entries.containsKey(a);}public int engineSize(){return entries.size();}public boolean engineIsKeyEntry(String a){return entries.containsKey(a);}public boolean engineIsCertificateEntry(String a){return false;}public String engineGetCertificateAlias(Certificate c){return null;}public void engineStore(OutputStream s,char[] p){}public void engineLoad(InputStream s,char[] p){}public KeyStore.Entry engineGetEntry(String a,KeyStore.ProtectionParameter p){return new KeyStore.SecretKeyEntry(entries.get(a));}}
public static class Generator extends KeyGeneratorSpi{private KeyGenParameterSpec spec;protected void engineInit(SecureRandom r){}protected void engineInit(int size,SecureRandom r){}protected void engineInit(AlgorithmParameterSpec p,SecureRandom r){spec=(KeyGenParameterSpec)p;if(spec.bits!=256)throw new IllegalArgumentException("not AES256");}protected SecretKey engineGenerateKey(){try{if(beforeGenerate!=null)beforeGenerate.run();KeyGenerator g=KeyGenerator.getInstance("AES","SunJCE");g.init(spec.bits);SecretKey k=g.generateKey();entries.put(spec.alias,k);generated++;return k;}catch(Exception e){throw new IllegalStateException(e);}}}
}''',
}
files['cn/lifelinegame/mobile/LifelineStoragePlugin.java'] = data.decode('utf-8')
files['CredentialProbe.java'] = '''import cn.lifelinegame.mobile.LifelineStoragePlugin;import com.getcapacitor.*;import org.json.*;import java.nio.file.*;import java.nio.charset.StandardCharsets;import testshim.Keys;
public class CredentialProbe {
static int failures,sequence;static Path root;static void ok(boolean v,String m){if(!v)throw new AssertionError(m);}static void test(String name,Runnable run){try{Keys.reset();android.util.AtomicFile.failWrites=false;android.util.AtomicFile.failExistingBaseFNF=false;android.util.AtomicFile.failAfter=0;android.util.AtomicFile.failReadAfter=0;run.run();System.out.println("PASS\\t"+name);}catch(Throwable e){failures++;System.out.println("FAIL\\t"+name+"\\t"+e.getClass().getSimpleName()+": "+e.getMessage());}}
static class F{final LifelineStoragePlugin p=new LifelineStoragePlugin();F(){p.context.root=root.resolve("fixture-"+(++sequence)).toFile();p.load();navigate();}void navigate(){for(WebViewListener l:p.bridge.listeners)l.onPageStarted(p.bridge.web);}PluginCall claim(){return claim(-1L,"a".repeat(64));}PluginCall claim(long expected,String challenge){PluginCall c=new PluginCall();c.data.put("expectedOwnerGeneration",expected).put("documentChallenge",challenge);p.claimCredentialOwner(c);return c;}void finish(){p.bridge.drain();p.bridge.web.evaluate();}JSObject lease(){PluginCall c=claim();finish();ok(c.result!=null,"claim failed");return c.result;}PluginCall call(JSObject lease){PluginCall c=new PluginCall();c.data=new JSObject(lease.toString());return c;}PluginCall load(JSObject lease){PluginCall c=call(lease);p.loadCredential(c);return c;}PluginCall clear(JSObject lease){PluginCall c=call(lease);p.clearCredential(c);return c;}PluginCall save(JSObject lease,JSONObject credential){PluginCall c=call(lease);c.data.put("credential",credential);p.saveCredential(c);return c;}Path file(String name){return p.context.root.toPath().resolve("no-backup/lifeline-credentials-v1/"+name);}String read(String name){try{return Files.readString(file(name));}catch(Exception e){throw new RuntimeException(e);}}void write(String name,String text){try{Files.createDirectories(file(name).getParent());Files.writeString(file(name),text);}catch(Exception e){throw new RuntimeException(e);}}}
static void simulateProcessRestart(){try{java.lang.reflect.Field f=LifelineStoragePlugin.class.getDeclaredField("credentialRecoveryRequired");f.setAccessible(true);f.setBoolean(null,false);}catch(Exception e){throw new RuntimeException(e);}}
static JSONObject credential(){return new JSONObject().put("token","synthetic-android-credential").put("username","测试😀");}
public static void main(String[] args)throws Exception{root=Path.of(args[0]);Files.createDirectories(root);Keys.install();
test("cold plugin refuses a guessed lease with no native document nonce",()->{LifelineStoragePlugin p=new LifelineStoragePlugin();p.context.root=root.resolve("cold-fixture").toFile();p.load();PluginCall c=new PluginCall();c.data.put("pageEpoch",1L).put("ownerGeneration",0L).put("documentNonce","");p.loadCredential(c);ok(c.result==null&&c.error!=null,"unclaimed empty nonce accepted");});
test("claim runs WebView reads on UI and grants a native nonce before page complete",()->{F f=new F();PluginCall c=f.claim();ok(c.result==null&&f.p.bridge.web.callbacks.isEmpty(),"not queued on UI");f.finish();ok(c.result!=null&&!c.result.getString("documentNonce").isEmpty(),"lease missing");ok(!c.result.getString("documentNonce").equals(f.p.bridge.web.challenge),"nonce is not native-owned");});
test("old challenge cannot claim new document",()->{F f=new F();f.p.bridge.web.challenge="b".repeat(64);PluginCall c=f.claim();f.finish();ok(c.error!=null&&c.result==null,"old challenge accepted");});
test("untrusted origin rejected without JavaScript evaluation",()->{F f=new F();f.p.bridge.web.url="https://untrusted.invalid/";PluginCall c=f.claim();f.p.bridge.drain();ok(c.error!=null&&f.p.bridge.web.callbacks.isEmpty(),"external origin accepted");});
test("navigation during evaluation invalidates claim",()->{F f=new F();PluginCall c=f.claim();f.p.bridge.drain();f.navigate();f.p.bridge.web.evaluate();ok(c.error!=null,"navigation accepted");});
test("URL change during evaluation invalidates claim",()->{F f=new F();PluginCall c=f.claim();f.p.bridge.drain();f.p.bridge.web.url="https://localhost/replaced";f.p.bridge.web.evaluate();ok(c.error!=null,"URL change accepted");});
test("compare-and-swap claim rejects a superseded owner",()->{F f=new F();JSObject a=f.lease();f.lease();PluginCall c=f.claim(((Number)a.opt("ownerGeneration")).longValue(),"a".repeat(64));f.finish();ok(c.error!=null,"stale owner reclaimed");});
test("stale document lease cannot load save or clear",()->{F f=new F();JSObject a=f.lease();f.navigate();ok(f.load(a).error!=null,"stale load");ok(f.save(a,credential()).error!=null,"stale save");ok(f.clear(a).error!=null,"stale clear");});
test("missing store is distinguished from clear tombstone",()->{F f=new F();JSObject a=f.lease();ok("missing".equals(f.load(a).result.getString("state")),"missing state");ok(Boolean.TRUE.equals(f.clear(a).result.opt("durable")),"clear unacknowledged");ok("cleared".equals(f.load(a).result.getString("state")),"tombstone absent");});
test("real JCA AES-GCM roundtrip persists no plaintext and uses fresh IV",()->{F f=new F();JSObject a=f.lease();ok(f.save(a,credential()).result!=null,"save failed");String first=f.read("credential");ok(!first.contains("synthetic-android-credential")&&!first.contains("测试"),"plaintext at rest");ok(f.load(a).result.getJSONObject("credential").toString().equals(credential().toString()),"roundtrip");ok(f.save(a,credential()).result!=null,"second save");ok(!new JSONObject(first).getString("iv").equals(new JSONObject(f.read("credential")).getString("iv")),"IV reused");ok(Keys.generated==1,"replacement key generated");});
test("tampered ciphertext rejects without creating a replacement key",()->{F f=new F();JSObject a=f.lease();f.save(a,credential());JSONObject record=new JSONObject(f.read("credential"));byte[] b=java.util.Base64.getDecoder().decode(record.getString("data"));b[0]^=1;record.put("data",java.util.Base64.getEncoder().encodeToString(b));f.write("credential",record.toString());ok(f.load(a).error!=null,"tamper accepted");ok(Keys.generated==1,"replaced key");});
test("key loss rejects load but key-independent logout still suppresses restore",()->{F f=new F();JSObject a=f.lease();f.save(a,credential());Keys.entries.clear();ok(f.load(a).error!=null,"lost key accepted");int before=Keys.queries;Keys.queryFails=true;ok(f.clear(a).result!=null,"clear used key");ok("cleared".equals(f.load(a).result.getString("state")),"old auth restored");ok(Keys.queries==before,"clear queried key");});
test("key query error is generic and never creates a key",()->{F f=new F();JSObject a=f.lease();Keys.queryFails=true;PluginCall c=f.save(a,credential());ok(c.error!=null&&!c.error.contains("synthetic-private"),"provider detail escaped");ok(Keys.generated==0,"query failure became key absence");});
test("invalid credential types and extra fields fail before key access",()->{F f=new F();JSObject a=f.lease();ok(f.save(a,new JSONObject().put("token",7).put("username","test")).error!=null,"coerced number");ok(f.save(a,credential().put("password","synthetic-extra")).error!=null,"extra field accepted");ok(f.save(a,new JSONObject().put("token","x").put("username","x".repeat(51))).error!=null,"oversized username");ok(Keys.queries==0,"invalid value reached key");});
test("owner rotation during encryption prevents stale file write",()->{F f=new F();JSObject a=f.lease();Keys.beforeGenerate=()->f.navigate();ok(f.save(a,credential()).error!=null,"stale save succeeded");ok(!Files.exists(f.file("credential")),"stale ciphertext persisted");});
test("clear write failure is not acknowledged and error stays generic",()->{F f=new F();JSObject a=f.lease();android.util.AtomicFile.failWrites=true;PluginCall c=f.clear(a);ok(c.result==null&&c.error!=null&&!c.error.contains("synthetic-private"),"false durable clear");});
test("failed commit at every stage suppresses unacknowledged credentials",()->{for(int stage=1;stage<=3;stage++){F f=new F();JSObject a=f.lease();ok(f.save(a,credential()).result!=null,"initial save failed");android.util.AtomicFile.failAfter=stage;JSONObject newer=new JSONObject().put("token","new-unacknowledged").put("username","test");ok(f.save(a,newer).error!=null,"failed commit acknowledged");ok("pending".equals(f.read("barrier")),"pending barrier missing");ok(f.load(a).error!=null,"unacknowledged credential exposed");simulateProcessRestart();ok(f.load(a).error!=null,"pending accepted after process restart");ok(f.clear(a).result!=null,"clear recovery failed");ok("cleared".equals(f.load(a).result.getString("state")),"clear did not recover");}});
test("failure after final atomic commit reestablishes pending suppression",()->{F f=new F();JSObject a=f.lease();ok(f.save(a,credential()).result!=null,"initial save failed");android.util.AtomicFile.failReadAfter=3;JSONObject newer=new JSONObject().put("token","new-unacknowledged").put("username","test");ok(f.save(a,newer).error!=null,"readback failure acknowledged");ok("pending".equals(f.read("barrier")),"post-commit pending barrier missing");ok(f.load(a).error!=null,"unacknowledged credential exposed");ok(f.clear(a).result!=null,"clear recovery failed");});
test("invalid barrier and missing present ciphertext fail closed",()->{F f=new F();JSObject a=f.lease();f.write("barrier","invalid");ok(f.load(a).error!=null,"invalid barrier accepted");f.write("barrier","present");ok(f.load(a).error!=null,"missing ciphertext accepted");});
test("existing AtomicFile base FileNotFoundException fails closed",()->{F f=new F();JSObject a=f.lease();f.write("barrier","present");android.util.AtomicFile.failExistingBaseFNF=true;PluginCall c=f.load(a);ok(c.error!=null&&c.result==null,"existing base FNF treated as missing");});
if(failures>0)System.exit(1);
}}
'''
for name, content in files.items():
    dest = out / 'src' / name
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(content, encoding='utf-8', newline='\n')
classes = out / 'classes'
classes.mkdir()
commands = []
def run(command, label):
    result = subprocess.run(list(map(str, command)), cwd=root, capture_output=True,
                            text=True, encoding='utf-8', errors='replace', timeout=45)
    log = result.stdout + result.stderr
    (out / (label + '.txt')).write_text(log, encoding='utf-8', newline='\n')
    commands.append({'argv': list(map(str, command)), 'exitCode': result.returncode,
                     'logSha256': sha(log.encode('utf-8'))})
    print(log, end='')
    return result
suffix = '.exe' if sys.platform == 'win32' else ''
compiled = run([args.java_bin / ('javac' + suffix), '-encoding', 'UTF-8', '-d', classes]
               + [out / 'src' / name for name in files], 'compile')
checks = []
executed = None
if compiled.returncode == 0:
    executed = run([args.java_bin / ('java' + suffix), '-cp', classes,
                    'CredentialProbe', out / 'private-fixtures'], 'behavior')
    for line in executed.stdout.splitlines():
        parts = line.split('\t', 2)
        if parts[0] in ('PASS', 'FAIL'):
            checks.append({'status': parts[0], 'name': parts[1],
                           **({'error': parts[2]} if len(parts) > 2 else {})})
stable = data == source.read_bytes()
passed = compiled.returncode == 0 and executed is not None and executed.returncode == 0 and stable and len(checks) == 20
receipt = {'scope': 'Actual Java plugin, desktop JDK/JCA AES-GCM with API substitutes. NOT Android SDK compilation, AndroidKeyStore, AtomicFile durability or device acceptance.',
           'status': 'PASS-SCOPED' if passed else 'FAIL', 'source': str(source.relative_to(root)),
           'sourceSha256': sha(data), 'sourceStable': stable, 'scriptSha256': sha(Path(__file__).read_bytes()),
           'commands': commands, 'checks': checks}
(out / 'receipt.json').write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(json.dumps({'status': receipt['status'], 'checks': len(checks), 'sourceStable': stable}))
sys.exit(0 if passed else 1)

