package cn.lifelinegame.mobile;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "LifelineCapabilities")
public final class LifelineCapabilitiesPlugin extends Plugin {
    private static JSObject capability(String support, String implementation) {
        JSObject value = new JSObject();
        value.put("support", support);
        value.put("implementation", implementation);
        return value;
    }

    private static void put(JSObject target, String name, String support, String implementation) {
        target.put(name, capability(support, implementation));
    }

    @PluginMethod
    public void getCapabilities(PluginCall call) {
        Object schemaVersion = call.getData().opt("schemaVersion");
        if (call.getData().length() != 1
                || !(schemaVersion instanceof Number)
                || ((Number) schemaVersion).doubleValue() != 1.0) {
            call.reject("Unsupported capability schema version.");
            return;
        }

        JSObject capabilities = new JSObject();
        put(capabilities, "sessionStorage", "implemented", "native");
        put(capabilities, "credentialStorage", "implemented", "native");
        put(capabilities, "replayShare", "implemented", "native");
        put(capabilities, "replayImport", "implemented", "native");
        put(capabilities, "tutorialHost", "implemented", "native");
        put(capabilities, "appInfo", "implemented", "native");
        put(capabilities, "background", "implemented", "native");
        put(capabilities, "backEvents", "implemented", "native");
        put(capabilities, "appLifecycle", "implemented", "native");
        put(capabilities, "systemNetwork", "implemented", "native");
        put(capabilities, "haptics", "implemented", "native");
        put(capabilities, "channelLogin", "not-implemented", "none");
        put(capabilities, "realName", "not-implemented", "none");

        JSObject result = new JSObject();
        result.put("schemaVersion", 1);
        result.put("platform", "android");
        result.put("source", "android-native");
        result.put("capabilities", capabilities);
        call.resolve(result);
    }
}
