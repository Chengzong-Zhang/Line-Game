import { PointState } from "./GameEngine.js?v=20261021-boardshapes1";

const PLAYER_NAMES = {
  zh: { BLACK: "蓝方", WHITE: "红方", PURPLE: "紫方", GREEN: "绿方", ORANGE: "橙方", CYAN: "青方", DRAW: "平局" },
  en: { BLACK: "Blue", WHITE: "Red", PURPLE: "Purple", GREEN: "Green", ORANGE: "Orange", CYAN: "Cyan", DRAW: "Draw" },
};

function edgeSet(snapshot) {
  return new Set(Object.entries(snapshot?.edges ?? {}).flatMap(([player, edges]) => (edges ?? []).map((edge) => `${player}\u0000${edge}`)));
}

const NODE_OWNER_BY_STATE = new Map([
  [PointState.BLACK_NODE, "BLACK"],
  [PointState.WHITE_NODE, "WHITE"],
  [PointState.PURPLE_NODE, "PURPLE"],
  [PointState.GREEN_NODE, "GREEN"],
  [PointState.ORANGE_NODE, "ORANGE"],
  [PointState.CYAN_NODE, "CYAN"],
]);

export function summarizeGameTransition(before, after, action, language = "en") {
  const zh = language === "zh";
  const names = PLAYER_NAMES[zh ? "zh" : "en"];
  const labels = [];
  const beforeEdges = edgeSet(before);
  const afterEdges = edgeSet(after);
  const addedEdges = [...afterEdges].filter((edge) => !beforeEdges.has(edge)).length;
  const removedEdges = [...beforeEdges].filter((edge) => !afterEdges.has(edge)).length;
  const beforeBoard = before?.boardMatrix ?? [];
  const afterBoard = after?.boardMatrix ?? [];
  const removedNodesByPlayer = { BLACK: 0, WHITE: 0, PURPLE: 0, GREEN: 0, ORANGE: 0, CYAN: 0 };
  for (let row = 0; row < Math.max(beforeBoard.length, afterBoard.length); row += 1) {
    for (let col = 0; col < Math.max(beforeBoard[row]?.length ?? 0, afterBoard[row]?.length ?? 0); col += 1) {
      const previous = Number(beforeBoard[row]?.[col] ?? PointState.EMPTY);
      const current = Number(afterBoard[row]?.[col] ?? PointState.EMPTY);
      const previousOwner = NODE_OWNER_BY_STATE.get(previous);
      if (previousOwner && current !== previous) removedNodesByPlayer[previousOwner] += 1;
    }
  }

  if (action?.type === "move") {
    const point = Array.isArray(action.point) ? `(${action.point[0]}, ${action.point[1]})` : "";
    const player = names[action.player] ?? action.player;
    labels.push(zh ? `${player}落子 ${point}`.trim() : `${player} played at ${point}`.trim());
  }
  if (action?.type === "skip") labels.push(zh ? "已跳过本回合" : "Turn skipped");
  if (action?.type === "resign") labels.push(zh ? `${names[action.player] ?? action.player}认输` : `${names[action.player] ?? action.player} resigned`);
  if (addedEdges) labels.push(zh ? `新增 ${addedEdges} 条连线` : `Connected ${addedEdges} new ${addedEdges === 1 ? "link" : "links"}`);
  if (removedEdges) labels.push(zh ? `切断 ${removedEdges} 条连线` : `Cut ${removedEdges} ${removedEdges === 1 ? "link" : "links"}`);
  for (const [player, count] of Object.entries(removedNodesByPlayer)) {
    if (count) labels.push(zh ? `${names[player]}失去 ${count} 个节点` : `${names[player]} lost ${count} ${count === 1 ? "node" : "nodes"}`);
  }
  const removedNodes = Object.values(removedNodesByPlayer).reduce((sum, count) => sum + count, 0);

  const territoryDeltas = [];
  for (const player of after?.players ?? Object.keys(after?.territories ?? {})) {
    const oldArea = Number(before?.territories?.[player]?.area ?? 0);
    const newArea = Number(after?.territories?.[player]?.area ?? 0);
    const delta = newArea - oldArea;
    if (delta) territoryDeltas.push(`${names[player] ?? player} ${delta > 0 ? "+" : ""}${delta}`);
  }
  if (territoryDeltas.length) labels.push(zh ? `领土变化：${territoryDeltas.join("、")}` : `Territory: ${territoryDeltas.join(", ")}`);

  if (after?.gameOver) {
    const winner = names[after.winner] ?? after.winner ?? (zh ? "无胜者" : "No winner");
    labels.push(zh ? `本局结束：${winner}${after.winner === "DRAW" ? "" : "获胜"}` : `Game over: ${winner}${after.winner === "DRAW" ? "" : " wins"}`);
  }
  if (!labels.length) labels.push(zh ? "局面已更新。" : "Position updated.");

  const kind = after?.gameOver ? "terminal" : removedNodes ? "clear" : territoryDeltas.length ? "territory" : addedEdges ? "connect" : removedEdges ? "cut" : "move";
  return { text: labels.join(zh ? "；" : ". "), kind, addedEdges, removedEdges, removedNodes, removedNodesByPlayer, territoryDeltas };
}

