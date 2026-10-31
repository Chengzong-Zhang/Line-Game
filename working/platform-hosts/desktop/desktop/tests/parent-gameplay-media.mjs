import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { verifyCandidate, filesIn } from "../scripts/release-lib.mjs";

// Independent artifact check. Browser playback and visual inspection are
// recorded separately; successful decoding alone is not visual acceptance.
const root = fileURLToPath(new URL("../../", import.meta.url));
const [captureArgument, mediaArgument] = process.argv.slice(2);
assert.ok(captureArgument && mediaArgument, "Usage: parent-gameplay-media <capture-manifest.json> <media-directory>");
const captureFile = path.resolve(captureArgument), mediaRoot = path.resolve(mediaArgument);
const captureRoot = path.dirname(captureFile), input = JSON.parse(fs.readFileSync(captureFile, "utf8"));
const runtimeFile = path.join(captureRoot, input.runtimeReceiptPath);
const runtime = JSON.parse(fs.readFileSync(runtimeFile, "utf8"));
const exported = JSON.parse(fs.readFileSync(path.join(mediaRoot, "trailer-export.json"), "utf8"));
const hash = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const ffmpeg = process.env.LIFELINE_FFMPEG || "ffmpeg";
const ffprobe = process.env.LIFELINE_FFPROBE || "ffprobe";
const run = (binary, args) => execFileSync(binary, args, { encoding: "utf8", windowsHide: true, timeout: 120000, maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
const output = fs.mkdtempSync(path.join(root, "local_artifacts/parent-media-review-"));
const receipt = { format: "lifeline-parent-gameplay-media-review", schemaVersion: 1, status: "RUNNING",
  checkedAt: new Date().toISOString(), captureManifest: path.relative(root, captureFile).replaceAll("\\", "/"),
  captureManifestSha256: hash(captureFile), runtimeReceiptSha256: hash(runtimeFile),
  mediaDirectory: path.relative(root, mediaRoot).replaceAll("\\", "/"),
  candidateId: input.candidateId, candidateAppAsarSha256: input.candidateAppAsarSha256,
  languages: {}, capturedTimelines: [], visualReview: "NOT-RUN", browserPlayback: "NOT-RUN" };
console.log(JSON.stringify({ output }));
try {
  assert.equal(runtime.status, "PASS"); assert.equal(exported.status, "PASS");
  assert.equal(input.runtimeReceiptSha256, hash(runtimeFile));
  assert.equal(exported.source.captureManifestSha256, hash(captureFile));
  assert.equal(runtime.captureSourceSha256, hash(path.join(root, "desktop/scripts/capture-gameplay.mjs")));
  assert.deepEqual(runtime.errors, []); assert.deepEqual(runtime.externalRequests, []);
  const candidate = verifyCandidate(path.join(root, "desktop/release/candidates", input.candidateId));
  assert.equal(candidate.package.appAsarSha256, input.candidateAppAsarSha256);
  receipt.candidatePortableSha256 = candidate.portable.sha256;
  receipt.captureSourceSha256 = runtime.captureSourceSha256;
  receipt.assemblerSourceSha256 = hash(path.join(root, "desktop/scripts/assemble-gameplay-trailer.mjs"));
  for (const shot of runtime.captures) {
    const timelineFile = path.join(captureRoot, shot.frameTimelinePath);
    const { frames, droppedFrames } = JSON.parse(fs.readFileSync(timelineFile, "utf8"));
    assert.ok(frames.length > 0 && frames.every((frame, i) => i === 0 || frame.timestamp > frames[i - 1].timestamp));
    assert.equal(droppedFrames.length, shot.droppedFrames);
    assert.ok(Math.abs(shot.actualDurationSeconds - shot.durationSeconds) < 0.1);
    receipt.capturedTimelines.push({ language: shot.language, id: shot.id, sha256: hash(timelineFile), frames: frames.length, droppedFrames: droppedFrames.length });
  }
  for (const language of ["en", "zh-CN"]) {
    const record = exported.languages[language];
    const videoFile = path.join(mediaRoot, record.video);
    assert.equal(hash(videoFile), record.sha256);
    assert.equal(hash(path.join(mediaRoot, record.subtitles)), record.subtitlesSha256);
    assert.equal(hash(path.join(mediaRoot, record.poster)), record.posterSha256);
    const streams = JSON.parse(run(ffprobe, ["-v", "error", "-count_frames", "-show_streams", "-show_format", "-of", "json", videoFile]));
    const video = streams.streams.find(s => s.codec_type === "video"), audio = streams.streams.find(s => s.codec_type === "audio");
    assert.equal(streams.streams.length, 2); assert.equal(video.codec_name, "h264"); assert.equal(video.width, 1920); assert.equal(video.height, 1080);
    assert.equal(video.avg_frame_rate, "30/1"); assert.equal(video.pix_fmt, "yuv420p"); assert.equal(Number(video.nb_read_frames), 1440);
    assert.ok(Number(video.bit_rate) >= 5000000); assert.ok(Math.abs(Number(streams.format.duration) - 48) < 0.1);
    assert.equal(audio.codec_name, "aac"); assert.equal(audio.channels, 2); assert.equal(audio.sample_rate, "48000");
    run(ffmpeg, ["-hide_banner", "-v", "error", "-nostdin", "-xerror", "-i", videoFile, "-f", "null", "-"]);
    const audioInfo = execFileSync(ffmpeg, ["-hide_banner", "-v", "error", "-nostdin", "-i", videoFile, "-map", "0:a", "-f", "s16le", "-acodec", "pcm_s16le", "-"],
      { windowsHide: true, timeout: 120000, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
    assert.ok(audioInfo.length > 0 && audioInfo.every(value => value === 0), "Compatibility audio must be silent");
    const clips = ["lesson_connect", "lesson_cut", "challenge_map", "challenge_play", "local_match", "replay"].map(id => input.captures.find(c => c.id === id && c.language === language));
    const args = ["-hide_banner", "-nostdin", "-i", videoFile];
    for (const clip of clips) { assert.equal(hash(path.join(captureRoot, clip.path)), clip.sha256); args.push("-i", path.join(captureRoot, clip.path)); }
    const filter = clips.map((_, i) => `[${i + 1}:v]scale=in_range=auto:out_range=tv,format=yuv420p,setpts=PTS-STARTPTS[v${i}]`).join(";") + ";" + clips.map((_, i) => `[v${i}]`).join("") + "concat=n=6:v=1:a=0[original];[0:v][original]ssim[out]";
    args.push("-filter_complex", filter, "-map", "[out]", "-an", "-f", "null", "-");
    let ssimLog;
    // FFmpeg reports aggregate SSIM on stderr even on success.
    const { spawnSync } = await import("node:child_process");
    const comparison = spawnSync(ffmpeg, args, { encoding: "utf8", windowsHide: true, timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
    assert.equal(comparison.status, 0, comparison.stderr);
    ssimLog = comparison.stderr;
    const match = ssimLog.match(/All:([0-9.]+)/);
    assert.ok(match && Number(match[1]) > 0.99, "Assembled video differs from recorded source timeline");
    fs.writeFileSync(path.join(output, `${language}-comparison.txt`), ssimLog);
    const sampleSeconds = [1, 5, 8, 12, 15, 19, 21, 27, 32, 37, 41, 46];
    const select = sampleSeconds.map(t => `eq(n\\,${t * 30})`).join("+");
    const contact = path.join(output, `${language}-contact.png`);
    run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-nostdin", "-n", "-i", videoFile, "-vf", `select='${select}',scale=480:270,tile=4x3`, "-frames:v", "1", contact]);
    receipt.languages[language] = { video: record.video, sha256: record.sha256, durationSeconds: Number(streams.format.duration),
      videoFrames: Number(video.nb_read_frames), videoBitrate: Number(video.bit_rate), fullDecode: "PASS", silentAudio: "PASS", sourceTimelineSSIM: Number(match[1]),
      contactSheet: path.relative(root, contact).replaceAll("\\", "/"), contactSheetSha256: hash(contact), sampledSeconds: sampleSeconds };
    console.log(JSON.stringify({ status: "LANGUAGE_VERIFIED", language, ssim: Number(match[1]) }));
  }
  receipt.inventory = filesIn(mediaRoot);
  receipt.status = "STRUCTURAL_MEDIA_PASS";
} catch (error) {
  receipt.status = "FAIL"; receipt.failure = { message: error.message, stack: error.stack }; process.exitCode = 1;
} finally {
  fs.writeFileSync(path.join(output, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" });
  console.log(JSON.stringify({ status: receipt.status, output, failure: receipt.failure?.message }));
}
