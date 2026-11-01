import UIKit
import WebKit
import Capacitor

// Capacitor 8.5.3 forwards script messages without checking WKFrameInfo.
// Keep its handler, but put an origin and main-frame gate in front of it.
private final class LifelineMessageGate: NSObject, WKScriptMessageHandler {
    weak var webView: WKWebView?
    let downstream: WKScriptMessageHandler
    let scheme: String
    let host: String
    init(webView: WKWebView, downstream: WKScriptMessageHandler, localURL: URL) {
        self.webView = webView; self.downstream = downstream
        self.scheme = localURL.scheme?.lowercased() ?? ""
        self.host = localURL.host?.lowercased() ?? ""
    }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        let origin = message.frameInfo.securityOrigin
        guard let webView = webView, message.webView === webView, message.frameInfo.isMainFrame,
              !scheme.isEmpty, !host.isEmpty, origin.protocol.lowercased() == scheme,
              origin.host.lowercased() == host, origin.port == 0 else { return }
        // The iOS adapter polls these two plugins with a document lease.
        // Capacitor's unleased built-in addListener can otherwise execute from
        // an old dispatch queue after reset() has removed the old listeners.
        if let body = message.body as? [String: Any], body["type"] as? String == "message",
           let plugin = body["pluginId"] as? String, ["LifelineIOS", "LifelineNetwork"].contains(plugin),
           let method = body["methodName"] as? String,
           ["addListener", "removeListener", "removeAllListeners"].contains(method) { return }
        downstream.userContentController(controller, didReceive: message)
    }
}

@objc(LifelineBridgeViewController)
final class LifelineBridgeViewController: CAPBridgeViewController {
    private var messageGate: LifelineMessageGate?
    override func capacitorDidLoad() {
        guard let bridge = bridge, let view = webView,
              let original = view.navigationDelegate as? WKScriptMessageHandler else {
            LifelineStore.shared.invalidateDocument()
            return
        }
        let gate = LifelineMessageGate(webView: view, downstream: original, localURL: bridge.config.localURL)
        let controller = view.configuration.userContentController
        controller.removeScriptMessageHandler(forName: "bridge")
        controller.add(gate, name: "bridge")
        messageGate = gate
        LifelineStore.shared.rotateDocument()
        bridge.registerPluginInstance(LifelineStoragePlugin())
        bridge.registerPluginInstance(LifelineCapabilitiesPlugin())
        bridge.registerPluginInstance(LifelineNetworkPlugin())
        bridge.registerPluginInstance(LifelineHapticsPlugin())
        bridge.registerPluginInstance(LifelineReplayImportPlugin())
        bridge.registerPluginInstance(LifelineTutorialHostPlugin())
        bridge.registerPluginInstance(LifelineIOSPlugin())
    }
    deinit { LifelineStore.shared.invalidateDocument() }
}
