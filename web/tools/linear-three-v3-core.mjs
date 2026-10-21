// Generic linear-policy PPO math, shared by new three-player/hex posttraining.
// No rule engine or model files are modified by this module.
export function policyProbabilities(features, weights, temperature = 1) {
  const logits = features.map((row) => row.reduce((sum, value, index) => sum + value * weights[index], 0) / temperature);
  const maximum = Math.max(...logits);
  const values = logits.map((value) => Math.exp(value - maximum));
  const total = values.reduce((sum, value) => sum + value, 0);
  return values.map((value) => value / total);
}

export function samplePolicy(probabilities, random) {
  const threshold = random();
  let cumulative = 0;
  for (let index = 0; index < probabilities.length; index++) {
    cumulative += probabilities[index];
    if (threshold < cumulative) return index;
  }
  return probabilities.length - 1;
}

// samples: {features, action, oldProb, advantage, weight, anchor}
// weight makes each complete player trajectory contribute equally, rather than
// allowing longer games to dominate. anchor is the fixed parent's legal policy.
export function ppoLossAndGradient(samples, weights, config) {
  const gradient = Array(weights.length).fill(0);
  const normalization = samples.reduce((sum, sample) => sum + sample.weight, 0);
  if (!(normalization > 0)) throw new Error("PPO requires positive trajectory weights.");
  let loss = 0, surrogate = 0, kl = 0, clipped = 0;
  for (const sample of samples) {
    const p = policyProbabilities(sample.features, weights, config.temperature);
    const ratio = p[sample.action] / sample.oldProb;
    const clippedRatio = Math.min(1 + config.clip, Math.max(1 - config.clip, ratio));
    const minimum = Math.min(ratio * sample.advantage, clippedRatio * sample.advantage);
    const active = !(sample.advantage > 0 && ratio > 1 + config.clip)
      && !(sample.advantage < 0 && ratio < 1 - config.clip);
    const scale = sample.weight / normalization;
    const anchorKl = sample.anchor.reduce((sum, q, index) =>
      sum + (q > 0 ? q * Math.log(q / Math.max(p[index], 1e-15)) : 0), 0);
    surrogate += scale * minimum; kl += scale * anchorKl;
    loss += scale * (-minimum + config.anchorKl * anchorKl);
    if (!active) clipped += scale;
    for (let i = 0; i < weights.length; i++) {
      const expected = p.reduce((sum, probability, action) => sum + probability * sample.features[action][i], 0);
      const policyGradient = active ? -sample.advantage * ratio * (sample.features[sample.action][i] - expected) : 0;
      const anchorGradient = p.reduce((sum, probability, action) =>
        sum + (probability - sample.anchor[action]) * sample.features[action][i], 0);
      gradient[i] += scale * (policyGradient + config.anchorKl * anchorGradient) / config.temperature;
    }
  }
  if (![loss, ...gradient].every(Number.isFinite)) throw new Error("Nonfinite PPO objective.");
  return { loss, gradient, surrogate, anchorKl: kl, clippedFraction: clipped };
}

export function adamStep(state, gradient, config) {
  const norm = Math.hypot(...gradient);
  const factor = norm > config.maximumGradientNorm ? config.maximumGradientNorm / norm : 1;
  state.step++;
  state.weights = state.weights.map((weight, index) => {
    const value = gradient[index] * factor;
    state.m[index] = config.beta1 * state.m[index] + (1 - config.beta1) * value;
    state.v[index] = config.beta2 * state.v[index] + (1 - config.beta2) * value * value;
    return weight - config.learningRate * (state.m[index] / (1 - config.beta1 ** state.step))
      / (Math.sqrt(state.v[index] / (1 - config.beta2 ** state.step)) + config.epsilon);
  });
  if (!state.weights.every(Number.isFinite)) throw new Error("Nonfinite Adam weights.");
  return state;
}
