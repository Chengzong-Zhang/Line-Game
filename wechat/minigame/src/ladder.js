export const RANKED_PROFILES = ['greedy', 'minimax-2', 'minimax-3', 'minimax-4'];
export const RANKED_LABELS = {
  zh: ['入门', '普通', '进阶', '深入'],
  en: ['Starter', 'Standard', 'Advanced', 'Deep search'],
};
export const LADDER_RULES = {
  zh: "AI 榜使用 Glicko-2 实力分，不加场次分，也不再使用难度倍数。四档 AI 是四个独立对手，它们的等级分由服务器实际对局共同估计；搜索档位不等于已测得的实力。战胜已确认更强的 AI，涨分更多。所有新玩家和 AI 从相同的 1500 分暂定值开始，未经校准的数值不代表真实强弱。仅“开始 AI 排位”计分，本地人机为练习。\n\n人类榜也使用 Glicko-2：根据实际胜 / 平 / 负与对手强弱所对应的预期成绩之间的差异更新实力分，同时考虑双方估计的可靠性。胜率和局数只展示，不另外加分。长期表现稳定时单局波动较小；新玩家或长期未玩时变化较大，但暂定玩家不进入正式排名。分差很小时仍可能换位，没有隐藏保级分，也没有固定“每局最多 16 分”。\n\n正式排名只按四舍五入的实力分，同分并列。可靠性达到标准（评级偏差 RD ≤ 75）才入榜，不再要求固定 5 局；局数不能保证定级。界面给出约 95% 的估计区间，这依赖模型假设，并非真实实力保证。久未对局不会自动扣实力分，但不确定性会上升，可能回到暂定状态。AI 榜与人类榜是两个独立评分池，不能横向比较分数。旧版积分不换算，新版重新定级。\n\nAI 排位固定 7 路三角棋盘、V3 规则、玩家先手，无提示和悔棋。人类 V3 默认起点且未悔棋的对局可计分；其他条件只记战绩。正常终局双方须各至少落子 2 次，开局互相 PASS 不计分；认输、主动离房按负结算。掉线可恢复，24 小时无操作后当前行动方按负结算，已结算不可悔棋。同一人类对手每天前 3 局、AI 每天前 20 局计分，北京时间零点重置；这些是防刷运营限制，不是实力公式。\n\n依据：Lichess 使用 Glicko-2；Chess.com 与 Dota 2 使用 Glicko 思路区分实力与不确定性。初始值和公式来自 Glickman 公开规范，在线稳定性与入榜参数参考 Lichess。参考参数有出处，但没有本游戏实测最优的证据；未来应按后续胜负预测误差校准。AI 也必须积累真实对局，不能因为叫“深入”就预先给高等级分。",
  en: "AI uses Glicko-2 skill ratings, without game-count bonuses or difficulty multipliers. Each server AI profile is a separate opponent whose strength is estimated from actual results. Search depth is not measured strength. Beating a reliably stronger AI earns more. New humans and AI profiles share a provisional 1500 starting value, not a claim of equal real strength. Only Play ranked AI counts; local AI remains practice.\n\nHuman skill also uses Glicko-2: actual win / draw / loss is compared with the expected result, taking both players' rating uncertainty into account. Games and win rate are statistics, not bonuses. Stable ratings usually move less; new or inactive players can move more but provisional players stay off the ranking. Close ratings can change order. There is no fixed 16-point cap or hidden rank protection.\n\nRank by rounded skill rating, with ties. Join the ranking when rating deviation RD ≤ 75, not after a fixed five games. Game count alone does not ensure qualification. The approximate 95% interval depends on model assumptions. Inactivity does not subtract skill points, but increases uncertainty and may make a rating provisional again. AI and Human use separate pools, so their numbers are not directly comparable. V1 points remain archived; V2 starts fresh placement.\n\nRanked AI uses a size-7 triangle, V3 rules, human first, no hints or undo. V3 human games with default roots and no takebacks can be rated. Normal finishes require two placements each; opening passes do not earn rating. Resigning or leaving forfeits. Disconnects can resume; 24 hours without action forfeits the current turn. Settled games cannot be undone. The first 3 games per human opponent and first 20 AI games per Beijing day are rated. These are anti-abuse limits, not strength weights.\n\nSources: Lichess uses Glicko-2; Chess.com and Dota 2 use Glicko-style uncertainty. Equations and initial values follow Glickman's specification; online stability and ranking thresholds borrow from Lichess. Defaults are sourced but are not proven optimal for this game. Future tuning should minimize held-out outcome prediction error. AI strength needs actual results, not a preset bonus for a difficulty name.",
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
      if (data?.version !== 'ladder-v2-glicko2' || data.board !== kind || !Array.isArray(data.entries) || !data.me) throw Error('LADDER_UNAVAILABLE');
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
  if (receipt.version === 'ladder-v1') return en ? 'V1 result archived; V2 uses fresh skill placement.' : '旧版结果已归档，新版实力榜重新定级。';
  const board = receipt.board === 'ai' ? 'AI' : en ? 'Human' : '人类';
  return receipt.rated ? (en ? `${board}: ${change.delta >= 0 ? '+' : ''}${change.delta} → ${change.points}${change.provisional ? ' · provisional' : ''}`
    : `${board} 榜实力分 ${change.delta >= 0 ? '+' : ''}${change.delta} · 当前 ${change.points} 分${change.provisional ? ' · 暂定' : ''}`)
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
  const receiptText = ladderResultText(state.result, state.player, ui.language);
  if (receiptText && (!state.kind || state.kind === state.result.board)) paragraph(receiptText);
  if (!state.enabled) paragraph(en ? 'Online service is unavailable in this build.' : '当前版本未配置联机服务。');
  else if (!state.kind) paragraph(en ? 'Skill ratings, without participation bonuses. Tap a ladder to view.' : '按实力分排名，不加场次分。点击查看榜单。');
  else {
    if (state.loading) paragraph(en ? 'Loading standings…' : '正在加载榜单…');
    else if (state.error) paragraph(en ? 'Cannot load standings. Refresh to retry; your results are saved on the server.' : '暂时无法读取榜单，请刷新重试；已结算成绩保存在服务器。', '#a43730');
    const data = state.data;
    if (data) {
      const summary = entry => en ? `${entry.games} played · ${Math.round(entry.winRate * 100)}% wins · ${entry.draws} draws · ${entry.ratedGames} rated`
        : `${entry.games} 局 · 胜率 ${Math.round(entry.winRate * 100)}% · ${entry.draws} 平 · ${entry.ratedGames} 计分`;
      const own = data.me;
      paragraph(en ? `Your skill · ${own.points} · ${own.rank ? `#${own.rank}` : `Provisional · calibrating`}\n${summary(own)}`
        : `我的实力分 ${own.points} · ${own.rank ? `第 ${own.rank} 名` : `暂定 · 定级中`}\n${summary(own)}`, '#2a2118');
      if (own.interval) paragraph(en ? `Estimated 95% range: ${own.interval.join('–')}` : `约 95% 估计范围：${own.interval.join('–')} 分`);
      if (data.aiOpponents?.length) paragraph(data.aiOpponents.map(bot => {
        const name = RANKED_LABELS[ui.language][RANKED_PROFILES.indexOf(bot.profile)] || 'AI';
        return `${name} ${bot.points}${bot.provisional ? (en ? ' (provisional)' : '（暂定）') : ''}`;
      }).join(' · '));
      if (!data.entries.length) paragraph(en ? 'No established players yet. Ratings need enough reliable evidence.' : '暂时还没有已定级玩家，实力估计可靠后入榜。');
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
