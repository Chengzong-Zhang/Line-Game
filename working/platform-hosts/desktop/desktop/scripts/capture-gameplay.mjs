import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { _electron } from "playwright-core";

// Capture the actual packaged renderer. Inputs use the ordinary pointer/UI;
// state reads only locate legal moves, verify actions, and record provenance.
// CDP compositor frames retain their real timestamps. Static intervals repeat
// the last real frame; no game state, UI, or time scale is manufactured.
const root = fileURLToPath(new URL("../../", import.meta.url));
const candidateRoot = path.join(root, "desktop/release/candidates/0.3.0-rc1");
const candidate = JSON.parse(fs.readFileSync(path.join(candidateRoot, "candidate.json"), "utf8"));
const executable = path.join(candidateRoot, "win-unpacked/LIFELINE.exe");
const archive = path.join(path.dirname(executable), "resources/app.asar");
const sha = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
assert.equal(sha(archive), candidate.package.appAsarSha256);
const ffmpeg = process.env.LIFELINE_FFMPEG || "ffmpeg";
const ffprobe = process.env.LIFELINE_FFPROBE || "ffprobe";
fs.mkdirSync(path.join(root, "local_artifacts"), { recursive: true });
const output = fs.mkdtempSync(path.join(root, "local_artifacts/gameplay-capture-"));
console.log(JSON.stringify({ output }));
const receipt = {
  format: "lifeline-gameplay-capture-runtime", schemaVersion: 1, status: "RUNNING",
  candidateId: candidate.id, candidateAppAsarSha256: sha(archive),
  executableSha256: sha(executable), source: "actual-packaged-application",
  playbackSpeed: 1, audioCaptured: false, languages: ["zh-CN", "en"],
  recordedAt: new Date().toISOString(), captures: [], errors: [], externalRequests: [],
  captureSourceSha256: sha(fileURLToPath(import.meta.url)),
  method: "CDP compositor JPEG frames with source timestamps; normal UI and real pointer clicks; isolated profile per language",
  boundary: "Gameplay footage only. Scripted inputs, not a human playtest. Audio is not captured. No Steam services or native dialogs are exercised.",
};
const manifest = { format: "lifeline-gameplay-capture", schemaVersion: 1,
  candidateId: candidate.id, candidateAppAsarSha256: receipt.candidateAppAsarSha256,
  source: receipt.source, playbackSpeed: 1, audioCaptured: false, captures: [] };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const probe = file => JSON.parse(execFileSync(ffprobe, ["-v", "error", "-show_streams", "-show_format", "-of", "json", file], { encoding: "utf8", windowsHide: true }));
let app, page, session, language, phase = "launch";
const tr = (zh, en) => language === "zh-CN" ? zh : en;
const vm = fn => page.evaluate(fn);
const state = () => vm(() => {
  const x = document.querySelector("#app")._vnode.component.proxy;
  return { revision: x.gameState.positionRevision, tutorial: x.currentTutorialLevel?.id,
    tutorialActive: x.tutorialActive, tutorialSuccess: x.tutorialSuccess,
    challenge: x.activeChallengeIndex, challengeStatus: x.challengeStatus,
    actions: x.localGameActions.length, replayCursor: x.replayCursor,
    gameOver: x.gameState.gameOver, currentPlayer: x.gameState.currentPlayer,
    players: JSON.parse(JSON.stringify(x.activeLocalPlayers)) };
});
const clickPoint = async point => {
  const p = await page.evaluate(point => {
    const x = document.querySelector("#app")._vnode.component.proxy;
    const r = x.controller.renderer, p = r.getPointPixelCoordinates(point), b = r.canvas.getBoundingClientRect();
    return { x: b.left + p.x * b.width / r.layout.cssWidth, y: b.top + p.y * b.height / r.layout.cssHeight,
      revision: x.gameState.positionRevision };
  }, point);
  await page.mouse.move(p.x, p.y, { steps: 12 });
  await delay(220);
  await page.mouse.click(p.x, p.y);
  await page.waitForFunction(revision => document.querySelector("#app")._vnode.component.proxy.gameState.positionRevision > revision, p.revision);
};
const tutorialMove = async () => {
  const level = await vm(() => JSON.parse(JSON.stringify(document.querySelector("#app")._vnode.component.proxy.currentTutorialLevel)));
  if (level.restriction) {
    const p = await page.evaluate(point => {
      const r = document.querySelector("#app")._vnode.component.proxy.controller.renderer, p = r.getPointPixelCoordinates(point), b = r.canvas.getBoundingClientRect();
      return { x: b.left + p.x * b.width / r.layout.cssWidth, y: b.top + p.y * b.height / r.layout.cssHeight };
    }, level.restriction.point);
    await page.mouse.click(p.x, p.y);
    await page.waitForFunction(() => document.querySelector("#app")._vnode.component.proxy.tutorialRestrictionObserved);
  }
  if (level.objective.type === "skip") await page.getByRole("button", { name: tr("跳过回合", "Skip Turn"), exact: true }).click();
  else await clickPoint(level.objective.point);
  await page.waitForFunction(() => document.querySelector("#app")._vnode.component.proxy.tutorialSuccess);
};
const nextLesson = async last => page.getByRole("button", { name: last ? tr("进入实战", "Continue to a real match") : tr("下一关", "Next lesson"), exact: true }).click();
const record = async (id, seconds, action) => {
  phase = `${language}/${id}`;
  const folder = path.join(output, `${language}-${id}`);
  fs.mkdirSync(folder);
  const frames = [], droppedFrames = [], before = await state();
  let firstResolve, frameError;
  const first = new Promise(resolve => { firstResolve = resolve; });
  const onFrame = event => {
    try {
      // Chromium can deliver an already queued compositor frame after a newer
      // frame. Preserve its timestamp for diagnosis but never rewind footage.
      if (frames.length && event.metadata.timestamp <= frames.at(-1).timestamp) {
        droppedFrames.push({ timestamp: event.metadata.timestamp, previousTimestamp: frames.at(-1).timestamp,
          reason: "late-or-duplicate-compositor-frame", receivedMs: performance.now() });
        return;
      }
      const name = `${String(frames.length).padStart(6, "0")}.jpg`;
      fs.writeFileSync(path.join(folder, name), Buffer.from(event.data, "base64"), { flag: "wx" });
      frames.push({ name, timestamp: event.metadata.timestamp, receivedMs: performance.now() });
      firstResolve();
    } catch (error) { frameError = error; firstResolve(); }
    finally { session.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(() => {}); }
  };
  session.on("Page.screencastFrame", onFrame);
  await session.send("Page.startScreencast", { format: "jpeg", quality: 96, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });
  try {
    await Promise.race([first, delay(10000).then(() => { if (!frames.length) throw new Error("No compositor frame"); })]);
    if (frameError) throw frameError;
    const began = performance.now();
    await action();
    const actionMs = performance.now() - began;
    assert.ok(actionMs < seconds * 1000, `${id} action exceeded shot duration: ${actionMs}`);
    await delay(seconds * 1000 - actionMs);
    const actualDurationSeconds = (performance.now() - began) / 1000;
    await session.send("Page.stopScreencast");
    session.off("Page.screencastFrame", onFrame);
    if (frameError) throw frameError;
    const after = await state();
    fs.writeFileSync(path.join(folder, "frames.json"), JSON.stringify({ frames, droppedFrames }, null, 2) + "\n", { flag: "wx" });
    const used = frames.filter(f => f.timestamp - frames[0].timestamp < seconds);
    assert.ok(used.length >= 2, `No visible movement in ${id}`);
    const lines = ["ffconcat version 1.0"];
    for (let i = 0; i < used.length; i++) {
      const current = used[i].timestamp - used[0].timestamp;
      const next = i + 1 < used.length ? used[i + 1].timestamp - used[0].timestamp : seconds;
      assert.ok(next >= current, "Compositor time went backwards");
      lines.push(`file '${used[i].name}'`, `duration ${Math.max(0.001, next - current).toFixed(6)}`);
    }
    lines.push(`file '${used.at(-1).name}'`);
    fs.writeFileSync(path.join(folder, "frames.ffconcat"), lines.join("\n") + "\n", { flag: "wx" });
    const video = path.join(output, `${language}-${id}.mp4`);
    execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-nostdin", "-n", "-f", "concat", "-safe", "1", "-i", path.join(folder, "frames.ffconcat"),
      "-t", String(seconds), "-vf", "fps=30", "-c:v", "libx264", "-preset", "fast", "-crf", "16", "-pix_fmt", "yuv420p", "-an", "-movflags", "+faststart", video],
    { windowsHide: true, timeout: 120000 });
    const media = probe(video), stream = media.streams.find(s => s.codec_type === "video");
    assert.equal(stream.width, 1920); assert.equal(stream.height, 1080); assert.equal(stream.avg_frame_rate, "30/1");
    assert.ok(Math.abs(Number(media.format.duration) - seconds) <= 0.05);
    const capture = { id, language, path: path.basename(video), sha256: sha(video), width: stream.width, height: stream.height,
      durationSeconds: Number(media.format.duration), encodedFrames: Number(stream.nb_frames), recordedAt: new Date().toISOString() };
    manifest.captures.push(capture);
    receipt.captures.push({ ...capture, frames: used.length, droppedFrames: droppedFrames.length, actualDurationSeconds, actionsBefore: before, actionsAfter: after,
      sourceTimestampStart: used[0].timestamp, sourceTimestampEnd: used.at(-1).timestamp,
      frameTimelinePath: path.relative(output, path.join(folder, "frames.json")).replaceAll("\\", "/") });
    await page.screenshot({ path: path.join(output, `${language}-${id}-end.png`), scale: "css" });
    console.log(JSON.stringify({ status: "SHOT_COMPLETE", language, id, seconds, frames: used.length }));
  } finally {
    await session.send("Page.stopScreencast").catch(() => {});
    session.off("Page.screencastFrame", onFrame);
  }
};
const humanTurn = async () => {
  await page.waitForFunction(() => {
    const x = document.querySelector("#app")._vnode.component.proxy;
    return x.gameState.gameOver || (x.gameState.currentPlayer === "BLACK" && !x.aiThinking);
  }, null, { timeout: 30000 });
};
const makeLegalMove = async index => {
  await humanTurn();
  const before = await state();
  assert.equal(before.gameOver, false, "Match ended before the shot");
  const point = await page.evaluate(index => {
    const x = document.querySelector("#app")._vnode.component.proxy;
    const moves = x.controller.engine.getSnapshot().legalMoves;
    return moves[index % moves.length]?.point;
  }, index);
  assert.ok(point);
  await clickPoint(point);
  await humanTurn();
  assert.ok((await state()).actions > before.actions, "Move must be applied by real UI");
};

try {
  for (language of receipt.languages) {
    const env = { ...process.env, LIFELINE_TEST_USER_DATA: path.join(output, `profile-${language}`) };
    delete env.ELECTRON_RUN_AS_NODE;
    app = await _electron.launch({ executablePath: executable, args: ["--force-device-scale-factor=1"], env, timeout: 60000 });
    page = await app.firstWindow();
    page.on("pageerror", error => receipt.errors.push(error.message));
    page.on("console", msg => { if (msg.type() === "error") receipt.errors.push(msg.text()); });
    page.on("request", req => { if (/^(https?|wss?):/i.test(req.url())) receipt.externalRequests.push(req.url()); });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.querySelector("#app")?._vnode?.component?.proxy?.controller?.renderer?.layout);
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setContentSize(1920, 1080); });
    await page.waitForFunction(() => innerWidth === 1920 && innerHeight === 1080 && devicePixelRatio === 1);
    session = await app.context().newCDPSession(page);
    await page.locator(".welcome-overlay").getByRole("button", { name: tr("简体中文", "English"), exact: true }).click();
    await page.locator(".welcome-overlay").waitFor({ state: "detached" });
    await record("lesson_connect", 7, async () => {
      await delay(1400); await tutorialMove(); await delay(850); await nextLesson(false); await delay(700); await tutorialMove();
    });
    await nextLesson(false);
    await record("lesson_cut", 7, async () => { await delay(2200); await tutorialMove(); });
    await nextLesson(false); await tutorialMove(); await nextLesson(false); await tutorialMove(); await nextLesson(true);
    await page.waitForFunction(() => !document.querySelector("#app")._vnode.component.proxy.tutorialActive);
    await page.locator(".dock-launcher-campaign").click();
    await page.locator(".campaign-level-card").first().waitFor();
    assert.equal(await page.locator(".campaign-level-card").count(), 24);
    await record("challenge_map", 6, async () => {
      await delay(1200);
      const box = await page.locator(".campaign-level-list").boundingBox();
      await page.mouse.move(box.x + box.width / 2, Math.min(820, box.y + 300));
      await page.mouse.wheel(0, 650); await delay(1600); await page.mouse.wheel(0, 650);
    });
    await page.locator(".campaign-level-card").nth(5).click();
    await page.locator(".utility-overlay-campaign").waitFor({ state: "detached" });
    const challenge = await vm(() => JSON.parse(JSON.stringify(document.querySelector("#app")._vnode.component.proxy.challengeLevels[5])));
    await record("challenge_play", 10, async () => {
      await delay(2000);
      for (const action of challenge.referenceSolution) if (action.player === "BLACK") { await humanTurn(); await clickPoint(action.point); await delay(650); }
      await page.waitForFunction(() => document.querySelector("#app")._vnode.component.proxy.challengeStatus === "won");
    });
    await page.getByRole("button", { name: tr("返回关卡", "Back to levels"), exact: true }).click();
    await page.locator(".utility-overlay-campaign .utility-close").click();
    await page.locator(".dock-launcher-board").click();
    await page.locator("#grid-size").getByRole("radio", { name: "5", exact: true }).click();
    await page.locator("#local-player-BLACK").selectOption("human");
    await page.locator("#local-player-WHITE").selectOption("ai");
    await page.locator(".local-player-card.is-red").getByRole("button", { name: tr("中等", "Medium"), exact: true }).click();
    await page.locator(".utility-overlay-board .utility-close").click();
    await page.getByRole("button", { name: tr("开始对局", "Start match"), exact: true }).click();
    await page.waitForFunction(() => !document.querySelector("#app")._vnode.component.proxy.localSetupPending);
    await makeLegalMove(2); await makeLegalMove(4);
    await record("local_match", 10, async () => { await delay(900); await makeLegalMove(5); await delay(1000); await makeLegalMove(3); });
    const live = await state();
    assert.equal(live.players.WHITE.depth, 3);
    await page.locator(".dock-launcher-board").click();
    phase = `${language}/open-replay`;
    await page.getByRole("button", { name: language === "zh-CN" ? /^复盘本局/ : /^Review this match/ }).click();
    await page.waitForFunction(() => document.querySelector("#app")._vnode.component.proxy.replayMode);
    const close = page.locator(".utility-overlay-board .utility-close");
    if (await close.isVisible()) await close.click();
    const first = page.locator(".replay-controls").getByRole("button", { name: tr("到起点", "First"), exact: true });
    if (await first.isEnabled()) await first.click();
    await record("replay", 8, async () => {
      await delay(800);
      await page.locator(".replay-controls").getByRole("button", { name: tr("播放", "Play"), exact: true }).click();
      await delay(4300);
      const pause = page.locator(".replay-controls").getByRole("button", { name: tr("暂停", "Pause"), exact: true });
      if (await pause.isVisible()) await pause.click();
    });
    await app.close(); app = null;
  }
  assert.equal(sha(archive), receipt.candidateAppAsarSha256);
  assert.deepEqual(receipt.errors, []); assert.deepEqual(receipt.externalRequests, []);
  assert.equal(manifest.captures.length, 12);
  receipt.status = "PASS";
} catch (error) {
  receipt.status = "FAIL"; receipt.failure = { phase, message: error.message, stack: error.stack };
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, "failure.png") }).catch(() => {});
  process.exitCode = 1;
} finally {
  if (app) await app.close().catch(() => {});
  const runtime = path.join(output, "runtime-receipt.json");
  fs.writeFileSync(runtime, JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" });
  if (receipt.status === "PASS") {
    manifest.runtimeReceiptPath = path.basename(runtime); manifest.runtimeReceiptSha256 = sha(runtime);
    fs.writeFileSync(path.join(output, "capture-manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
  }
  console.log(JSON.stringify({ status: receipt.status, output, captureCount: manifest.captures.length, failure: receipt.failure?.message }));
}
