# Mobile runtime endpoints

`runtime.release.json` is the fixed configuration used by the ordinary `npm run build` command. Environment variables do not change the selected endpoints.

For a staging resource build, provide an explicitly tagged JSON file under `mobile/`. The argument path is relative to `mobile/`; files may also live in the ignored `mobile/local_artifacts/` directory:

```sh
npm run build -- --environment staging --runtime-config config/runtime.staging.json
```

The staging file must use the exact four-field schema in `runtime.release.json`, set `environment` to `staging`, and provide secure API, WebSocket, and training contribution endpoints. The build does not install packages or rewrite `runtime.release.json`. This repository does not configure or claim the existence of a real staging server. A web-resource build packages resources only; it does not compile an Android APK or HarmonyOS HAP.
