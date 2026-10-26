import { playerIds } from './controllers.js';
import { PLAYER_LABEL_KEYS } from './display.js';
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
  if (state.roomSetup) {
    button('room-submit', state.roomSetup === 'create' ? label('createRoom') : (en ? 'Save room settings' : '保存房间设置'),
      x, y, area.width, actions.submitRoom, { height: 44, font: 15, primary: true, disabled: state.roomBusy || state.online && !state.canEditOnline }); y += 54;
    y += ui.wrap(state.roomSetup === 'create'
      ? (state.hostSeatAdded ? (en ? 'The first seat is now human for the host. Other human seats wait for friends.' : '已将第一席改为真人供房主使用，其余真人席位等待好友加入。')
        : (en ? 'The host takes the first human seat. Other human seats wait for friends; AI fills its assigned seats.' : '房主占第一个真人席位，其余真人席位等待邀请，AI 按设置补位。'))
      : state.nextGame ? (en ? 'Changes apply next game. This match continues.' : '修改在下一局生效，当前对局继续。')
        : (en ? 'Saving updates the room and asks every human to ready again.' : '保存后同步给所有玩家，并清除真人准备状态。'),
    x, y + 8, area.width, 13, CABIN_COLORS.muted, 3) + 18;
  }
  const onlineLocked = state.online && !state.canEditOnline;
  group(en ? 'Players' : '参与者');
  slider('player-count', en ? 'Players' : '玩家人数', state.playerCount, 2, 15, x, y, area.width, actions.players, onlineLocked); y += 72;
  for (const player of playerIds(state.playerCount)) {
    const name = actions.playerLabel(player), profile = state.controllers[player] || 'human';
    const incompatible = state.compatibleProfiles && !state.compatibleProfiles.includes(profile);
    pair([`controller-${player}`, `${name} · ${label(`controller-${profile}`)}${incompatible ? (en ? ' · choose again' : ' · 请重选') : ''}`, () => actions.controller(player), onlineLocked],
      [`starter-${player}`, `${state.startPlayer === player ? '✓ ' : ''}${name}${en ? ' starts' : '先手'}`, () => actions.starter(player), onlineLocked, state.startPlayer === player]);
  }
  if (state.playerCount > 2) y += ui.wrap(label('compatibleAIHelp'), x, y + 8, area.width, 14, CABIN_COLORS.muted, 3) + 18;
  const v3Eligible = state.rulesVersion === 'territory-v3' && state.playerCount <= 6;
  const hasPendingContribution = Boolean(state.contributionStatus?.pending);
  const canManageStored = Boolean(state.contribution || hasPendingContribution);
  const contributionLabel = v3Eligible
    ? `${en ? 'Help AI learn' : '帮 AI 学下棋'} · ${state.contribution ? (en ? 'On' : '开') : (en ? 'Off' : '关')}`
    : en ? `V3 local only · opt-in ${state.contribution ? 'on' : 'off'}`
      : `仅 V3 本地局 · 授权${state.contribution ? '开' : '关'}`;
  pair(['training-contribution', contributionLabel, actions.contribution,
    (!state.contributionAvailable || !v3Eligible) && !canManageStored],
    ['replay-mode', en ? 'Replay mode' : '复盘模式', actions.replay, state.online]);
  if (!v3Eligible || state.contribution || state.contributionStatus?.pending) {
    const pending = state.contributionStatus?.pending || 0;
    const description = !v3Eligible
      ? (pending
        ? (en ? `${pending} games are waiting. ${state.contributionAvailable ? 'Re-enable consent to retry them.' : 'Use the switch to clear them.'} This setup cannot add a new record.` : `${pending} 局棋谱待上传；${state.contributionAvailable ? '重新同意后会重试。' : '可用开关清除。'} 当前设置不会新增记录。`)
        : (en ? 'Contribution accepts new complete territory-v3 local games with 2–6 players only.' : '仅支持主动同意后新开始并完整结束的 2–6 人 territory-v3 本地对局。'))
      : pending
      ? (en ? `${pending} games waiting. Uploads resume when the game is idle and connected.` : `${pending} 局待上传，将在空闲且联网时自动继续。`)
      : (en ? 'After opt-in, newly started complete local games upload for AI research review.' : '主动开启后，新开始并完整结束的本地对局会上传，供 AI 研究筛选。');
    y += ui.wrap(description, x, y + 8, area.width, 14, CABIN_COLORS.muted, 3) + 18;
  }
  group(en ? 'Board & match' : '棋盘与对局');
  pair(['shape-triangle', en ? 'Triangle' : '三角形棋盘', () => actions.shape('triangle'), onlineLocked, state.boardShape === 'triangle'],
    ['shape-hexagon', en ? 'Hexagon' : '六边形棋盘', () => actions.shape('hexagon'), onlineLocked, state.boardShape === 'hexagon']);
  slider('board-size', en ? 'Points per side' : '棋盘边长', state.size, 5, 15, x, y, area.width, actions.size, onlineLocked); y += 72;
  pair(['starts-default', en ? 'Default roots' : '默认起点', () => actions.startingPoints('default'), onlineLocked || state.playerCount > 6, state.startingPointMode === 'default'],
    ['starts-random', en ? 'Random roots' : '随机起点', () => actions.startingPoints('random'), onlineLocked, state.startingPointMode === 'random']);
  pair(['starts-custom', en ? 'Place starting nodes' : '自定义起点', () => actions.startingPoints('custom'), onlineLocked, state.startingPointMode === 'custom'],
    ['undo-enabled', `${en ? 'Undo' : '悔棋'} · ${state.playOptions.undoEnabled ? (en ? 'On' : '开') : (en ? 'Off' : '关')}`,
      () => actions.option('undoEnabled', !state.playOptions.undoEnabled), onlineLocked, state.playOptions.undoEnabled]);
  slider('undo-count', en ? 'Undos per match' : '每局悔棋次数', state.playOptions.undoMaxCount ?? 3, 1, 10, x, y, area.width,
    value => actions.option('undoMaxCount', value), onlineLocked || !state.playOptions.undoEnabled); y += 72;
  if (state.playerCount > 6) y += ui.wrap(en ? '7–15 players use random or custom starting nodes.' : '7–15 人仅支持随机或自定义起点。', x, y + 8, area.width, 13, CABIN_COLORS.muted, 2) + 18;
  if (state.startingPointMode === 'random') y += ui.wrap(en ? 'Roots are drawn once when a new game starts, then kept in saves and replays.' : '重开时随机一次，实际起点会随存档和复盘保留。', x, y + 8, area.width, 13, CABIN_COLORS.muted, 2) + 18;
  pair(['clock-enabled', `${en ? 'Clock' : '回合计时'} · ${state.playOptions.turnTimerEnabled ? (en ? 'On' : '开') : (en ? 'Off' : '关')}`, () => actions.option('turnTimerEnabled', !state.playOptions.turnTimerEnabled), onlineLocked],
    ['hint-enabled', `${en ? 'Hints' : '落子提示'} · ${state.playOptions.hintEnabled ? (en ? 'On' : '开') : (en ? 'Off' : '关')}`,
    () => actions.option('hintEnabled', !state.playOptions.hintEnabled), onlineLocked]);
  slider('clock-duration', en ? 'Seconds per turn' : '每回合秒数', state.playOptions.turnTimeLimitSeconds, 15, 200, x, y, area.width,
    value => actions.option('turnTimeLimitSeconds', value), onlineLocked || !state.playOptions.turnTimerEnabled); y += 72;
  slider('hint-count', en ? 'Hints per match' : '每局提示次数', Math.max(1, state.playOptions.hintMaxCount), 1, 10, x, y, area.width,
    value => actions.option('hintMaxCount', value), onlineLocked || !state.playOptions.hintEnabled); y += 72;
  ui.wrap(state.online ? (en ? 'The host can edit all seats and board settings. Every human must approve an undo.' : '房主可调整席位和棋盘设置；每次联机悔棋需要所有真人同意。')
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
    y += wrap(state.account.displayName || (en ? 'Player' : '玩家'), area.x + 76, y + 23, area.width - 90, 17, CABIN_COLORS.ink, 2) + 55;
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
  if (state.online) for (const player of playerIds(state.playerCount || 2)) {
    const profile = state.roomProfiles?.[player], bot = state.bots?.includes(player);
    const side = label(PLAYER_LABEL_KEYS[player]);
    const own = state.ownPlayer === player ? (en ? ' · you' : ' · 你') : '';
    const seat = bot ? label(`controller-${state.controllers?.[player] || 'greedy'}`) : profile?.displayName
      ? `${profile.displayName}${state.ready?.[player] ? (en ? ' · ready' : ' · 已准备') : ''}` : (en ? 'Waiting for invitation' : '等待邀请加入');
    y += wrap(`${side}${own} · ${seat}`, area.x, y + 6, area.width, 15, CABIN_COLORS.ink, 2) + 12;
  }
  if (state.online) {
    pair(['room-settings', en ? 'Room settings' : '房间设置', actions.settings, state.busy]);
    pair(['share-room', label('shareRoom'), actions.share, state.busy], ['room-refresh-inline', label('reconnect'), actions.refresh, state.busy]);
    pair(['battle-leave', label('leaveRoom'), actions.leave, state.busy, true]);
  } else {
    pair(['friends', label('createRoom'), actions.create, !state.enabled || state.busy], ['join-room', label('joinRoom'), actions.join, !state.enabled || state.busy]);
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
