import XCTest
@testable import LifelineStore

private final class FaultBackend: LifelineCredentialBackend {
    var records: [String: Data] = [:]
    var writes = 0
    var failWrite: Int?
    var failAfterWrite: Int?
    func read(_ account: String) throws -> Data? { records[account] }
    func write(_ account: String, _ data: Data) throws {
        writes += 1
        if writes == failWrite { throw LifelineStoreError.unavailable }
        records[account] = data
        if writes == failAfterWrite { throw LifelineStoreError.unconfirmed }
    }
    func remove(_ account: String) throws { records.removeValue(forKey: account) }
}

final class LifelineStoreTests: XCTestCase {
    private let credential: [String: Any] = ["username": "synthetic", "token": "test-only-token"]
    func testLifecycleCounterExposesInactiveBetweenForegroundSnapshots() {
        var lifecycle = LifelineLifecycleCounter()
        let previous = lifecycle.transitionRevision
        lifecycle.transition(inactive: true)
        lifecycle.transition(inactive: false)
        XCTAssertEqual(lifecycle.transitionRevision, 2)
        XCTAssertGreaterThan(lifecycle.lastInactiveRevision, previous)
        XCTAssertLessThan(lifecycle.lastInactiveRevision, lifecycle.transitionRevision)
    }
    private func lease(_ store: LifelineStore) throws -> [String: Any] {
        store.rotateDocument()
        return try store.claim(expected: -1, epoch: store.currentEpoch())
    }
    func testPendingAtEachCommitFailureRequiresExplicitClear() throws {
        for step in 1...3 {
            let backend = FaultBackend(); let store = LifelineStore(backend: backend)
            let owner = try lease(store)
            backend.failWrite = step
            XCTAssertThrowsError(try store.saveCredential(owner, value: credential))
            XCTAssertThrowsError(try store.loadCredential(owner))
            XCTAssertThrowsError(try store.saveCredential(owner, value: credential))
            backend.failWrite = nil
            try store.clearCredential(owner)
            XCTAssertEqual(try store.loadCredential(owner)["state"] as? String, "cleared")
            XCTAssertNil(backend.records["credential"])
            try store.saveCredential(owner, value: credential)
            XCTAssertEqual(try store.loadCredential(owner)["state"] as? String, "present")
        }
    }
    func testFinalWriteReadbackFailureAndProcessRestart() throws {
        let backend = FaultBackend(); let store = LifelineStore(backend: backend)
        let owner = try lease(store); backend.failAfterWrite = 3
        XCTAssertThrowsError(try store.saveCredential(owner, value: credential))
        XCTAssertThrowsError(try store.loadCredential(owner))
        let restarted = LifelineStore(backend: backend); let next = try lease(restarted)
        XCTAssertThrowsError(try restarted.loadCredential(next))
        backend.failAfterWrite = nil
        try restarted.clearCredential(next)
        XCTAssertEqual(try restarted.loadCredential(next)["state"] as? String, "cleared")
    }
    func testLeaseRotationRejectsOldOwnerAndCapturedEpoch() throws {
        let store = LifelineStore(backend: FaultBackend())
        let first = try lease(store); let oldEpoch = store.currentEpoch()
        let document = try store.documentLease(epoch: oldEpoch)
        _ = try store.claim(expected: first["ownerGeneration"] as! Int, epoch: oldEpoch)
        XCTAssertNoThrow(try store.withDocument(document) { 1 })
        store.rotateDocument()
        XCTAssertThrowsError(try store.loadCredential(first))
        XCTAssertThrowsError(try store.claim(expected: -1, epoch: oldEpoch))
        XCTAssertThrowsError(try store.withDocument(document) { try store.loadRecord("lifeline-local-game-session-v1") })
        XCTAssertThrowsError(try store.withDocument(document) { try store.saveRecord("lifeline-local-game-session-v1", value: "stale") })
        XCTAssertThrowsError(try store.withDocument(document) { try store.resolveSessionRecovery("lifeline-local-game-session-v1", value: #"{"format":"lifeline-local-session-envelope","version":1,"revision":1,"state":"cleared"}"#) })
    }
    func testTwoSessionKeysAndTombstoneStaySeparate() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: dir) }
        let store = LifelineStore(backend: FaultBackend(), directory: dir)
        let ordinary = "lifeline-local-game-session-v1", topology = "lifeline-topology-local-game-session-v1"
        let saved = #"{"format":"lifeline-local-session-envelope","version":1,"revision":1,"state":"saved","payload":"state"}"#
        let cleared = #"{"format":"lifeline-local-session-envelope","version":1,"revision":2,"state":"cleared"}"#
        try store.saveRecord(ordinary, value: saved); try store.saveRecord(topology, value: cleared)
        XCTAssertEqual(try store.loadRecord(ordinary), saved); XCTAssertEqual(try store.loadRecord(topology), cleared)
        XCTAssertThrowsError(try store.saveRecord("unexpected", value: saved))
    }
    func testUnconfirmedCredentialWithoutBarrierFailsClosed() throws {
        let backend = FaultBackend(); backend.records["credential"] = Data(#"{"token":"t","username":"u"}"#.utf8)
        let store = LifelineStore(backend: backend); let owner = try lease(store)
        XCTAssertThrowsError(try store.loadCredential(owner))
        backend.records["barrier"] = Data([0xff])
        XCTAssertThrowsError(try store.loadCredential(owner))
    }
    func testInterruptedSessionCannotBeReadOrOverwrittenUntilClear() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: dir) }
        let key = "lifeline-local-game-session-v1"
        let first = LifelineStore(backend: FaultBackend(), directory: dir)
        try first.saveRecord(key, value: "old")
        let barrier = dir.appendingPathComponent("lifeline-session/session.json.barrier")
        try Data("pending".utf8).write(to: barrier, options: .atomic)
        let restarted = LifelineStore(backend: FaultBackend(), directory: dir)
        XCTAssertThrowsError(try restarted.loadRecord(key))
        XCTAssertThrowsError(try restarted.saveRecord(key, value: "unconfirmed"))
        let cleared = #"{"format":"lifeline-local-session-envelope","version":1,"revision":2,"state":"cleared"}"#
        try restarted.saveRecord(key, value: cleared)
        XCTAssertEqual(try restarted.loadRecord(key), cleared)
    }
    func testExplicitRecoveryClearsOnlySelectedKeyAndRejectsSavedOrInvalidValues() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: dir) }
        let store = LifelineStore(backend: FaultBackend(), directory: dir)
        let ordinary = "lifeline-local-game-session-v1", topology = "lifeline-topology-local-game-session-v1"
        try store.saveRecord(ordinary, value: "old ordinary")
        try store.saveRecord(topology, value: "old topology")
        try Data("pending".utf8).write(to: dir.appendingPathComponent("lifeline-session/session.json.barrier"), options: .atomic)
        XCTAssertEqual(try store.sessionRecoveryStatus(ordinary), "blocked")
        XCTAssertEqual(try store.sessionRecoveryStatus(topology), "ready")
        XCTAssertThrowsError(try store.resolveSessionRecovery(ordinary, value: "old ordinary"))
        let cleared = #"{"format":"lifeline-local-session-envelope","version":1,"revision":1,"state":"cleared"}"#
        try store.resolveSessionRecovery(ordinary, value: cleared)
        XCTAssertEqual(try store.loadRecord(ordinary), cleared)
        XCTAssertEqual(try store.loadRecord(topology), "old topology")
        XCTAssertThrowsError(try store.resolveSessionRecovery("unsupported", value: cleared))
    }
}
