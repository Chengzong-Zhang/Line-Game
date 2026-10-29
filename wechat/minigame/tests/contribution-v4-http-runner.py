"""Run native UI/outbox through a real loopback collector with its real Node validator."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import socket
import sqlite3
import subprocess
import tempfile
import threading
import time
from fastapi import FastAPI
import uvicorn

ROOT = Path(__file__).resolve().parents[3]
SOURCES = ['wechat/minigame/src/app.js', 'wechat/minigame/src/training-contribution.js',
           'wechat/minigame/src/contribution-transport.js', 'wechat/minigame/src/worker-runtime.js',
           'web/tools/training_contribution_schema.mjs', 'web/tools/validate_contribution.mjs',
           'web/tools/validate_contribution_v4.mjs', 'web/web后端/training_contributions.py']


def hashes():
    return {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in SOURCES}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    before = hashes()
    scratch = ROOT / 'working/local_artifacts'
    scratch.mkdir(parents=True, exist_ok=True)
    data = Path(tempfile.mkdtemp(prefix='contribution-v4-http-', dir=scratch))
    spec = importlib.util.spec_from_file_location('http_collector_v4', ROOT / 'web/web后端/training_contributions.py')
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    store = module.ContributionStore(data / 'inbox', node=shutil.which('node'))
    app = FastAPI(); app.include_router(module.create_router(store))
    sock = socket.socket(); sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(app, log_level='error', access_log=False))
    thread = threading.Thread(target=server.run, kwargs={'sockets': [sock]}, daemon=True); thread.start()
    try:
        deadline = time.monotonic() + 10
        while not server.started and time.monotonic() < deadline:
            time.sleep(.02)
        assert server.started
        command = [shutil.which('node'), str(ROOT / 'wechat/minigame/tests/contribution-v4-http-e2e.mjs'),
                   f'http://127.0.0.1:{port}', str(data / 'client.json')]
        subprocess.run(command, cwd=ROOT, check=True, timeout=180)
        report = json.loads((data / 'client.json').read_text())
        with sqlite3.connect(store.database) as db:
            counts = {table: db.execute(f'SELECT COUNT(*) FROM {table}').fetchone()[0]
                      for table in ['inbox', 'inbox_v2', 'inbox_v3', 'inbox_v4']}
        assert counts == {'inbox': 0, 'inbox_v2': 0, 'inbox_v3': 0, 'inbox_v4': 4}
        assert hashes() == before, 'Concurrent source change invalidates this receipt'
        report.update(sourceHashes=before, isolatedTableCounts=counts, realNodeValidator=True,
                      productionDataRead=False, deviceVerified=False)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        with args.output.open('x', encoding='utf-8') as handle:
            json.dump(report, handle, ensure_ascii=False, indent=2)
        print(json.dumps({'status': report['status'], 'games': 4, 'realNodeValidator': True}))
    finally:
        server.should_exit = True; thread.join(timeout=10); sock.close()


if __name__ == '__main__':
    main()
