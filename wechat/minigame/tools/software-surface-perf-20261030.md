# Software 3D renderer comparison, 2026-10-30

Baseline: renderer from commit `7dc00a1dc062f736ef683b35646d971388c41ae2`; the locally saved UTF-8 baseline file has SHA-256 `0859c7f4eceb1d4f7f425daf1f999a112a59599fff44ae02cb089047c2db895b`. Candidate renderer SHA-256: `9ad027359b67ca7151a5dda7b847e6addb586c449ff063479c73a9ddedcf6438`.

Windows x64, Node 22.22.3, native `@napi-rs/canvas` Canvas, 320×320, yaw 0.45, pitch -0.3, zoom 1, DPR 1. Actual initial game snapshots, default palette, three warmups, 12 interleaved measured draws per version; values below are the upper middle sorted sample. Scene construction is excluded. RGBA bytes are identical across renderers in every listed case.

| Preset | N | Cells / lines / nodes | Baseline ms | Candidate ms | Pixel SHA-256 |
|---|---:|---:|---:|---:|---|
| torus | 9 | 3456 / 1248 / 5 | 14.657 | 12.198 | `7d62bb2e278310f3738a435025f72ef4054781de6c7d7219e31b180890f7d5ab` |
| torus | 15 | 10584 / 3696 / 5 | 28.348 | 20.465 | `6c1c3b24dd49c28ac83d3ef207b64a44035786aa8e0caf6f79c2cfa6b20f762c` |
| double-torus | 9 | 6804 / 2496 / 3 | 16.684 | 14.155 | `e8c5f6dc498a8ab7c8f24675cc073e59592894f32f2f0bfd11f6b5a8599bc6c0` |
| double-torus | 15 | 21060 / 7392 / 3 | 53.487 | 43.737 | `466d9352972ed4c68be6a6b6fd2192d61921f315d86fffbd9e1016d2788a21ef` |

The samples overlap and include timing noise; they are local measurements, not a claim about native WeChat device speed. Raw samples and baseline are in `local_artifacts/surface-perf-20261030/`. The measured optimizations together reuse the two full-frame allocations, cache parsed colors within each draw, avoid a second rotation for each face, and avoid per-step Array.map for line discs. Every draw still clears both buffers and evaluates all faces, lines, nodes, and depth tests. Buffers are reallocated on resize and released on destroy.

Reproduce from `wechat/minigame` after saving the baseline source to the path shown (the Canvas module path is specified in the tool):

```powershell
git show 7dc00a1d:wechat/minigame/src/topology-software-surface.js | Set-Content -Encoding utf8 '../../local_artifacts/surface-perf-20261030/baseline.js'
node tools/benchmark-software-surface.mjs '../../local_artifacts/surface-perf-20261030/baseline.js' '../../local_artifacts/surface-perf-20261030/result.json'
node --test tests/topology-software-surface-cache.test.mjs
```

The isolated Canvas regression also checks content, palette, view, zoom, and size changes against fresh-renderer output, and checks buffer release. Existing end-to-end 3D UI tests require rebuilding the current shared native compatibility sources; during concurrent work their pinned source check reported `WEB_COMPAT_SOURCE_DRIFT` for `GameEngine.js` and `ReplayCodec.js`, so UI and real-device acceptance remain separate follow-up checks.

Final integration recheck: compatibility sources were rebuilt and the complete Mini suite passed 706/706, including the 3D UI and buffer/cache regressions. The offline native host also passed the real-browser board flow. These later checks resolve the intermediate source-drift failure; native WeChat device timing and interaction remain unverified.
