import fs from "node:fs";
import path from "node:path";
import { workspace, assert, json, fileHash, filesIn, verifyInventory, verifyCandidate, localOutputRoot, safeRelative } from "./release-lib.mjs";

// Copy accepted, hash-bound captures without altering their pixels. This creates
// a local folder only; it neither publishes nor contacts prospective testers.
const [candidateArgument, ...receiptArguments] = process.argv.slice(2);
try {
  assert(candidateArgument && receiptArguments.length === 2,
    "Usage: assemble-release-kit <candidate-directory> <zh-receipt.json> <en-receipt.json>");
  const candidateDirectory = path.resolve(candidateArgument);
  const candidate = verifyCandidate(candidateDirectory);
  assert(/^[a-z0-9][a-z0-9.-]{2,70}$/.test(candidate.id), "Invalid candidate ID");
  const receipts = receiptArguments.map(file => ({ file: path.resolve(file), value: json(path.resolve(file)) }));
  assert(new Set(receipts.map(r => r.value.language)).size === 2, "Supply distinct Chinese and English receipts");
  const sources = [];
  const add = (source, destination) => sources.push({ source, destination: safeRelative(destination), sha256: fileHash(source) });
  add(path.join(candidateDirectory, candidate.portable.path), candidate.portable.path);
  add(path.join(candidateDirectory, "candidate.json"), "verification/candidate.json");
  for (const { file, value } of receipts) {
    assert(value.status === "ACHIEVEMENTS_AND_CAPTURE_UI_PASS" && ["zh", "en"].includes(value.language), "Captures need a passing real-package receipt");
    assert(value.packageSha256 === candidate.package.appAsarSha256, "Screenshots were captured from another package");
    assert(value.captures.length === 5, "Expected five actual gameplay captures per language");
    assert(["errors", "consoleErrors", "vueWarnings", "requests", "responses"].every(key => Array.isArray(value[key]) && value[key].length === 0), "Capture run has errors or network requests");
    add(file, `verification/gameplay-${value.language}.json`);
    for (const capture of value.captures) {
      assert(fileHash(capture.path) === capture.sha256, "Capture changed since acceptance");
      const bytes = fs.readFileSync(capture.path);
      assert(bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])), "Capture must be PNG");
      assert(bytes.readUInt32BE(16) === capture.width && bytes.readUInt32BE(20) === capture.height, "Capture dimensions changed");
      add(capture.path, `screenshots/${value.language}/${capture.name}.png`);
    }
  }
  const artDirectory = path.join(workspace, "desktop/release/marketing-art");
  const art = json(path.join(artDirectory, "art-manifest.json"));
  assert(art.status === "LOCAL_ART_DRAFT" && art.items.length === 8, "Expected eight reviewed art draft dimensions");
  for (const item of art.items) {
    const name = safeRelative(`${item.name}.png`);
    const file = path.join(artDirectory, name), bytes = fs.readFileSync(file);
    assert(fileHash(file) === item.sha256 && bytes.readUInt32BE(16) === item.width && bytes.readUInt32BE(20) === item.height, `Art changed: ${item.name}`);
    add(file, `art-drafts/${name}`);
  }
  add(path.join(artDirectory, "art-manifest.json"), "art-drafts/art-manifest.json");
  for (const name of ["store-copy.zh-CN.md", "store-copy.en.md", "TEST_PACKAGE_GUIDE.md", "ART_AND_NAME_REVIEW_20261018.md", "OWNER_MINIMUM_20261019.md", "LAUNCH_FIELDS_20261019.md"]) {
    add(path.join(workspace, "docs/steam", name), `documents/${name}`);
  }
  for (const name of ["README.md", "config.example.json", "cloud-plan.json", "achievement-config.draft.json"]) {
    add(path.join(workspace, "desktop/steam", name), `steam-preparation/${name}`);
  }
  for (const name of ["THIRD_PARTY_NOTICES.md", "DEPENDENCY_LICENSES.txt"]) {
    add(path.join(workspace, "desktop/legal", name), `legal/${name}`);
  }
  add(path.join(workspace, "docs/verification/lifeline-steam-m3/asset-rights-inventory.json"), "verification/asset-rights-inventory.json");
  add(path.join(workspace, "docs/verification/lifeline-steam-m4/provenance-review.json"), "verification/provenance-review.json");
  assert(new Set(sources.map(s => s.destination.toLowerCase())).size === sources.length, "Duplicate kit destination");
  const output = path.join(localOutputRoot("desktop/release/kits"), candidate.id);
  fs.mkdirSync(output); // Existing kits, including failed attempts, are preserved.
  for (const item of sources) {
    const destination = path.join(output, item.destination);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(item.source, destination, fs.constants.COPYFILE_EXCL);
    assert(fileHash(destination) === item.sha256, `Kit copy changed: ${item.destination}`);
  }
  fs.writeFileSync(path.join(output, "README.md"), `# LIFELINE ${candidate.package.version} 本地发行准备包

运行根目录的 ${candidate.portable.path}。此程序尚未签名，进度保存在 Windows 用户应用数据目录。
设置中的备份可手动迁移教学与挑战记录；当前对局另用棋谱保存。

包含十张来自同一验收包的实际游戏截图、八张商店与游戏库素材草稿、双语商店文案、测试反馈表、许可说明和 Steam 配置准备。
已整理 [最小本人事项](documents/OWNER_MINIMUM_20261019.md) 和 [后台填写底稿](documents/LAUNCH_FIELDS_20261019.md)，现在无需逐项填写。

包体 SHA-256：${candidate.portable.sha256}

截图所属 app.asar：${candidate.package.appAsarSha256}

这是本地主机验收及发行资料草稿。没有 Steamworks/AppID，未上传或发布；第二台实体机、真人体验、名称与素材权利清查未完成。
Steam 成就、Cloud 和 Overlay 集成暂未启用，按离线完整游戏首发方案作为可选后续功能。游戏内五项本机成就不代表 Steam 成就。

steam-preparation 中的构建命令以源码仓库为起点，模板不是已生效的后台配置。哈希清单用于检查本地文件完整性，不是数字签名。
独立的 validation-kits/${candidate.id} 目录提供无需开发工具的 Run-check.cmd；该目录不随本资料包自动运行。
`, { flag:"wx" });
  const inventory = filesIn(output);
  verifyInventory(output, inventory);
  fs.writeFileSync(path.join(output, "kit.json"), JSON.stringify({ format:"lifeline-local-release-kit",schemaVersion:1,status:"LOCAL_KIT_COMPLETE",createdAt:new Date().toISOString(),candidateId:candidate.id,
    version:candidate.package.version,appAsarSha256:candidate.package.appAsarSha256,portableSha256:candidate.portable.sha256,inventory,
    boundary:"Local acceptance and drafts only; no Steam upload, signing, rights clearance or external playtest." },null,2)+"\n",{flag:"wx"});
  fs.writeFileSync(path.join(output, "SHA256SUMS.txt"), [...inventory,{path:"kit.json",sha256:fileHash(path.join(output,"kit.json"))}].map(item=>`${item.sha256}  ${item.path}`).join("\n")+"\n",{flag:"wx"});
  console.log(JSON.stringify({status:"LOCAL_KIT_COMPLETE",output,screenshots:10,artDrafts:8,files:inventory.length+2}));
} catch (error) {
  console.error(JSON.stringify({status:"FAIL",reason:error.message}));
  process.exitCode=1;
}
