# r4 independent public Web verification

Result: `PASS_PUBLIC_HTTPS_R4_BYTES_AND_V3_SCORING`.

The public endpoint `https://lifelinegame.cn` served all **121/121** frozen runtime
files with matching SHA-256, totalling **21,495,433 bytes**. This check downloaded
the files after the deployment owner reported activation. The exact downloaded
GameEngine passed all **21** assertions in the unchanged live-scoring probe.

## Identity and scoring

- Release: `web-all-features-20261025-r4`
- Asset version: `20261025-unified1`
- Frozen manifest: `313ff7f9b09655b25479dad68734df6711c85d43c900f817ab0a261b404cd02a`
- Downloaded engine: `3b70b69c4c480117a4952b06c279054ec535268b4293b04b4d63f960ac4b0fca`
- Initial score: V2 = 0, V3 = 1; V3 open line = 3.
- Empty/enemy-containing pocket scores: 7 / 6.
- Representative closed-position scores: 10 / 9.

`web-public-https-receipt.json` contains every public file result, exact timings,
source identities, the command and scoring result. `web-release-manifest.json`
is an exact copy of the r4 frozen source manifest. The runtime provenance file
also records rehashing of the archive: all 121 runtime files equal reviewed r3;
only release metadata was rebound for r4.

## Execution and retained failure

```powershell
.venv/Scripts/python.exe local_artifacts/release-all-20261025-web-public-r4/verify_public_r4.py --execute
```

Successful local receipt:
`local_artifacts/release-all-20261025-web-public-r4/runs/20261025T035322Z-5899fcbb/receipt.json`.

The first attempt received no HTTP responses because inherited local proxy
settings failed TLS handshakes. That failed receipt is preserved locally and
summarized here. The successful check used the repository Python environment
and a process-local direct HTTPS opener. Standard certificate verification
remained enabled; no system network configuration or expected hashes changed.

`verify_public_r4.snapshot.py` is the exact executed verification source, copied
for evidence and bound by its hash in the receipt. Its relative path bindings
refer to the original local-artifact directory shown in the command, so this
snapshot is not a new deployment entrypoint. The scoring probe is included
unchanged. The 21 MB download and generated ZIP remain local, outside Git.

## Boundaries

This confirms public HTTPS bytes and actual downloaded rule-engine behavior.
It does not establish real-browser Canvas/Worker behavior, phone acceptance,
account login, cross-platform WebSocket play, WeChat experience selection,
review or public channel release. This verification performed no SSH,
deployment, upload, publication or account mutation.
