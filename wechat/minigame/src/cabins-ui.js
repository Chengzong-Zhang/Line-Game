import { playerIds } from './controllers.js';
export const CABIN_COLORS = { ink: '#2a2118', muted: '#695749', panel: '#fff9ee', gold: '#c69a4b' };
export function cabinGeometry(metrics, top) {
  const dock = { x: 16, y: top, width: metrics.width - 32, height: 42 };
  const panel = { x: 12, y: top + 52, width: metrics.width - 24, height: metrics.height - metrics.bottom - top - 60 };
  return { dock, panel };
}
export function drawCabinDock(ui, active, actions) {
  const { dock } = cabinGeometry(ui.metrics, ui.top), width = (dock.width - 18) / 4;
  ['board', 'battle', 'guide', 'tutorial'].forEach((key, index) => ui.button(`cabin-${key}`, ui.label(`cabin-${key}`),
    dock.x + index * (width + 6), dock.y, width, () => actions.open(key),
    { height: dock.height, font: ui.language === 'en' ? 11 : 14, primary: active === key }));
}
export function drawCabinFrame(ui, active, close) {
  const { panel } = cabinGeometry(ui.metrics, ui.top);
  ui.ctx.fillStyle = '#f4ede1'; ui.ctx.fillRect(0, panel.y - 4, ui.metrics.width, ui.metrics.height - panel.y + 4);
  ui.rect(panel.x, panel.y, panel.width, panel.height, 20, '#fff9ee');
  ui.text(ui.label(`cabin-${active}`), panel.x + 18, panel.y + 25, 19, CABIN_COLORS.ink, 'left', 'bold');
  ui.button('cabin-close', ui.label('backToBoard'), panel.x + panel.width - 108, panel.y + 7, 98, close, { height: 38, font: 14 });
  return { x: panel.x + 16, y: panel.y + 57, width: panel.width - 32, height: panel.height - 69 };
}
export function drawBoardCabin(ui, area, state, actions) {
  const { button, text, label, slider } = ui, en = ui.language === 'en';
  const half = (area.width - 8) / 2, x = area.x; let y = area.y;
  const pair = (a, b) => {
    for (const [index, item] of [a, b].entries()) if (item) button(item[0], item[1], x + index * (half + 8), y, half,
      item[2], { height: 44, font: 14, disabled: Boolean(item[3]), primary: Boolean(item[4]) });
    y += 54;
  };
  const group = title => { text(title, x + 2, y + 13, 15, CABIN_COLORS.ink, 'left', 'bold'); y += 32; };
  pair(['language', en ? 'Language · English' : '语言 · 中文', actions.language],
    ['terminology', en ? `Terms · ${state.terminology === 'war' ? 'Story' : 'Math'}` : `术语 · ${state.terminology === 'war' ? '战争' : '数学'}`, actions.terminology]);
  group(en ? 'Players' : '参与者');
  slider('player-count', en ? 'Players' : '玩家人数', state.playerCount, 2, 6, x, y, area.width, actions.players, state.online); y += 72;
  for (const player of playerIds(state.playerCount)) {
    const name = actions.playerLabel(player), profile = state.controllers[player] || 'human';
    const incompatible = state.compatibleProfiles && !state.compatibleProfiles.includes(profile);
    pair([`controller-${player}`, `${name} · ${label(`controller-${profile}`)}${incompatible ? (en ? ' · choose again' : ' · 请重选') : ''}`, () => actions.controller(player), state.online],
      [`starter-${player}`, `${state.startPlayer === player ? '✓ ' : ''}${name}${en ? ' starts' : '先手'}`, () => actions.starter(player), state.online, state.startPlayer === player]);
  }
  if (state.playerCount > 2) y += ui.wrap(label('compatibleAIHelp'), x, y + 8, area.width, 14, CABIN_COLORS.muted, 3) + 18;
  const v2Eligible = state.rulesVersion === 'territory-v2';
  const hasPendingContribution = Boolean(state.contributionStatus?.pending);
  const canManageStored = Boolean(state.contribution || hasPendingContribution);
  const contributionLabel = v2Eligible
    ? `${en ? 'Help AI learn' : '帮 AI 学下棋'} · ${state.contribution ? (en ? 'On' : '开') : (en ? 'Off' : '关')}`
    : en ? `V2 only · opt-in ${state.contribution ? 'on' : 'off'}`
      : `仅 V2 · 授权${state.contribution ? '开' : '关'}`;
  pair(['training-contribution', contributionLabel, actions.contribution,
    (!state.contributionAvailable || !v2Eligible) && !canManageStored],
    ['replay-mode', en ? 'Replay mode' : '复盘模式', actions.replay, state.online]);
  if (!v2Eligible || state.contribution || state.contributionStatus?.pending) {
    const pending = state.contributionStatus?.pending || 0;
    const description = !v2Eligible
      ? (pending
        ? (en ? `${pending} older V2 games are waiting. ${state.contributionAvailable ? 'Re-enable consent to retry them.' : 'Use the switch to clear them.'} This V3 game cannot be added.` : `${pending} 局旧版 V2 对局待上传；${state.contributionAvailable ? '重新同意后会重试。' : '可用开关清除。'} 当前 V3 对局不会加入。`)
        : (en ? 'The current protocol accepts V2 games only. New default V3 games are excluded.' : '当前协议仅接受 V2 对局；默认 V3 新局不会上传。'))
      : pending
      ? (en ? `${pending} games waiting. Uploads resume when the game is idle and connected.` : `${pending} 局待上传，将在空闲且联网时自动继续。`)
      : (en ? 'Complete local games upload automatically for AI research review.' : '完整本地对局会自动上传，供 AI 研究筛选。');
    y += ui.wrap(description, x, y + 8, area.width, 14, CABIN_COLORS.muted, 3) + 18;
  }
  group(en ? 'Board & match' : '棋盘与对局');
  const onlineLocked = state.online && !state.canEditOnline;
  pair(['shape-triangle', en ? 'Triangle' : '三角形棋盘', () => actions.shape('triangle'), onlineLocked, state.boardShape === 'triangle'],
    ['shape-hexagon', en ? 'Hexagon' : '六边形棋盘', () => actions.shape('hexagon'), onlineLocked, state.boardShape === 'hexagon']);
  slider('board-size', en ? 'Points per side' : '棋盘边长', state.size, 5, 15, x, y, area.width, actions.size, onlineLocked); y += 72;
  pair(['starts-default', en ? 'Default roots' : '默认起点', () => actions.startingPoints('default'), onlineLocked, state.startingPointMode === 'default'],
    ['starts-random', en ? 'Random roots' : '随机起点', () => actions.startingPoints('random'), onlineLocked, state.startingPointMode === 'random']);
  pair(['starts-custom', en ? 'Place starting nodes' : '自定义起点', () => actions.startingPoints('custom'), onlineLocked, state.startingPointMode === 'custom'],
    ['undo-enabled', `${en ? 'Undo' : '悔棋'} · ${state.playOptions.undoEnabled ? (en ? 'On' : '开') : (en ? 'Off' : '关')}`,
      () => actions.option('undoEnabled', !state.playOptions.undoEnabled), onlineLocked, state.playOptions.undoEnabled]);
  slider('undo-count', en ? 'Undos per match' : '每局悔棋次数', state.playOptions.undoMaxCount ?? 3, 1, 10, x, y, area.width,
    value => actions.option('undoMaxCount', value), onlineLocked || !state.playOptions.undoEnabled); y += 72;
  if (state.startingPointMode === 'random') y += ui.wrap(en ? 'Roots are drawn once when a new game starts, then kept in saves and replays.' : '重开时随机一次，实际起点会随存档和复盘保留。', x, y + 8, area.width, 13, CABIN_COLORS.muted, 2) + 18;
  pair(['clock-enabled', `${en ? 'Clock' : '回合计时'} · ${state.playOptions.turnTimerEnabled ? (en ? 'On' : '开') : (en ? 'Off' : '关')}`, () => actions.option('turnTimerEnabled', !state.playOptions.turnTimerEnabled), state.online],
    ['hint-enabled', `${en ? 'Hints' : '落子提示'} · ${state.playOptions.hintEnabled ? (en ? 'On' : '开') : (en ? 'Off' : '关')}`,
    () => actions.option('hintEnabled', !state.playOptions.hintEnabled), state.online]);
  slider('clock-duration', en ? 'Seconds per turn' : '每回合秒数', state.playOptions.turnTimeLimitSeconds, 15, 200, x, y, area.width,
    value => actions.option('turnTimeLimitSeconds', value), state.online || !state.playOptions.turnTimerEnabled); y += 72;
  slider('hint-count', en ? 'Hints per match' : '每局提示次数', Math.max(1, state.playOptions.hintMaxCount), 1, 10, x, y, area.width,
    value => actions.option('hintMaxCount', value), state.online || !state.playOptions.hintEnabled); y += 72;
  ui.wrap(state.online ? (en ? 'The host can change board and undo settings before either player is ready. Both players must approve each undo.' : '双方准备前，房主可修改棋盘和悔棋设置；每次联机悔棋需要双方同意。')
    : (en ? 'Match settings take effect when you restart. The current position is preserved.' : '对局设置在重开后生效，当前棋局会保留。'), x, y + 10, area.width, 13, CABIN_COLORS.muted, 3); y += 54;
  return y - area.y;
}
export function drawBattleCabin(ui, area, state, actions) {
  const { button, text, wrap, label } = ui, en = ui.language === 'en', half = (area.width - 8) / 2;
  let y = area.y;
  const pair = (a, b) => { [a, b].forEach((item, i) => item && button(item[0], item[1], area.x + i * (half + 8), y, half,
    item[2], { height: 44, font: 14, disabled: Boolean(item[3]), danger: Boolean(item[4]) })); y += 54; };
  text(en ? 'WeChat account' : '微信账号', area.x, y + 10, 16, CABIN_COLORS.ink, 'left', 'bold'); y += 34;
  if (state.account) {
    ui.rect(area.x, y, area.width, 72, 14, '#f2eadc');
    actions.avatar?.(area.x + 12, y + 10, 50);
    y += wrap(state.account.displayName || (en ? 'LIFELINE player' : '生命线玩家'), area.x + 76, y + 23, area.width - 90, 17, CABIN_COLORS.ink, 2) + 55;
    pair(['profile-name', en ? 'Edit nickname' : '修改昵称', actions.editName, state.busy],
      ['profile-avatar', en ? 'Choose avatar' : '选择头像', actions.editAvatar, state.busy]);
    pair(['profile-wechat', en ? 'Use WeChat profile' : '导入微信昵称头像', actions.importWechat, state.busy],
      ['profile-privacy', en ? 'Privacy guide' : '微信隐私指引', actions.privacyContract, state.busy]);
    if (state.account.profileSync === 'pending') y += wrap(label('profileLocalSaved'), area.x, y, area.width, 13, CABIN_COLORS.muted, 3) + 12;
  }
  const accountText = state.account ? state.account.linkedWeb
    ? (en ? `Linked · ${state.account.displayName || state.account.linkedWeb.displayName || 'Web account'}` : `已关联 · ${state.account.displayName || state.account.linkedWeb.displayName || '网页账号'}`)
    : (en ? 'Signed in · no Web account linked' : '已登录 · 尚未关联网页账号')
    : (en ? 'Local play needs no login' : '本地游戏无需登录');
  y += wrap(accountText, area.x, y, area.width, 14, CABIN_COLORS.muted, 2) + 10;
  pair(['account', state.account ? (en ? 'Refresh account' : '刷新账号') : (en ? 'WeChat sign in' : '微信登录'), actions.account, !state.enabled || state.busy],
    ['account-link', state.account?.linkedWeb ? (en ? 'Unlink Web account' : '解除网页关联') : (en ? 'Link Web account' : '关联网页账号'), actions.link, !state.account || state.busy]);
  pair(['account-privacy', en ? 'Data & privacy' : '数据与隐私', actions.privacy], ['delete-account-inline', en ? 'Delete online account' : '删除联机账号', actions.delete, !state.account || state.busy, true]);
  text(en ? 'Friend games' : '好友对战', area.x, y + 12, 16, CABIN_COLORS.ink, 'left', 'bold'); y += 36;
  y += wrap(state.online ? `${label('roomLabel')} ${state.code || ''}` : label('crossPlatformHelp'), area.x, y, area.width, 14, CABIN_COLORS.muted, 3) + 10;
  if (state.online && state.roomProfiles) for (const [player, profile] of Object.entries(state.roomProfiles)) {
    if (!['BLACK', 'WHITE'].includes(player) || !profile) continue;
    const side = label(player === 'BLACK' ? 'black' : 'white'), own = state.ownPlayer === player ? (en ? ' · you' : ' · 你') : '';
    y += wrap(`${side}${own} · ${profile.displayName || (en ? 'Player' : '玩家')}`, area.x, y + 6, area.width, 15, CABIN_COLORS.ink, 2) + 12;
  }
  if (state.online) {
    pair(['share-room', label('shareRoom'), actions.share, state.busy], ['room-refresh-inline', label('reconnect'), actions.refresh, state.busy]);
    pair(['battle-leave', label('leaveRoom'), actions.leave, state.busy, true]);
  } else {
    pair(['friends', label('createRoom'), actions.create, !state.enabled || state.busy], ['join-room', label('joinRoom'), actions.join, !state.enabled || state.busy]);
    button('create-ai-room', en ? 'Create room with AI' : '创建 AI 对战房间', area.x, y, area.width,
      actions.createAi, { height: 44, font: 14, disabled: !state.enabled || state.busy }); y += 54;
    if (state.retryCode) { button('retry-room', `${en ? 'Retry joining' : '重试加入'} · ${state.retryCode}`, area.x, y, area.width,
      actions.retry, { height: 44, font: 14, disabled: !state.enabled || state.busy }); y += 54; }
    if (state.savedCode) pair(['resume-room', label('resumeRoom'), actions.resume, !state.enabled || state.busy]);
  }
  if (state.message) y += wrap(state.message, area.x, y + 8, area.width, 14, '#a43730', 4) + 18;
  if (!state.enabled) y += wrap(label('onlineOff'), area.x, y + 8, area.width, 14, CABIN_COLORS.muted, 3) + 18;
  return y - area.y;
}
export function drawTutorialCabin(ui, area, levels, completed, state, actions) {
  const { button, text, label, language } = ui;
  text(state.canPractice ? `${label('learn')} · ${completed.size}/${levels.length}` : label('practiceAfterRoom'),
    area.x, area.y + 8, state.canPractice ? 15 : 12, CABIN_COLORS.muted);
  levels.forEach((level, index) => {
    const title = language === 'en' ? ['Build a lifeline', 'Close a territory', 'Cut the supply line', 'Three-point limit', 'Finish and score'][index] : level.titleZh.replace(/^.*?[：:]\s*/, '');
    button(`lesson-${index}`, `${completed.has(index) ? '✓' : index + 1}  ${title}`, area.x, area.y + 29 + index * 47, area.width,
      () => actions.select(index), { height: 44, font: 15, disabled: !state.canPractice });
  });
  return 270;
}
