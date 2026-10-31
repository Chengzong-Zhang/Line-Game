# Common Web legacy App and cache alignment — verification receipt

The tested source is the current `C:/Users/zcz/.codex/worktrees/lifeline-alignment-20261031/line game/web/web前端` after the `dc50ad65` baseline, legacy core overlay, App overlay and cache-alignment changes. The cache changes were present during these runs. `common-cache-final-inputs.json` records all hashes: all 115 top-level files in this common directory match the test host byte for byte, including `LocalGameSession.js` and `ReplayCodec.js`. All eight mobile-host fixture files listed in that manifest match `C:/coding/py/line game/working/local_artifacts/alignment-20261031/mobile/mobile/dist` byte for byte. The five cache-alignment file hashes and the two important persistence/replay inputs are:

| File | SHA-256 |
| --- | --- |
| `OnlineApp.js` | `85a3e129e964ba2615dac5c390ee97545e716d7f54798514c45a8cf3a33604e8` |
| `GameController.js` | `7c18a7f6c644a0cad953dae67881bd89986d486711d5f4f5608e16dea563d2ad` |
| `CrossPlatformNetwork.js` | `6b533dcdbde3c78ede387cec5dfb6c33ed18fb88a8fe04fac78b40352d40d97e` |
| `main.js` | `2c8a2b0005c273e0d74afce0a2d6dab9dde8c11ac5df57d98cf202eaa0aee3f8` |
| `index.html` | `175e039ae13b4384c0f161264933289cc6e4f3543522bbe4eaa6eb9f70187e57` |
| `LocalGameSession.js` | `00bb0720648e3d90464baf27a783984294965f9517309996e9a0f3f832115ecd` |
| `ReplayCodec.js` | `4350feb52195f3c0fc14a1af37ec0804f04b39809134954159754af282ffd2ee` |

`common-legacy-app-session-receipt.json` reports 28/28 PASS, covering the actual common App handlers for legacy selection, late join, rejection rollback, lost ACK, capacity recovery and save failure, owned notices, stale skip and replay export. `common-shared-app-session-receipt.json` reports PASS for the shared HTTP/WebSocket synthetic-service flow: create, authoritative action, duplicate prevention, rejection, lost ACK and reconnect. These are browser VM tests with synthetic HTTP, WebSocket, storage, timers and Vue rendering; the common `App.setup` and handlers run. `main.js` is replaced by a bootstrap stub in the fixture and `index.html` is hashed but not executed. There is no actual browser, real network, native runtime or device evidence. The mobile-entry and `platform/` files are host setup fixtures; they are not presented as common production code.

The actual run used Node with `--experimental-vm-modules`, the local host `C:/coding/py/line game/working/tmp/alignment-20261031/common-legacy-integration/dist`, and an explicitly supplied Vue entry. Each test requires a dist path, a fresh receipt path and the Vue runtime path. The fourth argument has no machine-specific default:

```powershell
node --experimental-vm-modules --unhandled-rejections=strict 'C:/coding/py/line game/working/docs/maintenance/alignment-20261031/common-legacy-app-session-test.mjs' 'C:/coding/py/line game/working/tmp/alignment-20261031/common-legacy-integration/dist' 'C:/coding/py/line game/working/tmp/alignment-20261031/common-legacy-integration/cache-final-session.json' 'C:/coding/py/line game/working/local_artifacts/alignment-20261031/mobile/mobile/node_modules/vue/index.mjs'
node --experimental-vm-modules --unhandled-rejections=strict 'C:/coding/py/line game/working/docs/maintenance/alignment-20261031/common-shared-app-session-test.mjs' 'C:/coding/py/line game/working/tmp/alignment-20261031/common-legacy-integration/dist' 'C:/coding/py/line game/working/tmp/alignment-20261031/common-legacy-integration/cache-final-shared.json' 'C:/coding/py/line game/working/local_artifacts/alignment-20261031/mobile/mobile/node_modules/vue/index.mjs'
```

For a repeat, supply new receipt names. To recreate an equivalent host, copy the existing mobile fixture `mobile/mobile/dist` to a new local directory, then copy every top-level file from the current common `web/web前端` directory over it. Keep the mobile `mobile-entry.js` and `platform/` fixture directory. Compare hashes with `common-cache-final-inputs.json` before accepting results; use the Vue entry from an installed Vue runtime as the explicit fourth argument. The old pre-cache diagnostic receipts are retained locally under `working/tmp/alignment-20261031/common-legacy-integration/` and are not evidence for the current hashes.
