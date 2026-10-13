"""Local-only UI preview; no account database or existing service is touched."""
import argparse
import importlib.util
from pathlib import Path
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
import uvicorn

if __name__ == "__main__":
    parser = argparse.ArgumentParser(); parser.add_argument("--data", required=True); parser.add_argument("--port", type=int, default=8876); args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    spec = importlib.util.spec_from_file_location("training_contributions", root / "web后端/training_contributions.py")
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    app = FastAPI(); app.include_router(module.create_router(module.ContributionStore(args.data)))
    app.mount("/", StaticFiles(directory=root / "web前端", html=True), name="static")
    uvicorn.run(app, host="127.0.0.1", port=args.port, access_log=False)
