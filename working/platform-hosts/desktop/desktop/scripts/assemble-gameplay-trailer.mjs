import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { verifyCandidate, workspace } from "./release-lib.mjs";

const FORMAT = "lifeline-gameplay-capture";
const RUNTIME_FORMAT = "lifeline-gameplay-capture-runtime";
const CANDIDATE_ID = "0.3.0-rc1";
const CANDIDATE_ASAR_SHA256 = "34e87ac4ff68790ad3ea800af9abf9821b5865ec39d0ab99aaff321c09bdcf98";
const LANGUAGES = ["en", "zh-CN"];
const SEGMENTS = [
  { id: "lesson_connect", seconds: 7, title: { en: "Learn to connect", "zh-CN": "学会连接" } },
  { id: "lesson_cut", seconds: 7, title: { en: "See the cut", "zh-CN": "看懂切断" } },
  { id: "challenge_map", seconds: 6, title: { en: "24 tactical challenges", "zh-CN": "24 个战术挑战" } },
  { id: "challenge_play", seconds: 10, title: { en: "Find the next move", "zh-CN": "找出下一步" } },
  { id: "local_match", seconds: 10, title: { en: "Play at your own pace", "zh-CN": "按自己的节奏对弈" } },
  { id: "replay", seconds: 8, title: { en: "Review every move", "zh-CN": "逐步复盘" } },
];
const TOTAL_SECONDS = SEGMENTS.reduce((sum, segment) => sum + segment.seconds, 0);
const SHA256 = /^[a-f0-9]{64}$/;

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function safeRelative(value, label = "path") {
  assert(typeof value === "string" && value.length > 0 && !/[\x00-\x1f]/.test(value)
    && !path.isAbsolute(value) && !path.win32.isAbsolute(value) && !/^[a-z]:/i.test(value), `Unsafe ${label}`);
  const components = value.replaceAll("\\", "/").split("/");
  assert(components.every((part) => part && part !== "." && part !== ".."), `Unsafe ${label}`);
  return components.join(path.sep);
}

export function readJsonFile(file, maxBytes, label) {
  const stat = fs.lstatSync(file);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.size <= maxBytes, `${label} is missing, linked, or too large`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function inputFile(root, relative, label) {
  const safe = safeRelative(relative, label);
  const components = safe.split(path.sep);
  let current = root;
  for (const [index, component] of components.entries()) {
    current = path.join(current, component);
    const stat = fs.lstatSync(current);
    assert(!stat.isSymbolicLink(), `Linked ${label} path is not accepted`);
    if (index < components.length - 1) assert(stat.isDirectory(), `Invalid ${label} path`);
    else assert(stat.isFile(), `${label} is not a regular file`);
  }
  const resolvedRoot = fs.realpathSync(root);
  const resolvedFile = fs.realpathSync(current);
  const relativeCheck = path.relative(resolvedRoot, resolvedFile);
  assert(relativeCheck && !relativeCheck.startsWith(`..${path.sep}`) && relativeCheck !== ".." && !path.isAbsolute(relativeCheck), `${label} escaped its source directory`);
  return resolvedFile;
}

export function hashFile(file) {
  const hash = createHash("sha256");
  const stream = fs.createReadStream(file);
  return new Promise((resolve, reject) => {
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

export function validateSourceReceipt(receipt, manifest) {
  assert(receipt && typeof receipt === "object" && !Array.isArray(receipt), "Runtime receipt is not an object");
  assert(receipt.format === RUNTIME_FORMAT && receipt.schemaVersion === 1 && receipt.status === "PASS", "Runtime receipt is not a passing capture receipt");
  assert(receipt.candidateId === CANDIDATE_ID && receipt.candidateAppAsarSha256 === CANDIDATE_ASAR_SHA256, "Runtime receipt is for a different candidate");
  assert(receipt.source === "actual-packaged-application" && receipt.playbackSpeed === 1 && receipt.audioCaptured === false, "Runtime receipt has unsupported capture provenance");
  assert(Array.isArray(receipt.languages) && LANGUAGES.every((language) => receipt.languages.includes(language))
    && receipt.languages.length === LANGUAGES.length, "Runtime receipt is missing a trailer language");
  assert(Array.isArray(receipt.errors) && receipt.errors.length === 0, "Runtime receipt contains errors");
  assert(Array.isArray(receipt.externalRequests) && receipt.externalRequests.length === 0, "Runtime receipt contains external requests");
  assert(Array.isArray(receipt.captures) && receipt.captures.length === SEGMENTS.length * LANGUAGES.length, "Runtime receipt capture set is incomplete");
  const receiptCaptures = new Map();
  for (const capture of receipt.captures) {
    const key = `${capture.language}:${capture.id}`;
    assert(!receiptCaptures.has(key) && Number.isSafeInteger(capture.frames) && capture.frames > 0
      && Number.isFinite(capture.actualDurationSeconds) && capture.actualDurationSeconds > 0
      && capture.actionsBefore && typeof capture.actionsBefore === "object" && Number.isSafeInteger(capture.actionsBefore.revision)
      && capture.actionsBefore.revision >= 0 && Number.isSafeInteger(capture.actionsBefore.actions) && capture.actionsBefore.actions >= 0
      && Number.isSafeInteger(capture.actionsBefore.replayCursor)
      && capture.actionsAfter && typeof capture.actionsAfter === "object" && Number.isSafeInteger(capture.actionsAfter.revision)
      && capture.actionsAfter.revision >= 0 && Number.isSafeInteger(capture.actionsAfter.actions) && capture.actionsAfter.actions >= 0
      && Number.isSafeInteger(capture.actionsAfter.replayCursor),
    `Invalid runtime receipt capture: ${key}`);
    receiptCaptures.set(key, capture);
  }

  assert(manifest && typeof manifest === "object" && !Array.isArray(manifest), "Capture manifest is not an object");
  assert(manifest.format === FORMAT && manifest.schemaVersion === 1, "Unsupported capture manifest");
  assert(manifest.candidateId === CANDIDATE_ID && manifest.candidateAppAsarSha256 === CANDIDATE_ASAR_SHA256, "Capture manifest is for a different candidate");
  assert(manifest.source === "actual-packaged-application" && manifest.playbackSpeed === 1 && manifest.audioCaptured === false, "Capture manifest has unsupported provenance");
  assert(manifest.runtimeReceiptSha256 && SHA256.test(manifest.runtimeReceiptSha256), "Invalid runtime receipt hash");
  assert(Array.isArray(manifest.captures) && manifest.captures.length === SEGMENTS.length * LANGUAGES.length, "Capture manifest must contain exactly twelve clips");
  const clips = new Map();
  for (const clip of manifest.captures) {
    const key = `${clip.language}:${clip.id}`;
    assert(LANGUAGES.includes(clip.language) && SEGMENTS.some((segment) => segment.id === clip.id), `Unknown capture: ${key}`);
    const recorded = receiptCaptures.get(key);
    assert(!clips.has(key) && SHA256.test(clip.sha256) && clip.width === 1920 && clip.height === 1080
      && Number.isSafeInteger(clip.encodedFrames) && clip.encodedFrames > 0 && recorded
      && Number.isSafeInteger(recorded.frames) && recorded.frames > 0 && Number.isFinite(clip.durationSeconds) && clip.durationSeconds > 0,
    `Invalid capture metadata: ${key}`);
    assert(typeof clip.path === "string", `Missing capture path: ${key}`);
    assert(recorded.path === clip.path && recorded.sha256 === clip.sha256, `Capture file identity differs from runtime receipt: ${key}`);
    assert(Math.abs(recorded.actualDurationSeconds - clip.durationSeconds) <= 0.1, `Capture duration differs from runtime receipt: ${key}`);
    const expected = SEGMENTS.find((segment) => segment.id === clip.id).seconds;
    assert(Math.abs(clip.durationSeconds - expected) <= 0.75, `Unexpected segment duration: ${key}`);
    clips.set(key, clip);
  }
  assert(clips.size === SEGMENTS.length * LANGUAGES.length && [...receiptCaptures.keys()].every((key) => clips.has(key)), "Capture files do not match the runtime receipt");
  return { clips, receiptCaptures };
}

function resolveBinary(argument, environmentVariable, name) {
  const configured = argument ?? process.env[environmentVariable];
  if (configured) {
    assert(fs.existsSync(configured) && fs.statSync(configured).isFile(), `${name} binary was not found`);
    return path.resolve(configured);
  }
  const defaultPath = path.join("C:", "Program Files", "ffmpeg-8.0.1-full_build", "bin", `${name}.exe`);
  return fs.existsSync(defaultPath) ? defaultPath : `${name}.exe`;
}

function run(binary, args, label, timeout = 600_000) {
  const result = spawnSync(binary, args, { encoding: "utf8", windowsHide: true, timeout, maxBuffer: 8 * 1024 * 1024 });
  assert(!result.error, `${label} could not run: ${result.error?.message}`);
  assert(result.status === 0, `${label} failed: ${(result.stderr ?? "").slice(-2400)}`);
  return result.stdout;
}

function parseRate(value) {
  if (typeof value !== "string" || !value.includes("/")) return NaN;
  const [numerator, denominator] = value.split("/").map(Number);
  return denominator ? numerator / denominator : NaN;
}

export function probeMedia(ffprobe, file, label) {
  const output = run(ffprobe, ["-v", "error", "-count_frames", "-show_entries",
    "stream=codec_type,codec_name,width,height,pix_fmt,avg_frame_rate,r_frame_rate,nb_read_frames,duration:format=duration,format_name", "-of", "json", file], `Probe ${label}`, 120_000);
  const data = JSON.parse(output);
  const video = data.streams?.find((stream) => stream.codec_type === "video");
  assert(video && data.streams.filter((stream) => stream.codec_type === "video").length === 1, `${label} must have one video stream`);
  assert(!data.streams.some((stream) => stream.codec_type === "audio"), `${label} unexpectedly contains captured audio`);
  const duration = Number(video.duration ?? data.format?.duration);
  const frames = Number(video.nb_read_frames);
  const fps = parseRate(video.avg_frame_rate);
  assert(video.width === 1920 && video.height === 1080 && Number.isFinite(duration) && duration > 0
    && Number.isSafeInteger(frames) && frames > 0 && Math.abs(fps - 30) < 0.01, `${label} must be 1920x1080 CFR 30fps`);
  assert(Math.abs(duration - frames / 30) <= 0.08, `${label} duration and frame count disagree`);
  return { codec: video.codec_name, duration, frames, fps };
}

export function outputDirectoryPath(outputArgument) {
  assert(typeof outputArgument === "string" && outputArgument.length > 0, "An output directory is required");
  const root = path.join(workspace, "local_artifacts");
  if (!fs.existsSync(root)) fs.mkdirSync(root);
  const rootStat = fs.lstatSync(root);
  assert(rootStat.isDirectory() && !rootStat.isSymbolicLink(), "Local artifact directory must be a normal directory");
  const target = path.resolve(workspace, outputArgument);
  const relative = path.relative(root, target);
  assert(relative && !relative.includes(path.sep) && relative !== "." && /^[a-z0-9][a-z0-9._-]{2,70}$/i.test(relative), "Output must be a new named directory directly under local_artifacts");
  const realRoot = fs.realpathSync(root);
  assert(path.dirname(target).toLowerCase() === realRoot.toLowerCase(), "Output directory escaped local_artifacts");
  assert(!fs.existsSync(target) && !fs.existsSync(`${target}.tmp`), "Output already exists; refusing to overwrite");
  return { root: realRoot, target };
}

function timestamp(seconds) {
  const milliseconds = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const secs = Math.floor((milliseconds % 60_000) / 1000);
  const millis = milliseconds % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")},${String(millis).padStart(3, "0")}`;
}

function buildSubtitles(language, clips) {
  let cursor = 0;
  const lines = [];
  for (const [index, segment] of SEGMENTS.entries()) {
    const clip = clips.get(`${language}:${segment.id}`);
    const duration = clip.durationSeconds;
    const start = cursor + Math.min(0.4, duration / 10);
    const end = Math.min(cursor + duration - 0.1, start + 2.6);
    lines.push(`${index + 1}\n${timestamp(start)} --> ${timestamp(end)}\n${segment.title[language]}\n`);
    cursor += duration;
  }
  return `${lines.join("\n")}\n`;
}

function verifyOutput(ffprobe, file, language) {
  const output = run(ffprobe, ["-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height,pix_fmt,avg_frame_rate,sample_rate,channels,bit_rate:format=duration,format_name,bit_rate", "-of", "json", file], `Verify ${language} trailer`);
  const data = JSON.parse(output);
  const video = data.streams?.find((stream) => stream.codec_type === "video");
  const audio = data.streams?.find((stream) => stream.codec_type === "audio");
  const duration = Number(data.format?.duration);
  const bitrate = Number(video?.bit_rate ?? data.format?.bit_rate);
  assert(video?.codec_name === "h264" && video.width === 1920 && video.height === 1080
    && video.pix_fmt === "yuv420p" && Math.abs(parseRate(video.avg_frame_rate) - 30) < 0.01, `${language} trailer video format is invalid`);
  assert(Number.isFinite(bitrate) && bitrate >= 5_000_000, `${language} trailer video bitrate is below 5 Mbps`);
  assert(audio?.codec_name === "aac" && audio.sample_rate === "48000" && audio.channels === 2, `${language} trailer must include silent stereo AAC at 48 kHz`);
  assert(data.format?.format_name?.includes("mp4") && Math.abs(duration - TOTAL_SECONDS) <= 0.35, `${language} trailer container or duration is invalid`);
  return { duration, videoBitrate: bitrate, videoCodec: video.codec_name, width: video.width, height: video.height,
    pixelFormat: video.pix_fmt, frameRate: parseRate(video.avg_frame_rate), audioCodec: audio.codec_name, audioSampleRate: Number(audio.sample_rate), audioChannels: audio.channels };
}

export async function assemble({ manifestPath, candidateDirectory, outputDir, ffmpegPath, ffprobePath }) {
  const manifestFile = path.resolve(manifestPath);
  const manifestDirectory = fs.realpathSync(path.dirname(manifestFile));
  const manifest = readJsonFile(manifestFile, 1_000_000, "Capture manifest");
  const validation = validateSourceReceipt(readJsonFile(inputFile(manifestDirectory, manifest.runtimeReceiptPath, "Runtime receipt"), 4_000_000, "Runtime receipt"), manifest);
  const runtimeReceiptFile = inputFile(manifestDirectory, manifest.runtimeReceiptPath, "Runtime receipt");
  assert(await hashFile(runtimeReceiptFile) === manifest.runtimeReceiptSha256, "Runtime receipt checksum mismatch");
  const candidate = verifyCandidate(path.resolve(candidateDirectory));
  assert(candidate.id === CANDIDATE_ID && candidate.package?.version === "0.3.0"
    && candidate.package.appAsarSha256 === CANDIDATE_ASAR_SHA256, "Candidate directory is not the frozen 0.3.0-rc1 snapshot");

  const { target: finalOutput } = outputDirectoryPath(outputDir);
  const ffmpeg = resolveBinary(ffmpegPath, "FFMPEG_PATH", "ffmpeg");
  const ffprobe = resolveBinary(ffprobePath, "FFPROBE_PATH", "ffprobe");
  const inputs = new Map();
  for (const [key, clip] of validation.clips) {
    const file = inputFile(manifestDirectory, clip.path, `Capture ${key}`);
    assert(await hashFile(file) === clip.sha256, `Capture checksum mismatch: ${key}`);
    const media = probeMedia(ffprobe, file, key);
    const receiptCapture = validation.receiptCaptures.get(key);
    assert(media.frames === clip.encodedFrames && Math.abs(media.duration - clip.durationSeconds) <= Math.max(0.05, 1 / 30)
      && Math.abs(media.duration - receiptCapture.actualDurationSeconds) <= 0.15, `Encoded capture differs from runtime recording: ${key}`);
    inputs.set(key, { file, ...media, sha256: clip.sha256 });
  }

  const outputStat = fs.lstatSync(path.dirname(finalOutput));
  assert(outputStat.isDirectory() && !outputStat.isSymbolicLink(), "Output parent must be a normal directory");
  fs.mkdirSync(finalOutput); // Exclusive creation: existing outputs are never replaced.
  let success = false;
  let phase = "prepare";
  try {
    const version = candidate.package.version;
    const results = {};
    const ffmpegVersion = run(ffmpeg, ["-version"], "Read FFmpeg version").split(/\r?\n/, 1)[0];
    for (const language of LANGUAGES) {
      phase = `encode-${language}`;
      const segments = SEGMENTS.map((segment) => inputs.get(`${language}:${segment.id}`));
      const subtitleFile = path.join(finalOutput, `LIFELINE-${version}-trailer.${language}.srt`);
      fs.writeFileSync(subtitleFile, buildSubtitles(language, validation.clips), "utf8");
      const filters = segments.map((_, index) => `[${index}:v:0]fps=30,scale=iw:ih:in_range=pc:out_range=tv,format=yuv420p,setpts=PTS-STARTPTS[v${index}]`).join(";");
      const concatInputs = segments.map((_, index) => `[v${index}]`).join("");
      const filter = `${filters};${concatInputs}concat=n=${SEGMENTS.length}:v=1:a=0[outv]`;
      const videoFile = path.join(finalOutput, `LIFELINE-${version}-trailer.${language}.mp4`);
      const args = [];
      for (const segment of segments) args.push("-i", segment.file);
      args.push("-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000", "-filter_complex", filter,
        "-map", "[outv]", "-map", `${SEGMENTS.length}:a:0`, "-map_metadata", "-1", "-map_chapters", "-1",
        "-r", "30", "-fps_mode", "cfr", "-c:v", "libx264", "-preset", "medium", "-pix_fmt", "yuv420p",
        "-b:v", "8M", "-minrate", "8M", "-maxrate", "8M", "-bufsize", "16M", "-x264-params", "nal-hrd=cbr:force-cfr=1",
        "-g", "60", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2", "-shortest", "-movflags", "+faststart", "-f", "mp4", videoFile);
      run(ffmpeg, args, `Encode ${language} trailer`);
      results[language] = { video: path.basename(videoFile), ...verifyOutput(ffprobe, videoFile, language),
        bytes: fs.statSync(videoFile).size, sha256: await hashFile(videoFile), subtitles: path.basename(subtitleFile),
        subtitlesBytes: fs.statSync(subtitleFile).size, subtitlesSha256: await hashFile(subtitleFile) };
    }

    // Keep the handoff usable by a player who only has File Explorer and Notepad.
    phase = "copy-player-guides";
    for (const language of LANGUAGES) {
      fs.copyFileSync(path.join(workspace, "docs", "steam", `PLAYER_QUICKSTART.${language}.md`), path.join(finalOutput, `Quick-start.${language}.txt`));
    }
    phase = "write-feedback-template";
    fs.writeFileSync(path.join(finalOutput, "Feedback-template.txt"), [
      "LIFELINE local test feedback / LIFELINE 本地测试反馈",
      "Blank template only; no feedback has been collected. / 空白模板；尚未收集反馈。",
      "Do not include your name, account, full save, personal-data folder, or logs. / 请勿提供姓名、账号、完整存档、个人数据目录或日志。",
      "",
      "ENGLISH", "Candidate version: 0.3.0-rc1", "Windows version:", "Interface language / scale:",
      "Where it happened (lesson, challenge, or match step):", "Steps taken:", "Expected result:", "What happened:", "Can you reproduce it:", "Optional: cropped screenshot:",
      "", "简体中文", "候选版本：0.3.0-rc1", "Windows 版本：", "界面语言 / 缩放比例：", "发生位置（教学课次、挑战编号或对局步骤）：",
      "操作步骤：", "预期结果：", "实际结果：", "是否能再次出现：", "可选：已裁剪的相关画面：", "",
    ].join("\r\n"), "utf8");
    for (const language of LANGUAGES) {
      phase = `poster-${language}`;
      const poster = `poster.${language}.jpg`;
      const posterFile = path.join(finalOutput, poster);
      run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-nostdin", "-n", "-ss", "00:00:03", "-i",
        path.join(finalOutput, results[language].video), "-frames:v", "1", "-q:v", "2", posterFile], `Extract ${language} preview poster`);
      results[language].poster = poster;
      results[language].posterBytes = fs.statSync(posterFile).size;
      results[language].posterSha256 = await hashFile(posterFile);
    }
    phase = "write-preview";
    const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>LIFELINE gameplay preview</title><style>body{font:16px system-ui,sans-serif;max-width:960px;margin:2rem auto;padding:0 1rem;color:#17212b}video{width:100%;background:#111}section{margin:2rem 0}a{margin-right:1rem}</style><h1>LIFELINE / 生命线</h1><p>Local preview • silent gameplay demonstration • no server or external network required.</p><p>本地预览 · 静音实机演示 · 无需服务器或外部网络。视频不含录制游戏声音；兼容音轨为静音。</p><section><h2>English</h2><video controls preload="metadata" poster="${results.en.poster}" src="${results.en.video}"></video><p><a href="${results.en.subtitles}" download>Download English subtitles (.srt)</a> SRT files are separate captions; enable captions in a compatible player.</p></section><section lang="zh-CN"><h2>简体中文</h2><video controls preload="metadata" poster="${results["zh-CN"].poster}" src="${results["zh-CN"].video}"></video><p><a href="${results["zh-CN"].subtitles}" download>下载简体中文字幕 (.srt)</a> SRT 字幕独立提供，请在兼容播放器中手动启用。</p></section><p><a href="Quick-start.en.txt">English player quick-start (.txt)</a> · <a href="Quick-start.zh-CN.txt">简体中文快速入门 (.txt)</a> · <a href="Feedback-template.txt">Blank bilingual feedback form (.txt)</a></p></html>`;
    fs.writeFileSync(path.join(finalOutput, "Start-here.html"), html, "utf8");

    const receipt = { format: "lifeline-gameplay-trailer-export", schemaVersion: 1, status: "PASS",
      createdAt: new Date().toISOString(), candidateId: CANDIDATE_ID, candidateAppAsarSha256: CANDIDATE_ASAR_SHA256,
      source: { type: manifest.source, playbackSpeed: manifest.playbackSpeed, audioCaptured: manifest.audioCaptured,
        runtimeReceiptSha256: manifest.runtimeReceiptSha256, captureManifestSha256: await hashFile(manifestFile),
        captures: [...inputs.entries()].map(([key, input]) => ({ key, sha256: input.sha256, frames: input.frames, durationSeconds: input.duration })) },
      ffmpeg: ffmpegVersion, video: { container: "MP4", codec: "H.264", width: 1920, height: 1080, frameRate: 30,
        targetVideoBitrate: 8_000_000, pixelFormat: "yuv420p" },
      audio: { captured: false, track: "silent AAC stereo compatibility track", sampleRate: 48_000, channels: 2 },
      languages: results,
      boundary: "The assembler verifies manifest, runtime receipt, candidate identity, clip hashes and media properties. It does not independently prove that the recordings depict genuine play; that provenance comes from the paired runtime receipt." };
    phase = "write-export-receipt";
    fs.writeFileSync(path.join(finalOutput, "trailer-export.json"), `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
    success = true;
    return { output: finalOutput, receipt };
  } catch (error) {
    if (!success) {
      const failure = { format: "lifeline-gameplay-trailer-export-failure", schemaVersion: 1, status: "FAIL",
        failedAt: new Date().toISOString(), phase, error: error?.message ?? String(error) };
      try { fs.writeFileSync(path.join(finalOutput, "failure.json"), `${JSON.stringify(failure, null, 2)}\n`, { flag: "wx" }); }
      catch (writeError) { error.failureReceiptError = writeError?.message ?? String(writeError); }
    }
    throw error;
  }
}

function argumentsFrom(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index];
    if (!["--manifest", "--candidate-dir", "--output-dir", "--ffmpeg", "--ffprobe"].includes(name)) throw new Error(`Unknown option: ${name}`);
    const value = argv[++index];
    assert(value && !value.startsWith("--"), `Missing value for ${name}`);
    result[{ "--manifest": "manifestPath", "--candidate-dir": "candidateDirectory", "--output-dir": "outputDir", "--ffmpeg": "ffmpegPath", "--ffprobe": "ffprobePath" }[name]] = value;
  }
  assert(result.manifestPath && result.candidateDirectory && result.outputDir, "Usage: assemble-gameplay-trailer --manifest <capture-manifest.json> --candidate-dir <candidate> --output-dir <new-local_artifacts-directory> [--ffmpeg <path> --ffprobe <path>]");
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await assemble(argumentsFrom(process.argv.slice(2)));
    console.log(JSON.stringify({ status: result.receipt.status, output: result.output }));
  } catch (error) {
    console.error(JSON.stringify({ status: "FAIL", error: error?.message ?? String(error) }));
    process.exitCode = 1;
  }
}
