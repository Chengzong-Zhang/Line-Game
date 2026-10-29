import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { HexPlayerAI, createHexPlayerModel } from '../../../web/web前端/HexPlayerAI.js';
import payload from '../../../web/web前端/assets/research-ai/hex-player-policy-v1.json' with { type: 'json' };
import searchPayload from '../../../web/web前端/assets/research-ai/hex-player-search-v5.json' with { type: 'json' };
import { HexFastSearchAI } from '../../../web/web前端/HexFastSearchAI.js';
import { checksum, utf8 } from './integrity.js';
import { trainedPolicyModel } from '../../../web/web前端/PassTrainedPolicies.js';
import { withLearnedPass } from '../../../web/web前端/LearnedPassPolicy.js';

// Frozen deployed r4 v1 model bytes:
// 74aa7f945c3ea7ff5ca3edc9e7bdc431dc0ec5ad56d2563ce6d6d24c0494162b.
// This full-payload canonical checksum is an additional pin. The model's own
// integrity still hashes JSON.stringify(body) in insertion order, not canonical JSON.
export const HEX_PLAYER_MODEL_CHECKSUM = 'sha256:557523b990983a0ed962508359d501aa931c43fbcd9d395c8547634745a8ef94';
export const HEX_SEARCH_MODEL_CHECKSUM = 'sha256:8b8a23d88ef2852de5a4d1b388ee61d218f02f674e3658d2818c42df163c0a86';
export async function createEmbeddedHexPlayerAI(profile = 'hex-player-policy-v1', rulesVersion = 'territory-v3') {
  if (profile === 'hex-player-search-v5') {
    if (searchPayload.id !== profile || checksum(searchPayload) !== HEX_SEARCH_MODEL_CHECKSUM) throw new Error('MODEL_INTEGRITY');
    return new HexFastSearchAI(searchPayload);
  }
  if (profile !== 'hex-player-policy-v1') throw new Error('MODEL_INTEGRITY');
  if (checksum(payload) !== HEX_PLAYER_MODEL_CHECKSUM) throw new Error('MODEL_INTEGRITY');
  const model = trainedPolicyModel(await createHexPlayerModel(payload, text => bytesToHex(sha256(utf8(text)))), 'hex-v1', rulesVersion);
  return withLearnedPass(new HexPlayerAI(model));
}
