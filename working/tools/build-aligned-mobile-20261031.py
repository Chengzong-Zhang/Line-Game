"""Build the isolated 2026-10-31 mobile diagnostic candidate.

This does not create the candidate or resolve native admission failures. It
requires the separately reviewed, hash-bound aligned manifests and preserves
the original frozen manifest. No publishing or network dependency install.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import zipfile

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CANDIDATE = ROOT / "local_artifacts" / "alignment-20261031" / "mobile"
ASSETS = (
    "GameEngine.js",
    "TopologyGameEngine.js",
    "frozen-workers/web-topology-fix-20261030-r2/AIEngine.js",
    "GuideArticleFormat.js",
    "GuideImplementation.js",
    "OnlineApp.js",
    "OnlineAppI18n.js",
    "platform/TutorialHost.js",
    "platform/haptics-controller.js",
    "TurnOrderSetup.js",
    "LocalPlayerSetup.js",
    "styles.css",
)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def run(argv, cwd, env=None):
    print("+", " ".join(map(str, argv)), flush=True)
    subprocess.run(argv, cwd=cwd, env=env, check=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--candidate", type=Path, default=DEFAULT_CANDIDATE,
                        help="prepared isolated source candidate")
    parser.add_argument("--android", action="store_true",
                        help="also sync and build an offline debug APK")
    args = parser.parse_args()
    candidate = args.candidate.resolve(strict=True)
    if candidate == ROOT or not candidate.is_relative_to(ROOT):
        raise RuntimeError("Candidate must be an isolated directory inside the repository.")
    mobile = candidate / "mobile"
    web = candidate / "web" / "web前端"
    (mobile / "local_artifacts").mkdir(parents=True, exist_ok=True)
    manifest = json.loads((mobile / "config" / "aligned-sync-manifest.json").read_text(encoding="utf-8"))
    adaptations = {x["path"]: x for x in manifest["mobile_adaptations"]}
    for name, source_hash in manifest["source_files"].items():
        expected = adaptations.get(name, {}).get("mobile_sha256", source_hash)
        actual = digest((web / name).read_bytes())
        if actual != expected:
            raise RuntimeError(f"Candidate source does not match aligned manifest: {name}")
    run(["npm.cmd", "run", "build"], mobile)
    receipt = json.loads((mobile / "local_artifacts" / "mobile-web-build-receipt.json").read_text(encoding="utf-8"))
    if receipt.get("status") != "DIAGNOSTIC-UNVERIFIED":
        raise RuntimeError("Expected the candidate's diagnostic-only receipt.")
    if not args.android:
        print("Diagnostic Web build only; native admission remains unverified.")
        return
    env = os.environ.copy()
    for name in ("LIFELINE_JAVA_HOME", "LIFELINE_ANDROID_SDK", "LIFELINE_GRADLE"):
        if not env.get(name):
            raise RuntimeError(f"Set {name} to an existing local toolchain path.")
    env["JAVA_HOME"] = env["LIFELINE_JAVA_HOME"]
    env["ANDROID_HOME"] = env["LIFELINE_ANDROID_SDK"]
    env["ANDROID_SDK_ROOT"] = env["LIFELINE_ANDROID_SDK"]
    env["GRADLE_USER_HOME"] = str(mobile / "android" / ".candidate-gradle")
    run(["npx.cmd", "--no-install", "cap", "sync", "android"], mobile, env)
    run([env["LIFELINE_GRADLE"], "--offline", "--no-daemon", ":app:assembleDebug", "--console=plain"],
        mobile / "android", env)
    apk = mobile / "android" / "app" / "build" / "outputs" / "apk" / "debug" / "app-debug.apk"
    with zipfile.ZipFile(apk) as archive:
        for name in ASSETS:
            if digest(archive.read("assets/public/" + name)) != digest((mobile / "dist" / name).read_bytes()):
                raise RuntimeError(f"APK resource does not match built candidate: {name}")
    print(json.dumps({"status": "DIAGNOSTIC-UNVERIFIED",
                      "apk": str(apk), "sha256": digest(apk.read_bytes()),
                      "checked_assets": ASSETS}, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError) as exc:
        print(f"Diagnostic build failed: {exc}", file=sys.stderr)
        sys.exit(1)
