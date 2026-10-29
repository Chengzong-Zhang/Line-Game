"""Bounded stateless Node bridge for rooms containing 3–6-player AI seats."""

import asyncio
import json
import os
from pathlib import Path

BRIDGE_PATH = Path(__file__).resolve().parents[1] / "tools" / "online_bot_bridge.mjs"
BRIDGE_TIMEOUT_SECONDS = 15


class BotBridgeUnavailable(RuntimeError):
    pass


async def evaluate_room(settings, actions, bot_colors, action=None):
    """Recover all rule state, including Superko, from the accepted action log."""
    request = {"settings": settings, "actions": actions, "botColors": bot_colors, "action": action}
    try:
        process = await asyncio.create_subprocess_exec(
            os.environ.get("LIFELINE_NODE", "node"), str(BRIDGE_PATH),
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    except OSError as exc:
        raise BotBridgeUnavailable("AI runtime unavailable; install Node.js 18+ or set LIFELINE_NODE.") from exc
    try:
        stdout, stderr = await asyncio.wait_for(
            process.communicate(json.dumps(request, separators=(",", ":")).encode()),
            timeout=BRIDGE_TIMEOUT_SECONDS,
        )
    except (asyncio.TimeoutError, asyncio.CancelledError):
        if process.returncode is None:
            process.kill()
        await process.communicate()
        raise
    if process.returncode != 0:
        raise BotBridgeUnavailable(f"AI runtime exited with code {process.returncode}.")
    try:
        result = json.loads(stdout)
    except (ValueError, UnicodeError) as exc:
        raise BotBridgeUnavailable("AI runtime returned invalid output.") from exc
    if not isinstance(result, dict) or not isinstance(result.get("success"), bool):
        raise BotBridgeUnavailable("AI runtime returned an invalid result.")
    return result
