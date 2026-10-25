import { MultiplayerMinimaxAI } from '../../../web/web前端/MultiplayerSearch.js';
import { threePlayerModelIdForBoard } from '../../../web/web前端/ThreePlayerSearchOptions.js';
import { createHardRuntimeV2 } from '../../../web/web前端/MultiplayerHardRuntime.js';
import { loadMultiplayerRuntime } from '../../../web/web前端/MultiplayerRuntime.js';
import easyManifest from '../../../web/web前端/assets/research-ai/multiplayer-v1/easy.json' with { type: 'json' };
import { createEmbeddedThreePlayerAI } from './three-player-ai.js';
import { createEmbeddedHexPlayerAI } from './hex-player-ai.js';
import { checksum } from './integrity.js';
import { trainedPolicyInfo } from '../../../web/web前端/PassTrainedPolicies.js';
import { withPassDiscipline } from '../../../web/web前端/AIPassDisciplineV3.js';

export const MULTIPLAYER_TIER_PROFILES = Object.freeze([
  'multiplayer-easy-v1', 'multiplayer-medium-v1', 'multiplayer-hard-v1',
]);
export const MULTIPLAYER_EASY_CHECKSUM = 'sha256:732a95bad8cb783adddf3c78bd6689385a156ba25055fc2ea61c55742a69df75';

export function isMultiplayerTierProfile(profile) {
  return MULTIPLAYER_TIER_PROFILES.includes(profile);
}

function validateConfiguration(profile, engine) {
  if (!isMultiplayerTierProfile(profile) || !Number.isInteger(engine?.playerCount) || engine.playerCount < 3 || engine.playerCount > 15
    || !['territory-v2', 'territory-v3'].includes(engine.rulesVersion) || !Number.isInteger(engine.gridSize)
    || engine.gridSize < 5 || engine.gridSize > 15 || !['triangle', 'hexagon'].includes(engine.boardShape)
    || engine.playerCount > 6 && profile !== 'multiplayer-hard-v1'
    || profile === 'multiplayer-medium-v1' && engine.boardShape !== (engine.playerCount === 3 ? 'triangle' : 'hexagon')) {
    throw new Error('INVALID_CONTROLLERS');
  }
}

export async function createEmbeddedHardRuntime(engine) {
    const runtime = engine.playerCount === 3
      ? { ai: createEmbeddedThreePlayerAI(threePlayerModelIdForBoard(engine.gridSize), engine.rulesVersion) }
      : { ai: await createEmbeddedHexPlayerAI('hex-player-policy-v1', engine.rulesVersion) };
    const policySpec = runtime.ai.base ? runtime.ai.spec : runtime.ai.model.spec;
    const id = runtime.ai.base ? runtime.ai.spec.id : runtime.ai.model.spec.id;
    const hard = createHardRuntimeV2(engine, { policySpec, modelInfo: { id } });
    return { ai: hard.ai, modelInfo: { ...hard.modelInfo, ...trainedPolicyInfo(policySpec), id: 'multiplayer-hard-v1',
      runtime_uses_learned_pass: false, runtime_uses_trained_placement: Boolean(policySpec.passDisciplineTraining),
      runtime_policy: 'original-native-hard-search-with-trained-placement-base-and-shared-PASS-guard',
      compatibility: `${engine.rulesVersion} native 3–6 players; size 5–15` } };
}

const resources = {
  loadNativeHardRuntime: createEmbeddedHardRuntime,
  async loadAssetModel(id) {
    const spec = easyManifest.models?.[0];
    if (id !== 'multiplayer-easy-v1' || easyManifest.models.length !== 1
      || easyManifest.schema?.name !== 'lifeline-multiplayer-runtime' || easyManifest.schema.version !== 1
      || easyManifest.rulesVersion !== 'territory-v2' || spec?.id !== id
      || !Number.isInteger(spec.training?.updates) || spec.training.updates < 1
      || spec.weights?.length !== 16 || !spec.weights.every(Number.isFinite)
      || !Number.isFinite(spec.temperature) || spec.temperature <= 0
      || checksum(easyManifest) !== MULTIPLAYER_EASY_CHECKSUM) throw new Error('MODEL_INTEGRITY');
    return { spec: JSON.parse(JSON.stringify(spec)) };
  },
  async loadThreePlayerRuntime(id, engine) {
    // The existing factories pin the complete payload and preserve the native
    // JSON-clone / SHA adapters. No network model loaders are called here.
    const ai = createEmbeddedThreePlayerAI(id, engine.rulesVersion);
    const spec = ai.base ? ai.spec : ai.model.spec;
    return { ai, modelInfo: { id, ...trainedPolicyInfo(spec), runtime_uses_learned_pass: !ai.base && Number.isFinite(spec.passBias),
      runtime_uses_trained_placement: Boolean(spec.passDisciplineTraining) } };
  },
  async loadHexPlayerModel(_id, engine) {
    return (await createEmbeddedHexPlayerAI('hex-player-policy-v1', engine.rulesVersion)).model;
  },
};

export async function createEmbeddedMultiplayerRuntime(profile, engine) {
  validateConfiguration(profile, engine);
  const runtime = engine.playerCount > 6
    ? { ai: new MultiplayerMinimaxAI({ depth: Math.min(engine.playerCount + 1, 6), timeMs: 650 }),
      modelInfo: { id: profile, algorithm: 'paranoid-minimax', training: null,
        compatibility: `${engine.rulesVersion} generic 7–15 players; size 5–15` } }
    : await loadMultiplayerRuntime(profile, engine, resources);
  if (runtime.modelInfo.id !== profile) throw new Error('MODEL_INTEGRITY');
  const algorithm = withPassDiscipline(runtime.ai);
  return {
    modelInfo: runtime.modelInfo,
    ai: {
      lastSearch: null,
      getTopMoves(source, player = source.currentPlayer, topN = 5, options = {}) {
        validateConfiguration(profile, source);
        if (source.currentPlayer !== player || !source.activePlayers.includes(player)) throw new Error('WRONG_PLAYER');
        const moves = algorithm.getTopMoves(source, player, topN, options);
        this.lastSearch = algorithm.lastSearch;
        return moves;
      },
    },
  };
}
