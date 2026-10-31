const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { ACHIEVEMENTS, CHALLENGE_IDS, createAchievementService, createQueueStore, deriveUnlocked } = require("../src/achievement-store.cjs");

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lifeline-achievement-test-"));
  t.after(() => {
    const resolved = path.resolve(directory);
    if (path.basename(resolved).startsWith("lifeline-achievement-test-")
      && resolved.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`)) fs.rmSync(resolved, { recursive: true, force: true });
  });
  return directory;
}

test("five milestone rules derive from known distinct saved progress only", () => {
  assert.equal(ACHIEVEMENTS.length, 5);
  assert.equal(CHALLENGE_IDS.length, 24);
  assert.equal(new Set(CHALLENGE_IDS).size, 24);
  assert.deepEqual([...deriveUnlocked({ tutorialComplete: false, completedChallenges: ["not-a-challenge"] })], []);
  const atSix = deriveUnlocked({ tutorialComplete: true, completedChallenges: [...CHALLENGE_IDS.slice(0, 6), CHALLENGE_IDS[0], "fake"] });
  assert.deepEqual([...atSix], ["tutorial-complete", "challenge-first", "challenge-6"]);
  const all = deriveUnlocked({ tutorialComplete: false, completedChallenges: CHALLENGE_IDS });
  assert.equal(all.size, 4);
  assert.equal(all.has("challenge-24"), true);
});

test("service reads saved healthy profile, adds milestones idempotently, and keeps Steam unconfigured", (t) => {
  const directory = fixture(t);
  const progress = { tutorialComplete: true, completedChallenges: CHALLENGE_IDS.slice(0, 6) };
  const profileStore = { read: () => ({ ok: true, status: "saved", value: JSON.stringify({ progress }) }) };
  const steam = { status: () => ({ available: false, configured: false, reason: "steamworks-account-and-app-id-not-configured" }) };
  const service = createAchievementService(directory, profileStore, steam);
  const first = service.read("renderer-supplied-id");
  assert.equal(first.ok, true);
  assert.equal(first.pendingCount, 3);
  assert.equal(first.steam.configured, false);
  assert.deepEqual(first.achievements.filter((item) => item.unlocked).map((item) => item.id), ["tutorial-complete", "challenge-first", "challenge-6"]);
  assert.equal(service.read().pendingCount, 3, "reading again must not duplicate pending items");
  assert.equal(fs.existsSync(path.join(directory, "achievements", "pending.json")), true);
});

test("unhealthy or unsupported saved progress cannot unlock or queue achievements", (t) => {
  const directory = fixture(t);
  const queue = createQueueStore(directory);
  const service = createAchievementService(directory,
    { read: () => ({ ok: false, status: "unsupported-version", value: JSON.stringify({ progress: { tutorialComplete: true, completedChallenges: CHALLENGE_IDS } }) }) },
    { status: () => ({ available: false, configured: false }) });
  const result = service.read();
  assert.equal(result.ok, false);
  assert.equal(result.status, "unsupported-version");
  assert.deepEqual(result.achievements, []);
  assert.equal(queue.read().status, "empty");
});

test("queue accepts only known achievement ids and recovers its atomic backup", (t) => {
  const directory = fixture(t);
  const queue = createQueueStore(directory);
  assert.equal(queue.merge(["renderer-supplied-id"]).status, "invalid-achievement");
  assert.deepEqual(queue.merge(["tutorial-complete"]).pendingIds, ["tutorial-complete"]);
  assert.deepEqual(queue.merge(["challenge-first"]).pendingIds, ["tutorial-complete", "challenge-first"]);
  fs.writeFileSync(queue.paths.file, "{broken", "utf8");
  const recovered = queue.read();
  assert.equal(recovered.status, "recovered-backup");
  assert.deepEqual(recovered.pendingIds, ["tutorial-complete"]);
  assert.ok(fs.readdirSync(path.dirname(queue.paths.file)).some((name) => name.includes("pending.json.corrupt-")));
});

test("corrupt current queue is reconciled with its valid backup during service read", (t) => {
  const directory = fixture(t);
  const queue = createQueueStore(directory);
  queue.merge(["challenge-first"]);
  queue.merge(["challenge-6"]);
  fs.writeFileSync(queue.paths.file, "{broken", "utf8");
  const service = createAchievementService(directory,
    { read: () => ({ ok: true, status: "saved", value: JSON.stringify({ progress: { tutorialComplete: true, completedChallenges: [] } }) }) },
    { status: () => ({ available: false, configured: false }) });
  const result = service.read();
  assert.equal(result.ok, true);
  assert.deepEqual(queue.read().pendingIds, ["challenge-first", "tutorial-complete"]);
  assert.ok(fs.readdirSync(path.dirname(queue.paths.file)).some((name) => name.includes("pending.json.corrupt-")));
});

test("a corrupt queue without a valid backup is quarantined and writes pause", (t) => {
  const directory = fixture(t);
  const queue = createQueueStore(directory);
  fs.mkdirSync(path.dirname(queue.paths.file), { recursive: true });
  fs.writeFileSync(queue.paths.file, "{broken", "utf8");
  assert.equal(queue.merge(["tutorial-complete"]).status, "corrupt-quarantined");
  assert.equal(queue.merge(["tutorial-complete"]).status, "corrupt-quarantined");
  assert.ok(fs.readdirSync(path.dirname(queue.paths.file)).some((name) => name.includes("pending.json.corrupt-")));
  const reopened = createQueueStore(directory);
  assert.equal(reopened.read().status, "corrupt-quarantined");
  assert.equal(reopened.merge(["tutorial-complete"]).status, "corrupt-quarantined");
});

test("a future queue version remains untouched and blocks writes", (t) => {
  const directory = fixture(t);
  const queue = createQueueStore(directory);
  fs.mkdirSync(path.dirname(queue.paths.file), { recursive: true });
  const future = JSON.stringify({ format: "lifeline-achievement-envelope", schemaVersion: 2, payload: { schemaVersion: 2 } });
  fs.writeFileSync(queue.paths.file, future, "utf8");
  assert.equal(queue.read().status, "unsupported-version");
  assert.equal(queue.merge(["tutorial-complete"]).status, "unsupported-version");
  assert.equal(fs.readFileSync(queue.paths.file, "utf8"), future);
});

test("valid current queue plus future backup blocks merge without changing either file", (t) => {
  const directory = fixture(t);
  const queue = createQueueStore(directory);
  queue.merge(["tutorial-complete"]);
  const current = fs.readFileSync(queue.paths.file);
  const future = JSON.stringify({ format: "lifeline-achievement-envelope", schemaVersion: 2, payload: { schemaVersion: 2 } });
  fs.writeFileSync(queue.paths.backup, future, "utf8");
  assert.equal(queue.merge(["challenge-first"]).status, "unsupported-backup-version");
  assert.deepEqual(fs.readFileSync(queue.paths.file), current);
  assert.equal(fs.readFileSync(queue.paths.backup, "utf8"), future);
});

test("queue payload must carry the exact current schema version", (t) => {
  for (const payloadVersion of [undefined, 0]) {
    const directory = fixture(t);
    const queue = createQueueStore(directory);
    queue.merge(["tutorial-complete"]);
    const envelope = JSON.parse(fs.readFileSync(queue.paths.file, "utf8"));
    if (payloadVersion === undefined) delete envelope.payload.schemaVersion;
    else envelope.payload.schemaVersion = payloadVersion;
    fs.writeFileSync(queue.paths.file, JSON.stringify(envelope), "utf8");
    assert.equal(queue.read().status, "corrupt-quarantined");
  }
});

test("failed atomic queue write preserves current bytes and can be retried", (t) => {
  const directory = fixture(t);
  const file = path.join(directory, "achievements", "pending.json");
  let fail = true;
  const writeFile = (target, contents) => {
    if (fail && target === file) throw new Error("injected disk failure");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents, "utf8");
  };
  const queue = createQueueStore(directory, { atomicWrite: writeFile });
  // Seed with a normal store, then use the failing writer against the same files.
  createQueueStore(directory).merge(["tutorial-complete"]);
  const before = fs.readFileSync(file);
  assert.equal(queue.merge(["challenge-first"]).status, "write-failed");
  assert.deepEqual(fs.readFileSync(file), before);
  fail = false;
  assert.deepEqual(queue.merge(["challenge-first"]).pendingIds, ["tutorial-complete", "challenge-first"]);
});

test("untrusted renderer arguments cannot create unlocked achievements", (t) => {
  const directory = fixture(t);
  const service = createAchievementService(directory,
    { read: () => ({ ok: true, status: "empty", value: JSON.stringify({ progress: { tutorialComplete: false, completedChallenges: [] } }) }) },
    { status: () => ({ available: false, configured: false }) });
  const result = service.read(["tutorial-complete", "challenge-24"]);
  assert.deepEqual(result.achievements.filter((item) => item.unlocked), []);
  assert.equal(result.pendingCount, 0);
});

test("challenge catalog IDs remain aligned with the browser challenge source", (t) => {
  const source = fs.readFileSync(path.join(__dirname, "../../web/web前端/ChallengeCampaign.js"), "utf8");
  const baseIds = [...source.matchAll(/id: "(C\d{2}-[a-z0-9-]+)"/g)].map((match) => match[1]);
  const variants = [...source.matchAll(/makeTacticalVariant\(CHALLENGE_BASE_LEVELS\[(\d+)\], "([a-z0-9-]+)"/g)]
    .map((match) => `${baseIds[Number(match[1])]}-${match[2]}`);
  assert.deepEqual([...baseIds, ...variants], CHALLENGE_IDS);
});
