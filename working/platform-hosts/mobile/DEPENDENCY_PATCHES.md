# Mobile build dependency patches

## Capacitor native listener rejection

The mobile bridge build applies one narrowly scoped transform to `@capacitor/core@8.5.3`. The installed package and lockfile stay unchanged; no post-install script rewrites `node_modules`.

The upstream `addListenerNative` wrapper constructs a promise with a success handler only. If the underlying callback registration throws or rejects, a derived promise rejects without a handler and the promise awaited by the application remains pending. The build transform adds a rejection handler to that wrapper. Normal registration and the returned listener handle keep their existing behavior.

- Implementation: `tools/patch-capacitor-core.mjs` and the pre-transform plugin in `vite.config.mjs`.
- Original input: `@capacitor/core/dist/index.js`, SHA-256 `ff26656120e7613d0718f353f7be460790473d441b44550be847f1acb23fa606`.
- Guards: exact package version, source digest, one matching source fragment, and confirmation that the expected module was transformed during the build. Unexpected input fails the build.
- The patch implementation is bound by the mobile build receipt. The original package license remains in the bundled third-party notices.
- Verification: `npm --prefix mobile run build` and `npm --prefix mobile run verify`. The generated-entry regression injects both synchronous callback failure and a rejected callback promise into the actual bundled wrapper, checks the visible retry UI and absence of an unhandled rejection, and verifies that unrelated rejection events are not intercepted by the entry.

On a Capacitor upgrade, inspect the new upstream wrapper and rerun these behavior checks before changing the version/digest guard. Remove the transform only after equivalent rejection propagation is present upstream. Do not merely refresh the digest to bypass a failing build.

Parent H2 independently verified the JavaScript behavior and desktop browser retry flow. This is not evidence that the Android Java plugin or a physical WebView has passed native testing. See `../docs/verification/mobile-prototype-20261014/parent-checkpoint-h2.md`.
