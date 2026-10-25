import { PLAY_MODES } from './preferences.js';
import { playerIds } from './controllers.js';
import { PLAYER_COLORS, PLAYER_LABEL_KEYS } from './display.js';
import { MAX_SAVED_GAMES } from './library.js';

export function drawHome(ui, state, actions) {
  const { metrics: { width: w, height: h, bottom }, top, text, rect, wrap, button, label, ctx } = ui;
  const heroHeight = Math.max(80, Math.min(152, h - top - 326));
  rect(24, top, w - 48, heroHeight, 20, '#173e32');
  wrap(label('heroTitle'), 42, top + 25, w - 150, 21, '#fffdf3', 2);
  const gx = w - 76, gy = top + heroHeight / 2, scale = Math.min(35, heroHeight / 3);
  ctx.beginPath(); ctx.moveTo(gx, gy - scale); ctx.lineTo(gx - scale, gy + scale);
  ctx.lineTo(gx + scale, gy + scale); ctx.closePath(); ctx.strokeStyle = '#93bda4'; ctx.lineWidth = 3; ctx.stroke();
  for (const [x, y, color] of [[gx, gy - scale, '#f4f3e9'], [gx - scale, gy + scale, '#3578d4'], [gx + scale, gy + scale, '#d96356']]) {
    ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill();
  }
  if (heroHeight >= 110) text(label('heroSub'), 42, top + heroHeight - 19, 12, '#bcd3c3');
  let y = top + heroHeight + 14;
  button('new-game', label('start'), 24, y, w - 48, actions.start, { primary: true }); y += 57;
  const half = (w - 60) / 2, right = 36 + half;
  button('continue', label('continue'), 24, y, half, actions.continue, { disabled: !state.hasSave });
  button('learn', label('learn'), right, y, half, actions.lessons); y += 57;
  button('library', label('library'), 24, y, half, actions.library);
  button('friends', label('friends'), right, y, half, actions.friends, { disabled: state.deleting }); y += 57;
  button('settings', label('setup'), 24, y, half, actions.setup);
  button('about', label('about'), right, y, half, actions.about, { disabled: state.deleting });
  const footerY = Math.min(h - bottom - 18, y + 69);
  if (state.error) wrap(state.error, 24, footerY - 8, w - 48, 12, '#ac554c', 2);
  else text(`${state.size} × ${state.size} · ${label(state.mode)}`, w / 2, footerY, 12, '#738476', 'center');
}

export function drawSetup(ui, state, actions) {
  const { metrics: { width: w, height: h, bottom }, top, text, button, label } = ui;
  text(label('mode'), 24, top, 14, '#738476');
  button('players-setup', label('playerSetup'), w - 146, top - 24, 122, actions.players, { height: 42 });
  const half = (w - 60) / 2;
  PLAY_MODES.forEach((mode, i) => button(`mode-${mode}`, label(`short-${mode}`),
    i % 2 ? 36 + half : 24, top + 19 + Math.floor(i / 2) * 49, i === 4 ? w - 48 : half,
    () => actions.change('mode', mode), { primary: !state.controllers && state.mode === mode, height: 42 }));
  text(label('size'), 24, top + 181, 14, '#738476');
  text('5 – 15', w - 24, top + 181, 12, '#738476', 'right');
  button('size-minus', '−', 24, top + 199, 48, () => actions.change('size', state.size - 1), { disabled: state.size <= 5, height: 42 });
  text(`${state.size} × ${state.size}`, w / 2, top + 220, 22, '#244d3d', 'center', 'bold');
  button('size-plus', '+', w - 72, top + 199, 48, () => actions.change('size', state.size + 1), { disabled: state.size >= 15, height: 42 });
  text(label('difficulty'), 24, top + 261, 14, '#738476');
  for (const [i, difficulty] of ['easy', 'normal'].entries()) button(`difficulty-${difficulty}`, label(difficulty),
    i ? 36 + half : 24, top + 279, half, () => actions.change('difficulty', difficulty),
    { primary: state.difficulty === difficulty, disabled: state.playerCount > 2 || ['human', 'three-human'].includes(state.mode), height: 42 });
  button('setup-start', label('start'), 24, Math.max(top + 334, h - bottom - 58), w - 48, actions.start, { primary: true });
}

export function drawPlayers(ui, state, actions) {
  const { metrics: { width: w, height: h, bottom }, top, text, wrap, button, label } = ui;
  text(label('playerSetup'), 24, top, 19, '#244d3d', 'left', 'bold');
  button('swap-players', label('swapPlayers'), w - 128, top - 18, 104, actions.swap, { height: 36, disabled: state.playerCount !== 2 });
  button('players-minus', '−', 24, top + 28, 44, () => actions.players(state.playerCount - 1), { height: 40, disabled: state.playerCount <= 2 });
  text(`${state.playerCount} ${label('players')} · ${label(state.boardShape === 'hexagon' ? 'hexBoard' : 'triangleBoard')}`, w / 2, top + 48, 14, '#244d3d', 'center');
  button('players-plus', '+', w - 68, top + 28, 44, () => actions.players(state.playerCount + 1), { height: 40, disabled: state.playerCount >= 6 });
  const colors = playerIds(state.playerCount), footer = h - bottom - 112;
  const count = Math.max(1, Math.min(3, Math.floor((footer - top - 120) / 66)));
  const pages = Math.ceil(colors.length / count), page = Math.max(0, Math.min(pages - 1, state.page || 0));
  colors.slice(page * count, (page + 1) * count).forEach((player, index) => {
    const y = top + 82 + index * 66, cardWidth = w - 132;
    button(`controller-${player}`, '', 24, y, cardWidth, () => actions.controller(player), { height: 58 });
    text(label(PLAYER_LABEL_KEYS[player]), 38, y + 17, 14, PLAYER_COLORS[player]);
    wrap(label(`controller-${state.controllers[player]}`), 38, y + 40, cardWidth - 28, 14, '#244d3d', 1);
    button(`starter-${player}`, `${state.startPlayer === player ? '✓ ' : ''}${label('startsShort')}`, w - 100, y, 76,
      () => actions.starter(player), { height: 58, font: 13, primary: state.startPlayer === player });
  });
  wrap(label('compatibleAIHelp'),
    24, top + 88 + count * 66, w - 48, 12, '#738476', 2);
  if (pages > 1) {
    button('players-prev', '‹', 24, footer, 48, () => actions.page(page - 1), { height: 40, disabled: page === 0 });
    text(`${page + 1} / ${pages}`, w / 2, footer + 20, 14, '#738476', 'center');
    button('players-next', '›', w - 72, footer, 48, () => actions.page(page + 1), { height: 40, disabled: page + 1 === pages });
  }
  button('players-start', label('start'), 24, h - bottom - 58, w - 48, actions.start, { primary: true });
}

export function modelPageSize(metrics, top) { return Math.max(2, Math.min(5, Math.floor((metrics.height - metrics.bottom - top - 220) / 55))); }
export function drawModels(ui, state, actions) {
  const { metrics, top, text, wrap, button, label } = ui, { width: w, height: h, bottom } = metrics;
  text(`${state.target} · AI`, 24, top, 18, '#244d3d', 'left', 'bold');
  button('models-info', label('aboutModels'), w - 106, top - 17, 82, actions.info, { height: 36 });
  const half = (w - 60) / 2;
  for (const [i, group] of ['research', 'policy'].entries()) button(`models-${group}`, group === 'research' ? 'PUCT · CNN/GNN' : 'DQN / PPO / …',
    i ? 36 + half : 24, top + 31, half, () => actions.group(group), { primary: state.group === group, height: 42 });
  const count = modelPageSize(metrics, top), pages = Math.max(1, Math.ceil(state.models.length / count));
  const page = Math.max(0, Math.min(pages - 1, state.page));
  state.models.slice(page * count, (page + 1) * count).forEach((model, i) => {
    const y = top + 87 + i * 55;
    button(`model-${model.id}`, '', 24, y, w - 48, () => actions.select(model.profile), { height: 48 });
    text(model.title, 38, y + 16, 15, '#244d3d');
    text(`${model.research ? 'PUCT 16' : '5–15'}${model.experimental ? ` · ${label('experimental')}` : ''}`, 38, y + 36, 11, '#738476');
    text('›', w - 42, y + 24, 23, '#738476');
  });
  if (!state.models.length) wrap(ui.language === 'en' ? 'No compatible models in this group for the current board.' : '当前棋盘没有此分类下可用的模型。', 24, top + 112, w - 48, 15, '#738476', 3);
  const footer = h - bottom - 113;
  button('models-prev', '‹', 24, footer, 48, () => actions.page(-1), { disabled: page === 0, height: 40 });
  text(`${page + 1} / ${pages}`, w / 2, footer + 20, 14, '#738476', 'center');
  button('models-next', '›', w - 72, footer, 48, () => actions.page(1), { disabled: page === pages - 1, height: 40 });
  button('models-back', label('back'), 24, footer + 52, w - 48, actions.back, { height: 48 });
}

export function drawAnalysis(ui, state, actions) {
  const { metrics: { width: w, height: h, bottom }, top, text, wrap, rect, button, label } = ui;
  text(`${label('analysis')} · ${state.cursor}`, 24, top, 18, '#244d3d', 'left', 'bold');
  button('analysis-compare', label('compare'), w - 106, top - 17, 82, actions.compare,
    { height: 36, disabled: state.comparisons < 2 });
  button('analysis-choose', label(`controller-${state.profile}`), 24, top + 31, w - 48, actions.choose, { height: 42 });
  const result = state.result;
  wrap(state.error || (state.progress != null ? `${label('modelLoading')} ${state.progress}%`
    : state.busy ? label('thinking') : label(`metric-${result?.metric || 'heuristic'}`)),
  24, top + 92, w - 48, 12, state.error ? '#ac554c' : '#738476', 2);
  if (result) result.moves.forEach((move, i) => {
    const y = top + 131 + i * 55;
    button(`analysis-move-${i}`, '', 24, y, w - 48, () => actions.preview(move), { height: 48 });
    text(`${i + 1}   ${move.point ? `(${move.point.join(', ')})` : label('skip')}`, 40, y + 24, 16, '#244d3d');
    const score = result.metric === 'puct' ? `${move.visits} ${label('visits')} · ${(Number(move.meanValue) || 0).toFixed(3)}`
      : result.metric === 'prior' ? `${(move.score * 100).toFixed(1)}%` : Number(move.score).toFixed(2);
    text(score, w - 40, y + 24, 13, '#738476', 'right');
  });
  if (!result && !state.busy) button('analysis-retry', label('analyzeReplay'), 24, top + 150, w - 48, actions.retry);
  button('analysis-back', label('backToReplay'), 24, h - bottom - 58, w - 48, actions.back, { primary: true });
}

export function drawPlayOptions(ui, state, actions) {
  const { metrics: { width: w, height: h, bottom }, top, text, wrap, button, label } = ui;
  text(label('playOptions'), 24, top, 19, '#244d3d', 'left', 'bold');
  button('options-display', label('displayShort'), w - 90, top - 18, 66, actions.display, { height: 36 });
  wrap(label('clockHelp'), 24, top + 28, w - 48, 12, '#738476', 2);
  button('timer-toggle', `${label('turnClock')} · ${label(state.turnTimerEnabled ? 'enabled' : 'disabled')}`, 24, top + 64, w - 48,
    () => actions.change('turnTimerEnabled', !state.turnTimerEnabled), { primary: state.turnTimerEnabled, height: 44 });
  button('timer-duration', `${label('perTurn')} ${state.turnTimeLimitSeconds}s`, 24, top + 116, w - 48,
    actions.duration, { disabled: !state.turnTimerEnabled, height: 44 });
  button('hints-toggle', `${label('hint')} · ${label(state.hintEnabled ? 'enabled' : 'disabled')}`, 24, top + 185, w - 48,
    () => actions.change('hintEnabled', !state.hintEnabled), { primary: state.hintEnabled, height: 44 });
  button('hints-minus', '−', 24, top + 237, 48, () => actions.change('hintMaxCount', state.hintMaxCount - 1),
    { disabled: !state.hintEnabled || state.hintMaxCount <= 1, height: 44 });
  text(`${label('hintBudget')} ${state.hintMaxCount}`, w / 2, top + 259, 15, '#244d3d', 'center');
  button('hints-plus', '+', w - 72, top + 237, 48, () => actions.change('hintMaxCount', state.hintMaxCount + 1),
    { disabled: !state.hintEnabled || state.hintMaxCount >= 10, height: 44 });
  wrap(label('hintBudgetHelp'), 24, top + 299, w - 48, 12, '#738476', 2);
  button('options-start', label('start'), 24, h - bottom - 58, w - 48, actions.start, { primary: true });
}

export function drawLessons(ui, levels, completed, select) {
  const { metrics: { width: w }, top, text, wrap, button, label, language } = ui;
  text(`${label('learn')} · ${completed.size}/5`, 24, top, 18, '#244d3d', 'left', 'bold');
  levels.forEach((level, i) => {
    const y = top + 31 + i * 65;
    button(`lesson-${i}`, '', 24, y, w - 48, () => select(i), { height: 56 });
    text(String(i + 1).padStart(2, '0'), 44, y + 28, 22, completed.has(i) ? '#3578d4' : '#738476');
    const title = (language === 'zh' ? level.titleZh : level.titleEn).replace(/^.*?[：:]\s*/, '');
    wrap(`${completed.has(i) ? '✓ ' : ''}${title}`, 86, y + 20, w - 122, 14, '#244d3d', 2);
  });
}

export function libraryPageSize(metrics, top) { return Math.max(2, Math.min(5, Math.floor((metrics.height - metrics.bottom - top - 180) / 62))); }
export function drawLibrary(ui, state, actions) {
  const { metrics, top, text, wrap, button, label } = ui, { width: w, height: h, bottom } = metrics;
  const count = libraryPageSize(metrics, top), pages = Math.max(1, Math.ceil(state.entries.length / count));
  text(`${label('library')} · ${state.entries.length}/${MAX_SAVED_GAMES}`, 24, top, 18, '#244d3d', 'left', 'bold');
  text(`${state.page + 1} / ${pages}`, w - 24, top, 12, '#738476', 'right');
  state.entries.slice(state.page * count, (state.page + 1) * count).forEach((entry, i) => {
    const y = top + 27 + i * 62, { settings, actions: moves } = entry.payload.session;
    button(`saved-${entry.id}`, '', 24, y, w - 48, () => actions.open(entry), { height: 54, disabled: state.busy });
    text(`${settings.gridSize} × ${settings.gridSize} · ${settings.playerCount} ${label('players')} · ${moves.length} ${label('moves')}`, 40, y + 19, 15);
    text(new Date(entry.savedAt).toLocaleDateString(), 40, y + 39, 11, '#738476');
  });
  if (!state.entries.length) wrap(label('libraryEmpty'), 32, top + 55, w - 64, 15, '#738476', 4);
  const half = (w - 60) / 2, footer = h - bottom - 151;
  button('library-prev', label('previous'), 24, footer, half, () => actions.page(-1), { height: 36, disabled: state.busy || state.page === 0 });
  button('library-next', label('next'), 36 + half, footer, half, () => actions.page(1), { height: 36, disabled: state.busy || state.page + 1 >= pages });
  button('import-replay', label('importReplay'), 24, footer + 46, half, actions.import, { disabled: state.busy });
  button('export-replay', label('exportReplay'), 36 + half, footer + 46, half, actions.export, { disabled: state.busy || !state.hasGame });
  button('save-replay', label(state.busy ? 'thinking' : 'saveReplay'), 24, footer + 103, w - 48, actions.save, { primary: true, disabled: state.busy || !state.hasGame });
}
