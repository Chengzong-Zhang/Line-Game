import Foundation
import WebKit
import Capacitor

@objc(LifelineStoragePlugin)
final class LifelineStoragePlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "LifelineStoragePlugin"
    let jsName = "LifelineStorage"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "claimCredentialOwner", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "claimDocument", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "loadCredential", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "saveCredential", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearCredential", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "loadRecord", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "saveRecord", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "removeRecord", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getSessionRecoveryStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "resolveSessionRecovery", returnType: CAPPluginReturnPromise)
    ]
    override func shouldOverrideLoad(_ action: WKNavigationAction) -> NSNumber? {
        guard action.targetFrame?.isMainFrame == true else { return true }
        LifelineStore.shared.invalidateDocument()
        guard let url = action.request.url, let local = bridge?.config.localURL,
              url.scheme?.lowercased() == local.scheme?.lowercased(),
              url.host?.lowercased() == local.host?.lowercased(), url.port == local.port else { return true }
        LifelineStore.shared.rotateDocument()
        return nil
    }
    @objc func claimDocument(_ call: CAPPluginCall) {
        guard call.options.count == 1, let challenge = call.getString("documentChallenge"),
              challenge.utf8.count == 64,
              challenge.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else { call.reject("Document claim failed."); return }
        DispatchQueue.main.async { [weak self] in
            guard let self = self, let web = self.bridge?.webView, let url = web.url,
                  let local = self.bridge?.config.localURL, url.scheme == local.scheme,
                  url.host == local.host, url.port == local.port else { call.reject("Document claim failed."); return }
            let epoch = LifelineStore.shared.currentEpoch()
            web.evaluateJavaScript("String(globalThis.__LIFELINE_DOCUMENT_CHALLENGE__||'')") { [weak web] result, error in
                guard error == nil, let web = web, web.url == url,
                      let value = result as? String, value == challenge else { call.reject("Document changed."); return }
                do { call.resolve(try LifelineStore.shared.documentLease(epoch: epoch)) }
                catch { call.reject("Document changed.") }
            }
        }
    }
    @objc func claimCredentialOwner(_ call: CAPPluginCall) {
        guard call.options.count == 2, let expected = call.getInt("expectedOwnerGeneration"),
              let challenge = call.getString("documentChallenge"), challenge.utf8.count == 64,
              challenge.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else { call.reject("Credential owner claim failed."); return }
        DispatchQueue.main.async { [weak self] in
            guard let self = self, let web = self.bridge?.webView, let url = web.url,
                  let local = self.bridge?.config.localURL, url.scheme == local.scheme,
                  url.host == local.host, url.port == local.port else { call.reject("Credential owner claim failed."); return }
            let epoch = LifelineStore.shared.currentEpoch()
            web.evaluateJavaScript("String(globalThis.__LIFELINE_DOCUMENT_CHALLENGE__||'')") { [weak web] result, error in
                guard error == nil, let web = web, web.url == url, let value = result as? String,
                      value == challenge else { call.reject("Credential owner changed."); return }
                do { call.resolve(try LifelineStore.shared.claim(expected: expected, epoch: epoch)) }
                catch { call.reject("Credential owner changed.") }
            }
        }
    }
    @objc func loadCredential(_ call: CAPPluginCall) {
        do { guard call.options.count == 3, let lease = call.options as? [String: Any] else { throw LifelineStoreError.invalid }; call.resolve(try LifelineStore.shared.loadCredential(lease)) }
        catch { call.reject("Credential load failed.") }
    }
    @objc func saveCredential(_ call: CAPPluginCall) {
        do { guard call.options.count == 4, let lease = call.options as? [String: Any], let value = call.options["credential"] as? [String: Any] else { throw LifelineStoreError.invalid }
            try LifelineStore.shared.saveCredential(lease, value: value); call.resolve(["durable": true]) }
        catch { call.reject("Credential save failed.") }
    }
    @objc func clearCredential(_ call: CAPPluginCall) {
        do { guard call.options.count == 3, let lease = call.options as? [String: Any] else { throw LifelineStoreError.invalid }; try LifelineStore.shared.clearCredential(lease); call.resolve(["durable": true]) }
        catch { call.reject("Credential clear failed.") }
    }
    @objc func loadRecord(_ call: CAPPluginCall) {
        do { guard call.options.count == 2, let lease = call.options["documentLease"] as? [String: Any], let key = call.getString("key") else { throw LifelineStoreError.invalid }
            let value = try LifelineStore.shared.withDocument(lease) { try LifelineStore.shared.loadRecord(key) }; call.resolve(["value": value as Any? ?? NSNull()]) }
        catch { call.reject("Session read failed.") }
    }
    @objc func saveRecord(_ call: CAPPluginCall) {
        do { guard call.options.count == 3, let lease = call.options["documentLease"] as? [String: Any], let key = call.getString("key"), let value = call.getString("value") else { throw LifelineStoreError.invalid }
            try LifelineStore.shared.withDocument(lease) { try LifelineStore.shared.saveRecord(key, value: value) }; call.resolve(["durable": true]) }
        catch { call.reject("Session save failed.") }
    }
    @objc func removeRecord(_ call: CAPPluginCall) {
        do { guard call.options.count == 2, let lease = call.options["documentLease"] as? [String: Any], let key = call.getString("key") else { throw LifelineStoreError.invalid }
            try LifelineStore.shared.withDocument(lease) { try LifelineStore.shared.saveRecord(key, value: "__LIFELINE_CLEARED_V1__") }; call.resolve(["durable": true]) }
        catch { call.reject("Session clear failed.") }
    }
    @objc func getSessionRecoveryStatus(_ call: CAPPluginCall) {
        do {
            guard call.options.count == 1, let lease = call.options["documentLease"] as? [String: Any] else { throw LifelineStoreError.invalid }
            let statuses = try LifelineStore.shared.withDocument(lease) { () -> [String: Any] in
                ["ordinary": try LifelineStore.shared.sessionRecoveryStatus("lifeline-local-game-session-v1"),
                 "topology": try LifelineStore.shared.sessionRecoveryStatus("lifeline-topology-local-game-session-v1")]
            }
            call.resolve(statuses)
        } catch { call.reject("Session recovery status unavailable.") }
    }
    @objc func resolveSessionRecovery(_ call: CAPPluginCall) {
        do {
            guard call.options.count == 4, let lease = call.options["documentLease"] as? [String: Any], call.getBool("confirm") == true,
                  let key = call.getString("key"), let value = call.getString("value") else { throw LifelineStoreError.invalid }
            try LifelineStore.shared.withDocument(lease) { try LifelineStore.shared.resolveSessionRecovery(key, value: value) }
            call.resolve(["durable": true])
        } catch { call.reject("Session recovery clear could not be confirmed.") }
    }
}
