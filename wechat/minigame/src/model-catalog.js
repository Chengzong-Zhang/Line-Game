import legacy from '../../../web/web前端/assets/research-ai/manifest.json' with { type: 'json' };
import transfer from '../../../web/web前端/assets/research-ai/transfer-v1/manifest.json' with { type: 'json' };
import policies from '../../../web/web前端/assets/research-ai/model-free-manifest.json' with { type: 'json' };
import { THREE_PLAYER_SEARCH_MODEL_ID, THREE_PLAYER_SEARCH_SIZES } from '../../../web/web前端/ThreePlayerSearchOptions.js';
import { HEX_SEARCH_MODEL_ID, HEX_SEARCH_SIZES } from '../../../web/web前端/HexSearchOptions.js';

// The manifests remain the Web source of truth. No new training or weights.
const names = { padded_cnn: 'CNN', grid_gnn: 'Grid GNN', topology_gnn: 'Topology GNN' };
export const MODEL_CATALOG = [...transfer.models, ...legacy.models, ...policies.models].map(spec => {
  const research = Boolean(spec.model_kind), group = research ? 'research' : spec.model_family;
  const variant = spec.id.includes('transfer-v1') ? `S0${String(spec.id).slice(-1)}` : 'D14';
  return Object.freeze({ id: spec.id, profile: `model:${spec.id}`, spec, research, group,
    experimental: research, evidenceTier: spec.evidence_tier || (research ? 'compatibility-trial' : 'web-runtime'),
    title: research ? `${names[spec.model_kind]} · ${variant}` : spec.model_family.toUpperCase(),
    shortLabel: research ? `PUCT · ${names[spec.model_kind]} · ${variant}` : spec.model_family.toUpperCase(),
    bytes: spec.float_count * 4, packageName: `ai-${group}`,
    assetPath: `models/${group}/${spec.id}.bin`, sourcePath: `model-assets/${spec.id}.bin` });
});
export const MODEL_PACKAGES = [...new Set(MODEL_CATALOG.map(model => model.group))].map(group => ({
  name: `ai-${group}`, root: `models/${group}`,
}));
const allSizes = Object.freeze(Array.from({ length: 11 }, (_, index) => index + 5));
// These Web runtime profiles reuse existing policies/search; no ultimate
// candidate or additional model package is exposed by the mobile selector.
export const MULTIPLAYER_LEVEL_CATALOG = Object.freeze([
  { profile: 'multiplayer-easy-v1', title: '多人 · 简单', shortLabel: 'Multiplayer · Easy', metric: 'policy-score' },
  { profile: 'multiplayer-medium-v1', title: '多人 · 中等', shortLabel: 'Multiplayer · Medium', metric: 'search-score', nativeShapeOnly: true },
  { profile: 'multiplayer-hard-v1', title: '多人 · 困难', shortLabel: 'Multiplayer · Hard', metric: 'search-score' },
].map(item => Object.freeze({ playerCounts: Object.freeze([3, 4, 5, 6]),
  boardShapes: Object.freeze(['triangle', 'hexagon']), sizes: allSizes, experimental: false,
  nativeShapeOnly: false, ...item })));
// These small frozen JSON policies are embedded in the single Worker. They are
// selectable independently; choosing a failed/unpromoted candidate never changes
// defaults or silently substitutes the v1 policy.
export const MULTIPLAYER_AI_CATALOG = Object.freeze([
  { profile: 'three-player-policy-v1', title: '三人 AI · V1', shortLabel: 'Three-player · V1', playerCounts: [3],
    boardShape: 'triangle', sizes: allSizes, experimental: false, metric: 'policy-score' },
  { profile: 'three-player-policy-v2', title: '三人 AI · V2（实验）', shortLabel: 'Three-player · V2 (experimental)', playerCounts: [3],
    boardShape: 'triangle', sizes: allSizes, experimental: true, metric: 'policy-score' },
  { profile: THREE_PLAYER_SEARCH_MODEL_ID, title: '三人搜索 · V4 R12', shortLabel: 'Three-player search · V4 R12', playerCounts: [3],
    boardShape: 'triangle', sizes: THREE_PLAYER_SEARCH_SIZES, experimental: false, metric: 'search-score' },
  { profile: 'hex-player-policy-v1', title: '六边形 AI · V1', shortLabel: 'Hex AI · V1', playerCounts: [4, 5, 6],
    boardShape: 'hexagon', sizes: allSizes, experimental: false, metric: 'policy-score' },
  { profile: HEX_SEARCH_MODEL_ID, title: '六边形搜索 · V5（实验）', shortLabel: 'Hex search · V5 (experimental)', playerCounts: [4, 5, 6],
    boardShape: 'hexagon', sizes: HEX_SEARCH_SIZES, experimental: true, metric: 'search-score' },
  ...MULTIPLAYER_LEVEL_CATALOG,
].map(item => Object.freeze(item)));
export function modelForProfile(profile) { return MODEL_CATALOG.find(model => model.profile === profile) || null; }
export function multiplayerModelForProfile(profile) { return MULTIPLAYER_AI_CATALOG.find(model => model.profile === profile) || null; }
export function controllerLabel(profile, text = {}) {
  const model = modelForProfile(profile);
  const label = text[`controller-${profile}`] || model?.shortLabel
    || multiplayerModelForProfile(profile)?.shortLabel || profile;
  return model?.experimental ? `${label} · ${text.experimental || 'Experimental'}` : label;
}
