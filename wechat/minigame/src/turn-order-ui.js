import { PLAYER_COLORS, PLAYER_CONTRAST_COLORS } from './display.js';

function tint(color, amount = 0.78) {
  const hex = color.startsWith('#') ? color.slice(1) : color;
  const values = [0, 2, 4].map(offset => Number.parseInt(hex.slice(offset, offset + 2), 16));
  if (values.some(value => !Number.isFinite(value))) return '#f2eadc';
  return `#${values.map(value => Math.round(value + (255 - value) * amount).toString(16).padStart(2, '0')).join('')}`;
}

export function turnOrderRegions({ players = [], order = players, x, y, width, columns = 6, gap = 6,
  tileHeight = 42 } = {}) {
  const validPlayers = new Set(players);
  const filtered = [];
  for (const player of Array.isArray(order) ? order : []) {
    if (validPlayers.has(player) && !filtered.includes(player)) filtered.push(player);
  }
  for (const player of players) if (!filtered.includes(player)) filtered.push(player);
  const colCount = Math.max(1, Math.min(columns, filtered.length || 1));
  const tileWidth = (width - gap * (colCount - 1)) / colCount;
  return filtered.map((player, index) => ({ player, order: index + 1,
    x: x + index % colCount * (tileWidth + gap), y: y + Math.floor(index / colCount) * (tileHeight + gap),
    width: tileWidth, height: tileHeight, color: PLAYER_COLORS[player] || '#667085',
    contrast: PLAYER_CONTRAST_COLORS[player] || '#475064' }));
}

// Draw-only fallback; the returned hit regions let app.js own drag gestures.
export function drawTurnOrderStrip(ui, options = {}) {
  const regions = turnOrderRegions(options);
  const { text, rect } = ui;
  for (const region of regions) {
    rect(region.x, region.y, region.width, region.height, 11, options.disabled ? '#e7dfd0' : tint(region.color));
    if (ui.ctx && region.player === 'WHITE') {
      ui.ctx.strokeStyle = '#fff'; ui.ctx.lineWidth = 2;
      ui.ctx.strokeRect(region.x + 1, region.y + 1, region.width - 2, region.height - 2);
    }
    if (ui.ctx && !options.disabled) {
      ui.ctx.strokeStyle = region.contrast; ui.ctx.lineWidth = 1;
      ui.ctx.strokeRect(region.x + 1, region.y + 1, region.width - 2, region.height - 2);
    }
    text(String(region.order), region.x + region.width / 2, region.y + region.height / 2,
      Math.min(16, region.width < 42 ? 12 : 15), options.disabled ? '#9b9183' : region.contrast, 'center', 'bold');
  }
  const rows = regions.length ? Math.floor((regions.length - 1) / Math.max(1, Math.min(options.columns || 6, options.players?.length || 1))) + 1 : 0;
  return { height: rows * (options.tileHeight || 42) + Math.max(0, rows - 1) * (options.gap ?? 6), regions };
}
