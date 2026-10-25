import { createResearchModel, researchRelations } from "./ResearchAI.js?v=20261025-unified1";

const FEATURE_COUNT = 11;
const EPSILON = 1e-5;
const relu = value => value > 0 ? value : 0;

// Keep the reference's multiplication order and Float32 write boundaries.
function linear(input, inputSize, outputSize, weight, bias) {
  const output = new Float32Array(outputSize);
  for (let out = 0; out < outputSize; out += 1) {
    let total = bias ? bias[out] : 0;
    const offset = out * inputSize;
    for (let index = 0; index < inputSize; index += 1) total += weight[offset + index] * input[index];
    output[out] = total;
  }
  return output;
}

// Equivalent to ResearchPolicyValueModel.forwardGnn, except empty relation rows
// omit the dense zero projection. Nonempty aggregation and all heads are shared
// with the reference contract; this does not prune any legal move or relation.
export function forwardMultiplayerGnn(model, engine, encoded) {
  const nodes = engine.validPositions.length;
  const channels = model.channels;
  let hidden = new Float32Array(nodes * channels);
  for (let node = 0; node < nodes; node += 1) {
    const projected = linear(encoded.features.subarray(node * FEATURE_COUNT, (node + 1) * FEATURE_COUNT), FEATURE_COUNT, channels,
      model.tensor("input_projection.weight"), model.tensor("input_projection.bias"));
    for (let channel = 0; channel < channels; channel += 1) hidden[node * channels + channel] = relu(projected[channel]);
  }
  const relations = researchRelations(engine, encoded.player, model.spec.model_kind === "topology_gnn");
  const relationCount = model.spec.model_kind === "topology_gnn" ? 3 : 1;
  for (let layer = 0; layer < model.layers; layer += 1) {
    const update = new Float32Array(nodes * channels);
    const selfWeight = model.tensor(`blocks.${layer}.self_projection.weight`);
    const selfBias = model.tensor(`blocks.${layer}.self_projection.bias`);
    for (let node = 0; node < nodes; node += 1) {
      update.set(linear(hidden.subarray(node * channels, (node + 1) * channels), channels, channels, selfWeight, selfBias), node * channels);
    }
    for (let relation = 0; relation < relationCount; relation += 1) {
      const weight = model.tensor(`blocks.${layer}.relation_projections.${relation}.weight`);
      for (let node = 0; node < nodes; node += 1) {
        const neighbors = relations[relation][node];
        if (!neighbors.length) {
          // Finite weights times zero, accumulated from +0 without bias, yield
          // +0. Keep this addition because -0 + +0 must still become +0.
          for (let channel = 0; channel < channels; channel += 1) update[node * channels + channel] += 0;
          continue;
        }
        const aggregate = new Float32Array(channels);
        for (const neighbor of neighbors) for (let channel = 0; channel < channels; channel += 1) aggregate[channel] += hidden[neighbor * channels + channel] / neighbors.length;
        const projected = linear(aggregate, channels, channels, weight, null);
        for (let channel = 0; channel < channels; channel += 1) update[node * channels + channel] += projected[channel];
      }
    }
    for (let index = 0; index < update.length; index += 1) update[index] = hidden[index] + relu(update[index]);
    const normWeight = model.tensor(`blocks.${layer}.normalization.weight`);
    const normBias = model.tensor(`blocks.${layer}.normalization.bias`);
    for (let offset = 0; offset < update.length; offset += channels) {
      let mean = 0;
      for (let channel = 0; channel < channels; channel += 1) mean += update[offset + channel];
      mean /= channels;
      let variance = 0;
      for (let channel = 0; channel < channels; channel += 1) {
        const delta = update[offset + channel] - mean;
        variance += delta * delta;
      }
      const scale = 1 / Math.sqrt(variance / channels + EPSILON);
      for (let channel = 0; channel < channels; channel += 1) {
        update[offset + channel] = (update[offset + channel] - mean) * scale * normWeight[channel] + normBias[channel];
      }
    }
    hidden = update;
  }
  return model.applyHeads(hidden, nodes);
}

// The inherited 11 channels retain their relative meaning; all opponents are
// represented rather than silently selecting a single opponent in a 6-seat game.
export function encodeMultiplayerPosition(engine) {
  const player=engine.currentPlayer, own=engine._getPlayerStates(player);
  const opponents=engine.activePlayers.filter(p=>p!==player);
  const nodes=new Set(opponents.map(p=>engine._getPlayerStates(p).node));
  const lines=new Set(opponents.map(p=>engine._getPlayerStates(p).line));
  const homes=new Set(opponents.map(p=>engine.initialPositions[p].join(",")));
  const home=engine.initialPositions[player].join(","), scale=(engine.gridSize-1)*(engine.boardShape==="hexagon"?2:1);
  const features=new Float32Array(engine.validPositions.length*11);
  engine.validPositions.forEach((point,i)=>{
    const state=engine._getState(point), key=point.join(",");
    features.set([Number(state===0),Number(state===own.node),Number(state===own.line),
      Number(nodes.has(state)),Number(lines.has(state)),point[0]/scale,point[1]/scale,
      Number(engine._adjIdxList[i].length<6),Number(key===home),Number(homes.has(key)),
      Math.min(Math.max(engine.consecutiveSkips,0),2)/2],i*11);
  });
  return {features,player,passIndex:engine.validPositions.length,
    legal:engine.getLegalMoves().map(m=>engine._keyToIdx.get(m.point.join(",")))};
}

function createModel(spec,raw,forward) {
  if (!["grid_gnn","topology_gnn"].includes(spec.model_kind)) throw new Error("Unsupported multiplayer network");
  const inherited=createResearchModel(spec,raw);
  return {spec,evaluate(engine) {
    if (![3,4,5,6].includes(engine.playerCount) || !["territory-v2", "territory-v3"].includes(engine.rulesVersion) || engine.gameOver
      || engine.boardShape!==(engine.playerCount===3?"triangle":"hexagon")) throw new Error("Unsupported multiplayer model position");
    const encoded=encodeMultiplayerPosition(engine);
    // forwardGnn reads relation 2 via the first opponent. Supply a read-only
    // view whose opponent relation is the union, matching training exactly.
    const view=Object.create(engine), union=new Set();
    for(const p of engine.activePlayers) if(p!==encoded.player) for(const edge of engine.edges[p]) union.add(edge);
    view.edges={...engine.edges,ALL_OPPONENTS:union}; view._getOpponents=()=>["ALL_OPPONENTS"];
    const result=forward(inherited,view,encoded);
    if(![...result.pointScores,result.value,result.passScore].every(Number.isFinite)) throw new Error("Nonfinite multiplayer inference");
    const maximum=Math.max(...encoded.legal.map(i=>result.pointScores[i]));
    const exp=encoded.legal.map(i=>Math.exp(result.pointScores[i]-maximum));
    const total=exp.reduce((a,b)=>a+b,0);
    return {...result,priors:encoded.legal.map((index,i)=>({point:[...engine.validPositions[index]],
      actionIndex:index,prior:exp[i]/total,logit:result.pointScores[index]}))};
  }};
}

export function createMultiplayerModel(spec,raw) {
  return createModel(spec,raw,forwardMultiplayerGnn);
}

// Read-only oracle for parity checks and same-input performance comparisons.
export function createMultiplayerReferenceModel(spec,raw) {
  return createModel(spec,raw,(model,engine,encoded)=>model.forwardGnn(engine,encoded));
}
