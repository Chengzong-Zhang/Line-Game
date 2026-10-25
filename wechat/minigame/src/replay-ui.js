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
  const choices = ['firstReplay', 'lastReplay', 'jumpReplay', 'replaySpeed', 'displayOptions'];
  const half = (w - 60) / 2;
  choices.forEach((choice, i) => {
    const x = i % 2 ? 36 + half : 24, y = top + 80 + Math.floor(i / 2) * 55;
    const disabled = state.busy || choice === 'branchReplay' && !state.canBranch || choice === 'analyzeReplay' && !state.canAnalyze;
    button(`tool-${choice}`, '', x, y, half, () => actions.select(choice), { height: 48, disabled });
    wrap(label(choice), x + 13, y + 16, half - 26, 14, disabled ? '#9ba596' : '#244d3d', 2);
  });
  button('tools-back', label('backToReplay'), 24, h - bottom - 58, w - 48, actions.back, { primary: true });
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
