# Shared online AI and random starts, 2026-10-25

## Scope

- Web rooms accept one AI in two-player play and retain 3–6-player AI seats.
- Shared Web/WeChat two-player rooms accept one server-controlled WHITE AI. The server validates, persists, and broadcasts its turns. AI rooms support host setting edits before the human readies, reconnection, rematch, and a human-turn undo that also removes the following AI reply.
- Random starts are spread over the chosen board, saved with the room, and redrawn on a new match. The native Mini Game compatibility copy uses the same algorithm as Web.

## Local verification

- `python -m unittest web.tests.test_shared_online_ai_random web.tests.test_online_bots -q`: 15 passed using the real Node rule bridge.
- `python web/tests/wechat_release_compatibility_probe.py --service-root .`: 18 compatibility checks passed.
- `node web/web前端/tests/verify-online-start-undo.mjs`: passed.
- `node --test wechat/minigame/tests/online-navigation.test.mjs wechat/minigame/tests/shared-web-ui.test.mjs wechat/minigame/tests/starting-point-markers.test.mjs`: 27 passed.
- `node --test wechat/minigame/tests/online-candidate.test.mjs wechat/minigame/tests/online-consent.test.mjs`: 21 passed.
- `node wechat/minigame/tools/build.mjs`: `BUILT_NOT_WECHAT_VERIFIED`.

These checks do not establish browser interaction, WeChat device behavior, upload, or production activation.
