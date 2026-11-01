import Foundation
import Security

enum LifelineStoreError: Error { case invalid, unavailable, unconfirmed, recovery, stale }

// Caller serializes access (the iOS plugin uses the main queue).
struct LifelineLifecycleCounter {
    private(set) var transitionRevision = 0
    private(set) var lastInactiveRevision = 0
    mutating func transition(inactive: Bool) {
        transitionRevision += 1
        if inactive { lastInactiveRevision = transitionRevision }
    }
}

protocol LifelineCredentialBackend {
    func read(_ account: String) throws -> Data?
    func write(_ account: String, _ data: Data) throws
    func remove(_ account: String) throws
}

struct LifelineKeychainBackend: LifelineCredentialBackend {
    private let service = "cn.lifelinegame.mobile.credentials.v1"
    private func query(_ account: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
         kSecAttrAccount as String: account]
    }
    func read(_ account: String) throws -> Data? {
        var q = query(account)
        q[kSecReturnData as String] = true; q[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data, data.count <= 65536 else { throw LifelineStoreError.unavailable }
        return data
    }
    func write(_ account: String, _ data: Data) throws {
        let q = query(account)
        var status = SecItemUpdate(q as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecItemNotFound {
            var add = q; add[kSecValueData as String] = data
            add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            status = SecItemAdd(add as CFDictionary, nil)
        }
        guard status == errSecSuccess, try read(account) == data else { throw LifelineStoreError.unconfirmed }
    }
    func remove(_ account: String) throws {
        let status = SecItemDelete(query(account) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw LifelineStoreError.unavailable }
        guard try read(account) == nil else { throw LifelineStoreError.unconfirmed }
    }
}

// All credential operations and document lease transitions share this lock.
final class LifelineStore {
    static let shared = LifelineStore()
    private let backend: LifelineCredentialBackend
    private let testDirectory: URL?
    init(backend: LifelineCredentialBackend = LifelineKeychainBackend(), directory: URL? = nil) {
        self.backend = backend; self.testDirectory = directory
    }
    private let lock = NSRecursiveLock()
    private var epoch = 0
    private var owner = 0
    private var nonce = ""
    private var recoveryRequired = false
    private var sessionRecovery = Set<String>()
    private let keys: [String: String] = [
        "lifeline-local-game-session-v1": "session.json",
        "lifeline-topology-local-game-session-v1": "topology-session.json"
    ]

    func rotateDocument() {
        lock.lock()
        epoch += 1; owner += 1; nonce = ""
        var bytes = [UInt8](repeating: 0, count: 24)
        if SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess {
            nonce = Data(bytes).base64EncodedString()
        }
        lock.unlock()
        NotificationCenter.default.post(name: .lifelineDocumentInvalidated, object: nil)
    }
    func invalidateDocument() {
        lock.lock()
        epoch += 1; owner += 1; nonce = ""
        lock.unlock()
        NotificationCenter.default.post(name: .lifelineDocumentInvalidated, object: nil)
    }
    func currentEpoch() -> Int { lock.lock(); defer { lock.unlock() }; return epoch }
    func documentLease(epoch expectedEpoch: Int) throws -> [String: Any] {
        lock.lock(); defer { lock.unlock() }
        guard !nonce.isEmpty, epoch == expectedEpoch else { throw LifelineStoreError.stale }
        return ["pageEpoch": epoch, "documentNonce": nonce]
    }
    private func checkDocument(_ lease: [String: Any]) throws {
        guard lease.count == 2, let e = lease["pageEpoch"] as? Int,
              let n = lease["documentNonce"] as? String,
              !nonce.isEmpty, e == epoch, n == nonce else { throw LifelineStoreError.stale }
    }
    // Holding the same recursive lock across lease validation and I/O prevents
    // navigation from rotating a document while a native operation commits.
    func withDocument<T>(_ lease: [String: Any], _ action: () throws -> T) throws -> T {
        lock.lock(); defer { lock.unlock() }
        try checkDocument(lease)
        return try action()
    }
    func isCurrentDocument(_ lease: [String: Any]) -> Bool {
        (try? withDocument(lease) { true }) == true
    }
    func claim(expected: Int, epoch expectedEpoch: Int) throws -> [String: Any] {
        lock.lock(); defer { lock.unlock() }
        guard !nonce.isEmpty, epoch == expectedEpoch, expected == -1 || expected == owner else { throw LifelineStoreError.stale }
        owner += 1
        return ["pageEpoch": epoch, "ownerGeneration": owner, "documentNonce": nonce]
    }
    private func check(_ lease: [String: Any]) throws {
        guard let e = lease["pageEpoch"] as? Int, let o = lease["ownerGeneration"] as? Int,
              let n = lease["documentNonce"] as? String, !nonce.isEmpty,
              e == epoch, o == owner, n == nonce else { throw LifelineStoreError.stale }
    }

    private func barrier(_ text: String) throws { try backend.write("barrier", Data(text.utf8)) }
    private func validateCredential(_ credential: [String: Any]) throws {
        guard credential.count == 2, let token = credential["token"] as? String,
              let username = credential["username"] as? String,
              !token.isEmpty, token.utf16.count <= 16384,
              !username.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              username.unicodeScalars.count <= 50 else { throw LifelineStoreError.invalid }
    }
    func loadCredential(_ lease: [String: Any]) throws -> [String: Any] {
        lock.lock(); defer { lock.unlock() }
        try check(lease)
        guard !recoveryRequired else { throw LifelineStoreError.recovery }
        let barrierData = try backend.read("barrier")
        let state = barrierData.flatMap { String(data: $0, encoding: .utf8) }
        if barrierData != nil && state == nil { throw LifelineStoreError.recovery }
        if state == "cleared" { return ["state": "cleared"] }
        guard state == nil || state == "present" else { throw LifelineStoreError.recovery }
        guard let data = try backend.read("credential") else {
            if state == "present" { throw LifelineStoreError.recovery }
            return ["state": "missing"]
        }
        // A record without an explicit confirmed barrier must never be exposed.
        guard state == "present", let value = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw LifelineStoreError.recovery }
        try validateCredential(value); try check(lease)
        return ["state": "present", "credential": value]
    }
    func saveCredential(_ lease: [String: Any], value: [String: Any]) throws {
        lock.lock(); defer { lock.unlock() }
        try check(lease); try validateCredential(value)
        guard !recoveryRequired else { throw LifelineStoreError.recovery }
        let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
        do {
            try barrier("pending")
            try backend.write("credential", data)
            try barrier("present")
        } catch {
            recoveryRequired = true
            try? barrier("pending")
            throw error
        }
    }
    func clearCredential(_ lease: [String: Any]) throws {
        lock.lock(); defer { lock.unlock() }
        try check(lease)
        do { try barrier("cleared"); try backend.remove("credential"); recoveryRequired = false }
        catch { recoveryRequired = true; try? barrier("pending"); throw error }
    }
    private func file(_ key: String) throws -> URL {
        guard let name = keys[key], let base = testDirectory ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else { throw LifelineStoreError.invalid }
        let dir = base.appendingPathComponent("lifeline-session", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent(name, isDirectory: false)
    }
    private func readFile(_ url: URL) throws -> Data? {
        do { return try Data(contentsOf: url) }
        catch {
            let ns = error as NSError
            if ns.domain == NSCocoaErrorDomain && ns.code == NSFileReadNoSuchFileError { return nil }
            throw error
        }
    }
    private func writeFile(_ url: URL, _ data: Data) throws {
        try data.write(to: url, options: .atomic)
        guard try readFile(url) == data else { throw LifelineStoreError.unconfirmed }
    }
    private func isClearEnvelope(_ data: Data, resetRevision: Bool = false) -> Bool {
        guard let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              Set(object.keys) == Set(["format", "version", "revision", "state"]),
              object["format"] as? String == "lifeline-local-session-envelope",
              object["version"] as? Int == 1, object["state"] as? String == "cleared",
              let revision = object["revision"] as? Int,
              revision >= 1, revision <= 9_007_199_254_740_991 else { return false }
        return !resetRevision || revision == 1
    }
    func sessionRecoveryStatus(_ key: String) throws -> String {
        lock.lock(); defer { lock.unlock() }
        let url = try file(key)
        if sessionRecovery.contains(key) { return "blocked" }
        let barrier = try readFile(url.appendingPathExtension("barrier"))
        if let barrier = barrier, barrier != Data("present".utf8) { return "blocked" }
        if barrier != nil { if try readFile(url) == nil { return "blocked" } }
        return "ready"
    }
    func resolveSessionRecovery(_ key: String, value: String) throws {
        lock.lock(); defer { lock.unlock() }
        guard isClearEnvelope(Data(value.utf8), resetRevision: true) else { throw LifelineStoreError.invalid }
        // Caller first persists its own per-key recovery marker and identical clear.
        // This explicit operation deliberately supersedes both versions of this key.
        try saveRecord(key, value: value)
    }
    func loadRecord(_ key: String) throws -> String? {
        lock.lock(); defer { lock.unlock() }
        let url = try file(key)
        guard !sessionRecovery.contains(key) else { throw LifelineStoreError.recovery }
        let state = try readFile(url.appendingPathExtension("barrier"))
        guard state == nil || state == Data("present".utf8) else { throw LifelineStoreError.recovery }
        guard let data = try readFile(url) else {
            if state != nil { throw LifelineStoreError.recovery }
            return nil
        }
        guard data.count <= 5_000_000, let value = String(data: data, encoding: .utf8) else { throw LifelineStoreError.invalid }
        return value
    }
    func saveRecord(_ key: String, value: String) throws {
        lock.lock(); defer { lock.unlock() }
        let data = Data(value.utf8)
        guard data.count <= 5_000_000 else { throw LifelineStoreError.invalid }
        let url = try file(key)
        let stateURL = url.appendingPathExtension("barrier")
        let isExplicitClear = value == "__LIFELINE_CLEARED_V1__" || isClearEnvelope(data)
        guard !sessionRecovery.contains(key) || isExplicitClear else { throw LifelineStoreError.recovery }
        if let state = try readFile(stateURL), state != Data("present".utf8), !isExplicitClear { throw LifelineStoreError.recovery }
        do {
            try writeFile(stateURL, Data("pending".utf8))
            try writeFile(url, data)
            try writeFile(stateURL, Data("present".utf8))
            sessionRecovery.remove(key)
        } catch {
            sessionRecovery.insert(key)
            try? writeFile(stateURL, Data("pending".utf8))
            throw error
        }
    }
}

extension Notification.Name {
    static let lifelineDocumentInvalidated = Notification.Name("lifeline.native.document.invalidated")
}
