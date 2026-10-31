"""Compile and exercise the Android session-storage plugin against host stubs.

This tests the current Java source snapshot and AtomicFile behavior on the host.
It does not compile against the Android SDK or prove device/filesystem crash
durability. The compiled method's classfile call sequence and control-flow
dominance are checked directly; runtime failure injection covers I/O failure
paths. Run with --java-bin pointing to a JDK bin directory.
"""
from pathlib import Path
import argparse
import hashlib
import json
import struct
import subprocess
import sys
import tempfile


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--java-bin', type=Path, required=True)
parser.add_argument('--plugin-source', type=Path, help=argparse.SUPPRESS)
args = parser.parse_args()
root = Path(__file__).resolve().parents[2]
tracked_plugin = root / 'mobile/android/app/src/main/java/cn/lifelinegame/mobile/LifelineStoragePlugin.java'
plugin = args.plugin_source or tracked_plugin
tracked_source_bytes = tracked_plugin.read_bytes()
source_bytes = plugin.read_bytes()


def compiled_method_calls(class_path, method_name, descriptor):
    data = class_path.read_bytes()
    offset = 0

    def u1():
        nonlocal offset
        value = data[offset]
        offset += 1
        return value

    def u2():
        nonlocal offset
        value = struct.unpack_from('>H', data, offset)[0]
        offset += 2
        return value

    def u4():
        nonlocal offset
        value = struct.unpack_from('>I', data, offset)[0]
        offset += 4
        return value

    if u4() != 0xCAFEBABE:
        raise SystemExit('compiled plugin class has invalid magic')
    u2(); u2()
    cp_count = u2()
    cp = [None] * cp_count
    index = 1
    while index < cp_count:
        tag = u1()
        if tag == 1:
            length = u2()
            cp[index] = ('Utf8', data[offset:offset + length].decode('utf-8'))
            offset += length
        elif tag in (3, 4):
            offset += 4
        elif tag in (5, 6):
            offset += 8
            index += 1
        elif tag in (7, 8, 16, 19, 20):
            cp[index] = (tag, u2())
        elif tag in (9, 10, 11, 12, 17, 18):
            cp[index] = (tag, u2(), u2())
        elif tag == 15:
            cp[index] = (tag, u1(), u2())
        else:
            raise SystemExit(f'unsupported classfile constant-pool tag {tag}')
        index += 1

    def utf8(cp_index):
        entry = cp[cp_index]
        if not entry or entry[0] != 'Utf8':
            raise SystemExit('invalid classfile UTF-8 constant')
        return entry[1]

    def class_name(cp_index):
        entry = cp[cp_index]
        if not entry or entry[0] != 7:
            raise SystemExit('invalid classfile class reference')
        return utf8(entry[1])

    def method_ref(cp_index):
        entry = cp[cp_index]
        if not entry or entry[0] not in (10, 11):
            raise SystemExit('invalid classfile method reference')
        name_type = cp[entry[2]]
        return class_name(entry[1]), utf8(name_type[1]), utf8(name_type[2])

    u2(); u2(); u2()
    interface_count = u2()
    for _ in range(interface_count):
        u2()
    field_count = u2()
    for _ in range(field_count):
        u2(); u2(); u2()
        attribute_count = u2()
        for _ in range(attribute_count):
            u2()
            attr_length = u4()
            offset += attr_length
    code = None
    exception_table = []
    for _ in range(u2()):
        u2()
        name = utf8(u2())
        desc = utf8(u2())
        for _ in range(u2()):
            attr_name = utf8(u2())
            attr_length = u4()
            attr_start = offset
            if name == method_name and desc == descriptor and attr_name == 'Code':
                u2(); u2()
                code_length = u4()
                code = data[offset:offset + code_length]
                offset += code_length
                for _ in range(u2()):
                    exception_table.append((u2(), u2(), u2(), u2()))
            offset = attr_start + attr_length
    if code is None:
        raise SystemExit(f'compiled method {method_name}{descriptor} has no Code attribute')

    lengths = {opcode: 1 for opcode in (set(range(0x00, 0x10)) | set(range(0x1a, 0x36)) | set(range(0x3b, 0x84)) | set(range(0x85, 0x99)) | set(range(0xac, 0xb2)) | {0xbe, 0xbf, 0xc2, 0xc3})}
    lengths.update({opcode: 2 for opcode in (0x10, 0x12, *range(0x15, 0x1a), *range(0x36, 0x3b), 0xa9, 0xbc)})
    lengths.update({opcode: 3 for opcode in (0x11, 0x13, 0x14, 0x84, *range(0x99, 0xa9), *range(0xb2, 0xb9), 0xbb, 0xbd, 0xc0, 0xc1, 0xc6, 0xc7)})
    lengths.update({0xb9: 5, 0xba: 5, 0xc5: 4, 0xc8: 5, 0xc9: 5})
    calls = []
    instructions = {}
    pc = 0
    while pc < len(code):
        opcode = code[pc]
        if opcode in (0xaa, 0xab):
            aligned = (pc + 4) & ~3
            if opcode == 0xaa:
                low, high = struct.unpack_from('>ii', code, aligned + 4)
                count = high - low + 1
                if count < 0:
                    raise SystemExit(f'invalid tableswitch in {method_name}')
                targets = [pc + struct.unpack_from('>i', code, aligned + 12 + i * 4)[0]
                           for i in range(count)]
                default = pc + struct.unpack_from('>i', code, aligned)[0]
                next_pc = aligned + 12 + count * 4
            else:
                pairs = struct.unpack_from('>i', code, aligned + 4)[0]
                if pairs < 0:
                    raise SystemExit(f'invalid lookupswitch in {method_name}')
                default = pc + struct.unpack_from('>i', code, aligned)[0]
                targets = [pc + struct.unpack_from('>i', code, aligned + 12 + i * 8)[0]
                           for i in range(pairs)]
                next_pc = aligned + 8 + pairs * 8
        elif opcode == 0xc4:
            next_pc = pc + (6 if code[pc + 1] == 0x84 else 4)
        else:
            length = lengths.get(opcode)
            if length is None:
                raise SystemExit(f'unsupported bytecode opcode 0x{opcode:02x} in {method_name}')
            next_pc = pc + length
        if opcode in (0xb6, 0xb7, 0xb8, 0xb9):
            cp_index = struct.unpack_from('>H', code, pc + 1)[0]
            calls.append((pc, method_ref(cp_index)))
        if next_pc <= pc or next_pc > len(code):
            raise SystemExit(f'invalid bytecode instruction length in {method_name}')
        instructions[pc] = (opcode, next_pc)
        if opcode in (0xaa, 0xab):
            instructions[pc] = (opcode, next_pc, [default, *targets])
        pc = next_pc

    graph = {address: set() for address in instructions}
    for address, (opcode, next_pc, *switch_targets) in instructions.items():
        if opcode in (0xaa, 0xab):
            graph[address].update(switch_targets[0])
        elif opcode in (0xa9, 0xa8, 0xc9):
            raise SystemExit(f'legacy subroutine bytecode is unsupported in {method_name}')
        elif 0x99 <= opcode <= 0xa6 or opcode in (0xc6, 0xc7):
            graph[address].add(address + struct.unpack_from('>h', code, address + 1)[0])
            if next_pc < len(code):
                graph[address].add(next_pc)
        elif opcode in (0xa7, 0xc8):
            jump = (struct.unpack_from('>h', code, address + 1)[0] if opcode == 0xa7
                    else struct.unpack_from('>i', code, address + 1)[0])
            graph[address].add(address + jump)
        elif 0xac <= opcode <= 0xb1 or opcode == 0xbf:
            pass
        else:
            if next_pc < len(code):
                graph[address].add(next_pc)

    for start_pc, end_pc, handler_pc, _ in exception_table:
        if handler_pc not in graph or start_pc not in instructions:
            raise SystemExit(f'invalid exception handler in {method_name}')
        for address in instructions:
            if start_pc <= address < end_pc:
                graph[address].add(handler_pc)

    def reachable(target, removed=None):
        todo = [0]
        visited = set()
        while todo:
            address = todo.pop()
            if address == removed or address in visited:
                continue
            visited.add(address)
            if address == target:
                return True
            todo.extend(graph.get(address, ()))
        return False

    return calls, graph, reachable

stubs = {
    'android/content/Context.java': '''package android.content;
import java.io.File;
public class Context { public File filesDir; public File noBackupDir; public File getFilesDir(){return filesDir;} public File getNoBackupFilesDir(){return noBackupDir;} }''',
    'android/util/AtomicFile.java': '''package android.util;
import java.io.*;
import java.nio.file.*;
import java.util.*;
public class AtomicFile {
 public static String failAt=""; public static final List<String> events=new ArrayList<>();
 private final File base; private final File next;
 public AtomicFile(File file){base=file;next=new File(file.getPath()+".new");}
 public static void reset(){failAt="";events.clear();}
 private void fail(String stage)throws IOException{if(failAt.equals(stage))throw new IOException("injected-"+stage);}
 public FileOutputStream startWrite()throws IOException{events.add("startWrite");fail("startWrite");File parent=base.getParentFile();if(parent!=null&&!parent.exists()&&!parent.mkdirs())throw new IOException("mkdir");return new ProbeOutput(next);}
 public void finishWrite(FileOutputStream stream)throws IOException{events.add("finishWrite");fail("finishWrite");stream.close();Files.move(next.toPath(),base.toPath(),StandardCopyOption.REPLACE_EXISTING);}
 public void failWrite(FileOutputStream stream){events.add("failWrite");try{stream.close();}catch(IOException ignored){}try{Files.deleteIfExists(next.toPath());}catch(IOException ignored){}}
 public File getBaseFile(){return base;}
 public FileInputStream openRead()throws FileNotFoundException{events.add("openRead");if(failAt.equals("existingBaseFNF")&&base.exists())throw new FileNotFoundException("injected-existing-base-missing");if((failAt.equals("readBack")&&events.contains("finishWrite"))||failAt.equals("readIO"))return new FailingInput(base);if(failAt.equals("mismatchReadBack")&&events.contains("finishWrite")){File corrupt=new File(base.getPath()+".corrupt");try(FileOutputStream out=new FileOutputStream(corrupt)){out.write("different-record".getBytes(java.nio.charset.StandardCharsets.UTF_8));}catch(IOException e){throw new RuntimeException(e);}return new FileInputStream(corrupt);}return new FileInputStream(base);}
 private static final class FailingInput extends FileInputStream {FailingInput(File file)throws FileNotFoundException{super(file);}@Override public int read(byte[] value)throws IOException{throw new IOException("injected-read-io");}@Override public int read(byte[] value,int start,int length)throws IOException{throw new IOException("injected-read-io");}}
 private static final class ProbeOutput extends FileOutputStream {
  ProbeOutput(File file)throws IOException{super(file);}
  @Override public void write(byte[] value)throws IOException{events.add("write");failWrite();super.write(value);if(failAt.equals("sync"))close();}
  private void failWrite()throws IOException{if(failAt.equals("write"))throw new IOException("injected-write");}
 }
}''',
    'android/util/Base64.java': '''package android.util;
public final class Base64 {public static final int NO_WRAP=2,NO_PADDING=1;public static String encodeToString(byte[] v,int flags){return java.util.Base64.getEncoder().withoutPadding().encodeToString(v);}public static byte[] decode(String v,int flags){return java.util.Base64.getDecoder().decode(v);}}''',
    'android/net/Uri.java': '''package android.net;
public final class Uri {private final java.net.URI value;private Uri(String s){value=java.net.URI.create(s);}public static Uri parse(String s){return new Uri(s);}public String getScheme(){return value.getScheme();}public String getHost(){return value.getHost();}}''',
    'android/webkit/ValueCallback.java': 'package android.webkit; public interface ValueCallback<T>{void onReceiveValue(T value);}',
    'android/webkit/WebView.java': '''package android.webkit;
public class WebView {private String url="https://localhost/";public String getUrl(){return url;}public void setUrl(String s){url=s;}public void evaluateJavascript(String script,ValueCallback<String> callback){callback.onReceiveValue("null");}}''',
    'android/webkit/RenderProcessGoneDetail.java': 'package android.webkit; public class RenderProcessGoneDetail {}',
    'android/security/keystore/KeyProperties.java': '''package android.security.keystore;
public final class KeyProperties {public static final int PURPOSE_ENCRYPT=1,PURPOSE_DECRYPT=2;public static final String BLOCK_MODE_GCM="GCM",ENCRYPTION_PADDING_NONE="NoPadding";}''',
    'android/security/keystore/KeyGenParameterSpec.java': '''package android.security.keystore;
import java.security.spec.AlgorithmParameterSpec;
public class KeyGenParameterSpec implements AlgorithmParameterSpec {public static class Builder {public Builder(String alias,int purposes){}public Builder setBlockModes(String... values){return this;}public Builder setEncryptionPaddings(String... values){return this;}public Builder setKeySize(int value){return this;}public KeyGenParameterSpec build(){return new KeyGenParameterSpec();}}}''',
    'org/json/JSONObject.java': '''package org.json;
import java.util.*;
public class JSONObject {private final Map<String,Object> values=new LinkedHashMap<>();public JSONObject(){}public JSONObject(String s){}public Object opt(String k){return values.get(k);}public String getString(String k){return (String)values.get(k);}public JSONObject getJSONObject(String k){return (JSONObject)values.get(k);}public boolean has(String k){return values.containsKey(k);}public JSONObject put(String k,Object v){values.put(k,v);return this;}public int length(){return values.size();}public String toString(){return values.toString();}}''',
    'org/json/JSONTokener.java': 'package org.json; public class JSONTokener {public JSONTokener(String s){}public Object nextValue(){return null;}}',
    'com/getcapacitor/JSObject.java': '''package com.getcapacitor;
import java.util.*;
public class JSObject {public static final Object NULL=new Object();private final Map<String,Object> values=new LinkedHashMap<>();public JSObject put(String k,Object v){values.put(k,v);return this;}public Object get(String k){return values.get(k);}public boolean has(String k){return values.containsKey(k);}public int length(){return values.size();}public Set<String> keySet(){return values.keySet();}}''',
    'com/getcapacitor/PluginCall.java': '''package com.getcapacitor;
import org.json.JSONObject;import java.util.*;
public class PluginCall {private final Map<String,Object> data;public JSObject result;public String error;public boolean resolved;public PluginCall(Map<String,Object> v){data=v;}public PluginCall(String key,String value){data=new HashMap<>();if(key!=null)data.put(key,value);}public String getString(String k){Object v=data.get(k);return v instanceof String?(String)v:null;}public String getString(String k,String fallback){String v=getString(k);return v==null?fallback:v;}public long getLong(String k,long fallback){Object v=data.get(k);return v instanceof Number?((Number)v).longValue():fallback;}public JSONObject getJSONObject(String k){return (JSONObject)data.get(k);}public JSONObject getData(){return new JSONObject();}public void resolve(JSObject v){resolved=true;result=v;}public void reject(String message,Throwable cause){error=message;}public void reject(String message){error=message;}}''',
    'com/getcapacitor/WebViewListener.java': '''package com.getcapacitor;
import android.webkit.*;
public class WebViewListener {public void onPageStarted(WebView view){}public void onPageLoaded(WebView view){}public boolean onRenderProcessGone(WebView view,RenderProcessGoneDetail detail){return false;}}''',
    'com/getcapacitor/Bridge.java': '''package com.getcapacitor;
import android.webkit.WebView;import java.util.*;
public class Bridge {public final List<WebViewListener> listeners=new ArrayList<>();private final WebView view=new WebView();public void addWebViewListener(WebViewListener v){listeners.add(v);}public void removeWebViewListener(WebViewListener v){listeners.remove(v);}public WebView getWebView(){return view;}public void executeOnMainThread(Runnable r){r.run();}}''',
    'com/getcapacitor/Plugin.java': '''package com.getcapacitor;
import android.content.Context;
public class Plugin {public final Context context=new Context();public final Bridge bridge=new Bridge();public Context getContext(){return context;}public Bridge getBridge(){return bridge;}public void load(){}protected void handleOnDestroy(){}public void notifyListeners(String name,JSObject value){}}''',
    'com/getcapacitor/PluginMethod.java': 'package com.getcapacitor; public @interface PluginMethod {}',
    'com/getcapacitor/annotation/CapacitorPlugin.java': 'package com.getcapacitor.annotation; public @interface CapacitorPlugin {String name();}',
    'SessionStoreProbe.java': r'''import android.util.AtomicFile;import android.webkit.WebView;import cn.lifelinegame.mobile.LifelineStoragePlugin;import com.getcapacitor.*;import java.io.*;import java.nio.charset.StandardCharsets;import java.nio.file.*;import java.util.*;
public final class SessionStoreProbe {
 static final String KEY="lifeline-local-game-session-v1",TOMBSTONE="__LIFELINE_CLEARED_V1__";static int failed;
 static void ok(boolean b,String m){if(!b)throw new AssertionError(m);}
 static void test(String name,Runnable r){try{r.run();System.out.println("PASS\t"+name);}catch(Throwable e){failed++;System.out.println("FAIL\t"+name+"\t"+e);}}
 static final class F implements AutoCloseable {final Path root;final LifelineStoragePlugin p=new LifelineStoragePlugin();F()throws Exception{root=Files.createTempDirectory("lifeline-session-");p.context.filesDir=root.toFile();p.load();}PluginCall call(String method,String key,String value){Map<String,Object> data=new HashMap<>();if(key!=null)data.put("key",key);if(value!=null)data.put("value",value);return callData(method,data);}PluginCall callData(String method,Map<String,Object> data){PluginCall c=new PluginCall(data);switch(method){case"load":p.loadRecord(c);break;case"save":p.saveRecord(c);break;case"remove":p.removeRecord(c);break;default:throw new AssertionError(method);}return c;}@Override public void close()throws Exception{delete(root.toFile());}}
 static void delete(File f){if(f.isDirectory())for(File x:f.listFiles())delete(x);if(!f.delete())throw new RuntimeException("cleanup failed: "+f);}
 static Object value(PluginCall c){return c.result==null?null:c.result.get("value");}
 static void durable(PluginCall c){ok(c.error==null&&c.resolved,"operation rejected");ok(c.result!=null&&c.result.length()==1&&Boolean.TRUE.equals(c.result.get("durable")),"durable schema");}
 static void rejected(PluginCall c){ok(c.error!=null&&!c.resolved,"failed operation resolved");ok(c.result==null||!Boolean.TRUE.equals(c.result.get("durable")),"false durable acknowledgement");}
 public static void main(String[] args)throws Exception{
 test("independent keys preserve each other across save, restart and clear",()->{try(F f=new F()){String topology="lifeline-topology-local-game-session-v1";durable(f.call("save",KEY,"ordinary"));durable(f.call("save",topology,"topology"));LifelineStoragePlugin p2=new LifelineStoragePlugin();p2.context.filesDir=f.root.toFile();p2.load();PluginCall read=new PluginCall("key",topology);p2.loadRecord(read);ok("topology".equals(value(read)),"topology lost on restart");durable(f.call("remove",topology,null));ok("ordinary".equals(value(f.call("load",KEY,null))),"topology clear changed ordinary");ok(TOMBSTONE.equals(value(f.call("load",topology,null))),"topology clear missing");}catch(Exception e){throw new RuntimeException(e);}});
 test("missing session is null with exact load schema",()->{try(F f=new F()){PluginCall c=f.call("load",KEY,null);ok(c.error==null&&c.resolved,"missing load rejected");ok(c.result.length()==1&&c.result.has("value")&&value(c)==JSObject.NULL,"missing result schema/value");}catch(Exception e){throw new RuntimeException(e);}});
 test("Unicode JSON saves durably and survives a plugin instance boundary",()->{try(F f=new F()){String json="{\"emoji\":\"🌲🧪\",\"quote\":\"a\\\"b\",\"nested\":{\"城市\":[\"南京\",null,7]},\"raw\":true}";AtomicFile.reset();durable(f.call("save",KEY,json));ok(AtomicFile.events.equals(Arrays.asList("startWrite","write","finishWrite","openRead")),"write order "+AtomicFile.events);try(F second=new F()){second.p.context.filesDir=f.root.toFile();PluginCall loaded=second.call("load",KEY,null);ok(loaded.error==null&&loaded.resolved,"read-back instance failed");ok(loaded.result.length()==1&&json.equals(value(loaded)),"raw Unicode JSON changed");}}catch(Exception e){throw new RuntimeException(e);}});
 test("durable true follows start write sync finish and read-back only",()->{try(F f=new F()){AtomicFile.reset();PluginCall saved=f.call("save",KEY,"{\"x\":1}");durable(saved);ok(AtomicFile.events.equals(Arrays.asList("startWrite","write","finishWrite","openRead")),"AtomicFile order "+AtomicFile.events);}catch(Exception e){throw new RuntimeException(e);}});
 test("remove writes durable tombstone distinct from missing",()->{try(F f=new F()){PluginCall missing=f.call("load",KEY,null);ok(value(missing)==JSObject.NULL,"initial missing not null");durable(f.call("remove",KEY,null));PluginCall cleared=f.call("load",KEY,null);ok(cleared.error==null&&cleared.resolved&&TOMBSTONE.equals(value(cleared)),"tombstone missing or wrong");}catch(Exception e){throw new RuntimeException(e);}});
 test("existing base FileNotFoundException fails closed",()->{try(F f=new F()){durable(f.call("save",KEY,"{}"));AtomicFile.failAt="existingBaseFNF";rejected(f.call("load",KEY,null));}catch(Exception e){throw new RuntimeException(e);}});
 test("invalid or missing key and absent value fail closed",()->{try(F f=new F()){rejected(f.call("save","other-key","{}"));rejected(f.call("load","other-key",null));PluginCall absent=new PluginCall("key",KEY);f.p.saveRecord(absent);rejected(absent);rejected(f.call("remove","other-key",null));Map<String,Object> noKey=new HashMap<>();rejected(f.callData("load",noKey));noKey.put("value","{}");rejected(f.callData("save",noKey));rejected(f.callData("remove",new HashMap<String,Object>()));}catch(Exception e){throw new RuntimeException(e);}});
 test("startWrite failure rejects save and remove without durability",()->{try(F f=new F()){AtomicFile.reset();AtomicFile.failAt="startWrite";rejected(f.call("save",KEY,"{}"));AtomicFile.reset();AtomicFile.failAt="startWrite";rejected(f.call("remove",KEY,null));ok(!AtomicFile.events.contains("finishWrite"),"finish after failed start");}catch(Exception e){throw new RuntimeException(e);}});
 test("write and sync failures reject and fail the pending atomic write",()->{for(String stage:new String[]{"write","sync"})try(F f=new F()){AtomicFile.reset();AtomicFile.failAt=stage;rejected(f.call("save",KEY,"{}"));ok(AtomicFile.events.contains("failWrite"),"pending write not failed after "+stage);if(stage.equals("sync"))ok(AtomicFile.events.contains("write")&&!AtomicFile.events.contains("finishWrite"),"sync did not fail after data write");}catch(Exception e){throw new RuntimeException(e);}});
 test("finishWrite failure rejects and rolls back the pending write",()->{try(F f=new F()){AtomicFile.reset();AtomicFile.failAt="finishWrite";rejected(f.call("save",KEY,"{}"));ok(AtomicFile.events.contains("failWrite"),"failed finish not rolled back");}catch(Exception e){throw new RuntimeException(e);}});
 test("read-back failure rejects save and remove instead of claiming durability",()->{for(String stage:new String[]{"readBack","mismatchReadBack"})try(F f=new F()){AtomicFile.reset();AtomicFile.failAt=stage;rejected(f.call("save",KEY,"{}"));ok(AtomicFile.events.contains("finishWrite")&&AtomicFile.events.contains("openRead"),"save read-back was not attempted");AtomicFile.reset();AtomicFile.failAt=stage;rejected(f.call("remove",KEY,null));ok(AtomicFile.events.contains("finishWrite")&&AtomicFile.events.contains("openRead"),"remove read-back was not attempted");}catch(Exception e){throw new RuntimeException(e);}});
 test("load I/O failure after open rejects instead of masquerading as missing",()->{try(F f=new F()){AtomicFile.reset();durable(f.call("save",KEY,"{}"));AtomicFile.failAt="readIO";rejected(f.call("load",KEY,null));}catch(Exception e){throw new RuntimeException(e);}});
 if(failed>0)System.exit(1);
 }}''',
}

with tempfile.TemporaryDirectory(prefix='lifeline-android-session-store-') as tmp:
    temp = Path(tmp)
    sources = []
    for rel, content in stubs.items():
        target = temp / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding='utf-8')
        sources.append(str(target))
    plugin_snapshot = temp / 'cn/lifelinegame/mobile/LifelineStoragePlugin.java'
    plugin_snapshot.parent.mkdir(parents=True, exist_ok=True)
    plugin_snapshot.write_bytes(source_bytes)
    sources.append(str(plugin_snapshot))
    classes = temp / 'classes'
    classes.mkdir()
    suffix = '.exe' if sys.platform == 'win32' else ''
    javac = args.java_bin / ('javac' + suffix)
    java = args.java_bin / ('java' + suffix)
    try:
        compile_result = subprocess.run([str(javac), '-encoding', 'UTF-8', '-d', str(classes), *sources], capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=120)
        if compile_result.returncode:
            raise SystemExit(compile_result.stdout + compile_result.stderr)
        calls, graph, reachable = compiled_method_calls(classes / 'cn/lifelinegame/mobile/LifelineStoragePlugin.class', 'writeDurably', '(Landroid/util/AtomicFile;Ljava/lang/String;)V')
        targets = [target for _, target in calls]
        required = [
            ('java/io/FileOutputStream', 'getFD', '()Ljava/io/FileDescriptor;'),
            ('java/io/FileDescriptor', 'sync', '()V'),
            ('android/util/AtomicFile', 'finishWrite', '(Ljava/io/FileOutputStream;)V'),
            ('cn/lifelinegame/mobile/LifelineStoragePlugin', 'readRaw', '(Landroid/util/AtomicFile;)Ljava/lang/String;'),
            ('java/lang/String', 'equals', '(Ljava/lang/Object;)Z'),
        ]
        positions = [targets.index(target) if target in targets else -1 for target in required]
        if any(position < 0 for position in positions) or positions != sorted(positions):
            raise SystemExit('compiled writeDurably must call getFD, sync, finishWrite, readRaw, equals in order')
        if any(targets.count(target) != 1 for target in required):
            raise SystemExit('compiled writeDurably contains missing or duplicate durability calls')
        call_offsets = [next(address for address, target in calls if target == item) for item in required]
        for source_call, target_call, source_name, target_name in zip(
                call_offsets, call_offsets[1:], required, required[1:]):
            if not reachable(target_call):
                raise SystemExit('required durability call is unreachable in compiled writeDurably')
            if reachable(target_call, removed=source_call):
                raise SystemExit(f'compiled writeDurably control flow can bypass {source_name[1]} before {target_name[1]}')
        result = subprocess.run([str(java), '-cp', str(classes), 'SessionStoreProbe'], capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=120)
    finally:
        if plugin.read_bytes() != source_bytes or tracked_plugin.read_bytes() != tracked_source_bytes:
            raise SystemExit('LifelineStoragePlugin.java changed while the verifier ran')
    if result.returncode:
        raise SystemExit(result.stdout + result.stderr)
    checks = [line for line in result.stdout.splitlines() if line.startswith(('PASS\t', 'FAIL\t'))]
    expected = [
        'independent keys preserve each other across save, restart and clear',
        'missing session is null with exact load schema',
        'Unicode JSON saves durably and survives a plugin instance boundary',
        'durable true follows start write sync finish and read-back only',
        'remove writes durable tombstone distinct from missing',
        'existing base FileNotFoundException fails closed',
        'invalid or missing key and absent value fail closed',
        'startWrite failure rejects save and remove without durability',
        'write and sync failures reject and fail the pending atomic write',
        'finishWrite failure rejects and rolls back the pending write',
        'read-back failure rejects save and remove instead of claiming durability',
        'load I/O failure after open rejects instead of masquerading as missing',
    ]
    names = [line.split('\t', 1)[1].split('\t', 1)[0] for line in checks]
    if names != expected or len(set(names)) != len(expected) or any(not line.startswith('PASS\t') for line in checks):
        raise SystemExit(result.stdout + result.stderr)
    print(json.dumps({'status': 'PASS', 'source_sha256': hashlib.sha256(source_bytes).hexdigest().upper(), 'checks': len(checks), 'output': checks}, ensure_ascii=False))
