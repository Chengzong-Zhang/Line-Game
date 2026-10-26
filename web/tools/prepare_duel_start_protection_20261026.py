"""Assemble the duel start-protection hash-bound payload; no network or deployment.

The predecessor JSON must be inspected by the release owner on the server.
Only fixed runtime files, reviewed bundles and toolchain hash inputs are read.
"""

import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import zipfile

from deploy_duel_start_protection_20261026 import RELEASE, TARGETS, EXTRAS

ROOT = Path(__file__).resolve().parents[2]
SOURCES = {
    "legacy-server": "web/web后端/server.py",
    "legacy-bridge": "web/tools/online_bot_bridge.mjs",
    "legacy-runtime": "web/tools/online_bot_runtime.mjs",
    "legacy-package": "web/package.json",
    "wechat-server": "web/web后端/wechat_online.py",
    "wechat-bridge": "web/tools/online_bot_bridge.mjs",
    "wechat-runtime": "web/tools/online_bot_runtime.mjs",
    "wechat-package": "web/package.json",
    "wechat-validator": "wechat/minigame/tools/validate-action.mjs",
}
TREE_KEYS = {"siteManifest", "siteTree", "wechatFrontendTree"}
ALIASES = {"easy", "three-v4", "three-v1", "hex-v1"}
VERIFIER = "web/tools/verify-terminal-release-admission-v4.mjs"
BUILDER = "web/tools/build-server-validator-v2.mjs"


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def safe(name):
    return (
        isinstance(name, str)
        and bool(name)
        and not name.startswith("/")
        and "\\" not in name
        and ":" not in name
        and all(part not in ("", ".", "..") for part in name.split("/"))
    )


def plain_file(file):
    for entry in (file, *file.parents):
        if entry.is_symlink() or (
            hasattr(entry, "is_junction") and entry.is_junction()
        ):
            raise ValueError("symlink/junction rejected: " + str(entry))
    if not file.is_file():
        raise ValueError("ordinary file required: " + str(file))
    return file


def read(file):
    return plain_file(file).read_bytes()


def sha(file):
    return digest(read(file))


def hashed(value):
    return isinstance(value, str) and re.fullmatch("[a-f0-9]{64}", value) is not None


def source(root, name):
    if not safe(name):
        raise ValueError("unsafe source path")
    return root / name


def current_head(root):
    return subprocess.check_output(
        ["git", "rev-parse", "HEAD"], cwd=root, text=True, encoding="utf-8"
    ).strip()


def verify_validator_inputs(root, bundle, manifest):
    completed = subprocess.run(
        ["node", str(root / BUILDER), "verify-inputs", "--bundle", str(bundle)],
        check=True,
        timeout=60,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    proof = json.loads(completed.stdout)
    if (
        proof.get("status") != "PASS_REBUILT_NODE22_VALIDATOR_INPUTS"
        or proof.get("bundleSha256") != manifest["bundleSha256"]
        or proof.get("sourceCount") != len(manifest["sourceHashes"])
        or proof.get("nativeCompatibilityCount") != len(manifest["nativeCompatibility"])
    ):
        raise ValueError("validator independently rebuilt input proof differs")


def validate_validator(root, bundle):
    if bundle.name != "validate-action.mjs":
        raise ValueError("expected validate-action.mjs")
    manifest_path, receipt_path, verification_path = (
        bundle.with_name(name)
        for name in ("manifest.json", "build-receipt.json", "verification.json")
    )
    raw = read(bundle)
    manifest = json.loads(read(manifest_path))
    receipt = json.loads(read(receipt_path))
    probes = json.loads(read(verification_path))
    if (
        manifest.get("schemaVersion") != 1
        or manifest.get("kind") != "standalone-native-rule-validator-v2"
        or manifest.get("target") != "node22"
        or manifest.get("compiler") != "0.25.12"
        or digest(raw) != manifest.get("bundleSha256")
        or len(raw) != manifest.get("bundleBytes")
    ):
        raise ValueError("validator bundle/target/compiler mismatch")
    if (
        receipt.get("status") != "BUILT_AND_VERIFIED_LOCAL_NOT_DEPLOYED"
        or receipt.get("bundle", {}).get("sha256") != digest(raw)
        or receipt.get("manifest", {}).get("sha256") != sha(manifest_path)
        or receipt.get("verification", {}).get("sha256") != sha(verification_path)
        or receipt.get("compilerHashes") != manifest.get("compilerHashes")
        or probes.get("status") != "PASS_NODE22_CANONICAL_STATE_APPLY_2_6_7_15"
        or probes.get("bundleSha256") != digest(raw)
        or len(probes.get("records", [])) != 24
        or receipt.get("probes") != 24
        or not re.fullmatch(r"v22\.\d+\.\d+", probes.get("node", ""))
    ):
        raise ValueError("validator build/probe receipt mismatch")
    covered = {(row.get("players"), row.get("kind")) for row in probes["records"]}
    if covered != {
        (count, kind) for count in (2, 6, 7, 15) for kind in ("STATE", "APPLY")
    }:
        raise ValueError("validator missing player-count/action coverage")
    hashes = manifest.get("sourceHashes", {})
    if not isinstance(hashes, dict) or not {
        BUILDER,
        "wechat/minigame/tools/validate-action.mjs",
        "wechat/minigame/src/state.js",
        "web/web前端/GameEngine.js",
        "wechat/minigame/tools/web-compat.mjs",
        "wechat/minigame/compat/web/manifest.json",
    }.issubset(hashes):
        raise ValueError("validator source inventory incomplete")
    for name, expected in hashes.items():
        allowed = name in {
            BUILDER,
            "wechat/minigame/tools/validate-action.mjs",
            "wechat/minigame/tools/web-compat.mjs",
        } or any(
            name.startswith(prefix)
            for prefix in (
                "wechat/minigame/src/",
                "web/web前端/",
                "wechat/minigame/compat/web/",
                "wechat/minigame/node_modules/@noble/hashes/",
            )
        )
        if (
            not allowed
            or Path(name).suffix not in (".js", ".mjs", ".json")
            or not hashed(expected)
            or sha(source(root, name)) != expected
        ):
            raise ValueError("validator source drift: " + name)
    if receipt.get("sourceCount") != len(hashes):
        raise ValueError("validator source count mismatch")
    native = json.loads(read(root / "wechat/minigame/compat/web/manifest.json"))
    compatibility = manifest.get("nativeCompatibility", {})
    expected_native = {name for name in native.get("overrides", {}) if name in hashes}
    if set(compatibility) != expected_native or receipt.get(
        "nativeCompatibilityCount"
    ) != len(expected_native):
        raise ValueError("native compatibility inventory/count mismatch")
    for name, row in compatibility.items():
        expected = {
            key: native["overrides"][name].get(key)
            for key in ("canonicalSha256", "override", "overrideSha256")
        }
        if (
            row != expected
            or hashes.get(name) != row.get("canonicalSha256")
            or hashes.get(row.get("override")) != row.get("overrideSha256")
        ):
            raise ValueError("native compatibility binding changed")
    compiler = manifest.get("compilerHashes", {})
    if set(compiler) != {"package", "lock", "javascript", "binary"}:
        raise ValueError("compiler hash inventory mismatch")
    package = Path(compiler["package"]["path"])
    if package.parts[-3:] != ("node_modules", "esbuild", "package.json"):
        raise ValueError("unexpected compiler package path")
    tool = package.parents[2]
    expected_paths = {
        "package": tool / "node_modules/esbuild/package.json",
        "lock": tool / "package-lock.json",
        "javascript": tool / "node_modules/esbuild/lib/main.js",
    }
    binary = Path(compiler["binary"]["path"])
    if (
        binary.parent.parent == tool / "node_modules/@esbuild"
        and binary.parent.name.startswith("win32-")
        and binary.name == "esbuild.exe"
    ):
        expected_paths["binary"] = binary
    elif (
        binary.parent.name == "bin"
        and binary.parent.parent.parent == tool / "node_modules/@esbuild"
        and binary.name == "esbuild"
    ):
        expected_paths["binary"] = binary
    else:
        raise ValueError("unexpected compiler binary path")
    for key, file in expected_paths.items():
        if (
            Path(compiler[key]["path"]) != file
            or not hashed(compiler[key].get("sha256"))
            or sha(file) != compiler[key]["sha256"]
        ):
            raise ValueError("compiler hash changed: " + key)
    verify_validator_inputs(root, bundle, manifest)
    return (
        manifest,
        raw,
        {
            str(file): sha(file)
            for file in (manifest_path, receipt_path, verification_path)
        },
    )


def validate_terminal_policy(root, envelope, files):
    name = "PassTrainedPolicyData.js"
    policy = envelope.get("terminal_trained_policy", {})
    if (
        name not in files
        or policy.get("activation") != "PASS_DISCIPLINE_SCOPED"
        or set(policy.get("models", {})) != ALIASES
    ):
        raise ValueError("terminal policies must have completed scoped admission")
    raw = read(root / "web/web前端" / name)
    match = re.fullmatch(
        r"\s*(?://[^\n]*\n)*export const PASS_TRAINED_POLICY_DATA = Object\.freeze\((\{[\s\S]*\})\);?\s*",
        raw.decode("utf-8"),
    )
    if match is None or json.loads(match.group(1)) != policy:
        raise ValueError("frontend policy envelope differs from canonical source")
    summary = envelope.get("terminal_admission", {})
    body = {key: value for key, value in summary.items() if key != "summary_sha256"}
    # The shared verifier seals JSON.stringify insertion order; JSON loading
    # preserves it here. The summary consists of JSON strings/hash dictionaries.
    seal = digest(json.dumps(body, separators=(",", ":"), ensure_ascii=False).encode())
    if (
        summary.get("schema") != "lifeline-terminal-release-admission-v4"
        or summary.get("status") != "PASS_TERMINAL_RELEASE_ADMISSION_V4"
        or summary.get("summary_sha256") != seal
        or summary.get("policy_data_sha256") != digest(raw)
        or summary.get("admission_report_sha256")
        != policy.get("admission_report_sha256")
        or not hashed(policy.get("admission_report_sha256"))
        or summary.get("verifier_sha256") != sha(root / VERIFIER)
        or set(summary.get("candidate_hashes", {})) != ALIASES
        or set(summary.get("runtime_parameters_sha256", {})) != ALIASES
        or not isinstance(summary.get("scope"), str)
        or not summary["scope"]
    ):
        raise ValueError("terminal admission summary integrity/binding mismatch")
    for alias in ALIASES:
        model = policy["models"][alias]
        if (
            not hashed(model.get("candidate_sha256"))
            or summary["candidate_hashes"][alias] != model["candidate_sha256"]
            or not hashed(summary["runtime_parameters_sha256"][alias])
        ):
            raise ValueError("terminal candidate identity mismatch: " + alias)
    # Reuse JavaScript number serialization and the shared summary contract for
    # an exact binding to all deployed placement/PASS coefficients.
    program = """import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const {assertTerminalAdmissionSummary}=await import(pathToFileURL(process.argv[2]));
let raw='';for await(const chunk of process.stdin)raw+=chunk;
const {policy,summary,policyHash}=JSON.parse(raw);
assertTerminalAdmissionSummary(summary,policyHash);
if(policy.reward?.gamma!==1||policy.reward?.nonterminal_reward!==0||policy.reward?.type!=='terminal-outcome-native-margin-area-v1')throw Error('REWARD');
for(const [alias,model]of Object.entries(policy.models)){
if(model.weights?.length!==17||!model.weights.every(Number.isFinite)||model.passBias!==model.weights[16])throw Error('PARAMETERS');
const parameters={weights:model.weights.slice(0,16),passBias:model.passBias,temperature:1,rules_version:'territory-v3'};
if(createHash('sha256').update(JSON.stringify(parameters)).digest('hex')!==summary.runtime_parameters_sha256[alias])throw Error('PARAMETER_BINDING');
}"""
    subprocess.run(
        [
            "node",
            "--input-type=module",
            "-e",
            program,
            "terminal-payload-check",
            str(root / VERIFIER),
        ],
        input=json.dumps(
            {"policy": policy, "summary": summary, "policyHash": digest(raw)}
        ),
        text=True,
        encoding="utf-8",
        check=True,
        timeout=30,
        capture_output=True,
    )


def prepare(web_bundle, validator_bundle, before_json, output, *, root=ROOT):
    if (
        set(SOURCES) != set(TARGETS)
        or RELEASE != "web-duel-start-protection-20261026-r1"
    ):
        raise ValueError("deployer contract changed")
    if output.exists():
        raise ValueError("new output directory required")
    for entry in output.parents:
        if entry.is_symlink() or (
            hasattr(entry, "is_junction") and entry.is_junction()
        ):
            raise ValueError("output parent is a symlink/junction")
    if before_json.suffix != ".json":
        raise ValueError("predecessor snapshot must be JSON")
    before_raw = read(before_json)
    before = json.loads(before_raw)
    before = before.get("before", before)
    if set(before) != set(TARGETS) | TREE_KEYS or any(
        value is None and key in TREE_KEYS or value is not None and not hashed(value)
        for key, value in before.items()
    ):
        raise ValueError("incomplete or invalid server predecessor hashes")
    validator, validator_raw, validator_evidence = validate_validator(
        root, validator_bundle
    )
    manifest_raw = read(web_bundle / "release-manifest.json")
    envelope = json.loads(manifest_raw)
    head = current_head(root)
    if (
        envelope.get("release_id") != RELEASE
        or not re.fullmatch("[a-f0-9]{40}", head)
        or envelope.get("commit") != head
    ):
        raise ValueError(
            "frontend release/current HEAD mismatch; rebuild after source commit"
        )
    files = envelope.get("files")
    if (
        not isinstance(files, dict)
        or not files
        or not all(safe(name) and hashed(value) for name, value in files.items())
    ):
        raise ValueError("invalid frontend inventory")
    frontend = root / "web/web前端"
    required = {
        file.relative_to(frontend).as_posix()
        for file in frontend.rglob("*")
        if file.is_file()
        and not any(part.startswith(".") for part in file.relative_to(frontend).parts)
        and not file.relative_to(frontend).as_posix().startswith("tests/")
        and file.name != "smoke-test.html"
    }
    if set(files) != required:
        raise ValueError("frontend does not contain the complete current runtime")
    archive_path = web_bundle / "frontend-overlay.zip"
    archive_raw = read(archive_path)
    with zipfile.ZipFile(archive_path) as archive:
        names = archive.namelist()
        if (
            len(names) != len(set(names))
            or set(names) != set(files) | {"release-manifest.json"}
            or archive.read("release-manifest.json") != manifest_raw
        ):
            raise ValueError("frontend archive inventory/envelope mismatch")
        for name, expected in files.items():
            if (
                sha(frontend / name) != expected
                or digest(archive.read(name)) != expected
            ):
                raise ValueError("frontend source/archive drift: " + name)
    validate_terminal_policy(root, envelope, files)
    if json.loads(read(root / "web/package.json")).get("type") != "module":
        raise ValueError("Node runtime requires type=module")
    frozen = {
        key: validator_raw if key == "wechat-validator" else read(source(root, name))
        for key, name in SOURCES.items()
    }
    frozen["frontend-overlay.zip"] = archive_raw
    frozen["atomic_frontend_release.py"] = read(
        root / "web/tools/atomic_frontend_release.py"
    )
    deployer = read(root / "web/tools/deploy_duel_start_protection_20261026.py")
    if set(frozen) != set(TARGETS) | EXTRAS:
        raise ValueError("payload inventory differs from deployer")
    # Revalidate every captured source before making a new output directory.
    again, again_raw, again_evidence = validate_validator(root, validator_bundle)
    if (
        again != validator
        or again_raw != validator_raw
        or again_evidence != validator_evidence
    ):
        raise ValueError("validator changed during freeze")
    for name, expected in files.items():
        if sha(frontend / name) != expected:
            raise ValueError("frontend changed during freeze: " + name)
    for key, name in SOURCES.items():
        if key != "wechat-validator" and read(root / name) != frozen[key]:
            raise ValueError("runtime changed during freeze: " + name)
    if (
        read(archive_path) != archive_raw
        or read(web_bundle / "release-manifest.json") != manifest_raw
        or read(before_json) != before_raw
        or current_head(root) != head
        or read(root / "web/tools/deploy_duel_start_protection_20261026.py") != deployer
        or read(root / "web/tools/atomic_frontend_release.py")
        != frozen["atomic_frontend_release.py"]
    ):
        raise ValueError("release input changed during freeze")
    output.mkdir(parents=True, exist_ok=False)
    staged = output / "payload"
    staged.mkdir()
    for name, raw in frozen.items():
        (staged / name).write_bytes(raw)
    (output / "remote-release.py").write_bytes(deployer)
    archive_path = output / "payload.zip"
    with zipfile.ZipFile(
        archive_path, "x", compression=zipfile.ZIP_DEFLATED
    ) as archive:
        for name, raw in sorted(frozen.items()):
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, raw)
    payload = {name: digest(raw) for name, raw in sorted(frozen.items())}
    manifest = {
        "schemaVersion": 1,
        "releaseId": RELEASE,
        "commit": head,
        "before": before,
        "payload": payload,
        "archiveSha256": sha(archive_path),
        "deployerSha256": digest(deployer),
        "siteCandidateManifestSha256": digest(manifest_raw),
    }
    (output / "deployment-manifest.json").write_text(
        json.dumps(manifest, indent=2) + "\n", encoding="utf-8"
    )
    receipt = {
        "schema": "lifeline-duel-start-protection-release-preparation-v1",
        "status": "FROZEN_LOCAL_NOT_DEPLOYED",
        "releaseId": RELEASE,
        "commit": head,
        "payloadFiles": len(payload),
        "completeFrontendFiles": len(files),
        "archiveSha256": manifest["archiveSha256"],
        "deployerSha256": manifest["deployerSha256"],
        "deploymentManifestSha256": sha(output / "deployment-manifest.json"),
        "beforeJsonSha256": digest(before_raw),
        "validatorBundleSha256": validator["bundleSha256"],
        "validatorEvidence": validator_evidence,
        "sameFrontendForService": True,
        "networkAccess": False,
        "databaseReplacement": False,
        "sourceEdits": False,
    }
    (output / "preparation.json").write_text(
        json.dumps(receipt, indent=2) + "\n", encoding="utf-8"
    )
    return receipt


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--web-bundle", type=Path, required=True)
    parser.add_argument("--validator-bundle", type=Path, required=True)
    parser.add_argument("--before-json", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    print(
        json.dumps(
            prepare(
                args.web_bundle.absolute(),
                args.validator_bundle.absolute(),
                args.before_json.absolute(),
                args.output.absolute(),
            )
        )
    )
