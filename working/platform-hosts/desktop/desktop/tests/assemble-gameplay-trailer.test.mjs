import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { validateSourceReceipt, safeRelative, outputDirectoryPath, inputFile } from "../scripts/assemble-gameplay-trailer.mjs";
import { workspace } from "../scripts/release-lib.mjs";

const ids = ["lesson_connect", "lesson_cut", "challenge_map", "challenge_play", "local_match", "replay"];
const languages = ["en", "zh-CN"];
const digest = "a".repeat(64);
function fixtures() {
  const captures = [];
  const runtimeCaptures = [];
  for (const language of languages) for (const id of ids) {
    captures.push({ language, id, path: `${language}-${id}.mp4`, sha256: digest, width: 1920, height: 1080,
      encodedFrames: ({ lesson_connect: 210, lesson_cut: 210, challenge_map: 180, challenge_play: 300, local_match: 300, replay: 240 })[id],
      durationSeconds: ({ lesson_connect: 7, lesson_cut: 7, challenge_map: 6, challenge_play: 10, local_match: 10, replay: 8 })[id] });
    runtimeCaptures.push({ language, id, path: captures.at(-1).path, sha256: captures.at(-1).sha256,
      frames: 8, actualDurationSeconds: captures.at(-1).durationSeconds,
      actionsBefore: { revision: 1, tutorial: "L1-connect", tutorialActive: true, tutorialSuccess: false,
        challenge: -1, challengeStatus: "idle", actions: 0, replayCursor: 0, gameOver: false, currentPlayer: "BLACK" },
      actionsAfter: { revision: 2, tutorial: "L2-close-territory", tutorialActive: true, tutorialSuccess: true,
        challenge: -1, challengeStatus: "idle", actions: 0, replayCursor: 0, gameOver: false, currentPlayer: "WHITE" } });
  }
  const manifest = { format: "lifeline-gameplay-capture", schemaVersion: 1, candidateId: "0.3.0-rc1",
    candidateAppAsarSha256: "34e87ac4ff68790ad3ea800af9abf9821b5865ec39d0ab99aaff321c09bdcf98",
    source: "actual-packaged-application", playbackSpeed: 1, audioCaptured: false, runtimeReceiptSha256: digest, captures };
  const receipt = { format: "lifeline-gameplay-capture-runtime", schemaVersion: 1, status: "PASS",
    candidateId: manifest.candidateId, candidateAppAsarSha256: manifest.candidateAppAsarSha256,
    source: manifest.source, playbackSpeed: 1, audioCaptured: false, languages, errors: [], externalRequests: [], captures: runtimeCaptures };
  return { manifest, receipt };
}

test("accepts clips whose encoded frame counts differ from compositor frame counts", () => {
  const { manifest, receipt } = fixtures();
  const result = validateSourceReceipt(receipt, manifest);
  assert.equal(result.clips.get("en:lesson_connect").encodedFrames, 210);
  assert.equal(result.receiptCaptures.get("en:lesson_connect").frames, 8);
});

test("rejects incorrect source provenance and incomplete clip sets", () => {
  const { manifest, receipt } = fixtures();
  assert.throws(() => validateSourceReceipt({ ...receipt, source: "synthetic" }, manifest), /provenance/);
  assert.throws(() => validateSourceReceipt(receipt, { ...manifest, captures: manifest.captures.slice(1) }), /exactly twelve/);
});

test("rejects unsafe and missing clip paths without modifying inputs", () => {
  assert.throws(() => safeRelative("../outside.mp4"), /Unsafe/);
  assert.throws(() => safeRelative("C:\\outside.mp4"), /Unsafe/);
  const root = fs.mkdtempSync(path.join(workspace, "media-input-"));
  try { assert.throws(() => inputFile(root, "missing.mp4", "capture")); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("refuses an existing output directory and preserves its contents", () => {
  const name = `trailer-test-${randomBytes(5).toString("hex")}`;
  const directory = path.join(workspace, "local_artifacts", name);
  fs.mkdirSync(directory, { recursive: true });
  const sentinel = path.join(directory, "keep.txt");
  fs.writeFileSync(sentinel, "preserve");
  try {
    assert.throws(() => outputDirectoryPath(path.join("local_artifacts", name)), /refusing to overwrite/);
    assert.equal(fs.readFileSync(sentinel, "utf8"), "preserve");
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
