// Pure offline/online experiment helper. No Node, DOM, model, or territory dependency.
const check = (condition, message) => { if (!condition) throw new Error(message); };
// Pure, reusable evaluation. Callers supply the already computed native graph
// metrics; this function cannot trigger territory scoring or mutate an engine.
export function evaluateNonterminalTeacher(metrics, actor, alive, boardPointCount, {
  nodeWeight = 15 / 43, coverageWeight = 8 / 43, reachWeight = 20 / 43, valueTemperature = 0.12,
} = {}) {
  check(Number.isInteger(boardPointCount) && boardPointCount > 0 && Array.isArray(alive) && alive.length > 0
    && new Set(alive).size === alive.length && metrics?.[actor] && alive.every(player => metrics[player]), 'Invalid heuristic evaluation state');
  check([nodeWeight, coverageWeight, reachWeight, valueTemperature].every(Number.isFinite)
    && nodeWeight >= 0 && coverageWeight >= 0 && reachWeight >= 0 && nodeWeight + coverageWeight + reachWeight > 0
    && valueTemperature > 0, 'Invalid explicit heuristic evaluation weights');
  const heuristicStrengths = Object.fromEntries(Object.entries(metrics).map(([player, row]) => {
    check(['nodes', 'coverage', 'reach'].every(name => Number.isFinite(row[name]) && row[name] >= 0), 'Invalid heuristic graph counts');
    return [player, nodeWeight * row.nodes + coverageWeight * row.coverage + reachWeight * row.reach];
  }));
  const values = alive.map(player => heuristicStrengths[player]), maximum = Math.max(...values);
  const exp = values.map(value => Math.exp((value - maximum) / (boardPointCount * valueTemperature)));
  const heuristicValue = alive.includes(actor) ? exp[alive.indexOf(actor)] / exp.reduce((sum, value) => sum + value, 0) : 0;
  const heuristicMargin = (heuristicStrengths[actor] - Math.max(0, ...alive.filter(player => player !== actor).map(player => heuristicStrengths[player]))) / boardPointCount;
  return { heuristicValue, heuristicMargin, heuristicStrengths };
}

// An opt-in tactical signal, not area or win probability. Counts refer to the
// same root action before/after one real opponent reply. A captured node only
// earns sustained-cut credit while the attacking node remains root-connected.
export function evaluateReplyResilience({ boardPointCount, ownNodesAfterRoot,
  retainedOwnNodes, capturedNodesAfterRoot, retainedCapturedNodes, attackNodeSurvives,
  followupCutNodes = 0 }) {
  const counts = [boardPointCount, ownNodesAfterRoot, retainedOwnNodes,
    capturedNodesAfterRoot, retainedCapturedNodes, followupCutNodes];
  check(counts.every(Number.isInteger) && boardPointCount > 0
    && counts.slice(1).every(value => value >= 0 && value <= boardPointCount)
    && retainedOwnNodes <= ownNodesAfterRoot
    && retainedCapturedNodes <= capturedNodesAfterRoot
    && typeof attackNodeSurvives === 'boolean', 'Invalid reply-resilience counts');
  const lostOwnNodes = ownNodesAfterRoot - retainedOwnNodes;
  const sustainedCutNodes = attackNodeSurvives ? retainedCapturedNodes : 0;
  return { score: (retainedOwnNodes - lostOwnNodes + sustainedCutNodes + followupCutNodes) / (3 * boardPointCount),
    cutRisk: lostOwnNodes / boardPointCount, retainedOwnNodes, lostOwnNodes,
    sustainedCutNodes, attackNodeSurvives, followupCutNodes };
}

// Positive means a strictly better COMPLETE next-opponent packet. Floating
// heuristic scores cannot compensate for a lost node or lost supply coverage.
export function compareCompletedReplyResilience(candidate, incumbent, { anchor = incumbent } = {}) {
  for (const packet of [candidate, incumbent, anchor]) {
    check(packet?.complete === true && packet.reason === 'complete'
      && packet.terminalRoot === false && typeof packet.replyPlayer === 'string'
      && Number.isInteger(packet.repliesCompleted) && packet.repliesCompleted > 0
      && ['maximumNodeLoss', 'maximumCoverageLoss', 'minimumRetainedCapturedNodes'].every(name =>
        Number.isInteger(packet[name]) && packet[name] >= 0)
      && Number.isInteger(packet.worstNetNodeGain)
      && packet.worstNetNodeGain === packet.minimumRetainedCapturedNodes - packet.maximumNodeLoss
      && Number.isFinite(packet.minimumDefenseSignal)
      && typeof packet.rootWasAttack === 'boolean'
      && typeof packet.allRepliesRetainAttackNode === 'boolean'
      && typeof packet.conditionalFollowupComplete === 'boolean'
      && (packet.conditionalFollowupComplete
        ? Number.isInteger(packet.minimumFollowupCutNodes) && packet.minimumFollowupCutNodes >= 0
          && typeof packet.allRepliesRetainFollowupCut === 'boolean'
          && packet.allRepliesRetainFollowupCut === (packet.minimumFollowupCutNodes >= 1)
        : packet.minimumFollowupCutNodes === null && packet.allRepliesRetainFollowupCut === null)
      && (!packet.allRepliesRetainAttackNode || packet.rootWasAttack),
    'Incomplete or invalid reply-resilience comparison');
  }
  // A defensive replacement cannot give up guaranteed net node material from
  // the FIXED entry anchor. Among admissible roots retain the best complete
  // lexicographic packet, not merely the first root to clear that gate.
  if (candidate.maximumNodeLoss < anchor.maximumNodeLoss && candidate.worstNetNodeGain < anchor.worstNetNodeGain)
    return 0;
  const chain = packet => packet.allRepliesRetainFollowupCut ? packet.minimumFollowupCutNodes : 0;
  return incumbent.maximumNodeLoss - candidate.maximumNodeLoss
    || candidate.worstNetNodeGain - incumbent.worstNetNodeGain
    || incumbent.maximumCoverageLoss - candidate.maximumCoverageLoss
    || Number(candidate.allRepliesRetainAttackNode) - Number(incumbent.allRepliesRetainAttackNode)
    || (candidate.conditionalFollowupComplete && incumbent.conditionalFollowupComplete ? chain(candidate) - chain(incumbent) : 0);
}

