export const RANKED_PROFILES = ['greedy', 'minimax-2', 'minimax-3', 'minimax-4'];
export const RANKED_LABELS = {
  zh: ['入门 · ×1', '普通 · ×1.5', '进阶 · ×2', '深入 · ×3'],
  en: ['Starter · ×1', 'Standard · ×1.5', 'Advanced · ×2', 'Deep search · ×3'],
};
export const LADDER_RULES = {
  zh: 'AI 榜：积分 = 1000 × 难度加权成绩 ÷（计分局数 + 10）+ 2 × min（计分局数，100）。胜记 1、平记 0.5、负记 0，再乘难度系数 1 / 1.5 / 2 / 3。额外的 10 局分母压低小样本运气；场次奖励最高 200 分。\n\n人类榜：实力分从 1000 开始，每局变化 = 16 ×（实际成绩 − 预期成绩）；预期成绩 = 1 ÷（1 + 10^((对手实力分 − 自己实力分) ÷ 400)）。胜 / 平 / 负为 1 / 0.5 / 0。榜单积分 = 实力分 + 2 × min（计分局数，50）。击败强敌加分更多，实力分单局最多变化 16 分，场次奖励最高 100 分。双方分差很小时仍可能换位，单局不会抹掉明显的长期优势。\n\n两榜满 5 场计分对局后入榜，同分并列。战绩显示所有已结算新对局；胜率 = 胜局 ÷ 总局数，平局单列。人类榜同一对手每天前 3 局计分，AI 榜每天前 20 局计分，均在北京时间零点重置。\n\nAI 排位固定 7 路三角棋盘、V3 规则、玩家先手，无提示、悔棋。仅服务器执行的 AI 排位计入 AI 榜，本地人机为练习。人类联机 V3 默认起点、未悔棋的对局可计分；自定义/随机起点、悔棋局只记战绩。正常终局双方须各有至少 2 次落子，开局直接互相 PASS 不计分；认输和主动离房按输结算。掉线可恢复，轮到自己后连续 24 小时无操作按负结算；不会因短暂断网立即扣分。已结算对局不可再悔棋。',
  en: 'AI points = 1000 × weighted results / (rated games + 10) + 2 × min(rated games, 100). Win / draw / loss is 1 / 0.5 / 0, multiplied by difficulty 1 / 1.5 / 2 / 3. Ten extra denominator games soften small samples. Participation is capped at 200.\n\nHuman skill starts at 1000. Change = 16 × (result − expected result). Expected result = 1 / (1 + 10^((opponent skill − your skill) / 400)). Win / draw / loss is 1 / 0.5 / 0. Points = skill + 2 × min(rated games, 50). Beating stronger opponents earns more; skill moves by at most 16 per game. Participation is capped at 100. Close scores may change order.\n\nFive rated games qualify for each board; equal points share a rank. Records cover all newly settled games. Win rate = wins / all games; draws are shown separately. Only the first 3 games against the same human per day and first 20 AI games per day are rated, resetting at midnight Beijing time.\n\nRanked AI uses a fixed size-7 triangle, V3 rules and human first move, with no hints or undo. Only server-run AI matches count; local AI is practice. V3 human rooms with default roots and no takebacks can be rated. Other rooms record results only. Normal finishes require at least 2 placements each; opening passes do not earn points. Resigning or leaving forfeits. Disconnects can resume; 24 hours without action on your turn forfeits. Settled games cannot be undone.',
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
      if (data?.version !== 'ladder-v1' || data.board !== kind || !Array.isArray(data.entries) || !data.me) throw Error('LADDER_UNAVAILABLE');
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
  const board = receipt.board === 'ai' ? 'AI' : en ? 'Human' : '人类';
  return receipt.rated ? (en ? `${board}: ${change.delta >= 0 ? '+' : ''}${change.delta} → ${change.points} points`
    : `${board} 榜积分 ${change.delta >= 0 ? '+' : ''}${change.delta} · 当前 ${change.points} 分`)
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
  else if (!state.kind) paragraph(en ? 'Five rated games to enter. Tap a ladder to view.' : '满 5 场计分对局后入榜，点击查看榜单。');
  else {
    if (state.loading) paragraph(en ? 'Loading standings…' : '正在加载榜单…');
    else if (state.error) paragraph(en ? 'Cannot load standings. Refresh to retry; your results are saved on the server.' : '暂时无法读取榜单，请刷新重试；已结算成绩保存在服务器。', '#a43730');
    const data = state.data;
    if (data) {
      const summary = entry => en ? `${entry.games} played · ${Math.round(entry.winRate * 100)}% wins · ${entry.draws} draws · ${entry.ratedGames} rated`
        : `${entry.games} 局 · 胜率 ${Math.round(entry.winRate * 100)}% · ${entry.draws} 平 · ${entry.ratedGames} 计分`;
      const own = data.me;
      paragraph(en ? `You · ${own.points} pts · ${own.rank ? `#${own.rank}` : `${Math.max(0, 5 - own.ratedGames)} more rated to qualify`}\n${summary(own)}`
        : `我的积分 ${own.points} · ${own.rank ? `第 ${own.rank} 名` : `再完成 ${Math.max(0, 5 - own.ratedGames)} 场计分局入榜`}\n${summary(own)}`, '#2a2118');
      if (!data.entries.length) paragraph(en ? 'No qualifying players yet. Complete rated games to join.' : '暂时还没有入榜玩家，完成计分对局即可参与。');
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
