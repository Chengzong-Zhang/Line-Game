import { PLAYER_ORDER } from "./GameEngine.js?v=20261025-terminal-v4";

const accents = ["blue", "red", "purple", "green", "orange", "cyan", "pink", "brown", "lime", "navy", "gold", "teal", "magenta", "slate", "coral"];
const colors = ["#2b6fff", "#e44b4b", "#8b5cf6", "#22965a", "#e79824", "#16a6b6", "#d96ba5", "#8c593b", "#79a92b", "#344a8c", "#b99016", "#238b78", "#b13ba8", "#667085", "#d7684b"];
const chinese = ["蓝方", "红方", "紫方", "绿方", "橙方", "青方", "粉方", "棕方", "黄绿方", "藏蓝方", "金方", "蓝绿方", "品红方", "灰方", "珊瑚方"];
const english = ["Blue", "Red", "Purple", "Green", "Orange", "Cyan", "Pink", "Brown", "Lime", "Navy", "Gold", "Teal", "Magenta", "Slate", "Coral"];

export const PLAYER_PALETTE = Object.freeze(Object.fromEntries(PLAYER_ORDER.map((player, index) => [player,
  Object.freeze({ player, accent: accents[index], color: colors[index], chinese: chinese[index], english: english[index], number: index + 1 }),
])));

export function playerLabel(player, language = "zh") {
  return PLAYER_PALETTE[player]?.[language === "en" ? "english" : "chinese"] ?? player;
}
