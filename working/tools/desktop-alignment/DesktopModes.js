import GameEngine, { PointState } from './GameEngine.js';
import { CHALLENGE_LEVELS, evaluateChallengeResult, snapshotChallengeMetrics } from './ChallengeCampaign.js';
import { loadPlayerProfileResult, persistPlayerProfile, getPlayerProfileReadNotice } from './LocalProfile.js';
import { summarizeGameTransition } from './GameFeedback.js';

const fields = ['addedEdges', 'removedEdges', 'removedNodes', 'territoryGain'];
const blankMetrics = () => Object.fromEntries([...fields, 'territory'].map(field => [field, { BLACK: 0, WHITE: 0, PURPLE: 0 }]));

export function createDesktopProfileController() {
  function read() { return loadPlayerProfileResult(); }
  function update(mutator) {
    const result = read();
    if (!result.ok) return { ok: false, status: result.status };
    mutator(result.profile);
    return persistPlayerProfile(result.profile);
  }
  function applyPreferences(preferences) {
    if (typeof document === 'undefined') return;
    document.documentElement.style.zoom = String(preferences.uiScale ?? 1);
    let style = document.getElementById('lifeline-desktop-reduced-motion');
    if (preferences.reducedMotion && !style) {
      style = document.createElement('style'); style.id = 'lifeline-desktop-reduced-motion';
      style.textContent = '*,*::before,*::after{animation-duration:0.01ms!important;animation-iteration-count:1!important;transition-duration:0.01ms!important;scroll-behavior:auto!important}';
      document.head.appendChild(style);
    } else if (!preferences.reducedMotion) style?.remove();
  }
  function preferences() { return read().profile.preferences; }
  function setPreferences(changes) {
    const saved = update(profile => { profile.preferences = { ...profile.preferences, ...changes }; });
    if (saved.ok) applyPreferences(preferences());
    return saved;
  }
  function refresh() { const current = read(); applyPreferences(current.profile.preferences); return current; }
  function finishTutorial() { return update(profile => { profile.progress.tutorialComplete = true; }); }
  function playFeedback(before, after, action, language) {
    const settings = preferences();
    if (!settings.audioEnabled || !before || !after || !action) return;
    try {
      const Audio = globalThis.AudioContext ?? globalThis.webkitAudioContext;
      if (!Audio) return;
      const kind = summarizeGameTransition(before, after, action, language).kind;
      const context = new Audio(), oscillator = context.createOscillator(), gain = context.createGain();
      oscillator.frequency.value = ({ terminal: 660, clear: 250, territory: 740, connect: 580, cut: 320 })[kind] ?? 440;
      gain.gain.setValueAtTime(0.0001, context.currentTime);
      gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, 0.035 * settings.audioVolume / 100), context.currentTime + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.12);
      oscillator.connect(gain); gain.connect(context.destination); oscillator.start(); oscillator.stop(context.currentTime + 0.13);
      oscillator.onended = () => { void context.close(); };
    } catch { /* Sound is optional; never block the game. */ }
  }
  applyPreferences(preferences());
  return { read, preferences, setPreferences, finishTutorial, playFeedback, refresh };
}

// A challenge has its own engine, so opening it cannot replace a live match.
export class DesktopChallenge {
  constructor(level, profile) {
    this.level = level;
    this.profile = profile;
    this.engine = new GameEngine(level);
    for (const action of level.prefix) {
      if (this.engine.getCurrentPlayer() !== action.player) throw new Error('Challenge prefix actor mismatch.');
      const result = action.type === 'skip' ? this.engine.skipTurn() : this.engine.playMove(action.point);
      if (!result.success) throw new Error('Challenge prefix is incompatible with these rules.');
    }
    this.snapshot = this.engine.getSnapshot();
    this.startingNodes = this.snapshot.boardMatrix.flatMap((row, y) => row.flatMap((value, x) => value === PointState.BLACK_NODE ? [[x, y]] : []));
    this.metrics = blankMetrics();
    this.playerMoves = 0;
    this.opponentReplies = 0;
    this.status = 'running';
    this.saveResult = null;
  }
  step(point, player) {
    if (this.status !== 'running' || this.engine.getCurrentPlayer() !== player) return false;
    const before = this.snapshot;
    const result = point === null ? this.engine.skipTurn() : this.engine.playMove(point);
    if (!result.success) return false;
    this.snapshot = this.engine.getSnapshot();
    const delta = snapshotChallengeMetrics(before, this.snapshot);
    if (delta) {
      for (const field of fields) for (const name of Object.keys(this.metrics[field])) this.metrics[field][name] += delta[field][name];
      this.metrics.territory = delta.territory;
    }
    if (player === 'BLACK') this.playerMoves += 1;
    else this.opponentReplies += 1;
    const metrics = { ...this.metrics, playerMoves: this.playerMoves, opponentReplies: this.opponentReplies };
    const afterReply = this.snapshot.currentPlayer === 'BLACK' && this.opponentReplies > 0 ? this.snapshot : null;
    if (evaluateChallengeResult(this.level, metrics, this.startingNodes, afterReply, this.snapshot)) {
      this.status = 'won';
      const current = loadPlayerProfileResult();
      if (!current.ok) this.saveResult = { ok: false, status: current.status };
      else {
        current.profile.progress.completedChallenges = [...new Set([...current.profile.progress.completedChallenges, this.level.id])];
        this.saveResult = persistPlayerProfile(current.profile);
        if (this.saveResult.ok) this.profile = current.profile;
      }
    } else {
      const needsReply = ['preserve-starting-nodes', 'cut-and-territory'].includes(this.level.goal.type);
      if (this.playerMoves >= this.level.maxPlayerMoves && (!needsReply || this.snapshot.currentPlayer === 'BLACK')) this.status = 'failed';
    }
    return true;
  }
  play(point) {
    if (!this.step(point, 'BLACK')) return false;
    if (this.status === 'running' && this.engine.getCurrentPlayer() === 'WHITE') {
      const preferred = this.level.replyPreferences[this.opponentReplies];
      const legal = this.engine.getLegalMoves('WHITE');
      const chosen = legal.find(move => preferred && move.point[0] === preferred[0] && move.point[1] === preferred[1]) ?? legal[0];
      this.step(chosen?.point ?? null, 'WHITE');
    }
    return true;
  }
}

export function openDesktopCampaign({ language = 'zh', onClose = () => {}, onLanguageChange = () => {}, profileController = createDesktopProfileController() } = {}) {
  const zh = language !== 'en';
  let loaded = loadPlayerProfileResult();
  let session = null;
  const overlay = document.createElement('section');
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', zh ? '挑战关卡' : 'Challenges');
  Object.assign(overlay.style, { position: 'fixed', inset: '0', zIndex: '99999', overflow: 'auto', background: '#f7f0e3', color: '#243c33', padding: '20px', font: '16px system-ui' });
  document.body.appendChild(overlay);
  const button = (label, fn) => { const el = document.createElement('button'); el.textContent = label; el.type = 'button'; el.style.cssText = 'padding:8px 12px;margin:4px;border:1px solid #71897c;border-radius:8px;background:white;color:#243c33;cursor:pointer'; el.addEventListener('click', fn); return el; };
  const text = (tag, value) => { const el = document.createElement(tag); el.textContent = value; return el; };
  let closed = false;
  function close() { if (closed) return; closed = true; overlay.remove(); onClose(); }
  overlay.addEventListener('keydown', event => {
    event.stopPropagation();
    if (event.key === 'Escape') { event.preventDefault(); close(); }
  });
  function render() {
    overlay.replaceChildren();
    overlay.append(button(zh ? '返回对局' : 'Return to match', close));
    if (!session) {
      overlay.append(text('h1', zh ? '挑战关卡' : 'Challenges'));
      const notice = getPlayerProfileReadNotice(loaded.status, language);
      if (notice) overlay.append(text('p', notice));
      const settings = document.createElement('details');
      settings.append(text('summary', zh ? '桌面设置' : 'Desktop settings'));
      const pref = profileController.preferences();
      const set = changes => {
        const result = profileController.setPreferences(changes);
        if (!result.ok) settings.append(text('p', zh ? '设置保存失败，原数据已保留。' : 'Settings could not be saved; original data was retained.'));
        return result.ok;
      };
      const checkbox = (title, key) => {
        const label = document.createElement('label'), input = document.createElement('input');
        input.type = 'checkbox'; input.checked = Boolean(pref[key]); input.addEventListener('change', () => { if (!set({ [key]: input.checked })) input.checked = !input.checked; });
        label.style.cssText = 'display:block;margin:8px 0'; label.append(input, document.createTextNode(title)); settings.append(label);
      };
      checkbox(zh ? '启用音效' : 'Sound', 'audioEnabled');
      checkbox(zh ? '减少动态效果' : 'Reduce motion', 'reducedMotion');
      const volume = document.createElement('input'); volume.type = 'range'; volume.min = '0'; volume.max = '100'; volume.value = String(pref.audioVolume);
      volume.setAttribute('aria-label', zh ? '音量' : 'Volume'); volume.addEventListener('change', () => set({ audioVolume: Number(volume.value) }));
      settings.append(text('span', zh ? '音量' : 'Volume'), volume);
      const scale = document.createElement('select'); scale.setAttribute('aria-label', zh ? '界面缩放' : 'UI scale');
      for (const value of [0.9, 1, 1.1]) { const option = document.createElement('option'); option.value = String(value); option.textContent = `${Math.round(value * 100)}%`; scale.append(option); }
      scale.value = String(pref.uiScale); scale.addEventListener('change', () => set({ uiScale: Number(scale.value) })); settings.append(text('span', zh ? '界面缩放' : 'UI scale'), scale);
      settings.append(button(zh ? '切换中文 / English' : 'Switch English / 中文', () => { const next = zh ? 'en' : 'zh'; if (set({ language: next })) { onLanguageChange(next); close(); } }));
      settings.append(button(zh ? '切换全屏' : 'Toggle fullscreen', async () => {
        try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen(); set({ fullscreen: Boolean(document.fullscreenElement) }); }
        catch { settings.append(text('p', zh ? '无法切换全屏。' : 'Fullscreen is unavailable.')); }
      }));
      overlay.append(settings);
      const backup = async operation => {
        const result = await globalThis.lifelineDesktop?.[operation]?.();
        if (result?.ok && operation === 'importProgressBackup') {
          loaded = profileController.refresh();
          if (loaded.profile.preferences.language) onLanguageChange(loaded.profile.preferences.language);
        }
        render();
        if (result?.status !== 'cancelled') overlay.prepend(text('p', result?.ok ? (zh ? '备份操作完成。' : 'Backup operation complete.') : (zh ? '备份操作失败，原数据已保留。' : 'Backup failed; existing data was retained.')));
      };
      overlay.append(button(zh ? '导出进度' : 'Export progress', () => backup('exportProgressBackup')),
                     button(zh ? '导入进度' : 'Import progress', () => backup('importProgressBackup')));
      overlay.append(button(zh ? '查看成就' : 'Achievements', async () => {
        const result = await globalThis.lifelineDesktop?.readAchievements?.();
        const list = document.createElement('section');
        list.append(text('h2', zh ? '成就' : 'Achievements'));
        if (!result?.ok) list.append(text('p', zh ? '成就读取失败。' : 'Could not read achievements.'));
        else for (const achievement of result.achievements) list.append(text('p', `${achievement.unlocked ? '✓' : '○'} ${zh ? achievement.titleZh : achievement.titleEn}`));
        overlay.append(list);
      }));
      const grid = document.createElement('div'); grid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:6px;max-width:1000px';
      for (const level of CHALLENGE_LEVELS) {
        const completed = loaded.profile.progress.completedChallenges.includes(level.id);
        grid.append(button(`${completed ? '✓ ' : ''}${zh ? level.titleZh : level.titleEn}`, () => { try { loaded = loadPlayerProfileResult(); session = new DesktopChallenge(level, loaded.profile); render(); } catch (error) { overlay.prepend(text('p', error.message)); } }));
      }
      overlay.append(grid); return;
    }
    const { level, snapshot } = session;
    overlay.append(button(zh ? '关卡列表' : 'Challenge list', () => { session = null; render(); }), text('h2', zh ? level.titleZh : level.titleEn), text('p', zh ? level.promptZh : level.promptEn));
    if (session.status !== 'running') {
      let notice = session.status === 'won' ? (zh ? level.successZh : level.successEn) : (zh ? '步数已用完，请重试。' : 'Move limit reached. Try again.');
      if (session.saveResult && !session.saveResult.ok) notice += zh ? ' 进度保存失败，原文件已保留。' : ' Progress could not be saved; original files were retained.';
      overlay.append(text('p', notice), button(zh ? '重试' : 'Retry', () => { session = new DesktopChallenge(level, loaded.profile); render(); }));
    }
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `-1 -1 ${level.gridSize + 2} ${level.gridSize + 2}`); svg.setAttribute('role', 'group'); svg.setAttribute('aria-label', zh ? '挑战棋盘' : 'Challenge board'); svg.style.cssText = 'width:min(90vw,600px);height:auto;display:block;background:#fffaf0;border-radius:12px';
    const point = (x, y) => [x + y * 0.5, y * 0.866];
    for (const [player, edges] of Object.entries(snapshot.edges ?? {})) for (const edge of edges) {
      const ends = edge.split('|').map(item => item.split(',').map(Number)); if (ends.length !== 2 || ends.some(p => p.length !== 2 || p.some(Number.isNaN))) continue;
      const [a, b] = ends.map(([x, y]) => point(x, y)); const line = document.createElementNS(svg.namespaceURI, 'line');
      for (const [name, value] of Object.entries({ x1: a[0], y1: a[1], x2: b[0], y2: b[1], stroke: player === 'BLACK' ? '#276c9b' : '#b85a4c', 'stroke-width': 0.09 })) line.setAttribute(name, value);
      svg.appendChild(line);
    }
    const legal = new Set(session.engine.getLegalMoves('BLACK').map(move => move.point.join(',')));
    snapshot.boardMatrix.forEach((row, y) => row.forEach((value, x) => {
      if (x + y >= level.gridSize) return;
      const [cx, cy] = point(x, y); const circle = document.createElementNS(svg.namespaceURI, 'circle');
      const canPlay = session.status === 'running' && legal.has(`${x},${y}`);
      for (const [name, item] of Object.entries({ cx, cy, r: canPlay ? 0.16 : 0.12, fill: value === PointState.BLACK_NODE ? '#276c9b' : value === PointState.WHITE_NODE ? '#b85a4c' : '#c4b6a4', tabindex: canPlay ? '0' : '-1', 'aria-label': `${x},${y}` })) circle.setAttribute(name, item);
      if (canPlay) { const play = () => { session.play([x, y]); if (session.status === 'won' && session.saveResult?.ok) loaded = loadPlayerProfileResult(); render(); }; circle.addEventListener('click', play); circle.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); play(); } }); }
      svg.appendChild(circle);
    }));
    overlay.append(svg);
  }
  render();
  return close;
}
