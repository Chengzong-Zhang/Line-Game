import { PASS_TRAINED_POLICY_DATA } from "./PassTrainedPolicyData.js?v=20261025-terminal-v4";

const check = (ok, message) => { if (!ok) throw new Error(message); };
const clone = value => JSON.parse(JSON.stringify(value));
export function trainedPolicySpec(base, alias, rulesVersion = "territory-v3") {
  if (rulesVersion !== "territory-v3") return base;
  const entry = PASS_TRAINED_POLICY_DATA.models[alias];
  if (!entry) return base;
  if (base.passDisciplineTraining?.candidate_sha256 === entry.candidate_sha256) {
    check(JSON.stringify(base.weights) === JSON.stringify(entry.weights.slice(0, 16))
      && base.temperature === 1 && base.passBias === entry.passBias, "PASS_OPPORTUNITY_OVERLAY_CHANGED");
    return base;
  }
  check(PASS_TRAINED_POLICY_DATA.schema === "lifeline-terminal-trained-policies-v4"
    && ["EVALUATION_ONLY", "PASS_DISCIPLINE_SCOPED"].includes(PASS_TRAINED_POLICY_DATA.activation)
    && PASS_TRAINED_POLICY_DATA.reward?.gamma === 1
    && PASS_TRAINED_POLICY_DATA.reward?.nonterminal_reward === 0
    && PASS_TRAINED_POLICY_DATA.reward?.type === "terminal-outcome-native-margin-area-v1"
    && entry.parent_id === base.id && Array.isArray(entry.weights) && entry.weights.length === 17
    && entry.weights.every(Number.isFinite) && entry.weights[16] === entry.passBias
    && JSON.stringify(entry.parent_weights) === JSON.stringify(base.weights)
    && entry.parent_temperature === base.temperature && /^[a-f0-9]{64}$/.test(entry.candidate_sha256)
    && Number.isInteger(entry.updates) && entry.updates > 0
    && Number.isInteger(entry.naturally_completed_episodes) && entry.naturally_completed_episodes >= entry.updates
    && Number.isInteger(entry.training_samples) && entry.training_samples > 0
    && Number.isInteger(entry.minimum_completed_depth) && entry.minimum_completed_depth >= 3
    && /^[a-f0-9]{64}$/.test(entry.training_identity)
    && /^[a-f0-9]{64}$/.test(entry.parent_sha256),
  "PASS_OPPORTUNITY_MODEL_IDENTITY_MISMATCH");
  const spec = clone(base);
  spec.weights = entry.weights.slice(0, 16);
  spec.temperature = 1;
  spec.passBias = entry.passBias;
  spec.passDisciplineTraining = { revision: PASS_TRAINED_POLICY_DATA.revision,
    id: entry.id, parent_id: entry.parent_id, parent_sha256: entry.parent_sha256,
    candidate_sha256: entry.candidate_sha256, training_identity: entry.training_identity,
    updates: entry.updates, training_samples: entry.training_samples,
    naturally_completed_episodes: entry.naturally_completed_episodes,
    truncated_episodes: entry.truncated_episodes,
    minimum_completed_depth: entry.minimum_completed_depth,
    reward: clone(PASS_TRAINED_POLICY_DATA.reward),
    policy: "Existing 16 placement coefficients continued with terminal-only REINFORCE, plus learned PASS bias; shared opportunity guard",
    strength_verified: false, admission_scope: PASS_TRAINED_POLICY_DATA.activation,
    admission_report_sha256: PASS_TRAINED_POLICY_DATA.admission_report_sha256 ?? null };
  return spec;
}
export function trainedPolicyModel(model, alias, rulesVersion = "territory-v3") {
  const spec = trainedPolicySpec(model.spec, alias, rulesVersion);
  if (spec === model.spec) return model;
  return { ...model, spec, score(features) {
    check(Array.isArray(features) && features.length === 16 && features.every(Number.isFinite), "PASS_OPPORTUNITY_FEATURES");
    return features.reduce((sum, value, index) => sum + value * spec.weights[index], 0);
  } };
}
export function trainedPolicyInfo(spec) {
  return spec?.passDisciplineTraining ? { terminalPolicyTraining: clone(spec.passDisciplineTraining),
    passDisciplineTraining: clone(spec.passDisciplineTraining) } : {};
}
