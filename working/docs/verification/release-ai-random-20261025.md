# Web and WeChat AI/random-start release, 2026-10-25

## Source and local checks

- Source branch: `codex/release-all-web-wechat-20261025`.
- Product commit: `c8d766ad1ca1efbe391cd6b8073e5af8b09dabfd`.
- Scope: Web and WeChat online AI seats, refreshed random starting points on a new match, and the current shared frontend/runtime dependencies. The Mini Game version is `0.12.10`.
- Mini Game candidate: `0.12.10-c6dad19826bd-iZdLlh`; 467/467 local tests passed and 35 package files verified before upload. Local checks do not establish device behaviour.

## Server activation

- Release: `web-ai-random-20261025-r1`.
- Frozen payload SHA-256: `4856a76b529c6783e1fc0d2679d2378a08be7c67d38e34c7ef0ba5548a55184a`.
- Frontend overlay SHA-256: `71bad797971dc4d602e7e98fe44ffaf238ba332045008c4970e23d211d40bef7`; 130 runtime files.
- The one-shot deployment checked predecessor hashes, prepared a complete frontend snapshot, probed a 2-player AI move against staged service modules, restarted both services, checked local health, then switched the frontend atomically. Its receipt reports `ACTIVATED_ALL_COMPONENTS_VERIFIED`; the frontend switch receipt reports `ATOMIC_SWITCH_OK`.
- The previous frontend is retained at `/home/ubuntu/line-game/.deploy-artifacts/web-ai-random-20261025-r1.rollback-web前端`; previous service files and the WeChat service frontend are retained under the release's `rollback` directory. Production databases were not replaced.
- Both `lifeline-game.service` and `lifeline-wechat.service` were active after activation. The public HTTPS origin returned 200 from the server host; SHA-256 for `/`, `/OnlineApp.js`, and `/StartingPoints.js` matched the frozen candidate (`96aa177f`, `a8af10b1`, `40aad1e9` prefixes respectively). The public health and WeChat status endpoints returned 200. This is resource/service verification, not a browser or device acceptance run.

## Mini Game transfer

- The first upload through the local proxy failed with SDK error 20003 (`invalid ip`). A direct connection to the WeChat endpoints was then verified.
- The official `miniprogram-ci` 2.1.31 upload from a fresh candidate copy completed for version `0.12.10`, robot 2. Receipt status: `CODE_UPLOADED_EXPERIENCE_NOT_CONFIGURED`. The SDK reported a 19,739,061-byte full package.
- Receipt: `local_artifacts/wechat-transfers/upload-0.12.10-eEbQdb/receipt.json` in the WeChat worktree (local, ignored). The credential was kept outside the release and repository.
- Experience version selection, tester access, device verification, review, and public publication are not confirmed by the code-upload receipt.
