"""Hash-bound standalone collector installation; keeps the game server running.

Run on the Linux server as ubuntu with sudo -n. Config and service rollback
are independent of atomic_frontend_release.py's complete frontend rollback.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import tarfile
import urllib.request
import zipfile

RELEASE = "web-training-data-v1-20261013"
ROOT = Path("/home/ubuntu/line-game")
ARTIFACTS = ROOT / ".deploy-artifacts"
PACKAGE = ARTIFACTS / f"{RELEASE}-collector"
RUNTIME = ARTIFACTS / f"{RELEASE}-node"
DATA = Path("/home/ubuntu/line-game-data/training-contributions-v1")
NGINX = Path("/etc/nginx/conf.d/lifeline.conf")
UNIT_NAME = "lifeline-training-contributions.service"
RECEIPT = ARTIFACTS / f"{RELEASE}.collector.json"
def sha(raw): return hashlib.sha256(raw).hexdigest()
def run(*args): return subprocess.run(args, check=True, capture_output=True, text=True).stdout.strip()
def new_json(path, value):
    with path.open("x", encoding="utf-8") as stream: json.dump(value, stream, indent=2)
def fetch(url):
    with urllib.request.urlopen(url, timeout=40) as response: return response.read()
def install_node():
    # Official portable runtime, confined to this release; no system package changes.
    entries = json.loads(fetch("https://nodejs.org/dist/index.json"))
    version = next(e["version"] for e in entries if re.fullmatch(r"v22\.\d+\.\d+", e["version"]) and "linux-x64" in e["files"])
    name = f"node-{version}-linux-x64.tar.xz"
    expected = next(line.split()[0] for line in fetch(f"https://nodejs.org/dist/{version}/SHASUMS256.txt").decode().splitlines() if line.split()[-1] == name)
    archive = fetch(f"https://nodejs.org/dist/{version}/{name}")
    if sha(archive) != expected: raise RuntimeError("Official Node archive SHA mismatch")
    RUNTIME.mkdir(); archive_file = ARTIFACTS / name
    with archive_file.open("xb") as stream: stream.write(archive)
    with tarfile.open(archive_file) as bundle:
        members = [m for m in bundle.getmembers() if m.name.endswith("/bin/node") and m.isfile()]
        if len(members) != 1: raise RuntimeError("Node executable inventory mismatch")
        executable = bundle.extractfile(members[0]).read()
    (RUNTIME / "node").write_bytes(executable); (RUNTIME / "node").chmod(0o755)
    return {"version": run(str(RUNTIME / "node"), "--version"), "archive_sha256": expected, "binary_sha256": sha(executable), "source": f"https://nodejs.org/dist/{version}/{name}"}
def install(args):
    if PACKAGE.exists() or RUNTIME.exists() or RECEIPT.exists(): raise RuntimeError("Collector release already exists")
    if Path(f"/etc/systemd/system/{UNIT_NAME}").exists(): raise RuntimeError("Collector service already exists")
    archive = args.archive.resolve(); archive.relative_to(ARTIFACTS)
    if sha(archive.read_bytes()) != args.sha256: raise RuntimeError("Collector archive hash mismatch")
    with zipfile.ZipFile(archive) as bundle:
        manifest = json.loads(bundle.read("collector-manifest.json"))
        if manifest["release_id"] != RELEASE or set(bundle.namelist()) != set(manifest["files"]) | {"collector-manifest.json"}: raise RuntimeError("Collector inventory mismatch")
        PACKAGE.mkdir()
        for name, expected in manifest["files"].items():
            destination = PACKAGE / name; destination.resolve().relative_to(PACKAGE.resolve())
            if Path(name).is_absolute() or ".." in Path(name).parts: raise RuntimeError("Collector path escape")
            raw = bundle.read(name)
            if sha(raw) != expected: raise RuntimeError("Collector file SHA mismatch")
            destination.parent.mkdir(parents=True, exist_ok=True); destination.write_bytes(raw)
    runtime = install_node(); DATA.mkdir(parents=True, exist_ok=True); DATA.chmod(0o700)
    python = ROOT / "web/web后端/.venv/bin/python"
    run(str(python), "-c", "import fastapi,uvicorn; print(fastapi.__version__)")
    if run("sh", "-c", "ss -ltnH 'sport = :8005'"): raise RuntimeError("Collector port already occupied")
    original = NGINX.read_bytes(); original_hash = sha(original)
    marker = "    listen 443 ssl;\n    server_name lifelinegame.cn www.lifelinegame.cn;\n"
    text = original.decode()
    if text.count(marker) != 1 or "/api/training/" in text: raise RuntimeError("Nginx target structure changed")
    location = """
    # LIFELINE opt-in replay collector v1; no account/game routing changes.
    location /api/training/ {
        client_max_body_size 512k;
        proxy_pass http://127.0.0.1:8005;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 30s;
        proxy_send_timeout 30s;
    }
"""
    updated = text.replace(marker, marker + location).encode()
    backup = ARTIFACTS / f"{RELEASE}.nginx-original.conf"; backup.write_bytes(original)
    candidate = ARTIFACTS / f"{RELEASE}.nginx-candidate.conf"; candidate.write_bytes(updated)
    unit = f"""[Unit]
Description=LIFELINE opt-in anonymous replay collector
After=network.target
StartLimitIntervalSec=120
StartLimitBurst=5
[Service]
User=ubuntu
Group=ubuntu
WorkingDirectory={PACKAGE}/web/web后端
Environment=LIFELINE_CONTRIBUTIONS_DIR={DATA}
Environment=LIFELINE_NODE={RUNTIME}/node
ExecStart={python} -m uvicorn contribution_asgi:app --host 127.0.0.1 --port 8005 --proxy-headers --forwarded-allow-ips=127.0.0.1 --no-access-log
Restart=on-failure
RestartSec=5
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths={DATA}
MemoryMax=512M
TasksMax=64
[Install]
WantedBy=multi-user.target
"""
    unit_file = ARTIFACTS / UNIT_NAME; unit_file.write_text(unit)
    installed = False
    try:
        run("sudo", "-n", "install", "-m", "644", str(unit_file), f"/etc/systemd/system/{UNIT_NAME}")
        run("sudo", "-n", "systemctl", "daemon-reload")
        run("sudo", "-n", "systemctl", "enable", "--now", UNIT_NAME)
        for _ in range(30):
            try:
                if json.loads(fetch("http://127.0.0.1:8005/api/training/contributions/status"))["enabled"]: break
            except (OSError, ValueError):
                import time; time.sleep(.2)
        else: raise RuntimeError("Collector did not become healthy")
        if sha(NGINX.read_bytes()) != original_hash: raise RuntimeError("Nginx changed during preparation")
        run("sudo", "-n", "install", "-m", "644", str(candidate), str(NGINX)); installed = True
        run("sudo", "-n", "nginx", "-t"); run("sudo", "-n", "systemctl", "reload", "nginx")
    except Exception:
        if installed:
            run("sudo", "-n", "install", "-m", "644", str(backup), str(NGINX)); run("sudo", "-n", "nginx", "-t"); run("sudo", "-n", "systemctl", "reload", "nginx")
        run("sudo", "-n", "systemctl", "disable", "--now", UNIT_NAME)
        raise
    receipt = {"status": "COLLECTOR_ACTIVE", "release_id": RELEASE, "commit": manifest["commit"], "archive_sha256": args.sha256, "files": manifest["files"], "runtime": runtime, "nginx_before_sha256": original_hash, "nginx_after_sha256": sha(updated), "nginx_backup": str(backup), "service": UNIT_NAME, "data_directory": str(DATA), "game_service_restarted": False}
    new_json(RECEIPT, receipt); print(json.dumps(receipt))
def rollback():
    receipt = json.loads(RECEIPT.read_text())
    if sha(NGINX.read_bytes()) != receipt["nginx_after_sha256"]: raise RuntimeError("Nginx changed; rollback refused")
    backup = Path(receipt["nginx_backup"])
    if sha(backup.read_bytes()) != receipt["nginx_before_sha256"]: raise RuntimeError("Nginx rollback hash mismatch")
    run("sudo", "-n", "install", "-m", "644", str(backup), str(NGINX)); run("sudo", "-n", "nginx", "-t"); run("sudo", "-n", "systemctl", "reload", "nginx")
    run("sudo", "-n", "systemctl", "disable", "--now", UNIT_NAME)
    new_json(ARTIFACTS / f"{RELEASE}.collector-rollback.json", {"status": "COLLECTOR_ROLLED_BACK", "data_preserved": True})
    print("COLLECTOR_ROLLED_BACK")
if __name__ == "__main__":
    parser = argparse.ArgumentParser(); parser.add_argument("command", choices=["install", "rollback"]); parser.add_argument("--archive", type=Path); parser.add_argument("--sha256")
    args = parser.parse_args()
    if args.command == "install": install(args)
    else: rollback()
