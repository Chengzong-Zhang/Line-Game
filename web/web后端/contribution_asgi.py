"""Standalone collector for deployments that preserve the running game server."""
try:
    from .training_contributions import create_router
except ImportError:
    from training_contributions import create_router
from fastapi import FastAPI

app = FastAPI(title="LIFELINE anonymous replay inbox")
app.include_router(create_router())
