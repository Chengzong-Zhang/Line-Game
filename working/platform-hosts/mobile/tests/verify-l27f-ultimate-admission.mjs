import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  ACCEPTED_ULTIMATE_RELEASES,
  CURRENT_ULTIMATE_MODEL_ID,
  createUltimateAdmissionGuard,
} from '../../web/web前端/MultiplayerUltimateAdmission.js';
import { loadMultiplayerRuntime } from '../../web/web前端/MultiplayerRuntime.js';

assert.deepEqual(ACCEPTED_ULTIMATE_RELEASES, [], 'the shipped Ultimate admission registry stays empty');
const guard = createUltimateAdmissionGuard();
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url) => new Response(await readFile(new URL(url)), { status: 200 });
const rows = [];
try {
  for (const rulesVersion of ['territory-v2', 'territory-v3']) {
    for (const playerCount of [3, 4, 5, 6]) {
      const context = {
        playerCount,
        gridSize: 5,
        boardShape: playerCount === 3 ? 'triangle' : 'hexagon',
        rulesVersion,
      };
      const before = JSON.stringify(context);
      const profile = { choice: 'ai-ultimate', modelId: CURRENT_ULTIMATE_MODEL_ID };
      const admission = guard.checkProfile(profile, context, {
        id: CURRENT_ULTIMATE_MODEL_ID,
        asset_sha256: 'a'.repeat(64),
        training: { identity: 'b'.repeat(64) },
      });
      assert.equal(admission.allowed, false);
      assert.equal(admission.code, 'ULTIMATE_NOT_QUALIFIED', `${rulesVersion}, ${playerCount} players: direct selection is rejected`);
      assert.equal(admission.preserveSelection, true);
      assert.equal(admission.preserveSave, true);

      const session = {
        settings: context,
        match: { players: { BLACK: profile } },
      };
      const restored = guard.checkSavedSession(session, {
        [CURRENT_ULTIMATE_MODEL_ID]: {
          id: CURRENT_ULTIMATE_MODEL_ID,
          asset_sha256: 'a'.repeat(64),
          training: { identity: 'b'.repeat(64) },
        },
      });
      assert.equal(restored.allowed, false, 'restoring a saved Ultimate choice remains fail-closed');
      assert.equal(restored.preserveSave, true);
      assert.equal(restored.preserveSelection, true);
      assert.equal(restored.blocked[0].code, 'ULTIMATE_NOT_QUALIFIED', `${rulesVersion}, ${playerCount} players: saved choice is rejected`);

      await assert.rejects(
        loadMultiplayerRuntime(CURRENT_ULTIMATE_MODEL_ID, context),
        (error) => error.code === 'ULTIMATE_NOT_QUALIFIED',
        `${rulesVersion}, ${playerCount} players: the real runtime loader rejects the unqualified model`,
      );
      assert.equal(JSON.stringify(context), before, 'admission does not mutate the caller context');
      rows.push({ rulesVersion, playerCount, directRejected: true, restoreRejected: true, runtimeRejected: true });
    }
  }
} finally {
  globalThis.fetch = originalFetch;
}

console.log(JSON.stringify({
  status: 'PASS_L27F_ULTIMATE_ADMISSION',
  acceptedReleaseCount: ACCEPTED_ULTIMATE_RELEASES.length,
  modelId: CURRENT_ULTIMATE_MODEL_ID,
  rows,
  scope: 'Admission and runtime-loading boundary only; no move selection or strength claim.',
}));
