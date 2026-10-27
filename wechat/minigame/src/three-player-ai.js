import { ThreePlayerAI, createThreePlayerModel } from '../../../web/web前端/ThreePlayerAI.js';
import payload from '../../../web/web前端/assets/research-ai/three-player-policy-v1.json' with { type: 'json' };
import payloadV2 from '../../../web/web前端/assets/research-ai/three-player-policy-v2.json' with { type: 'json' };
import payloadV4 from '../../../web/web前端/assets/research-ai/three-player-search-v4-round12.json' with { type: 'json' };
import { createSupportedThreePlayerModel } from '../../../web/web前端/ThreePlayerModels.js';
import { ThreePlayerSearchAI } from '../../../web/web前端/ThreePlayerSearchAI.js';
import { checksum } from './integrity.js';

// Fixed deployed r4 v1 model, SHA-256:
// 8cd1a2f36267f96b1e32b7749a9cdc785f489ea7ec12e31aee0beb0a72901794.
// Its 2,354-byte JSON is bundled into the Worker. No URL, fetch, model download,
// replacement weights or new training is needed to run the frozen Web policy.
export const THREE_PLAYER_MODEL_CHECKSUM = 'sha256:6df0c30c2da64291d0e4890298881e4c05ac5ce00a56f22d3f69ffaf30587155';
export const THREE_PLAYER_MODEL_CHECKSUMS = Object.freeze({
  'three-player-policy-v1': THREE_PLAYER_MODEL_CHECKSUM,
  'three-player-policy-v2': 'sha256:a79a0e10c1ab64e54b5d302123a34c1ffcb61ebabbddc74752f12d27e774152d',
  'three-player-search-v4-round12': 'sha256:b1876e3070cf103a4273c29cf41988aa726b7fec073a92ca4ac285ab03243aee',
});
export function createEmbeddedThreePlayerAI(profile = 'three-player-policy-v1') {
  const selected = { 'three-player-policy-v1': payload, 'three-player-policy-v2': payloadV2,
    'three-player-search-v4-round12': payloadV4 }[profile];
  if (!selected || selected.id !== profile || checksum(selected) !== THREE_PLAYER_MODEL_CHECKSUMS[profile]) throw new Error('MODEL_INTEGRITY');
  if (profile === 'three-player-search-v4-round12') return new ThreePlayerSearchAI(selected);
  return new ThreePlayerAI(profile === 'three-player-policy-v1' ? createThreePlayerModel(selected) : createSupportedThreePlayerModel(selected));
}
