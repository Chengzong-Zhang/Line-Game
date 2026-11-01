import UIKit
import WebKit
import UniformTypeIdentifiers
import Capacitor

@objc(LifelineReplayImportPlugin)
final class LifelineReplayImportPlugin: CAPPlugin, CAPBridgedPlugin, UIDocumentPickerDelegate {
    let identifier = "LifelineReplayImportPlugin"
    let jsName = "LifelineReplayImport"
    let pluginMethods = [CAPPluginMethod(name: "selectReplay", returnType: CAPPluginReturnPromise)]
    private var pending: CAPPluginCall?
    private var pendingEpoch = 0
    @objc func selectReplay(_ call: CAPPluginCall) {
        guard let lease = call.options["documentLease"] as? [String: Any], LifelineStore.shared.isCurrentDocument(lease) else { call.reject("Document changed."); return }
        let epoch = LifelineStore.shared.currentEpoch()
        DispatchQueue.main.async { [weak self] in
            guard let self = self, LifelineStore.shared.isCurrentDocument(lease), self.pending == nil, let presenter = self.bridge?.viewController,
                  presenter.presentedViewController == nil, UIApplication.shared.applicationState == .active,
                  epoch == LifelineStore.shared.currentEpoch() else { call.reject("Replay picker unavailable or busy.", "busy"); return }
            self.pending = call; self.pendingEpoch = epoch
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.json], asCopy: false)
            picker.allowsMultipleSelection = false; picker.delegate = self
            presenter.present(picker, animated: true)
        }
    }
    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        let call = pending; pending = nil
        if pendingEpoch == LifelineStore.shared.currentEpoch() { call?.resolve(["status": "cancelled"]) }
    }
    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard let call = pending else { return }; pending = nil
        guard pendingEpoch == LifelineStore.shared.currentEpoch() else { return }
        guard urls.count == 1, let url = urls.first else { call.resolve(["status": "cancelled"]); return }
        let access = url.startAccessingSecurityScopedResource()
        defer { if access { url.stopAccessingSecurityScopedResource() } }
        do {
            var readError: NSError?
            var bytes: Data?
            var ioError: Error?
            NSFileCoordinator().coordinate(readingItemAt: url, options: [], error: &readError) { coordinatedURL in
                do {
                    let file = try FileHandle(forReadingFrom: coordinatedURL)
                    defer { try? file.close() }
                    var result = Data()
                    while result.count <= 4_000_000 {
                        let chunk = try file.read(upToCount: min(65536, 4_000_001 - result.count)) ?? Data()
                        if chunk.isEmpty { break }
                        result.append(chunk)
                    }
                    bytes = result
                } catch { ioError = error }
            }
            guard readError == nil, ioError == nil, let data = bytes else { throw LifelineStoreError.unavailable }
            if data.count > 4_000_000 { call.resolve(["status": "too-large"]); return }
            guard let text = String(data: data, encoding: .utf8),
                  (try JSONSerialization.jsonObject(with: data)) is [String: Any] else { throw LifelineStoreError.invalid }
            guard pendingEpoch == LifelineStore.shared.currentEpoch() else { return }
            call.resolve(["status": "selected", "text": text])
        } catch { call.reject("Replay file could not be read.") }
    }
}

// A separate non-persistent WKWebView, with no Capacitor bridge and no network.
private final class TutorialAssets: NSObject, WKURLSchemeHandler {
    private let root: URL
    init?(root: URL?) { guard let root = root else { return nil }; self.root = root.standardizedFileURL.resolvingSymlinksInPath() }
    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url, url.scheme == "lifeline-tutorial", url.host == "localhost",
              url.user == nil, url.password == nil, url.port == nil else { task.didFailWithError(LifelineStoreError.invalid); return }
        let path = url.path == "/" ? "/index.html" : url.path
        guard !path.contains(".."), !path.contains("\\") else { task.didFailWithError(LifelineStoreError.invalid); return }
        let asset = root.appendingPathComponent(String(path.dropFirst())).standardizedFileURL.resolvingSymlinksInPath()
        guard asset.path.hasPrefix(root.path + "/") else { task.didFailWithError(LifelineStoreError.invalid); return }
        do {
            var data = try Data(contentsOf: asset)
            let ext = asset.pathExtension.lowercased()
            let types = ["html": "text/html", "js": "application/javascript", "mjs": "application/javascript", "css": "text/css", "json": "application/json", "wasm": "application/wasm", "svg": "image/svg+xml", "png": "image/png", "jpg": "image/jpeg", "webp": "image/webp", "woff2": "font/woff2", "woff": "font/woff"]
            let mime = types[ext] ?? "application/octet-stream"
            if path == "/index.html" {
                guard var html = String(data: data, encoding: .utf8), let head = html.range(of: "<head>", options: .caseInsensitive) else { throw LifelineStoreError.invalid }
                html.insert(contentsOf: "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'self' data: blob:; connect-src 'none'; frame-src 'none'; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; style-src 'self' 'unsafe-inline'\">", at: head.upperBound)
                data = Data(html.utf8)
            }
            task.didReceive(URLResponse(url: url, mimeType: mime, expectedContentLength: data.count, textEncodingName: nil))
            task.didReceive(data); task.didFinish()
        } catch { task.didFailWithError(error) }
    }
    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}

private final class TutorialController: UIViewController, WKNavigationDelegate {
    let assets: TutorialAssets
    let page: URL
    private var invalidation: NSObjectProtocol?
    init(assets: TutorialAssets, page: URL) { self.assets = assets; self.page = page; super.init(nibName: nil, bundle: nil) }
    required init?(coder: NSCoder) { nil }
    override func viewDidLoad() {
        super.viewDidLoad()
        invalidation = NotificationCenter.default.addObserver(forName: .lifelineDocumentInvalidated, object: nil, queue: .main) { [weak self] _ in self?.dismiss(animated: true) }
        view.backgroundColor = .systemBackground
        let close = UIButton(type: .system); close.setTitle("完成教学 / Close tutorial", for: .normal)
        close.addTarget(self, action: #selector(dismissTutorial), for: .touchUpInside)
        let config = WKWebViewConfiguration(); config.websiteDataStore = .nonPersistent(); config.setURLSchemeHandler(assets, forURLScheme: "lifeline-tutorial")
        let web = WKWebView(frame: .zero, configuration: config); web.navigationDelegate = self
        let stack = UIStackView(arrangedSubviews: [close, web]); stack.axis = .vertical; stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([stack.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor), stack.bottomAnchor.constraint(equalTo: view.bottomAnchor), stack.leadingAnchor.constraint(equalTo: view.leadingAnchor), stack.trailingAnchor.constraint(equalTo: view.trailingAnchor)])
        web.load(URLRequest(url: page))
    }
    deinit { if let invalidation = invalidation { NotificationCenter.default.removeObserver(invalidation) } }
    @objc private func dismissTutorial() { dismiss(animated: true) }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        decisionHandler(navigationAction.targetFrame?.isMainFrame == true && navigationAction.request.url == page ? .allow : .cancel)
    }
}

@objc(LifelineTutorialHostPlugin)
final class LifelineTutorialHostPlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "LifelineTutorialHostPlugin"
    let jsName = "LifelineTutorialHost"
    let pluginMethods = [CAPPluginMethod(name: "openTutorial", returnType: CAPPluginReturnPromise)]
    @objc func openTutorial(_ call: CAPPluginCall) {
        guard let lease = call.options["documentLease"] as? [String: Any], LifelineStore.shared.isCurrentDocument(lease), let input = call.getString("url"), let parts = URLComponents(string: input),
              let local = bridge?.config.localURL, parts.scheme == local.scheme, parts.host == local.host,
              parts.port == local.port, parts.user == nil, parts.password == nil, parts.fragment == nil,
              ["/", "/index.html"].contains(parts.path), parts.queryItems?.count == 1,
              parts.queryItems?.first?.name == "tutorial", parts.queryItems?.first?.value == "1",
              let page = URL(string: "lifeline-tutorial://localhost/index.html?tutorial=1"),
              let assets = TutorialAssets(root: Bundle.main.resourceURL?.appendingPathComponent("public", isDirectory: true)) else { call.reject("Invalid tutorial URL."); return }
        let epoch = LifelineStore.shared.currentEpoch()
        DispatchQueue.main.async { [weak self] in
            guard let self = self, LifelineStore.shared.isCurrentDocument(lease), epoch == LifelineStore.shared.currentEpoch(), UIApplication.shared.applicationState == .active,
                  let presenter = self.bridge?.viewController, presenter.presentedViewController == nil else { call.reject("Tutorial unavailable or busy."); return }
            let tutorial = TutorialController(assets: assets, page: page)
            tutorial.modalPresentationStyle = .fullScreen
            presenter.present(tutorial, animated: true) {
                if LifelineStore.shared.isCurrentDocument(lease) { call.resolve(["status": "opened"]) }
            }
        }
    }
}
