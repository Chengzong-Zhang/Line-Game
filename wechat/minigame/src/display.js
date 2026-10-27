const KEY = 'lifeline-wx-display-v1';
export const PLAYER_COLORS = Object.freeze({ BLACK: '#3578d4', WHITE: '#d96356', PURPLE: '#8b5cf6', GREEN: '#218557', ORANGE: '#bd6a13', CYAN: '#087f9b' });
export const PLAYER_CONTRAST_COLORS = Object.freeze({ BLACK: '#1855ae', WHITE: '#b7382e', PURPLE: '#7342bb', GREEN: '#126439', ORANGE: '#995000', CYAN: '#00657a' });
export const PLAYER_LABEL_KEYS = Object.freeze({ BLACK: 'black', WHITE: 'white', PURPLE: 'purple', GREEN: 'green', ORANGE: 'orange', CYAN: 'cyan' });
export const DEFAULT_DISPLAY = Object.freeze({ territories: true, legalMoves: true, lastMove: true, coordinates: false, highContrast: false });

export function normalizeDisplay(value) {
  return Object.fromEntries(Object.entries(DEFAULT_DISPLAY).map(([key, fallback]) =>
    [key, typeof value?.[key] === 'boolean' ? value[key] : fallback]));
}
export function readDisplay(storage) {
  try { return normalizeDisplay(JSON.parse(storage.get(KEY) || '{}')); }
  catch (_) { return { ...DEFAULT_DISPLAY }; }
}
export function saveDisplay(storage, value) {
  const normalized = normalizeDisplay(value), raw = JSON.stringify(normalized);
  storage.set(KEY, raw);
  if (storage.get(KEY) !== raw) throw new Error('SAVE_WRITE_FAILED');
  return normalized;
}
