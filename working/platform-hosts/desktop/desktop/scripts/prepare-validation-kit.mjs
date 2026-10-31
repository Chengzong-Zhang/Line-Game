import fs from "node:fs";
import path from "node:path";
import { workspace, assert, fileHash, filesIn, verifyCandidate, localOutputRoot } from "./release-lib.mjs";

// A standalone recipient needs Windows PowerShell 5.1 only. Generation uses
// the development machine; running the resulting kit does not need Node.
const [candidateArgument, kitId] = process.argv.slice(2);
const xml = value => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
try {
  assert(candidateArgument && /^[a-z0-9][a-z0-9.-]{2,70}$/.test(kitId ?? ""), "Usage: prepare-validation-kit <candidate-directory> <new-kit-id>");
  const candidateDirectory = path.resolve(candidateArgument), candidate = verifyCandidate(candidateDirectory);
  assert(/^LIFELINE-[0-9][A-Za-z0-9.-]*-x64-portable\.exe$/.test(candidate.portable.path), "Unsupported portable name");
  const output = path.join(localOutputRoot("desktop/release/validation-kits"), kitId);
  fs.mkdirSync(output); // Preserve any existing kit, even if incomplete.
  const copy = (source, relative) => {
    const destination = path.join(output, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
    assert(fileHash(source) === fileHash(destination), `Copy mismatch: ${relative}`);
  };
  copy(path.join(candidateDirectory, candidate.portable.path), `candidate/${candidate.portable.path}`);
  copy(path.join(candidateDirectory, "candidate.json"), "candidate/candidate.json");
  copy(path.join(workspace, "desktop/scripts/Test-LifelineCandidate.ps1"), "Test-LifelineCandidate.ps1");
  fs.writeFileSync(path.join(output, "Run-check.cmd"), '@echo off\r\n"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0Test-LifelineCandidate.ps1" -CandidateDirectory "%~dp0candidate" -OutputRoot "%~dp0results"\r\nset "CHECK_RESULT=%ERRORLEVEL%"\r\necho.\r\necho Result files are in the results folder.\r\npause\r\nexit /b %CHECK_RESULT%\r\n', { flag:"wx" });
  const sandboxResults = path.join(output, "sandbox-results");
  fs.mkdirSync(sandboxResults);
  fs.writeFileSync(path.join(output, "Optional-Windows-Sandbox.wsb"), `<?xml version="1.0" encoding="utf-8"?>
<Configuration>
  <Networking>Disable</Networking>
  <ClipboardRedirection>Disable</ClipboardRedirection>
  <MappedFolders>
    <MappedFolder><HostFolder>${xml(output)}</HostFolder><SandboxFolder>C:\\LifelineCheck</SandboxFolder><ReadOnly>true</ReadOnly></MappedFolder>
    <MappedFolder><HostFolder>${xml(sandboxResults)}</HostFolder><SandboxFolder>C:\\LifelineResults</SandboxFolder><ReadOnly>false</ReadOnly></MappedFolder>
  </MappedFolders>
  <LogonCommand><Command>powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\\LifelineCheck\\Test-LifelineCandidate.ps1 -CandidateDirectory C:\\LifelineCheck\\candidate -OutputRoot C:\\LifelineResults -EnvironmentLabel windows-sandbox</Command></LogonCommand>
</Configuration>
`, { flag:"wx" });
  fs.writeFileSync(path.join(output, "README.md"), `# LIFELINE 自动检查包 ${candidate.package.version}

双击 Run-check.cmd。无需安装 Node、Python、浏览器或 Steam；不需要管理员权限。
脚本会校验候选文件，在独立临时档案中启动游戏、完成五课教学、落子、正常退出并重开，最后写入 results 下的新目录。
不会使用你的正常游戏存档。结果为 ISOLATED_RUNTIME_PASS 才表示这些步骤通过；任何失败都会留下 result.json，可能另有 failure.png。第一次运行可能需要几十秒解包。

Windows 自带 PowerShell 的本次进程策略只用于运行本目录脚本，不修改系统设置。程序尚未签名；哈希校验表示文件一致，不是身份认证或数字签名。
离线运行脚本不需要联网；同机检查只是观察到无渲染器联网请求，并非全系统网络抓包。

若系统已安装 Windows Sandbox，可选用 Optional-Windows-Sandbox.wsb；配置禁用沙盒网络和剪贴板，测试包只读，仅 sandbox-results 可写。它绑定此电脑当前绝对路径，移动目录后需重新生成配置；不要求为此安装功能或重启。沙盒未安装时直接使用 Run-check.cmd 即可。

候选：${candidate.id}
便携包 SHA-256：${candidate.portable.sha256}
app.asar SHA-256：${candidate.package.appAsarSha256}

完整校验清单在 SHA256SUMS.txt。result.json 的 callerDeclaredEnvironment 仅记录启动方声明，environmentAttested 始终为 false；声明 windows-sandbox 不证明真的运行在沙盒中。两种入口均不能冒充第二台实体机、真人体验、最低硬件或 Steam 客户端验收。IntegrityOnly 模式仅检查完整性，不启动游戏。
本包不会上传任何文件，不会自动向开发者发送结果。
`, { flag:"wx" });
  const inventory = filesIn(output);
  const record = { format:"lifeline-standalone-validation-kit", schemaVersion:1, status:"KIT_PREPARED_RUNTIME_NOT_IMPLIED", createdAt:new Date().toISOString(), candidateId:candidate.id, portableSha256:candidate.portable.sha256, appAsarSha256:candidate.package.appAsarSha256, inventory };
  fs.writeFileSync(path.join(output, "validation-kit.json"), JSON.stringify(record,null,2)+"\n", {flag:"wx"});
  fs.writeFileSync(path.join(output, "SHA256SUMS.txt"), [...inventory,{path:"validation-kit.json",sha256:fileHash(path.join(output,"validation-kit.json"))}].map(f=>`${f.sha256}  ${f.path}`).join("\n")+"\n", {flag:"wx"});
  console.log(JSON.stringify({status:record.status,output,files:inventory.length+2,candidateId:candidate.id}));
} catch (error) {
  console.error(JSON.stringify({status:"FAIL",reason:error.message}));
  process.exitCode=1;
}
