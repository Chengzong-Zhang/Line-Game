# Steam configuration preparation

Status: **local templates and validation only**. No Steamworks account, owned
AppID, depot, SDK, upload or Steam client acceptance exists for this candidate.
`cn.lifelinegame.desktop` is an Electron application identifier, not a Steam ID.

The default first release is a complete offline Windows game. Valve's
[API overview](https://partner.steamgames.com/doc/sdk/api), checked 2026-10-19,
does not require API integration to ship. Account/AppID, Steam delivery, honest
store configuration and review still apply. Native achievements, Cloud and
Overlay integration remain optional follow-up work and are not advertised.
See [minimal owner decisions](../../docs/steam/OWNER_MINIMUM_20261019.md) and
[prefilled store fields](../../docs/steam/LAUNCH_FIELDS_20261019.md).

## Reproducible local candidate

From the repository root, with pinned dependencies and materialized Git LFS:

```powershell
npm ci
npm run desktop:pack:dir
npm run desktop:test:achievements
npm run desktop:test:release
npm run desktop:preflight
npm run desktop:pack:portable
node desktop/scripts/release-candidate.mjs snapshot 0.3.0-rc1
node desktop/scripts/release-candidate.mjs verify desktop/release/candidates/0.3.0-rc1
```

Each snapshot has its own `win-unpacked`, portable executable and `candidate.json`.
Existing candidate names are never overwritten. A failed copy retains an
incomplete receipt and cannot pass verification. The receipt binds each file to
its SHA-256 hash and records the source revision, dirty-state flag and source
hashes. **Integrity checks do not claim play testing, signing, legal clearance,
Steam validation or byte-identical rebuilds.** Bind runtime acceptance to both
the archive and portable hashes before distribution.

After the Chinese and English real-package UI runs have passed, assemble a
separate local kit with their exact receipt paths:

```powershell
node desktop/scripts/assemble-release-kit.mjs desktop/release/candidates/0.3.0-rc1 <zh-receipt.json> <en-receipt.json>
```

The kit contains the portable, ten unmodified actual gameplay screenshots, eight
art drafts, bilingual store copy, test instructions, notices and hash inventories.
Screenshots from a different archive or a failed run are rejected. Existing kit
directories are never overwritten. This command only copies local files; it does
not distribute them or turn the rights review into a clearance.

Generate a separate self-contained Windows check kit after freezing a candidate:

```powershell
node desktop/scripts/prepare-validation-kit.mjs desktop/release/candidates/0.3.0-rc1 0.3.0-rc1
```

Run-check.cmd needs only Windows PowerShell 5.1 and built-in .NET. It verifies
the portable, runs tutorials and a move in an isolated profile, then checks a
normal restart. It restricts the child PATH to Windows system directories.
Optional-Windows-Sandbox.wsb disables networking and maps the kit read-only,
with only its results directory writable. The generated Sandbox file contains
host-specific absolute paths; regenerate it if the kit moves. It does not
install Windows features. The receipt's environment name is caller-declared,
not an attestation that Sandbox or a second physical computer was used.

## SteamPipe preview preparation

Copy `config.example.json` into ignored `desktop/release/steam-local.json` only
after real IDs are available. Supply the game's owned `appId` and
`windowsDepotId`. Null values, Spacewar 480 and identical app/depot IDs fail
validation. Example IDs used in unit fixtures are synthetic, never account IDs.

```powershell
node desktop/scripts/release-candidate.mjs steam-preview desktop/release/candidates/0.3.0-rc1 desktop/release/steam-local.json
```

This verifies the candidate again and generates `app_build.vdf` and
`depot_windows.vdf` under ignored `desktop/release/steam-preview/`. It never
invokes SteamCMD. The generated AppBuild uses `Preview=1`, has no `SetLive`, and
maps the unpacked distribution, not the self-extracting portable wrapper.
Steam launch settings should target `LIFELINE.exe` with no debugging arguments.
Credentials and SteamGuard data belong outside the repository.

When the account exists, separately validate the generated mapping with Valve's
tools, configure ownership packages and the private test branch, then test actual
Steam launch/update/rollback. Enabling upload or a live branch is a separate
release action; these scripts intentionally do not provide it.

## Manual progress transfer

Settings can export a versioned, checksummed JSON containing only tutorial
completion and distinct known challenge IDs. Import validates a bounded 16 KB
document, unions it with healthy local progress and refreshes local milestones.
It never copies preferences, a current match, identities or the award queue.
Cancelling does not read/quarantine the profile. Invalid, future or quarantined
profiles block transfer; preserved quarantine evidence also blocks import after
restart. Current matches use the separate replay export/import flow. Native
dialog response simulation in automated tests is labeled separately from actual
human interaction with the operating system's file picker.

## Achievements

Five local milestones correspond to saved tutorial and distinct challenge
progress. Their stable IDs and translated descriptions are in
`desktop/src/achievement-store.cjs`. Pending entries are stored in
`userData/achievements/pending.json`, with checksum, backup and newer-schema
protection. Opening the local achievement panel reconciles validated saved
progress. No platform award, Steam identity or automatic account import occurs.

Future SDK work must configure the same identifiers in Steamworks and explicitly
bind local imports to a verified account. A successful native ACK must belong to
that account before any queue entry is retired. Switching Steam accounts cannot
reuse another account's completion receipt. No such ACK path is claimed here.

## Cloud preparation

`cloud-plan.json` is a disabled design worksheet, not an uploadable configuration.
The current save location is shared by the Windows user. Enabling Auto-Cloud on
that folder before implementing account isolation could transfer one player's
progress to another Steam account, so this worksheet deliberately stays disabled.

The future account-specific design should sync validated campaign progress and
one selected current match, leaving local preferences, caches, logs, quarantined
files and the unbound achievement queue out of Cloud. Merge completed challenge
sets only after schema validation; concurrent current matches require an explicit
choice and retention of both copies, never a board-state merge. Verify account
switching, first import, two-device offline forks and unsupported-version saves
before enabling the store's Steam Cloud feature.

## Sources checked 2026-10-18

- [Valve: Uploading to Steam](https://partner.steamgames.com/doc/sdk/uploading)
  defines AppBuild/DepotBuild, preview mode and file mappings.
- [Valve: Steam Cloud](https://partner.steamgames.com/doc/features/cloud)
  describes root paths, Steam user path substitutions and cross-device testing.

These documents guide the templates. They do not establish backend acceptance
for a game which does not yet have an AppID.
