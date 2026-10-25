import { multiplayerClock as performance } from "./MultiplayerClock.js";
import { probeMultiplayerReplyResilience } from "./MultiplayerSearch.js";

export const STANDARD_DEFENSE_GATE = Object.freeze({
  shortlistWidth: 4,
  maximumRoots: 2,
  totalWindowMs: 60,
  maxProbes: 4096,
  followupMode: "none",
});

const samePoint = (left, right) => Array.isArray(left) && Array.isArray(right)
  && left.length === right.length && left.every((value, index) => value === right[index]);
const pointKey = point => Array.isArray(point) ? point.join(",") : "PASS";

function countercutRepair(anchor, move) {
  const before = anchor?.features, after = move?.features;
  return Array.isArray(before) && before.length === 16 && Array.isArray(after) && after.length === 16
    && after[10] === 1 && Number.isFinite(before[6]) && after[6] === before[6]
    && Number.isFinite(before[9]) && Number.isFinite(after[9]) && after[9] > before[9];
}

function completePacketFor(packet, source, move) {
  return packet?.complete === true && packet.reason === "complete" && packet.terminalRoot === false
    && packet.player === source.currentPlayer && samePoint(packet.rootPoint, move.point)
    && typeof packet.replyPlayer === "string" && packet.replyPlayer !== source.currentPlayer
    && source.activePlayers.includes(packet.replyPlayer)
    && !source.resignedPlayers?.has(packet.replyPlayer)
    && Number.isInteger(packet.repliesCompleted) && packet.repliesCompleted > 0
    && packet.repliesCompleted <= source.validPositions.length + 1
    && packet.followupMode === STANDARD_DEFENSE_GATE.followupMode
    && [packet.maximumNodeLoss, packet.maximumCoverageLoss, packet.minimumRetainedCapturedNodes]
      .every(value => Number.isInteger(value) && value >= 0);
}

export function strictlyImprovesStandardDefense(anchor, challenger) {
  if (!anchor || !challenger) return false;
  const nodeSafe = challenger.maximumNodeLoss <= anchor.maximumNodeLoss;
  const coverageSafe = challenger.maximumCoverageLoss <= anchor.maximumCoverageLoss;
  const strictlySafer = challenger.maximumNodeLoss < anchor.maximumNodeLoss
    || challenger.maximumCoverageLoss < anchor.maximumCoverageLoss;
  const captureSafe = challenger.minimumRetainedCapturedNodes >= anchor.minimumRetainedCapturedNodes;
  return nodeSafe && coverageSafe && strictlySafer && captureSafe;
}

function promoteOriginalObject(ranking, challenger) {
  const index = ranking.findIndex(move => samePoint(move.point, challenger.point));
  const selected = index >= 0 ? ranking[index] : challenger;
  return [selected, ...ranking.filter((_, candidateIndex) => candidateIndex !== index)]
    .slice(0, ranking.length);
}

export function applyStandardDefenseGate(source, originalRanking, {
  completeRanking = null,
  now = () => performance.now(),
  probe = probeMultiplayerReplyResilience,
  startedAt = null,
} = {}) {
  const original = Array.isArray(originalRanking) ? originalRanking : [];
  const fallback = (status, details = {}) => ({ moves: original, receipt: {
    status, rootsConsidered: 0, selectedPoint: original[0]?.point ?? null, ...details,
  } });
  if (!Array.isArray(originalRanking) || original.length < 2 || source.gameOver)
    return fallback("preserved-no-comparison");

  try {
    const started = startedAt ?? now();
    if (!Number.isFinite(started)) return fallback("preserved-invalid-clock");
    const deadline = started + STANDARD_DEFENSE_GATE.totalWindowMs;
    const roots = [original[0]], complete = Array.isArray(completeRanking) ? completeRanking : [];
    const anchorEvidence = complete.find(move => pointKey(move?.point) === pointKey(original[0].point));
    const repairs = complete.map((move, index) => ({ move, index }))
      .filter(({ move }) => pointKey(move?.point) !== pointKey(original[0].point) && countercutRepair(anchorEvidence, move))
      .sort((left, right) => right.move.features[9] - left.move.features[9]
        || right.move.features[5] - left.move.features[5]
        || left.index - right.index);
    if (repairs.length) roots.push(repairs[0].move);
    if (roots.length < 2) return fallback("preserved-no-repair-candidate");
    if (now() >= deadline) return fallback("preserved-deadline");

    const probeOptions = { maxReplies: source.validPositions.length + 1,
      maxProbes: STANDARD_DEFENSE_GATE.maxProbes,
      timeMs: STANDARD_DEFENSE_GATE.totalWindowMs, deadline,
      followupMode: STANDARD_DEFENSE_GATE.followupMode, now };
    const anchor = probe(source, roots[0].point, probeOptions);
    if (now() >= deadline) return fallback("preserved-deadline");
    if (!completePacketFor(anchor, source, roots[0])) return fallback("preserved-anchor-packet",
      { failedPoint: [...roots[0].point], packetReason: anchor?.reason ?? null });

    const improvements = [];
    for (let index = 1; index < roots.length; index += 1) {
      if (now() >= deadline) return fallback("preserved-deadline");
      const challenger = probe(source, roots[index].point, probeOptions);
      if (now() >= deadline) return fallback("preserved-deadline");
      if (!completePacketFor(challenger, source, roots[index])) return fallback("preserved-challenger-packet",
        { failedPoint: [...roots[index].point], packetReason: challenger?.reason ?? null, rootsConsidered: index + 1 });
      if (strictlyImprovesStandardDefense(anchor, challenger)) improvements.push({ move: roots[index], packet: challenger, index });
    }
    if (improvements.length) {
      improvements.sort((left, right) => left.packet.maximumNodeLoss - right.packet.maximumNodeLoss
        || left.packet.maximumCoverageLoss - right.packet.maximumCoverageLoss
        || right.packet.minimumRetainedCapturedNodes - left.packet.minimumRetainedCapturedNodes
        || left.index - right.index);
      const selected = improvements[0];
      return { moves: promoteOriginalObject(original, selected.move),
        receipt: { status: "selected-strict-defense-improvement", rootsConsidered: roots.length,
          selectedPoint: [...selected.move.point], anchorPoint: [...roots[0].point] } };
    }
    return { moves: original, receipt: { status: "preserved-no-strict-improvement",
      rootsConsidered: roots.length, selectedPoint: [...roots[0].point] } };
  } catch (_) {
    return fallback("preserved-error");
  }
}
