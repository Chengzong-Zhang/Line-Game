"""Compile and exercise the current Android capability plugin with host stubs.

This executes the Java source from this checkout with a desktop JDK. It does
not compile against the Android SDK or prove behavior on an Android device.
Run with --java-bin pointing to a JDK bin directory.
"""
from pathlib import Path
import argparse
import hashlib
import json
import subprocess
import sys
import tempfile


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--java-bin', type=Path, required=True)
parser.add_argument('--plugin-source', type=Path, help=argparse.SUPPRESS)
args = parser.parse_args()
root = Path(__file__).resolve().parents[2]
tracked_plugin = root / 'mobile/android/app/src/main/java/cn/lifelinegame/mobile/LifelineCapabilitiesPlugin.java'
plugin = args.plugin_source or tracked_plugin
tracked_source_bytes = tracked_plugin.read_bytes()
source_bytes = plugin.read_bytes()

stubs = {
    'com/getcapacitor/JSObject.java': '''package com.getcapacitor;
import java.util.*;
public class JSObject {
 private final Map<String,Object> values=new LinkedHashMap<>();
 public JSObject put(String key,Object value){values.put(key,value);return this;}
 public Object opt(String key){return values.get(key);}
 public Object get(String key){return values.get(key);}
 public int length(){return values.size();}
 public Set<String> keySet(){return Collections.unmodifiableSet(values.keySet());}
}''',
    'com/getcapacitor/PluginCall.java': '''package com.getcapacitor;
public class PluginCall {
 private final JSObject data=new JSObject(); public JSObject result; public String error; public int resolves,rejects;
 public JSObject getData(){return data;}
 public void resolve(JSObject value){resolves++;result=value;}
 public void reject(String message){rejects++;error=message;}
}''',
    'com/getcapacitor/Plugin.java': 'package com.getcapacitor; public class Plugin {}',
    'com/getcapacitor/PluginMethod.java': 'package com.getcapacitor; public @interface PluginMethod {}',
    'com/getcapacitor/annotation/CapacitorPlugin.java': 'package com.getcapacitor.annotation; public @interface CapacitorPlugin {String name();}',
    'CapabilitiesProbe.java': r'''import java.util.*;import com.getcapacitor.*;import cn.lifelinegame.mobile.LifelineCapabilitiesPlugin;
public final class CapabilitiesProbe {
 static int failed;
 static final LinkedHashMap<String,String> EXPECTED=new LinkedHashMap<>();
 static {for(String name:new String[]{"sessionStorage","credentialStorage","replayShare","replayImport","tutorialHost","appInfo","background","backEvents","appLifecycle","systemNetwork","haptics"})EXPECTED.put(name,"implemented/native");EXPECTED.put("channelLogin","not-implemented/none");EXPECTED.put("realName","not-implemented/none");}
 static void ok(boolean value,String message){if(!value)throw new AssertionError(message);}
 static void test(String name,Runnable check){try{check.run();System.out.println("PASS\t"+name);}catch(Throwable error){failed++;System.out.println("FAIL\t"+name+"\t"+error);}}
 static PluginCall call(Object version,Object extra){PluginCall call=new PluginCall();if(version!=null)call.getData().put("schemaVersion",version);if(extra!=null)call.getData().put("extra",extra);new LifelineCapabilitiesPlugin().getCapabilities(call);return call;}
 static JSObject validResult(Number version){PluginCall call=call(version,null);ok(call.error==null,"valid request rejected");ok(call.resolves==1&&call.rejects==0,"valid request settled incorrectly");return call.result;}
 static void rejected(PluginCall call){ok(call.result==null&&call.resolves==0,"rejected request resolved");ok(call.rejects==1,"rejected request settled more than once");ok("Unsupported capability schema version.".equals(call.error),"unexpected rejection text");}
 static void verifyExact(JSObject result){ok(((Number)result.get("schemaVersion")).intValue()==1,"schemaVersion");ok("android".equals(result.get("platform")),"platform");ok("android-native".equals(result.get("source")),"source");ok(result.length()==4,"top-level field drift");JSObject capabilities=(JSObject)result.get("capabilities");ok(capabilities.keySet().equals(EXPECTED.keySet()),"capability key drift: "+capabilities.keySet());for(var entry:EXPECTED.entrySet()){JSObject value=(JSObject)capabilities.get(entry.getKey());String[] expected=entry.getValue().split("/");ok(value!=null&&value.length()==2,entry.getKey()+" schema");ok(expected[0].equals(value.get("support")),entry.getKey()+" support");ok(expected[1].equals(value.get("implementation")),entry.getKey()+" implementation");}}
 public static void main(String[] args){
  test("integer schema returns the exact Android capability contract",()->verifyExact(validResult(1)));
  test("numeric schema 1.0 is accepted without changing the contract",()->verifyExact(validResult(1.0)));
  test("missing schema is rejected",()->rejected(call(null,null)));
  test("string schema is rejected",()->rejected(call("1",null)));
  test("unsupported numeric schema is rejected",()->{rejected(call(0,null));rejected(call(2,null));rejected(call(Double.NaN,null));});
  test("additional request fields are rejected",()->rejected(call(1,true)));
  test("rejections do not poison a later valid request",()->{rejected(call("bad",null));verifyExact(validResult(1));});
  test("each response owns fresh capability objects",()->{JSObject first=validResult(1);JSObject firstCaps=(JSObject)first.get("capabilities");((JSObject)firstCaps.get("haptics")).put("support","tampered");JSObject second=validResult(1);verifyExact(second);ok("implemented".equals(((JSObject)((JSObject)second.get("capabilities")).get("haptics")).get("support")),"response reused mutable object");});
  if(failed>0)System.exit(1);
 }
}''',
}

with tempfile.TemporaryDirectory(prefix='lifeline-android-capabilities-') as tmp:
    temp = Path(tmp)
    sources = []
    for relative, content in stubs.items():
        target = temp / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding='utf-8')
        sources.append(str(target))
    plugin_snapshot = temp / 'cn/lifelinegame/mobile/LifelineCapabilitiesPlugin.java'
    plugin_snapshot.parent.mkdir(parents=True, exist_ok=True)
    plugin_snapshot.write_bytes(source_bytes)
    sources.append(str(plugin_snapshot))
    classes = temp / 'classes'
    classes.mkdir()
    suffix = '.exe' if sys.platform == 'win32' else ''
    javac = args.java_bin / ('javac' + suffix)
    java = args.java_bin / ('java' + suffix)
    try:
        compile_result = subprocess.run(
            [str(javac), '-encoding', 'UTF-8', '-d', str(classes), *sources],
            capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=120,
        )
        if compile_result.returncode:
            raise SystemExit(compile_result.stdout + compile_result.stderr)
        result = subprocess.run(
            [str(java), '-cp', str(classes), 'CapabilitiesProbe'],
            capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=120,
        )
    finally:
        if plugin.read_bytes() != source_bytes or tracked_plugin.read_bytes() != tracked_source_bytes:
            raise SystemExit('LifelineCapabilitiesPlugin.java changed while the verifier ran')
    if result.returncode:
        raise SystemExit(result.stdout + result.stderr)
    checks = [line for line in result.stdout.splitlines() if line.startswith(('PASS\t', 'FAIL\t'))]
    expected = [
        'integer schema returns the exact Android capability contract',
        'numeric schema 1.0 is accepted without changing the contract',
        'missing schema is rejected',
        'string schema is rejected',
        'unsupported numeric schema is rejected',
        'additional request fields are rejected',
        'rejections do not poison a later valid request',
        'each response owns fresh capability objects',
    ]
    names = [line.split('\t', 1)[1].split('\t', 1)[0] for line in checks]
    if names != expected or len(set(names)) != len(expected) or any(not line.startswith('PASS\t') for line in checks):
        raise SystemExit(result.stdout + result.stderr)
    print(json.dumps({
        'status': 'PASS',
        'source_sha256': hashlib.sha256(source_bytes).hexdigest().upper(),
        'checks': len(checks),
        'output': checks,
    }, ensure_ascii=False))
