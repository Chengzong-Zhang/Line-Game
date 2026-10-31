# LIFELINE itch.io release

This folder builds the current `web/web前端` runtime as a self-contained HTML5 candidate for itch.io. It does not use the historical mobile source manifest. The build discovers the current top-level runtime modules plus the complete current `assets/` and `guide/` trees, then records every packaged file and SHA-256 in a fresh manifest.

## Local candidate

Use Node.js 22.12 or later:

```powershell
Set-Location itch
npm ci
npm run release:local
npm run verify:determinism # release-gate check: two byte-identical builds
npm run verify:browser     # Chrome journey, storage denial, mobile emulation, Edge smoke
```

Generated payloads stay outside Git under `local_artifacts/itch-html5/`:

- `dist/` is the directory to send to butler;
- `lifeline-html5-20261022-rc1.zip` is the manual-upload fallback;
- `lifeline-html5-20261022-rc1-build-receipt.json` records limits and hashes.

The receipt status `PASS_PACKAGE_CURRENT` only means that the current release inputs, runtime model identities, extracted directory and ZIP agree. It does not mean that browser interaction, an itch-hosted preview, a phone, upload or public release has passed.

The itch channel bundles fixed Vue, MathJax and font assets. Its runtime configuration deliberately disables online rooms, automatic reconnect, training-game contribution and the mainland China filing footer. Local play, AI, teaching, rules, replay, save/restore, replay import/export, language and settings remain in the same Web runtime.

## Incremental upload

The itch project page must already exist and the local butler client must be authenticated. Then set the exact existing target and push the validated directory:

```powershell
$env:LIFELINE_ITCH_TARGET = "creator/lifeline:html5"
$env:LIFELINE_BUTLER_PATH = "C:\path\to\butler.exe" # optional when butler is not on PATH
npm run push
```

`npm run push` always rebuilds and verifies first. The upload helper independently repeats the package verification and refuses a stale `dist` whose `source_tree_sha256` differs from the current release inputs.

After the first push, mark the upload as `HTML5 / Playable in browser` on the itch edit page. A successful butler transfer is only `uploaded`; it is not `hosted-preview-verified` or `public` until those separate checks pass.

## Runtime model payloads

The browser inference `.f32` files are release dependencies tracked with Git LFS and identified by SHA-256 in four runtime manifests. See [MODEL_ASSETS.md](MODEL_ASSETS.md). A missing payload, an LFS pointer without its object, a byte/hash/float-count mismatch, path traversal, or an unreferenced `.f32` makes both build and verification fail closed.

## Browser validation pages

After `npm run release:local`, run `npm run serve:validation`. The server exposes the direct subdirectory candidate at `/candidate/`, an itch-like sandbox at `/iframe/`, and an opaque-origin sandbox that denies Web Storage at `/storage-denied/`. These local pages are validation aids and are not included in the player ZIP.

`npm run verify:browser` starts its own temporary validation server and writes screenshots plus a machine-readable receipt under `local_artifacts/itch-html5/browser-acceptance/`. Set `LIFELINE_CHROME_PATH` or `LIFELINE_EDGE_PATH` when the browsers are installed outside their standard Windows locations. The 390×844 result is browser emulation, not physical-device acceptance; itch host fullscreen also remains a separate hosted-preview check.
