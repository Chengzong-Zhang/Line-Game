export const RANKED_PROFILES = ['greedy', 'minimax-2', 'minimax-3', 'minimax-4'];
export const RANKED_LABELS = {
  zh: ['入门', '普通', '进阶', '深入'],
  en: ['Starter', 'Standard', 'Advanced', 'Deep search'],
};
export const LADDER_RULES = {
  "zh": "两个榜都按保守分排名：保守分 = Glicko-2 实力估计 − 2 × 评级偏差 RD，最后四舍五入。同分并列。完成 1 局有效计分对局即可上榜，不再设可靠性入榜门槛。新玩家仍显示“暂定”；证据少、RD 大，会有更大的不确定性扣减，因此通常排在实力相近的老玩家后面。只有一位玩家时仍然是第 1 名，不人为安排名次。\n\n局数和胜率只作战绩展示，不直接奖励分数。胜负与对手强弱对应的预期成绩比较后更新实力；击败已确认更强的对手收益更高。多局一致的表现可以减少不确定性、提高保守分，这来自证据而非固定场次奖励。长期不玩不扣实力估计，但不确定性上升时保守分可能下降。稳定评级波动通常更小，接近的名次仍可能交换。\n\nAI 榜支持棋盘舱中所有兼容 AI，包括模型与多人 AI；可选 2–6 人、三角、菱形或六边形、5–15 路以及默认、随机、自定义起点（菱形三人及以上须用随机或自定义起点）。保留一个真人，其余席位选 AI，然后点击“开始 AI 排位”。服务器执行 AI 并核验结果；本地离线局仍为练习。随机起点由服务器抽取并保存，重连不重抽；再来一局重新抽取。排位关闭提示、悔棋与本地计时。\n\n不同 AI 程序、棋盘、人数、先手、真人席位、起点方式及 AI 阵容分别校准，不能预设“深入”更强。自定义起点按具体布局校准，随机起点按同一抽样规则校准。多人正常结束时按正式领土和认输状态，与每个 AI 比较胜 / 平 / 负；每个对手权重为 1 / AI 数量，一局只结算一次，避免人数多就获得成倍积分。真人认输或离房即结束挑战，按负于所有 AI 结算，不虚构其余 AI 的名次。\n\nAI 正常终局至少有一次实际落子；人类正常终局双方各至少落子 2 次。纯开局互相 PASS 不计分；认输可计分。V3 真人联机未悔棋的对局可计分。同一人类对手每天前 3 局、AI 每天前 20 局计分，北京时间零点重置。短暂掉线可恢复；AI 挑战 24 小时无操作按真人放弃结算。旧 v2 实力估计保留，用新的保守分排序；v1 活跃度积分仍单独归档。\n\n依据：Glickman 的 Glicko-2 与约 95% 评级区间，取该区间下端 R−2RD 排名。2 来自已采用的区间约定，并非本游戏拟合出的最优系数。多人比较采用总权重为 1 的近似，不能当作相互独立的多局证据。显示区间和保守分都依赖模型假设；AI 相对强度、不同配置间的可比性仍需真实对局校准。AI 榜和人类榜独立，分数不能横向比较。",
  "en": "Both ladders rank by conservative score: Glicko-2 skill estimate minus 2 × rating deviation RD, rounded with ties. One rated match is enough to appear. There is no confidence gate. New players remain provisional: larger uncertainty means a larger deduction, so they usually start below similarly skilled established players. A sole entrant is still first; ranks are not artificially forced down.\n\nGames and win rate are descriptive statistics, not point bonuses. Skill updates compare actual results with expected results against measured opponents. Consistent evidence can reduce uncertainty and raise conservative score, without a fixed participation reward. Inactivity does not subtract estimated skill, but growing uncertainty can lower conservative score. Established ratings usually move less; nearby ranks can still swap.\n\nAI ranking supports every compatible Board cabin AI, including models and multiplayer AI: 2–6 seats, triangle, diamond or hexagon, sizes 5–15, and default, random or custom starts (diamond boards with 3+ players require random or custom starts). Keep exactly one human and choose AI for the remaining seats, then Play ranked AI. The server executes AI and validates results; offline play remains practice. Random starts are drawn and retained by the server, and redrawn on rematch. Hints, undo and local timers are disabled.\n\nAI programs, board, size, seat count, turn order, human seat, start mode and lineup are calibrated separately. Custom layouts have separate estimates; random layouts share the same sampling distribution. Multiplayer finishes compare official territory and resignations against each AI, weighted 1 / AI count. One match produces one update, not multiplied rewards for more opponents. Resigning or leaving ends the challenge as a loss to every AI, without inventing ranks among the remaining AI.\n\nAI finishes require at least one actual placement; human finishes require two placements per seat. Opening-only passes are not rated. Resignations can be rated. V3 human games without takebacks count. The first 3 games per human opponent and 20 AI games per Beijing day are rated. Brief disconnects can resume; 24 hours of inactivity forfeits an AI challenge. V2 skill estimates are retained and ranked using the new lower bound. V1 participation points stay archived.\n\nSources: Glickman’s Glicko-2 and its approximate 95% rating interval; ranking uses the lower endpoint R−2RD. The coefficient 2 follows that interval convention, not game-specific optimization. Multiplayer uses normalized comparison weights, not a claim of independent games. Intervals and conservative scores rely on model assumptions; AI strengths and cross-configuration comparability still need real-game calibration. AI and Human pools remain separate."
};

export class LadderClient {
  constructor(online, changed) { this.online = online; this.changed = changed; this.kind = null; this.sequence = 0; this.data = null; this.loading = false; this.error = ''; this.uid = null; }
  async load(kind, offset = 0) {
    const sequence = ++this.sequence, authEpoch = this.online.authEpoch;
    this.kind = kind; this.data = null; this.loading = true; this.error = ''; this.changed();
    let uid;
    try {
      await this.online.authenticate();
      uid = this.online.account?.uid;
      if (sequence !== this.sequence || authEpoch !== this.online.authEpoch) return;
      const data = await this.online.request(`ladder/${kind}?offset=${offset}`, undefined, { accountUid: uid });
      if (sequence !== this.sequence || authEpoch !== this.online.authEpoch || uid !== this.online.account?.uid) return;
      if (data?.version !== 'ladder-v3-conservative' || data.board !== kind || !Array.isArray(data.entries) || !data.me) throw Error('LADDER_UNAVAILABLE');
      this.data = data; this.uid = uid;
    } catch (error) {
      if (sequence === this.sequence) this.error = error.message;
    } finally {
      if (sequence === this.sequence) { this.loading = false; this.changed(); }
    }
  }
  view() { return { kind: this.kind, loading: this.loading, error: this.error,
    data: this.uid === this.online.account?.uid ? this.data : null }; }
}

export function ladderResultText(receipt, player, language) {
  const change = receipt?.players?.[player], en = language === 'en';
  if (!change) return '';
  if (receipt.version === 'ladder-v1') return en ? 'V1 participation result archived separately.' : '旧版活跃度积分已单独归档。';
  if (receipt.version === 'ladder-v2-glicko2') return en ? 'V2 skill result retained. See the ladder for your current conservative score.' : '已保留本局 v2 实力成绩，当前保守分请查看天梯榜。';
  const board = receipt.board === 'ai' ? 'AI' : en ? 'Human' : '人类';
  return receipt.rated ? (en ? `${board} conservative: ${change.delta >= 0 ? '+' : ''}${change.delta} → ${change.points}${change.provisional ? ' · provisional' : ''}`
    : `${board} 榜保守分 ${change.delta >= 0 ? '+' : ''}${change.delta} · 当前 ${change.points} 分${change.provisional ? ' · 暂定' : ''}`)
    : en ? 'Recorded without points: practice or daily limit.' : '本局只记战绩：练习条件或当日计分次数已满。';
}

export function drawLadder(ui, area, state, actions) {
  const en = ui.language === 'en', x = area.x, width = area.width, half = (width - 8) / 2;
  let y = area.y;
  const row = (a, b) => { [a, b].forEach((v, i) => v && ui.button(v[0], v[1], x + i * (half + 8), y, half, v[2], { height: 44, font: en ? 12 : 14, disabled: Boolean(v[3]), primary: Boolean(v[4]) })); y += 54; };
  ui.text(en ? 'Ladders' : '天梯榜', x, y + 10, 17, '#2a2118', 'left', 'bold'); y += 30;
  row(['ladder-ai', en ? 'AI ladder' : 'AI 榜', () => actions.load('ai'), !state.enabled, state.kind === 'ai'],
    ['ladder-human', en ? 'Human ladder' : '人类榜', () => actions.load('human'), !state.enabled, state.kind === 'human']);
  row(['ladder-start-ai', en ? 'Play ranked AI' : '开始 AI 排位', actions.start, !state.enabled || state.online || state.busy],
    ['ladder-rules', en ? 'Scoring rules' : '积分规则', actions.rules]);
  const paragraph = (value, color = '#695749') => { y += ui.wrap(value, x, y + 8, width, 13, color, 6) + 18; };
  paragraph(en ? 'Set seats, board and AI in the Board cabin before starting.' : '在棋盘舱设置人数、棋盘和 AI，再开始排位。');
  const receiptText = ladderResultText(state.result, state.player, ui.language);
  if (receiptText && (!state.kind || state.kind === state.result.board)) paragraph(receiptText);
  if (!state.enabled) paragraph(en ? 'Online service is unavailable in this build.' : '当前版本未配置联机服务。');
  else if (!state.kind) paragraph(en ? 'One rated match to join. Rank by skill minus uncertainty.' : '一局有效对局即可上榜，按实力的保守估计排名。');
  else {
    if (state.loading) paragraph(en ? 'Loading standings…' : '正在加载榜单…');
    else if (state.error) paragraph(en ? 'Cannot load standings. Refresh to retry; your results are saved on the server.' : '暂时无法读取榜单，请刷新重试；已结算成绩保存在服务器。', '#a43730');
    const data = state.data;
    if (data) {
      const summary = entry => en ? `${entry.games} played · ${Math.round(entry.winRate * 100)}% wins · ${entry.draws} draws · ${entry.ratedGames} rated`
        : `${entry.games} 局 · 胜率 ${Math.round(entry.winRate * 100)}% · ${entry.draws} 平 · ${entry.ratedGames} 计分`;
      const own = data.me;
      paragraph(en ? `Your conservative score · ${own.points} · ${own.rank ? `#${own.rank}` : 'Unranked'}${own.provisional ? ' · provisional' : ''}\n${summary(own)}`
        : `我的保守分 ${own.points} · ${own.rank ? `第 ${own.rank} 名` : '尚未上榜'}${own.provisional ? ' · 暂定' : ''}\n${summary(own)}`, '#2a2118');
      if (own.rating != null) paragraph(en ? `Skill estimate: ${own.rating} · uncertainty RD: ${own.ratingDeviation}` : `实力估计 ${own.rating} · 不确定性 RD ${own.ratingDeviation}`);
      if (own.interval) paragraph(en ? `Estimated 95% range: ${own.interval.join('–')}` : `约 95% 估计范围：${own.interval.join('–')} 分`);
      if (data.aiOpponents?.length) paragraph((en ? 'Recent AI skill estimates (not ladder scores): ' : '最近对手的实力估计（非榜单分）：') + data.aiOpponents.map(bot => {
        const name = ui.label?.(`controller-${bot.profile}`) || RANKED_LABELS[ui.language][RANKED_PROFILES.indexOf(bot.profile)] || bot.profile;
        return `${name} ${bot.points}${bot.provisional ? (en ? ' (provisional)' : '（暂定）') : ''}`;
      }).join(' · '));
      if (!data.entries.length) paragraph(en ? 'No ranked players yet. Complete one rated match to join.' : '暂时还没有上榜玩家，完成一局有效计分对局即可上榜。');
      for (const entry of data.entries) {
        ui.rect(x, y, width, 83, 12, entry.isMe ? '#eee0c4' : '#f4ede1');
        ui.text(`#${entry.rank}`, x + 10, y + 20, 14, '#695749');
        let name = String(entry.displayName);
        while (name.length > 1 && ui.ctx.measureText(name).width > width - 138) name = name.slice(0, -1);
        ui.text(name, x + 52, y + 20, 14, '#2a2118');
        ui.text(`${entry.points}`, x + width - 10, y + 20, 15, '#8b6427', 'right', 'bold');
        ui.wrap(summary(entry), x + 10, y + 47, width - 20, 12, '#695749', 2); y += 92;
      }
      row(['ladder-previous', en ? 'Previous' : '上一页', () => actions.load(state.kind, Math.max(0, data.offset - 20)), data.offset === 0],
        ['ladder-next', en ? 'Next' : '下一页', () => actions.load(state.kind, data.offset + 20), !data.hasMore]);
    }
    row(['ladder-refresh', en ? 'Refresh' : '刷新榜单', () => actions.load(state.kind, state.data?.offset || 0), state.loading]);
  }
  return y - area.y;
}
