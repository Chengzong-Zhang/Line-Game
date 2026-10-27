export function drawReplayPrimary(ui, state, actions, y) {
  const width = (ui.metrics.width - 64) / 3;
  ['analyzeReplay', 'inspectReplay', 'branchReplay'].forEach((choice, index) => {
    ui.button(`replay-${choice}`, ui.label(choice), 24 + index * (width + 8), y, width,
      () => actions.select(choice), { height: 46, font: ui.language === 'en' ? 12 : 14,
        primary: choice === 'analyzeReplay', disabled: state.busy || choice === 'branchReplay' && !state.canBranch
          || choice === 'analyzeReplay' && !state.canAnalyze });
  });
}

export function drawReplayTools(ui, state, actions) {
  const { metrics: { width: w, height: h, bottom }, top, text, wrap, button, label } = ui;
  text(label('replayToolsTitle'), 24, top, 19, '#244d3d', 'left', 'bold');
  text(`${state.cursor} / ${state.total}`, w - 24, top, 14, '#738476', 'right');
  wrap(label('replayToolsHelp'), 24, top + 30, w - 48, 12, '#738476', 2);
  const choices = state.compactActions ? ['analyzeReplay', 'inspectReplay', 'branchReplay', 'jumpReplay'] : ['jumpReplay'];
  const half = (w - 60) / 2;
  choices.forEach((choice, i) => {
    const x = i % 2 ? 36 + half : 24, y = top + 80 + Math.floor(i / 2) * 55;
    const disabled = state.busy || choice === 'branchReplay' && !state.canBranch || choice === 'analyzeReplay' && !state.canAnalyze;
    button(`tool-${choice}`, '', x, y, half, () => actions.select(choice), { height: 48, disabled });
    wrap(label(choice), x + 13, y + 16, half - 26, 14, disabled ? '#9ba596' : '#244d3d', 2);
  });
  button('tools-back', label('backToReplay'), 24, h - bottom - 58, w - 48, actions.back, { primary: true });
}

// Match the Web transport symbols while keeping each touch target at least 44px.
export function drawReplayTransport(ui, state, actions, y) {
  const { metrics: { width: w }, button, seekBar, ctx } = ui;
  const iconButton = (id, icon, x, row, width, action, disabled, primary = false) => {
    button(id, '', x, row, width, action, { height: 44, disabled, primary });
    const cx = x + width / 2, cy = row + 22, left = icon === 'first' || icon === 'prev';
    ctx.fillStyle = disabled ? '#9b9183' : primary ? '#fff9ee' : '#2a2118';
    if (icon === 'pause') { ctx.fillRect(cx - 7, cy - 9, 5, 18); ctx.fillRect(cx + 2, cy - 9, 5, 18); return; }
    const shift = icon === 'first' ? 3 : icon === 'last' ? -3 : 0;
    ctx.beginPath(); ctx.moveTo(cx + shift + (left ? -7 : 7), cy);
    ctx.lineTo(cx + shift + (left ? 5 : -5), cy - 9);
    ctx.lineTo(cx + shift + (left ? 5 : -5), cy + 9); ctx.closePath(); ctx.fill();
    if (icon === 'first' || icon === 'last') ctx.fillRect(cx + (left ? -10 : 7), cy - 9, 3, 18);
  };
  const width = (w - 72) / 4;
  const steps = [['first', 0], ['prev', state.cursor - 1], ['next', state.cursor + 1], ['last', state.total]];
  steps.forEach(([id, cursor], index) => iconButton(`replay-${id}`, id,
    24 + index * (width + 8), y, width, () => actions.seek(cursor),
    state.busy || cursor < 0 || cursor > state.total || cursor === state.cursor));
  const row = y + 50, playWidth = 48, speedWidth = 54, trackX = 24 + playWidth + 8;
  iconButton('replay-play', state.playing ? 'pause' : 'play', 24, row, playWidth, actions.toggle,
    !state.playing && (state.busy || state.cursor >= state.total), true);
  seekBar('replay-timeline', state.cursor, state.total, trackX, row, w - 48 - playWidth - speedWidth - 16,
    actions.seek, state.busy || !state.total);
  button('replay-speed', `${Number((1000 / state.interval).toFixed(2))}×`, w - 24 - speedWidth, row, speedWidth,
    actions.speed, { height: 44, font: 14, disabled: state.busy });
}

export function drawBranch(ui, state, actions) {
  const { metrics: { width: w, height: h, bottom }, top, text, wrap, button, label } = ui;
  text(label('branchReplay'), 24, top, 19, '#244d3d', 'left', 'bold');
  wrap(label('branchPreserve'), 24, top + 30, w - 48, 12, '#738476', 2);
  text(`${label('branchPosition')} ${state.cursor} / ${state.total}`, 24, top + 83, 20, '#244d3d');
  button('branch-human', label('branchHuman'), 24, top + 111, w - 48, () => actions.players(false),
    { primary: !state.keepPlayers, disabled: state.busy, height: 46 });
  button('branch-keep', label('branchKeep'), 24, top + 167, w - 48, () => actions.players(true),
    { primary: state.keepPlayers, disabled: state.busy || !state.canKeep, height: 46 });
  wrap(state.error || label('branchReset'), 24, top + 239, w - 48, 12, state.error ? '#ac554c' : '#738476', 3);
  button('branch-start', label(state.busy ? 'thinking' : 'branchStart'), 24, h - bottom - 113, w - 48, actions.start,
    { primary: true, disabled: state.busy });
  button('branch-back', label('backToReplay'), 24, h - bottom - 58, w - 48, actions.back);
}

export function drawDisplayOptions(ui, state, actions) {
  const { metrics: { width: w, height: h, bottom }, top, text, wrap, button, label } = ui;
  text(label('displayOptions'), 24, top, 19, '#244d3d', 'left', 'bold');
  button('display-help', label('rulesShort'), w - 90, top - 18, 66, actions.help, { height: 36 });
  wrap(label('displayHelp'), 24, top + 29, w - 48, 12, '#738476', 2);
  ['territories', 'legalMoves', 'lastMove', 'coordinates', 'highContrast'].forEach((key, i) => {
    const y = top + 78 + i * 48;
    button(`display-${key}`, '', 24, y, w - 48, () => actions.change(key, !state[key]), { height: 42 });
    text(label(`display-${key}`), 38, y + 21, 14, '#244d3d');
    text(label(state[key] ? 'enabled' : 'disabled'), w - 40, y + 21, 14, state[key] ? '#244d3d' : '#738476', 'right');
  });
  button('display-back', label('back'), 24, h - bottom - 58, w - 48, actions.back, { primary: true });
}
