import UIKit
import Network
import Capacitor

@objc(LifelineCapabilitiesPlugin)
final class LifelineCapabilitiesPlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "LifelineCapabilitiesPlugin"
    let jsName = "LifelineCapabilities"
    let pluginMethods = [CAPPluginMethod(name: "getCapabilities", returnType: CAPPluginReturnPromise)]
    @objc func getCapabilities(_ call: CAPPluginCall) {
        guard call.options.count == 1, call.getInt("schemaVersion") == 1 else { call.reject("Unsupported capability schema."); return }
        let native = Set(["sessionStorage", "credentialStorage", "replayShare", "replayImport", "tutorialHost", "appInfo", "appLifecycle", "systemNetwork", "haptics"])
        let names = ["sessionStorage", "credentialStorage", "replayShare", "replayImport", "tutorialHost", "appInfo", "background", "backEvents", "appLifecycle", "systemNetwork", "haptics", "channelLogin", "realName"]
        var values: [String: Any] = [:]
        for name in names { values[name] = native.contains(name) ? ["support": "implemented", "implementation": "native"] : ["support": "not-implemented", "implementation": "none"] }
        call.resolve(["schemaVersion": 1, "platform": "ios", "source": "ios-native", "capabilities": values])
    }
}

@objc(LifelineHapticsPlugin)
final class LifelineHapticsPlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "LifelineHapticsPlugin"
    let jsName = "LifelineHaptics"
    let pluginMethods = [CAPPluginMethod(name: "requestMoveHaptic", returnType: CAPPluginReturnPromise)]
    @objc func requestMoveHaptic(_ call: CAPPluginCall) {
        guard let lease = call.options["documentLease"] as? [String: Any], LifelineStore.shared.isCurrentDocument(lease) else { call.reject("Document changed."); return }
        let epoch = LifelineStore.shared.currentEpoch()
        let started = ProcessInfo.processInfo.systemUptime
        DispatchQueue.main.async { [weak self] in
            guard let self = self, LifelineStore.shared.isCurrentDocument(lease), UIApplication.shared.applicationState == .active,
                  self.bridge?.webView?.window != nil, epoch == LifelineStore.shared.currentEpoch(),
                  ProcessInfo.processInfo.systemUptime - started < 0.35 else { call.resolve(["status": "suppressed"]); return }
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            call.resolve(["status": "requested"])
        }
    }
}

@objc(LifelineNetworkPlugin)
final class LifelineNetworkPlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "LifelineNetworkPlugin"
    let jsName = "LifelineNetwork"
    let pluginMethods = [CAPPluginMethod(name: "getNetworkStatus", returnType: CAPPluginReturnPromise), CAPPluginMethod(name: "startNetworkStatus", returnType: CAPPluginReturnPromise), CAPPluginMethod(name: "stopNetworkStatus", returnType: CAPPluginReturnPromise)]
    private var monitor: NWPathMonitor?
    private var token: String?
    private var revision = 0
    private var availability = "unknown"
    private var observers: [NSObjectProtocol] = []
    private func snapshot(reason: String? = nil) -> [String: Any] {
        revision += 1
        var status: [String: Any] = ["schemaVersion": 1, "source": "ios-native", "revision": revision, "availability": availability, "validation": "unknown"]
        if let reason = reason { status["reason"] = reason }
        return status
    }
    override func load() {
        for name in [UIApplication.willResignActiveNotification, .lifelineDocumentInvalidated] {
            observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in self?.stop() })
        }
    }
    private func stop() { monitor?.cancel(); monitor = nil; token = nil; availability = "unknown" }
    deinit { for observer in observers { NotificationCenter.default.removeObserver(observer) }; monitor?.cancel() }
    @objc func getNetworkStatus(_ call: CAPPluginCall) {
        guard let lease = call.options["documentLease"] as? [String: Any], LifelineStore.shared.isCurrentDocument(lease) else { call.reject("Document changed."); return }
        DispatchQueue.main.async { [weak self] in
            guard let self = self, LifelineStore.shared.isCurrentDocument(lease) else { call.reject("Network unavailable."); return }
            let active = UIApplication.shared.applicationState == .active
            call.resolve(self.snapshot(reason: active ? (self.monitor == nil ? "unavailable" : nil) : "background"))
        }
    }
    @objc func startNetworkStatus(_ call: CAPPluginCall) {
        guard let lease = call.options["documentLease"] as? [String: Any], LifelineStore.shared.isCurrentDocument(lease), let id = call.getString("subscriptionId"), !id.isEmpty, id.utf8.count <= 128 else { call.reject("Invalid subscription."); return }
        DispatchQueue.main.async { [weak self] in
            guard let self = self, LifelineStore.shared.isCurrentDocument(lease), UIApplication.shared.applicationState == .active, self.monitor == nil else { call.reject("Network subscription unavailable."); return }
            self.token = id; self.availability = "unknown"
            let monitor = NWPathMonitor(); self.monitor = monitor
            monitor.pathUpdateHandler = { [weak self, weak monitor] path in
                DispatchQueue.main.async {
                    guard let self = self, let monitor = monitor, self.monitor === monitor, self.token == id, LifelineStore.shared.isCurrentDocument(lease) else { return }
                    self.availability = path.status == .satisfied ? "available" : "unavailable"
                }
            }
            monitor.start(queue: DispatchQueue(label: "cn.lifelinegame.network"))
            call.resolve(self.snapshot())
        }
    }
    @objc func stopNetworkStatus(_ call: CAPPluginCall) {
        guard let lease = call.options["documentLease"] as? [String: Any], LifelineStore.shared.isCurrentDocument(lease), let id = call.getString("subscriptionId") else { call.reject("Invalid subscription."); return }
        DispatchQueue.main.async { [weak self] in
            guard let self = self, LifelineStore.shared.isCurrentDocument(lease) else { call.reject("Network unavailable."); return }
            if self.token == id { self.stop() }
            call.resolve()
        }
    }
}

@objc(LifelineIOSPlugin)
final class LifelineIOSPlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "LifelineIOSPlugin"
    let jsName = "LifelineIOS"
    let pluginMethods = [CAPPluginMethod(name: "getAppState", returnType: CAPPluginReturnPromise), CAPPluginMethod(name: "getAppInfo", returnType: CAPPluginReturnPromise), CAPPluginMethod(name: "shareReplay", returnType: CAPPluginReturnPromise)]
    private var activeShare = false
    // Notification handling and snapshots both run on the main thread. A
    // foreground poll can thus detect a complete inactive/active cycle that
    // happened while WebKit timers were suspended.
    private var lifecycle = LifelineLifecycleCounter()
    private var lifecycleObservers: [NSObjectProtocol] = []
    override func load() {
        for name in [UIApplication.didBecomeActiveNotification, UIApplication.willResignActiveNotification] {
            lifecycleObservers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] notification in
                guard let self = self else { return }
                self.lifecycle.transition(inactive: notification.name == UIApplication.willResignActiveNotification)
            })
        }
    }
    deinit { for observer in lifecycleObservers { NotificationCenter.default.removeObserver(observer) } }
    @objc func getAppState(_ call: CAPPluginCall) {
        guard let lease = call.options["documentLease"] as? [String: Any], LifelineStore.shared.isCurrentDocument(lease) else { call.reject("Document changed."); return }
        DispatchQueue.main.async { [weak self] in
            guard let self = self, LifelineStore.shared.isCurrentDocument(lease) else { call.reject("Document changed."); return }
            call.resolve(["isActive": UIApplication.shared.applicationState == .active,
                          "transitionRevision": self.lifecycle.transitionRevision, "lastInactiveRevision": self.lifecycle.lastInactiveRevision])
        }
    }
    @objc func getAppInfo(_ call: CAPPluginCall) {
        call.resolve(["version": Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "", "build": Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? ""])
    }
    private func shareFile(_ data: Data) throws -> URL {
        guard let base = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first else { throw LifelineStoreError.unavailable }
        let directory = base.appendingPathComponent("lifeline-replay-share", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let now = Date()
        let keys: Set<URLResourceKey> = [.creationDateKey, .fileSizeKey, .isRegularFileKey]
        var files: [(URL, Date, Int)] = []
        for url in try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: Array(keys)) {
            guard url.lastPathComponent.hasPrefix("replay-"), url.pathExtension == "json" else { continue }
            let values = try url.resourceValues(forKeys: keys)
            guard values.isRegularFile == true, let date = values.creationDate, let size = values.fileSize else { throw LifelineStoreError.unavailable }
            if now.timeIntervalSince(date) > 24 * 3600 { try FileManager.default.removeItem(at: url) }
            else { files.append((url, date, size)) }
        }
        files.sort { $0.1 < $1.1 }
        var total = files.reduce(0) { $0 + $1.2 }
        while files.count >= 32 || total + data.count > 128 * 1024 * 1024 {
            guard let first = files.first, now.timeIntervalSince(first.1) >= 3600 else { throw LifelineStoreError.unavailable }
            try FileManager.default.removeItem(at: first.0); total -= first.2; files.removeFirst()
        }
        let url = directory.appendingPathComponent("replay-\(UUID().uuidString).json")
        try data.write(to: url, options: .atomic)
        return url
    }
    @objc func shareReplay(_ call: CAPPluginCall) {
        guard let lease = call.options["documentLease"] as? [String: Any], LifelineStore.shared.isCurrentDocument(lease), let document = call.options["replayDocument"] as? [String: Any], document["format"] as? String == "lifeline-replay", document["schemaVersion"] as? Int == 1,
              let data = try? JSONSerialization.data(withJSONObject: document), data.count <= 4_000_000 else { call.reject("Invalid replay document."); return }
        let epoch = LifelineStore.shared.currentEpoch()
        DispatchQueue.main.async { [weak self] in
            guard let self = self, LifelineStore.shared.isCurrentDocument(lease), !self.activeShare, epoch == LifelineStore.shared.currentEpoch(),
                  UIApplication.shared.applicationState == .active, let presenter = self.bridge?.viewController,
                  presenter.presentedViewController == nil else { call.reject("Share unavailable or busy."); return }
            self.activeShare = true
            do {
                let url = try self.shareFile(data)
                let sheet = UIActivityViewController(activityItems: [url], applicationActivities: nil)
                if let popover = sheet.popoverPresentationController { popover.sourceView = presenter.view; popover.sourceRect = CGRect(x: presenter.view.bounds.midX, y: presenter.view.bounds.midY, width: 1, height: 1) }
                sheet.completionWithItemsHandler = { [weak self] _, completed, _, _ in
                    self?.activeShare = false
                    if !completed { try? FileManager.default.removeItem(at: url) }
                    // Keep completed exports for at least an hour for receiving extensions.
                    if epoch == LifelineStore.shared.currentEpoch() { call.resolve(["status": completed ? "returned" : "cancelled"]) }
                }
                presenter.present(sheet, animated: true)
            } catch { self.activeShare = false; call.reject("Share preparation failed.") }
        }
    }
}
