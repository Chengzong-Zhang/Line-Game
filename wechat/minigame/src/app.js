import { ComputeScheduler } from './scheduler.js';
import { SaveStore } from './storage.js';
import { GameSession } from './session.js';
import { TUTORIAL_LEVELS, createLocalGameSession, resolveInitialPositions, randomInitialPositions } from './core.js';
import { TEXT, errorText } from './i18n.js';
import { boardLayout, drawBoard, hitPoint, pointAtScreen, focusBoardLayout, panBoardFocus } from './board.js';
import { OnlineClient, ONLINE_EMOTES } from './online.js';
import { ReplayLibrary } from './library.js';
import { readPreferences, savePreferences } from './preferences.js';
import { BASIC_CONTROLLERS, playerIds, controllerChoices, defaultAIProfile, presetControllers, controllersMode } from './controllers.js';
import { drawSetup, drawPlayers, drawPlayOptions, drawLessons, drawLibrary, libraryPageSize, drawModels, drawAnalysis } from './screens.js';
import { normalizePlayOptions } from './play-options.js';
import { MODEL_CATALOG, controllerLabel } from './model-catalog.js';
import { ModelAssets } from './model-assets.js';
import { readDisplay, saveDisplay, PLAYER_COLORS, PLAYER_LABEL_KEYS } from './display.js';
import { drawReplayPrimary, drawReplayTools, drawBranch, drawDisplayOptions } from './replay-ui.js';
import { helpDocument, summarizeResult } from './help-content.js';
import { drawReader, drawResult, drawGuideCabin, createGuideImages } from './help-ui.js';
import { createReaderCache } from './reader-cache.js';
import { drawCabinDock, drawCabinFrame, drawBoardCabin, drawBattleCabin, drawTutorialCabin } from './cabins-ui.js';
import { ACCOUNT_COPY, ACCOUNT_ERRORS } from './account-ui.js';
import { TrainingContribution, contributionContext, CONTRIBUTION_NOTICE, CONTRIBUTION_NOTICE_EN,
  CLEAR_PENDING_NOTICE, CLEAR_PENDING_NOTICE_EN } from './training-contribution.js';
import { ensureOnlineConsent } from './online-consent.js';

const THEME = { background: '#f4ede1', ink: '#2a2118', muted: '#695749', border: '#dfd1bb', white: '#fff9ee' };

export function createApp(platform, config = {}) {
  const canvas = platform.canvas, ctx = canvas.getContext('2d');
  let language = 'zh';
  try { if (platform.storage.get('lifeline-wx-language') === 'en') language = 'en'; } catch (_) { /* First run. */ }
  const preferences = readPreferences(platform.storage);
  let scene = 'game', cabin = null, cabinGeneration = 0, disposed = false, selected = null, size = preferences.size, mode = preferences.mode, difficulty = preferences.difficulty;
  let startPlayer = preferences.startPlayer || 'BLACK', controllers = preferences.controllers || null;
  let playerCount = preferences.playerCount ?? (mode === 'three-human' ? 3 : 2), playersPage = 0;
  let boardShape = preferences.boardShape || (playerCount >= 4 ? 'hexagon' : 'triangle');
  let startingPointMode = preferences.startingPointMode || 'default', initialPositions = preferences.initialPositions || null;
  let startDraft = null, startSeat = 'BLACK', startPoint = null;
  const draftSettings = () => ({ gridSize: size, playerCount, boardShape });
  const playerDrafts = preferences.playerDrafts || {};
  const draftPlayerCount = () => playerCount;
  const draftControllers = () => controllers || presetControllers(mode, difficulty, draftPlayerCount(), draftSettings());
  const controllerMenuChoices = (count, settings = draftSettings()) => {
    const compatible = controllerChoices(count, settings);
    return [...compatible.filter(profile => !profile.startsWith('model:')), ...(compatible.some(profile => profile.startsWith('model:')) ? ['models'] : [])];
  };
  function rememberPlayerDraft() {
    playerDrafts[draftPlayerCount()] = { mode, startPlayer, controllers: controllers ? { ...controllers } : null,
      boardShape, startingPointMode, initialPositions };
  }
  function changePlayerCount(count) {
    if (!Number.isInteger(count) || count < 2 || count > 6 || count === draftPlayerCount()) return;
    rememberPlayerDraft(); cabinGeneration++;
    const saved = playerDrafts[count];
    playerCount = count; playersPage = 0;
    mode = saved?.mode || (count === 3 ? 'three-human' : count >= 4 ? 'human' : 'ai-white');
    startPlayer = saved?.startPlayer || 'BLACK'; controllers = saved?.controllers ? { ...saved.controllers } : null;
    boardShape = saved?.boardShape || (count >= 4 ? 'hexagon' : 'triangle');
    startingPointMode = saved?.startingPointMode || 'default'; initialPositions = saved?.initialPositions || null;
    persistPreferences();
  }
  function selectController(player, profile) {
    const count = draftPlayerCount();
    if (!playerIds(count).includes(player) || !controllerChoices(count, draftSettings()).includes(profile)) return;
    controllers = { ...draftControllers(), [player]: profile };
    mode = count === 3 ? 'three-human' : controllersMode(controllers); persistPreferences();
  }
  let playOptions = normalizePlayOptions(preferences.playOptions), optionsConfigured = Boolean(preferences.playOptions);
  let buttons = [], layout = null, metrics = platform.metrics(), frame = null, startTouch = null;
  let baseLayout = null, boardRect = null, zoomFocus = null, view = null;
  let modelTarget = null, modelPage = 0, modelGroup = 'research';
  let analysis = null, analysisProfile = 'minimax-2', analysisResults = [], analysisPosition = null;
  let display = readDisplay(platform.storage), displayReturn = 'options';
  let inspection = null, keepBranchPlayers = false;
  let readerReturn = 'guide', readerKind = 'rules', readerPage = 0, helpGeneration = 0;
  const readerCache = createReaderCache(helpDocument);
  let friendsGeneration = 0, visibilityGeneration = 0, appVisible = true;
  let roomRetryCode = null, roomFeedbackPending = false;
  let terminology = preferences.terminology || 'math', cabinScroll = 0, scrollArea = null, scrollMax = 0, clipArea = null, sliders = [];
  let accountBusy = false, accountMessage = '', emotePage = 0, displayedEmote = null, emoteMessage = '', emoteTimer = null, observedEmoteError = null, contributionTicket = null, pendingContribution = null, contributionEpoch = null;
  let nameDraft = '', avatarEntry = null;
  let userInfoControl = null, userInfoControlKey = null, userInfoUnavailableKey = null, profileHideCount = 0;
  const privacyAuthorization = platform.installPrivacyAuthorization?.({ language: () => language });
  const models = new ModelAssets(platform);
  const guideImages = createGuideImages(platform.createImage, redraw);
  const scheduler = new ComputeScheduler(platform.createWorker, { timeoutMs: config.workerTimeoutMs || 15000 });
  const library = new ReplayLibrary(platform.storage);
  let libraryEntries = [], libraryPage = 0, fileBusy = false, fileGeneration = 0, archiveNotice = '';
  const completedLevels = new Set();
  try {
    const saved = JSON.parse(platform.storage.get('lifeline-wx-lessons-v1') || '[]');
    if (Array.isArray(saved)) saved.filter(i => Number.isInteger(i) && i >= 0 && i < 5).forEach(i => completedLevels.add(i));
  } catch (_) { /* Lesson progress is optional. */ }
  const localSession = new GameSession(scheduler, new SaveStore(platform.storage), () => {
    if (localSession.tutorial?.done && !completedLevels.has(localSession.tutorial.index)) {
      completedLevels.add(localSession.tutorial.index);
      try { platform.storage.set('lifeline-wx-lessons-v1', JSON.stringify([...completedLevels])); } catch (_) {}
    }
    checkContribution(); contribution.wake?.(); redraw();
  }, { models });
  const online = new OnlineClient(platform, config, scheduler, () => { syncEmoteError(); redraw(); });
  online.game.models = models;
  let session = localSession;
  online.onEmote = event => { if (appVisible && isOnline()) showEmote(event); };
  const contribution = new TrainingContribution({ storage: platform.storage, request: platform.contributionRequest, origin: config.apiBase,
    createReplay: (settings, actions) => scheduler.request('EXPORT_REPLAY', { settings, actions }, localSession.context(), 2),
    canRun: () => appVisible && !localSession.busy && !isOnline()
      && Boolean(localSession.snapshot?.gameOver || localSession.paused), onChange: redraw });
  function invalidateContribution() {
    contribution.invalidateMatch(contributionTicket); contribution.invalidateMatch(pendingContribution);
    contributionTicket = pendingContribution = null;
  }
  function beginContribution() {
    contributionEpoch = localSession.settings;
    contributionTicket = contribution.beginMatch({ settings: localSession.settings, context: contributionContext(localSession), source: 'local', actionCount: localSession.actions.length });
  }
  function checkContribution() {
    if (!contributionTicket || localSession.settings !== contributionEpoch || !localSession.snapshot?.gameOver || localSession.busy || localSession.tutorial || localSession.replayIndex !== null) return;
    const ticket = contributionTicket; contributionTicket = null;
    // Seal the finished trajectory before a reset can cancel the shared Worker.
    // Validation and upload run later while the game is idle.
    contribution.captureCompletedMatch(ticket, { settings: localSession.settings, actions: localSession.actions,
      context: contributionContext(localSession), source: 'local', terminal: true });
  }
  const t = () => TEXT[language];
  const warTerms = { zh: { confirm: '确认部署', choose: '点选前线，再确认部署', selected: '已选位置，确认部署', hint: '参谋', played: '部署', resultScoreUnits: '控制的领土格点' }, en: { confirm: 'Deploy', choose: 'Choose a position, then deploy', selected: 'Position selected. Deploy to confirm.', hint: 'Advice', played: 'deployed', resultScoreUnits: 'Controlled territory points' } };
  const label = (key) => key.startsWith('controller-') ? controllerLabel(key.slice(11), t()) : terminology === 'war' && warTerms[language][key] || t()[key];
  const playerLabel = player => label(PLAYER_LABEL_KEYS[player] || 'draw');
  const isOnline = () => session === online.game;
  const onlineSettings = (overrides = {}, base = online.room?.settings) => {
    const current = base || { gridSize: size, boardShape,
      startingPointMode: playerCount === 2 ? startingPointMode : 'default',
      initialPositions: playerCount === 2 ? initialPositions : null,
      undoEnabled: playOptions.undoEnabled, undoMaxCount: playOptions.undoMaxCount };
    const next = { rulesVersion: current.rulesVersion || 'territory-v3', gridSize: current.gridSize, boardShape: current.boardShape || 'triangle',
      startingPointMode: current.startingPointMode || (current.initialPositions ? 'custom' : 'default'),
      initialPositions: current.initialPositions, undoEnabled: current.undoEnabled === true,
      undoMaxCount: current.undoMaxCount || 3,
      ...(current.botCount ? { botCount: current.botCount } : {}), ...overrides };
    if (next.startingPointMode === 'default') delete next.initialPositions;
    else if (next.startingPointMode === 'random' && (overrides.startingPointMode === 'random' || !next.initialPositions))
      next.initialPositions = randomInitialPositions(next.gridSize, 2, Math.random, next.boardShape);
    else next.initialPositions = resolveInitialPositions(next.gridSize, 2, next.initialPositions, next.boardShape);
    return next;
  };
  const editOnlineSettings = overrides => { if (online.canEditSettings()) void online.updateSettings(onlineSettings(overrides)); };
  const canPlay = () => isOnline() ? online.canPlay() : session.canPlay();
  const play = (action) => isOnline() ? online.act(action) : session.act(action);
  const currentView = () => view?.session === session && view.epoch === session.epoch && view.snapshot === session.snapshot && view.scene === scene;
  const inBoard = (x, y) => boardRect && x >= boardRect.x && y >= boardRect.y
    && x <= boardRect.x + boardRect.width && y <= boardRect.y + boardRect.height;
  function clearBoardView() { selected = null; zoomFocus = null; startTouch = null; }

  function clearUserInfoControl() {
    userInfoControl?.destroy(); userInfoControl = null; userInfoControlKey = null;
  }
  function syncUserInfoControl() {
    const target = !disposed && appVisible && scene === 'game' && cabin === 'battle' && !accountBusy && !online.deleting
      && online.account && buttons.find(item => item.id === 'profile-wechat' && !item.disabled);
    if (!target || typeof platform.createUserInfoControl !== 'function') { clearUserInfoControl(); return; }
    const uid = online.account.uid, generation = cabinGeneration, key = `${uid}:${generation}:${language}`;
    if (userInfoUnavailableKey === key) return;
    const bounds = { x: target.x, y: target.y, width: target.width, height: target.height };
    if (userInfoControlKey === key && userInfoControl) {
      if (userInfoControl.update({ bounds, language }) === false) { clearUserInfoControl(); userInfoUnavailableKey = key; }
      return;
    }
    clearUserInfoControl();
    let initialized = false;
    try {
      userInfoControl = platform.createUserInfoControl({ bounds, language, onResult: (profile, error) => {
        // A missing optional native API may report failure while creating the
        // button. Only an actual later user tap can start a profile operation.
        if (!initialized || disposed || !appVisible || scene !== 'game' || cabin !== 'battle' || cabinGeneration !== generation || online.account?.uid !== uid) return;
        void accountAction('wechat', profile, error);
      } });
      initialized = true;
      if (userInfoControl) { userInfoControlKey = key; userInfoUnavailableKey = null; }
      else userInfoUnavailableKey = key;
    } catch (_) { userInfoUnavailableKey = key; /* The drawn control explains unavailable authorization. */ }
  }
  function redraw() { if (frame === null) frame = platform.frame(() => { frame = null; draw(); syncUserInfoControl(); }); }
  function resize() {
    const next = platform.metrics();
    if (['width', 'height', 'dpr', 'top', 'bottom'].some(key => next[key] !== metrics[key])) clearBoardView();
    startTouch = null; metrics = next;
    canvas.width = Math.round(metrics.width * metrics.dpr); canvas.height = Math.round(metrics.height * metrics.dpr);
    redraw();
  }
  function text(value, x, y, font = 16, color = THEME.ink, align = 'left', weight = '') {
    ctx.fillStyle = color; ctx.font = `${weight} ${font}px sans-serif, Emoji`.trim(); ctx.textAlign = align; ctx.textBaseline = 'middle';
    ctx.fillText(String(value), x, y);
  }
  function wrap(value, x, y, width, font = 14, color = THEME.muted, max = 4) {
    ctx.font = `${font}px sans-serif, Emoji`;
    const lines = [];
    for (const paragraph of String(value).split('\n')) {
      let line = '';
      const tokens = language === 'en' ? paragraph.match(/\S+|\s+/g) || [] : [...paragraph];
      for (const token of tokens) {
        if (!token.trim()) { if (line) line += ' '; continue; }
        if (line && ctx.measureText(line + token).width > width) { lines.push(line.trimEnd()); line = ''; }
        for (const character of token) {
          if (line && ctx.measureText(line + character).width > width) { lines.push(line.trimEnd()); line = ''; }
          line += character;
        }
      }
      if (line) lines.push(line.trimEnd());
    }
    if (lines.length > max) {
      let last = lines[max - 1];
      while (last && ctx.measureText(`${last}…`).width > width) last = last.slice(0, -1);
      lines[max - 1] = `${last}…`;
    }
    lines.slice(0, max).forEach((l, i) => text(l, x, y + i * (font + 6), font, color));
    return Math.min(max, lines.length) * (font + 6);
  }
  function rect(x, y, w, h, radius = 14, fill = THEME.white) {
    ctx.beginPath(); ctx.moveTo(x + radius, y); ctx.lineTo(x + w - radius, y); ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
    ctx.lineTo(x + w, y + h - radius); ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
    ctx.lineTo(x + radius, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - radius); ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y); ctx.fillStyle = fill; ctx.fill();
  }
  function button(id, title, x, y, w, action, { primary = false, disabled = false, height = 48, font = language === 'en' ? 14 : 16, danger = false } = {}) {
    rect(x, y, w, height, 13, disabled ? '#e7dfd0' : primary ? '#244d3d' : danger ? '#f8e8e2' : clipArea ? '#f3ecdf' : THEME.white);
    ctx.font = `${font}px sans-serif, Emoji`;
    const textWidth = w - (id.startsWith('cabin-') ? 6 : 14);
    const lines = []; let line = '';
    for (const token of language === 'en' ? String(title).match(/\S+\s*/g) || [] : [...String(title)]) {
      if (line && ctx.measureText(line + token.trimEnd()).width > textWidth) { lines.push(line.trimEnd()); line = ''; }
      line += token;
    }
    if (line) lines.push(line.trimEnd());
    if (lines.length > 2) {
      lines[1] += '…';
      while (lines[1].length > 1 && ctx.measureText(lines[1]).width > textWidth) lines[1] = lines[1].slice(0, -2) + '…';
    }
    lines.slice(0, 2).forEach((value, index) => text(value, x + w / 2,
      y + height / 2 + (Math.min(2, lines.length) === 2 ? (index - 0.5) * (font + 3) : 0), font,
      disabled ? '#9b9183' : primary ? '#fff9ee' : danger ? '#a43730' : THEME.ink, 'center'));
    if (!clipArea || y >= clipArea.y && y + height <= clipArea.y + clipArea.height) buttons.push({ id, x, y, width: w, height, action, disabled });
  }
  function slider(id, title, value, min, max, x, y, width, change, disabled = false) {
    text(`${title} · ${value}`, x, y + 9, 14, disabled ? '#9b9183' : THEME.ink);
    rect(x, y + 38, width, 5, 2, '#dfd1bb');
    const knob = x + 12 + (width - 24) * (value - min) / (max - min);
    rect(knob - 11, y + 29, 22, 22, 11, disabled ? '#bdb4a6' : '#2a2118');
    const item = { id, x, y: y + 20, width, height: 42, disabled,
      action: () => {}, set: point => change(Math.max(min, Math.min(max, Math.round(min + (point - x - 12) / (width - 24) * (max - min))))) };
    if (!clipArea || item.y >= clipArea.y && item.y + item.height <= clipArea.y + clipArea.height) { buttons.push(item); sliders.push(item); }
  }
  function drawAvatar(x, y, size) {
    const url = online.account?.avatarUrl;
    if (url && avatarEntry?.url !== url && typeof platform.loadImage === 'function') {
      const entry = avatarEntry = { url, image: null, failed: false };
      Promise.resolve(platform.loadImage(url)).then(image => {
        if (disposed || avatarEntry !== entry) return;
        entry.image = image; redraw();
      }).catch(() => { if (!disposed && avatarEntry === entry) { entry.failed = true; redraw(); } });
    }
    if (!url) avatarEntry = null;
    if (url && avatarEntry?.url === url && avatarEntry.image) {
      ctx.save(); ctx.beginPath(); ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2); ctx.clip();
      ctx.drawImage(avatarEntry.image, x, y, size, size); ctx.restore(); return;
    }
    ctx.fillStyle = '#8d8578'; ctx.beginPath(); ctx.arc(x + size / 2, y + size * .35, size * .15, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(x + size / 2, y + size * .75, size * .27, Math.PI, Math.PI * 2); ctx.fill();
  }
  function header() {
    const onStage = scene === 'game' || scene === 'home';
    const y = Number.isFinite(metrics.capsuleTop) ? metrics.capsuleTop : metrics.top - 38;
    const nativeLeft = metrics.capsuleLeft || metrics.width - 102;
    const middle = y + (metrics.capsuleHeight || 32) / 2;
    button('account-avatar', '', 16, middle - 18, 36, () => openCabin('battle'), { height: 36 });
    drawAvatar(18, middle - 16, 32);
    text('LIFELINE', 62, middle, nativeLeft < 220 ? 20 : 23, THEME.ink, 'left', 'bold');
    if (!onStage) button('home', label('backToBoard'), 16, metrics.top + 8, 96, returnToBoard, { height: 40, font: 14 });
    return metrics.top + (onStage ? 8 : 64);
  }
  function draw() {
    if (!currentView()) {
      clearBoardView(); view = { session, epoch: session.epoch, snapshot: session.snapshot, scene };
    }
    const { width: w, height: h, dpr } = metrics;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.fillStyle = THEME.background; ctx.fillRect(0, 0, w, h);
    buttons = []; sliders = []; scrollArea = null; clipArea = null; layout = null; boardRect = null; baseLayout = null; const navTop = header(), top = navTop + ((scene === 'game' || scene === 'home') ? 52 : 0);
    const ui = { metrics, top, text, rect, wrap, button, slider, label, ctx, language, guideImages };
    const cabinUi = { ...ui, top: navTop };
    if (scene === 'starts') {
      text(label('customStarts'), 24, top, 20, THEME.ink, 'left', 'bold');
      wrap(label('customStartsHelp'), 24, top + 32, w - 48, 13, THEME.muted, 2);
      const seats = playerIds(playerCount), columns = 3, cell = (w - 64) / columns;
      seats.forEach((player, index) => button(`start-seat-${player}`, `${playerLabel(player)} (${startDraft[player].join(',')})`,
        24 + index % columns * (cell + 8), top + 70 + Math.floor(index / columns) * 45, cell,
        () => { startSeat = player; startPoint = null; redraw(); }, { height: 39, font: 12, primary: startSeat === player }));
      const footer = h - metrics.bottom - 108;
      boardRect = { x: 30, y: top + 76 + Math.ceil(seats.length / columns) * 45,
        width: w - 60, height: Math.max(65, footer - top - 94 - Math.ceil(seats.length / columns) * 45) };
      baseLayout = boardLayout(size, boardRect, playerCount, boardShape);
      layout = zoomFocus ? focusBoardLayout(size, boardRect, zoomFocus, 44, playerCount, boardShape) : baseLayout;
      const extent = boardShape === 'hexagon' ? 2 * size - 1 : size;
      const matrix = Array.from({ length: extent }, () => Array(extent).fill(0));
      seats.forEach((player, index) => { const [x, y] = startDraft[player]; matrix[y][x] = 2 * index + 1; });
      if (zoomFocus) { ctx.save(); ctx.beginPath(); ctx.rect(boardRect.x, boardRect.y, boardRect.width, boardRect.height); ctx.clip(); }
      drawBoard(ctx, { gridSize: size, boardShape, players: seats, initialPositions: startDraft, boardMatrix: matrix,
        territories: {}, edges: {}, legalMoves: [], gameOver: false }, layout,
        { selected: startPoint, target: startDraft[startSeat], display: { ...display, coordinates: true } });
      if (zoomFocus) ctx.restore();
      const duplicate = startPoint && seats.some(player => player !== startSeat && startDraft[player].every((v, i) => v === startPoint[i]));
      if (duplicate) text(label('startPointOccupied'), w / 2, footer - 12, 13, '#a43730', 'center');
      button('start-point-confirm', `${label('confirmStart')} · ${playerLabel(startSeat)}`, 24, footer, w - 48,
        () => { if (!startPoint || duplicate) return; startDraft = { ...startDraft, [startSeat]: [...startPoint] }; startPoint = null;
          startSeat = seats[(seats.indexOf(startSeat) + 1) % seats.length]; redraw(); }, { height: 44, primary: true, disabled: !startPoint || duplicate });
      button('starts-save', label('saveStarts'), 24, footer + 54, (w - 60) / 2, async () => {
        initialPositions = resolveInitialPositions(size, playerCount, startDraft, boardShape); startingPointMode = 'custom';
        if (isOnline()) {
          if (!await online.updateSettings(onlineSettings({ startingPointMode: 'custom', initialPositions }))) return;
          redraw();
        } else persistPreferences();
        openCabin('board'); }, { height: 44, disabled: Boolean(startPoint) });
      button('starts-cancel', label('cancelStarts'), 36 + (w - 60) / 2, footer + 54, (w - 60) / 2, () => openCabin('board'), { height: 44 });
      if (baseLayout.spacing < 44) button('start-zoom', label(zoomFocus ? 'overviewShort' : 'zoomShort'), w - 81, boardRect.y - 12, 57,
        () => { zoomFocus = zoomFocus ? null : startPoint || startDraft[startSeat]; startPoint = null; redraw(); }, { height: 32, font: 12 });
      return;
    }
    if (scene === 'setup') {
      drawSetup(ui, { size, mode, difficulty, controllers, playerCount }, { start: startNew, players: () => { playersPage = 0; scene = 'players'; redraw(); }, change: (key, value) => {
        if (key === 'size') size = Math.max(5, Math.min(15, value));
        if (key === 'mode') { rememberPlayerDraft(); playerCount = value === 'three-human' ? 3 : 2; mode = value; controllers = null; startPlayer = 'BLACK'; }
        if (key === 'difficulty') {
          difficulty = value;
          if (controllers && draftPlayerCount() === 2) controllers = Object.fromEntries(Object.entries(controllers).map(([player, profile]) =>
            [player, profile === 'human' ? profile : difficulty === 'easy' ? 'greedy' : 'minimax-2']));
        }
        persistPreferences();
      } }); return;
    }
    if (scene === 'options') {
      drawPlayOptions(ui, playOptions, { start: startNew, display: () => openDisplay('options'),
        change: (key, value) => { playOptions = normalizePlayOptions({ ...playOptions,
          ...(key === 'hintEnabled' && value ? { hintMaxCount: Math.max(1, playOptions.hintMaxCount) } : {}), [key]: value });
          optionsConfigured = true; persistPreferences(); },
        duration: configureDuration }); return;
    }
    if (scene === 'players') {
      drawPlayers(ui, { playerCount: draftPlayerCount(), boardShape, startPlayer, controllers: draftControllers(), page: playersPage }, {
        start: startNew, controller: configureController,
        page: value => { playersPage = value; redraw(); }, players: changePlayerCount,
        starter: player => { startPlayer = player; persistPreferences(); },
        swap: () => { if (draftPlayerCount() !== 2) return; const previous = controllers || presetControllers(mode, difficulty);
          controllers = { BLACK: previous.WHITE, WHITE: previous.BLACK }; mode = controllersMode(controllers); persistPreferences(); },
      }); return;
    }
    if (scene === 'display') {
      drawDisplayOptions(ui, display, {
        change: (key, value) => { if (session.hidden) return; display = saveDisplay(platform.storage, { ...display, [key]: value }); redraw(); },
        back: () => { scene = displayReturn; redraw(); },
        help: () => openReader('rules-essential', 'display'),
      }); return;
    }
    if (scene === 'reader') {
      drawReader(ui, { ...readerCache.get(ui, readerKind, online.enabled), kind: readerKind, page: readerPage,
        canPractice: canPractice(), onlineEnabled: online.enabled, deleting: online.deleting,
        returnLabel: readerReturn === 'battle' ? 'backToBattle' : readerReturn === 'display' ? 'back' : 'backToGuide' }, {
        page: value => { readerPage = value; redraw(); },
        practice: async index => {
          if (!canPractice() || session.hidden) return;
          invalidateContribution(); scene = 'game'; selected = null; await session.tutorialLevel(index); redraw();
        }, back: () => { helpGeneration++; if (readerReturn === 'display') { scene = 'display'; redraw(); } else openCabin(readerReturn); }, deleteAccount,
      }); return;
    }
    if (scene === 'result') {
      const result = summarizeResult(session.snapshot);
      if (!result) { scene = 'game'; redraw(); return; }
      drawResult(ui, { result, playerLabel, online: isOnline() }, {
        back: () => { scene = 'game'; redraw(); },
        replay: () => { scene = 'game'; selected = null; void session.replay(0); redraw(); },
        save: async () => { if (!isOnline() && !session.hidden) { archiveCurrent(); await platform.message(label('replaySaved')); } },
      }); return;
    }
    if (scene === 'replay-hub') {
      text(language === 'en' ? 'Replay workspace' : '复盘模式', 24, top + 10, 22, THEME.ink, 'left', 'bold');
      button('replay-current', label('replay'), 24, top + 46, w - 48, () => { invalidateContribution(); scene = 'game'; void session.replay(0); redraw(); }, { disabled: !session.actions.length || isOnline(), primary: true });
      button('library', label('library'), 24, top + 104, w - 48, openLibrary, { disabled: isOnline() });
      button('display-open', label('displayOptions'), 24, top + 162, w - 48, () => openDisplay('replay-hub'));
      return;
    }
    if (scene === 'replay-tools') {
      drawReplayTools(ui, { cursor: session.replayIndex, total: session.actions.length, busy: session.busy,
        canBranch: !isOnline() && session.replayIndex !== null && !session.snapshot?.gameOver,
        canAnalyze: playerIds(session.settings.playerCount).length >= 2 && !session.snapshot?.gameOver }, {
        select: replayAction, back: () => { scene = 'game'; redraw(); },
      }); return;
    }
    if (scene === 'branch') {
      drawBranch(ui, { cursor: session.replayIndex, total: session.actions.length, keepPlayers: keepBranchPlayers,
        busy: session.busy, canKeep: session.snapshot.players.some(player => session.controllerFor(player) !== 'human'),
        error: session.error && errorText(session.error, t()) }, {
        players: keep => { keepBranchPlayers = keep; redraw(); }, start: branchReplay,
        back: () => { session.pause(); scene = 'game'; redraw(); },
      }); return;
    }
    if (scene === 'models') {
      const modelSettings = modelTarget?.kind === 'analysis' ? session.settings : draftSettings();
      const compatible = controllerChoices(modelSettings.playerCount, modelSettings);
      drawModels(ui, { models: MODEL_CATALOG.filter(model => compatible.includes(model.profile) && model.research === (modelGroup === 'research')),
        page: modelPage, group: modelGroup, target: modelTarget?.kind === 'analysis' ? label('analyzeReplay') : playerLabel(modelTarget?.player) }, {
        select: profile => {
          if (session.hidden) return;
          if (modelTarget?.kind === 'analysis') { scene = 'analysis'; void runAnalysis(profile); }
          else if (modelTarget?.player && controllerChoices(playerCount, draftSettings()).includes(profile)) {
            controllers = { ...(controllers || presetControllers(mode, difficulty)), [modelTarget.player]: profile };
            mode = controllersMode(controllers); scene = modelTarget.returnCabin ? 'home' : 'players'; persistPreferences();
          }
          redraw();
        },
        page: delta => { modelPage += delta; redraw(); },
        group: value => { modelGroup = value; modelPage = 0; redraw(); },
        info: () => platform.message(label('modelInfo')),
        back: () => { scene = modelTarget?.kind === 'analysis' ? 'analysis' : modelTarget?.returnCabin ? 'home' : 'players'; redraw(); },
      }); return;
    }
    if (scene === 'analysis') {
      drawAnalysis(ui, { result: analysis, profile: analysisProfile, cursor: session.replayIndex,
        busy: session.busy, progress: session.modelLoading?.progress,
        error: session.error && errorText(session.error, t()), comparisons: analysisResults.length }, {
        choose: configureAnalysis, retry: () => runAnalysis(analysisProfile),
        compare: () => platform.message([label('compareHelp'), ...analysisResults.map(result =>
          `${label(`controller-${result.profile}`)}: ${result.moves[0]?.point ? `(${result.moves[0].point.join(', ')})` : label('skip')}`)].join('\n')),
        preview: move => { session.pause(); session.hintPoint = move.point ? [...move.point] : null; scene = 'game'; redraw(); },
        back: () => { session.pause(); scene = 'game'; redraw(); },
      }); return;
    }
    if (scene === 'lessons') {
      drawLessons(ui, TUTORIAL_LEVELS, completedLevels, async index => {
        invalidateContribution(); scene = 'game'; selected = null; await session.tutorialLevel(index); redraw();
      }); return;
    }
    if (scene === 'library') {
      const pages = Math.max(1, Math.ceil(libraryEntries.length / libraryPageSize(metrics, top)));
      libraryPage = Math.max(0, Math.min(libraryPage, pages - 1));
      drawLibrary(ui, { entries: libraryEntries, page: libraryPage, busy: fileBusy,
        hasGame: Boolean(localSession.snapshot && !localSession.tutorial) }, {
        open: savedGameMenu, page: direction => { libraryPage += direction; redraw(); },
        import: importReplay, export: () => exportReplay(localSession.capture()),
        save: async () => { archiveCurrent(); refreshLibrary(); await platform.message(label('replaySaved')); },
      }); return;
    }
    const snapshot = session.snapshot;
    if (!snapshot) {
      const error = isOnline() ? online.error || session.error : session.error;
      wrap(error ? errorText(error, t()) : label(session.paused ? 'loadPaused' : 'thinking'), 24, top + 60, w - 48);
      if (!session.busy && !isOnline()) {
        button('load-retry', label('again'), 24, top + 164, w - 48, startNew, { primary: true });
      }
      return;
    }
    const boxW = (w - 60) / 2;
    const compact = h - metrics.top - metrics.bottom < 620;
    const multiScore = snapshot.players.length >= 4, scoreExtra = multiScore ? 48 : 0;
    const replaying = session.replayIndex !== null;
    const boardOffset = (session.tutorial ? 160 : replaying ? visibleInspection() ? 190 : 172 : 132) + scoreExtra, statusTop = top + scoreExtra;
    const footer = h - metrics.bottom - 102;
    boardRect = { x: 30, y: top + boardOffset, width: w - 60, height: Math.max(60, footer - top - boardOffset - 18) };
    baseLayout = boardLayout(snapshot.gridSize, boardRect, snapshot.players.length, snapshot.boardShape);
    layout = zoomFocus ? focusBoardLayout(snapshot.gridSize, boardRect, zoomFocus, 44, snapshot.players.length, snapshot.boardShape) : baseLayout;
    if (zoomFocus) zoomFocus = layout.focus;
    const zoomAvailable = baseLayout.spacing < 44 && !session.saveError;
    const secondaryX = 24, secondaryW = w - 48;
    const ownSide = isOnline() ? online.room?.player : null;
    const roundWidth = 64, scoreGap = 6;
    const scoreWidth = multiScore ? (w - 44) / 3 : (w - 32 - roundWidth - snapshot.players.length * scoreGap) / snapshot.players.length;
    const scoreOrder = snapshot.players.length === 2 ? [snapshot.players[0], null, snapshot.players[1]] : multiScore ? snapshot.players : [...snapshot.players, null];
    const roundNumber = Math.max(1, (session.replayIndex ?? session.actions.length) + (snapshot.gameOver ? 0 : 1));
    let scoreX = 16;
    for (const [scoreIndex, player] of scoreOrder.entries()) {
      const scoreY = top + (multiScore ? Math.floor(scoreIndex / 3) * 48 : 0);
      if (multiScore) scoreX = 16 + (scoreIndex % 3) * (scoreWidth + scoreGap);
      if (player === null) {
        rect(scoreX, top, roundWidth, 44, 12, '#eae0cf');
        text(`${label('turn')} ${roundNumber}`, scoreX + roundWidth / 2, top + 22, 14, THEME.ink, 'center');
        scoreX += roundWidth + scoreGap; continue;
      }
      const color = PLAYER_COLORS[player];
      const activeTurn = !snapshot.gameOver && snapshot.currentPlayer === player;
      rect(scoreX, scoreY, scoreWidth, 44, 12, activeTurn ? `${color}18` : THEME.white);
      const own = ownSide === player ? (language === 'en' ? ' (you)' : '·你') : '';
      text(`${playerLabel(player)}${own}  ${snapshot.territories[player].area}`, scoreX + scoreWidth / 2,
        scoreY + (multiScore ? 16 : 22), multiScore ? 13 : 14, color, 'center', 'bold');
      if (multiScore) text(activeTurn ? `${label('turn')} ${roundNumber}` : snapshot.resignedPlayers?.includes(player) ? label('resigned') : '—',
        scoreX + scoreWidth / 2, scoreY + 32, 11, activeTurn ? color : THEME.muted, 'center');
      // A vector underline identifies whose turn it is without emoji font variation.
      if (activeTurn) rect(scoreX + 12, scoreY + 38, scoreWidth - 24, 3, 1, color);
      scoreX += scoreWidth + scoreGap;
    }
    let instruction = session.busy ? label('thinking') : snapshot.gameOver
      ? `${label('result')} · ${snapshot.winner === 'DRAW' ? label('draw') : `${playerLabel(snapshot.winner)} ${label('wins')}`}`
      : session.paused ? label('resume') : language === 'en' ? 'Your move' : '轮到你落子';
    const lesson = session.tutorial && TUTORIAL_LEVELS[session.tutorial.index];
    // Replay retains the full log; only the displayed prefix may identify the last action.
    const lastAction = !lesson && !session.busy ? session.actions[(session.replayIndex ?? session.actions.length) - 1] : null;
    const lastType = { player_move: 'move', player_skip: 'skip', player_resign: 'resign' }[lastAction?.type] || lastAction?.type;
    let target = null, blocked = null;
    if (lesson) {
      instruction = `${session.tutorial.index + 1}/5 · ${session.tutorial.done ? label('lessonDone') : (language === 'zh' ? lesson.titleZh : lesson.titleEn).replace(/^.*?[：:]\s*/, '')}`;
      target = lesson.objective.point;
      if (lesson.restriction && !session.tutorial.restrictionObserved) target = blocked = lesson.restriction.point;
    }
    if (session.replayIndex !== null) instruction = `${label('replay')} · ${session.replayIndex} / ${session.actions.length}`;
    if (isOnline() && session.replayIndex === null) instruction = `${online.room?.code || ''} · ${label(online.room?.status === 'waiting' ? 'roomWaiting' : online.room?.status === 'closed' ? 'roomClosed' : snapshot.gameOver ? 'result' : snapshot.currentPlayer === 'BLACK' ? 'black' : 'white')}`;
    const hasResult = snapshot.gameOver && !lesson && session.replayIndex === null;
    if (hasResult) instruction = snapshot.winner === 'DRAW' ? label('draw') : `${playerLabel(snapshot.winner)} ${label('wins')}`;
    if (isOnline() || !session.settings.undoEnabled || replaying || lesson || snapshot.gameOver)
      text(instruction, session.replayIndex !== null || hasResult ? 24 : w / 2, statusTop + (compact && !lesson ? 59 : 65), 15, THEME.ink,
        session.replayIndex !== null || hasResult ? 'left' : 'center');
    if (session.replayIndex !== null) button('replay-options', label('replayTools'), w - 106, statusTop + (compact ? 44 : 47), 82, replayMenu, { height: 36, font: 13 });
    if (replaying) drawReplayPrimary(ui, { busy: session.busy,
      canBranch: !isOnline() && !snapshot.gameOver, canAnalyze: !snapshot.gameOver }, { select: replayAction }, statusTop + 84);
    if (hasResult) button('result-detail', label('resultDetails'), w - 106, statusTop + (compact ? 44 : 47), 82,
      () => { if (!session.hidden) { session.pause(); scene = 'result'; redraw(); } }, { height: 36, disabled: session.busy });
    if (lesson) wrap(session.tutorial.done ? (language === 'zh' ? lesson.successZh : lesson.successEn)
      : session.tutorial.restrictionObserved && lesson.allowedInstructionZh
        ? (language === 'zh' ? lesson.allowedInstructionZh : lesson.allowedInstructionEn)
        : (language === 'zh' ? lesson.instructionZh : lesson.instructionEn), 24, top + 103, w - 48, 13, THEME.muted, 3);
    else {
      const error = isOnline() ? online.error || session.error : session.error;
      const clockVisible = !isOnline() && session.settings.turnTimerEnabled && session.replayIndex === null && !snapshot.gameOver;
      const clockLabel = clockVisible ? session.clock.running
        ? `${label('clockRemaining')} ${Math.ceil(session.clock.remaining() / 1000)}s` : label('clockPaused') : '';
      const help = session.replayIndex !== null ? label(visibleInspection() ? 'inspectionMarks' : 'replayHelp')
        : isOnline() && online.room?.status === 'waiting' ? label('roomHelp')
        : isOnline() && online.room?.status === 'closed' ? label('roomClosed')
        : isOnline() && snapshot.gameOver ? `${label(snapshot.winner === 'DRAW' ? 'draw' : snapshot.winner === 'BLACK' ? 'black' : 'white')}${snapshot.winner === 'DRAW' ? '' : ` ${label('wins')}`}`
        : snapshot.gameOver ? label('gameOverHelp')
        : session.modelLoading ? `${label('modelLoading')} ${session.modelLoading.progress}%`
        : session.busy ? label('thinking')
        : !isOnline() && session.paused ? label('pausedHelp')
        : selected ? label('selected') : isOnline() && online.room?.player !== snapshot.currentPlayer ? label('pending')
        : zoomFocus ? label('zoomedHelp') : baseLayout.spacing < 28 ? label('zoomHelp') : label('choose');
      const replayActionLabel = replaying && lastAction && !visibleInspection() && { move: 'played', skip: 'passed', resign: 'resigned' }[lastType];
      wrap(error ? errorText(error, t()) : emoteMessage || archiveNotice || (replayActionLabel ? `${label('lastAction')} · ${label(replayActionLabel)}` : help), 24, statusTop + (replaying ? 146 : 96), w - 48, compact ? 13 : 14,
        error ? '#ac554c' : THEME.muted, visibleInspection() ? 2 : 1);
      if ((lastAction || clockVisible) && !error && !visibleInspection() && !replaying) {
        const actionLabel = { move: 'played', skip: 'passed', resign: 'resigned' }[lastType];
        text([actionLabel ? `${label('lastAction')} · ${label(actionLabel)}` : '', clockLabel].filter(Boolean).join(' · '),
          w / 2, statusTop + 117, 12, THEME.muted, 'center');
      }
    }
    if (!lesson && session.replayIndex === null && !snapshot.gameOver) {
      button('skip', label('skip'), 24, statusTop + 48, 58, () => quickAction('skip'), { height: 36, font: 14, disabled: !canPlay() });
      button('hint', label('hint'), w - 82, statusTop + 48, 58, () => quickAction('hint'), { height: 36, font: 14, disabled: isOnline() || !canPlay() || !session.hintsRemaining });
      if (!isOnline() && session.settings.undoEnabled) button('undo', `${label('undo')} · ${session.undoRemaining}`, w / 2 - 49, statusTop + 48, 98,
        async () => { selected = null; const current = session; if (await current.undo()) {
          // Undo retains this local match's settings and its existing opt-in
          // ticket. Terminal capture checks the original signature and records
          // final retained actions plus actual undo usage; never mint a ticket
          // here for pre-consent, restored, replayed or imported games.
          inspection = null; analysis = null;
        } redraw(); },
        { height: 36, font: 14, disabled: !session.undoAvailable });
    }
    if (isOnline() && !lesson && session.replayIndex === null && online.room?.settings?.undoEnabled
      && online.room.actions.length && !online.room.undo?.pending
      && (!online.room.settings.botCount || online.room.actions.some(action => action.player === 'BLACK')))
      button('undo', `${label('undo')} · ${Math.max(0, online.room.settings.undoMaxCount - (online.room.undo?.usedCount || 0))}`,
        w / 2 - 49, statusTop + 48, 98, () => online.voteUndo(true),
        { height: 36, font: 14, disabled: online.sending || (online.room.undo?.usedCount || 0) >= online.room.settings.undoMaxCount });
    if (zoomFocus) { ctx.save(); ctx.beginPath(); ctx.rect(boardRect.x, boardRect.y, boardRect.width, boardRect.height); ctx.clip(); }
    drawBoard(ctx, snapshot, layout, { selected, hint: session.hintPoint, target: session.tutorial?.done ? null : target, blocked,
      lastMove: lastType === 'move' ? lastAction.point : null, effects: visibleInspection()?.effects,
      display: lesson ? { ...display, legalMoves: true, territories: true } : display });
    if (zoomFocus) { ctx.restore(); ctx.strokeStyle = THEME.border; ctx.lineWidth = 1; ctx.strokeRect(boardRect.x, boardRect.y, boardRect.width, boardRect.height); }
    if (session.saveError) {
      wrap(label('saveError'), 24, footer - 28, w - 48, 12, '#ac554c', 2);
      button('save-retry', label('retrySave'), 24, footer + 54, session.replayIndex !== null ? boxW : w - 48, () => { session.save(); redraw(); });
    }
    if (session.replayIndex !== null) {
      const replayWidth = (w - 72) / 3;
      button('replay-prev', label('previous'), 24, footer, replayWidth, () => { selected = null; void session.replay(session.replayIndex - 1); }, { disabled: session.busy || session.replayIndex <= 0 });
      button('replay-play', label(session.replayPlaying ? 'pauseReplay' : 'playReplay'), 36 + replayWidth, footer, replayWidth,
        () => session.replayPlaying ? session.pause() : session.startReplayPlayback(),
        { primary: true, disabled: !session.replayPlaying && (session.busy || session.replayIndex >= session.actions.length) });
      button('replay-next', label('next'), 48 + replayWidth * 2, footer, replayWidth, () => { selected = null; void session.replay(session.replayIndex + 1); }, { disabled: session.busy || session.replayIndex >= session.actions.length });
      button('exit-replay', label('backGame'), session.saveError ? 36 + boxW : secondaryX, footer + 54, session.saveError ? boxW : secondaryW, () => { selected = null; void session.exitReplay(); }, { primary: true });
    } else if (isOnline() && online.room?.status === 'closed') {
      button('room-closed', label('backHome'), 24, footer, w - 48, goHome, { primary: true });
    } else if (isOnline() && (!online.connected || online.error || online.pending)) {
      button('room-retry', label(online.sending ? 'thinking' : 'reconnect'), 24, footer, w - 48,
        async () => { await online.refresh(); if (online.pending) await online.retryPending(); await online.connect(); }, { primary: true, disabled: online.sending || session.busy });
    } else if (isOnline() && online.room?.status === 'waiting') {
      button('room-ready', label(online.room.ready[online.room.player] ? 'readyWaiting' : 'ready'), 24, footer, w - 48,
        () => online.command('ready'), { primary: true, disabled: online.sending || online.room.ready[online.room.player] });
    } else if (isOnline() && online.room?.undo?.pending) {
      const voted = online.room.undo.votes.includes(online.room.player);
      button('undo-accept', voted ? (language === 'en' ? 'Waiting for vote' : '等待对方确认') : (language === 'en' ? 'Accept undo' : '同意悔棋'),
        24, footer, boxW, () => online.voteUndo(true), { primary: true, disabled: voted || online.sending });
      button('undo-reject', language === 'en' ? 'Reject undo' : '拒绝悔棋', 32 + boxW, footer, boxW,
        () => online.voteUndo(false), { disabled: online.sending });
    } else if (isOnline() && snapshot.gameOver) {
      button('room-rematch', label(online.room.rematchVotes[online.room.player] ? 'readyWaiting' : 'rematch'), 24, footer, boxW,
        () => online.command('rematch'), { primary: true, disabled: online.sending || online.room.rematchVotes[online.room.player] });
      button('replay', label('replay'), 36 + boxW, footer, boxW, () => { selected = null; void session.replay(0); });
    } else if (isOnline() && !online.canPlay()) {
      button('room-wait', label(online.sending || session.busy ? 'thinking' : 'pending'), 24, footer, w - 48, () => {}, { disabled: true });
    } else if (lesson && session.tutorial.done) {
      button('lesson-next', label(session.tutorial.index === 4 ? 'finishLesson' : 'nextLesson'), 24, footer, w - 48,
        () => { selected = null; void session.tutorialLevel(session.tutorial.index + 1); }, { primary: true });
    } else if (!isOnline() && !snapshot.gameOver && (session.busy || session.paused || (!lesson && session.isAITurn()))) {
      button('pause-resume', label(session.busy ? 'cancel' : 'resume'), 24, footer, w - 48,
        () => session.busy ? session.pause() : session.resume(), { primary: true });
    } else if (snapshot.gameOver && !lesson) {
      button('new-game', label('again'), 24, footer, boxW, startNew, { primary: true });
      button('replay', label('replay'), 36 + boxW, footer, boxW, () => { selected = null; void session.replay(0); });
    } else {
      const passLesson = lesson?.objective.type === 'skip';
      const quarter = (w - 64) / 4;
      button('confirm', label(passLesson ? 'skip' : 'confirm'), lesson ? 24 : 32 + quarter, footer, lesson ? w - 48 : quarter * 2,
        () => { const p = selected; selected = null; void play(passLesson ? { type: 'skip' } : { type: 'move', point: p }); },
        { primary: true, disabled: !canPlay() || (!passLesson && !selected) });
    }
    if (session.replayIndex === null && !session.saveError) {
      if (lesson) {
        button('lesson-exit', label('exitLesson'), 24, footer + 54, (w - 56) / 2, exitLesson, { height: 44, font: 14 });
        button('game-menu', label('restartLesson'), 32 + (w - 56) / 2, footer + 54, (w - 56) / 2,
          () => { selected = null; void session.tutorialLevel(session.tutorial.index); }, { height: 44, font: 14, disabled: session.busy });
      } else {
        const quarter = (w - 64) / 4;
        // Special connection/replay/AI states retain their complete main controls.
        if (!snapshot.gameOver && online.room?.status !== 'closed') {
          for (const item of buttons) if (item.y === footer && item.width === w - 48) {
            item.x = 32 + quarter; item.width = quarter * 2;
            // Redraw the action within the central columns after changing its hit area.
          }
          const main = buttons.find(item => item.y === footer && item.x === 32 + quarter);
          if (main && main.id !== 'confirm') {
            ctx.fillStyle = THEME.background; ctx.fillRect(24, footer, w - 48, 48);
            const title = main.id === 'pause-resume' ? label(session.busy ? 'cancel' : 'resume') : main.id === 'room-ready' ? label(online.room.ready[online.room.player] ? 'readyWaiting' : 'ready') : main.id === 'room-retry' ? label('reconnect') : label('pending');
            buttons = buttons.filter(item => item !== main); button(main.id, title, main.x, main.y, main.width, main.action, { primary: true, disabled: main.disabled, font: 14 });
          }
          button('resign', label('resign'), 24, footer, quarter, () => quickAction('resign'), { danger: true, disabled: !canPlay(), font: 14 });
          button('new-game', language === 'en' ? 'Reset' : '重置', 40 + quarter * 3, footer, quarter, startNew, { disabled: isOnline(), font: 14 });
        }
        const emoteWidth = (w - 48 - 24) / 5;
        ONLINE_EMOTES.slice(emotePage * 4, emotePage * 4 + 4).forEach((emoji, index) => button(`emote-${index}`, emoji,
          24 + index * (emoteWidth + 6), footer + 56, emoteWidth, () => sendEmote(emoji),
          { height: 42, font: 24, disabled: isOnline() && !online.canEmote() }));
        button('emote-more', '···', 24 + 4 * (emoteWidth + 6), footer + 56, emoteWidth,
          () => { emotePage = (emotePage + 1) % Math.ceil(ONLINE_EMOTES.length / 4); redraw(); }, { height: 42, font: 22 });
        const emote = displayedEmote?.session === session && displayedEmote.settings === session.settings
          && (!isOnline() || displayedEmote.matchId === online.room?.matchId) ? displayedEmote : null;
        if (emote) text(`${playerLabel(emote.player)} ${emote.emoji}`, w / 2, boardRect.y + boardRect.height - 4, 20, THEME.ink, 'center');
      }
    }
    if (zoomAvailable) button('board-zoom', label(zoomFocus ? 'overviewShort' : 'zoomShort'), w - 81, boardRect.y - 4, 57,
      () => {
        zoomFocus = zoomFocus ? null : selected || session.hintPoint || target || (snapshot.boardShape === 'hexagon'
          ? [snapshot.gridSize - 1, snapshot.gridSize - 1] : [(snapshot.gridSize - 1) / 3, (snapshot.gridSize - 1) / 3]);
        selected = null; startTouch = null; redraw();
      }, { height: 36, font: 13, disabled: session.busy });
    drawCabinDock(cabinUi, scene === 'home' ? 'board' : cabin, { open: openCabin });
    if (cabin || scene === 'home') {
      const active = scene === 'home' ? 'board' : cabin;
      buttons = buttons.filter(item => item.id.startsWith('cabin-') || item.id === 'account-avatar');
      const area = drawCabinFrame(cabinUi, active, closeCabin);
      layout = null; boardRect = null; scrollArea = area; clipArea = area;
      ctx.save(); ctx.beginPath(); ctx.rect(area.x, area.y, area.width, area.height); ctx.clip();
      const content = { ...area, y: area.y - cabinScroll }; let contentHeight = area.height;
      if (active === 'board') contentHeight = drawBoardCabin(ui, content, { language, terminology,
        size: isOnline() ? online.room?.settings?.gridSize || size : size, online: isOnline(),
        canEditOnline: isOnline() && online.canEditSettings(),
        playerCount: isOnline() ? 2 : draftPlayerCount(),
        boardShape: isOnline() ? online.room?.settings?.boardShape || 'triangle' : boardShape,
        startingPointMode: isOnline() ? online.room?.settings?.startingPointMode || 'default' : startingPointMode,
        startPlayer, controllers: draftControllers(),
        playOptions: isOnline() ? normalizePlayOptions(online.room?.settings || {}) : playOptions,
        compatibleProfiles: controllerChoices(playerCount, draftSettings()),
        hasActions: Boolean(session.actions.length), rulesVersion: session.settings?.rulesVersion || 'territory-v3',
        contribution: contribution.enabled, contributionStatus: contribution.snapshot(),
        contributionAvailable: Boolean(contribution.origin && platform.contributionRequest) }, {
        language: toggleLanguage, terminology: () => { terminology = terminology === 'math' ? 'war' : 'math'; persistPreferences(); },
        playerLabel, players: changePlayerCount,
        controller: async player => { const generation = cabinGeneration, count = draftPlayerCount(); const choices = controllerMenuChoices(count);
          const valid = () => generation === cabinGeneration && count === draftPlayerCount() && scene === 'home' && !isOnline() && !session.hidden;
          const profile = choices[await platform.choose(choices.map(item => item === 'models' ? label('moreModels') : label(`controller-${item}`)),
            { previousLabel: label('previousPage'), nextLabel: label('nextPage'), isCurrent: valid })];
          if (!profile || !valid()) return;
          if (profile === 'models') { modelTarget = { kind: 'controller', player, returnCabin: true }; modelPage = 0; scene = 'models'; redraw(); return; }
          selectController(player, profile); },
        starter: player => { startPlayer = player; persistPreferences(); },
        shape: value => { if (isOnline()) return editOnlineSettings({ boardShape: value, startingPointMode: 'default', initialPositions: undefined });
          if (boardShape === value) return; boardShape = value; initialPositions = null;
          if (startingPointMode === 'custom') startingPointMode = 'default'; cabinGeneration++; persistPreferences(); },
        startingPoints: value => { if (value === 'custom') openStartingPoints(); else if (isOnline()) editOnlineSettings({ startingPointMode: value, initialPositions: undefined });
          else { startingPointMode = value; initialPositions = null; persistPreferences(); } },
        size: value => { if (isOnline()) return editOnlineSettings({ gridSize: value, startingPointMode: 'default', initialPositions: undefined });
          if (size !== value) { initialPositions = null; if (startingPointMode === 'custom') startingPointMode = 'default'; } size = value; persistPreferences(); }, option: (key, value) => {
          if (isOnline()) return editOnlineSettings({ [key]: value });
          playOptions = normalizePlayOptions({ ...playOptions, ...(key === 'hintEnabled' && value ? { hintMaxCount: Math.max(1, playOptions.hintMaxCount) } : {}), [key]: value });
          optionsConfigured = true; persistPreferences(); },
        contribution: toggleContribution,
        replay: () => { invalidateContribution(); closeCabin(false); scene = 'replay-hub'; redraw(); },
        library: () => { closeCabin(false); void openLibrary(); }, display: () => { closeCabin(false); openDisplay('game'); },
      });
      if (active === 'battle') contentHeight = drawBattleCabin(ui, content, { online: isOnline(), code: online.room?.code, enabled: online.enabled,
        roomProfiles: online.room?.playerProfiles, ownPlayer: online.room?.player,
        account: online.account, savedCode: online.savedCode, retryCode: roomRetryCode, busy: online.deleting || accountBusy, message: accountMessage }, {
        create: () => friendsMenu(null, 'create'), createAi: () => friendsMenu(null, 'create-ai'),
        join: () => friendsMenu(null, 'join'), resume: () => friendsMenu(null, 'resume'),
        retry: () => roomRetryCode && friendsMenu(roomRetryCode),
        account: () => accountAction('load'), link: () => accountAction('link'), delete: () => accountAction('delete'),
        editName: () => accountAction('name'), editAvatar: () => accountAction('avatar'), avatar: drawAvatar,
        importWechat: () => accountAction('wechat'), privacyContract: () => accountAction('privacyContract'),
        privacy: () => openReader('privacy', 'battle'),
        share: () => platform.share(online.sharePayload()), refresh: async () => { await online.refresh(); await online.connect(); },
        leave: () => quickAction('leave'),
      });
      if (active === 'guide') contentHeight = drawGuideCabin(ui, { canPractice: canPractice(), compactHeader: true, terminology }, {
        select: kind => openReader(kind, 'guide'),
      }, content) || area.height;
      if (active === 'tutorial') contentHeight = drawTutorialCabin(ui, content, TUTORIAL_LEVELS, completedLevels,
        { canPractice: !isOnline() && session.replayIndex === null }, { select: async index => {
          if (isOnline() || session.hidden) return;
          invalidateContribution(); closeCabin(false); invalidateContribution(); scene = 'game'; selected = null; await session.tutorialLevel(index); redraw();
        } });
      ctx.restore(); clipArea = null; scrollMax = Math.max(0, contentHeight - area.height);
      if (active === 'battle' && roomFeedbackPending) { roomFeedbackPending = false; cabinScroll = scrollMax; redraw(); }
      if (cabinScroll > scrollMax) { cabinScroll = scrollMax; redraw(); }
      if (scrollMax) { const track = area.height - 8, thumb = Math.max(24, track * area.height / contentHeight);
        rect(area.x + area.width + 5, area.y + 4 + (track - thumb) * cabinScroll / scrollMax, 3, thumb, 1, '#c4b28f'); }
    }
  }
  function clearEmote() {
    clearTimeout(emoteTimer); emoteTimer = null; displayedEmote = null; emoteMessage = '';
    observedEmoteError = online.emoteError;
  }
  function expireEmote() {
    clearTimeout(emoteTimer); emoteTimer = setTimeout(() => { displayedEmote = null; emoteMessage = ''; emoteTimer = null; if (!disposed) redraw(); }, 2000);
  }
  function showEmote(event) {
    displayedEmote = { ...event, session, settings: session.settings }; emoteMessage = ''; expireEmote(); redraw();
  }
  function emoteFailure(code) {
    const copy = { EMOTE_RATE_LIMIT: ['表情发送太快，稍等一下。', 'Too many reactions. Try again shortly.'],
      EMOTES_UNAVAILABLE: ['当前房间暂不支持表情。', 'Reactions are unavailable in this room.'],
      INVALID_EMOTE: ['请选择列表中的表情。', 'Choose a reaction from the list.'],
      NETWORK_ERROR: ['表情未发出，请稍后重试。', 'Reaction was not sent. Try again shortly.'] };
    emoteMessage = (copy[code] || copy.NETWORK_ERROR)[language === 'en' ? 1 : 0]; expireEmote(); redraw();
  }
  function syncEmoteError() {
    if (!online.emoteError) { observedEmoteError = null; return; }
    if (appVisible && session === online.game && online.emoteError !== observedEmoteError) {
      observedEmoteError = online.emoteError; emoteFailure(online.emoteError);
    }
  }
  async function sendEmote(emoji) {
    if (isOnline()) { const life = online.lifecycle, match = online.room?.matchId; observedEmoteError = null;
      try { await online.sendEmote(emoji); } catch (error) { if (appVisible && isOnline() && online.lifecycle === life && online.room?.matchId === match) emoteFailure(error.message); } }
    else showEmote({ emoji, player: session.snapshot.currentPlayer });
  }
  async function toggleContribution() {
    const generation = cabinGeneration;
    if (contribution.enabled) { contribution.setEnabled(false); contributionTicket = null; return; }
    const pending = contribution.snapshot().pending > 0;
    const available = Boolean(contribution.origin && platform.contributionRequest);
    if (pending && !available) {
      if (await platform.confirm(language === 'en' ? CLEAR_PENDING_NOTICE_EN : CLEAR_PENDING_NOTICE)
        && generation === cabinGeneration && scene === 'home' && appVisible) contribution.setEnabled(false);
      return;
    }
    if (!available || localSession.settings?.rulesVersion !== 'territory-v2' && !pending) return;
    if (await platform.confirm(language === 'en' ? CONTRIBUTION_NOTICE_EN : CONTRIBUTION_NOTICE) && generation === cabinGeneration && scene === 'home' && appVisible) contribution.setEnabled(true);
  }
  function toggleLanguage() {
    language = language === 'zh' ? 'en' : 'zh';
    try { platform.storage.set('lifeline-wx-language', language); } catch (_) {}
    redraw();
  }
  function openCabin(key) {
    if (session.hidden) return;
    helpGeneration++; friendsGeneration++; cabinGeneration++;
    pauseForPanel(); selected = null; cabinScroll = 0; accountMessage = '';
    scene = key === 'board' ? 'home' : 'game'; cabin = key === 'board' ? null : key; redraw();
  }
  function closeCabin(resume = true) {
    cabinGeneration++; cabin = null; scene = 'game'; selected = null;
    if (resume && !isOnline() && session.snapshot && session.replayIndex === null) session.resume();
    redraw();
  }
  async function exitLesson() {
    if (isOnline() || !session.tutorial) return;
    await session.exitTutorial(); selected = null; scene = 'game'; redraw();
  }
  async function accountAction(action, wechatProfile = null, profileError = null) {
    if (accountBusy || !online.enabled) return;
    const generation = cabinGeneration, hiddenAtStart = profileHideCount, accountUid = online.account?.uid,
      current = session, copy = ACCOUNT_COPY[language];
    let nativePicker = false;
    // Native album/camera can hide the game. That suspension must not discard
    // the photo the player just chose; actual navigation/account changes still cancel it.
    const valid = () => !disposed && (appVisible || nativePicker) && cabin === 'battle' && scene === 'game'
      && generation + (nativePicker ? profileHideCount - hiddenAtStart : 0) === cabinGeneration && session === current
      && (!accountUid || online.account?.uid === accountUid);
    accountBusy = true; accountMessage = ''; redraw();
    try {
      if (!await ensureOnlineConsent({ online, platform, language, isCurrent: valid }) || !valid()) return;
      if (action === 'load') {
        const account = await online.loadAccount();
        // A successful explicit refresh may retry a failed image once. Normal
        // redraws keep the failed entry, avoiding a request loop while offline.
        if (valid() && avatarEntry?.failed && avatarEntry.url === account?.avatarUrl) avatarEntry = null;
        // Already-authorized new users can reuse WeChat's profile without another prompt.
        // A custom game name/avatar is only replaced by the explicit import control.
        if (valid() && account?.displayName === '微信玩家' && !account.avatarUrl && account.profileSync !== 'pending') {
          const profile = await platform.getAuthorizedUserInfo?.();
          if (profile && valid()) await saveWechatProfile(profile, valid);
        }
      }
      if (action === 'privacyContract') await platform.openPrivacyContract?.();
      if (action === 'wechat') {
        if (profileError) throw profileError;
        const profile = wechatProfile || await platform.getAuthorizedUserInfo?.();
        if (!profile) throw new Error('WECHAT_PROFILE_UNAVAILABLE');
        if (valid()) await saveWechatProfile(profile, valid);
      }
      if (action === 'name' || action === 'avatar') {
        if (!online.account) await online.loadAccount();
        if (!valid()) return;
        if (action === 'name') {
          const value = await platform.input(label('nicknamePrompt'), nameDraft || online.account?.displayName || '');
          if (value == null || !valid()) return;
          nameDraft = String(value).trim();
          if ([...nameDraft].length < 1 || [...nameDraft].length > 24 || /[\u0000-\u001f\u007f]/u.test(nameDraft)) {
            accountMessage = label('nicknameInvalid'); return;
          }
          await online.saveProfile({ displayName: nameDraft }, { localFirst: true });
          if (valid()) { nameDraft = ''; accountMessage = label(online.account?.profileSync === 'pending' ? 'profileLocalSaved' : 'profileSaved'); }
        } else {
          nativePicker = true;
          const avatar = await platform.pickAvatar();
          if (!avatar || !valid()) return;
          await online.saveProfile({ avatarDataUrl: avatar.dataUrl }, { localFirst: true });
          if (valid()) accountMessage = label(online.account?.profileSync === 'pending' ? 'profileLocalSaved' : 'profileSaved');
        }
      }
      if (action === 'link') {
        if (online.account?.linkedWeb) { if (await platform.confirm(copy.confirmUnlink) && valid()) await online.unlinkWebAccount(); }
        else { const code = await platform.input(copy.instructions); if (code && valid() && await platform.confirm(copy.confirmLink) && valid()) await online.linkWebAccount(code); }
      }
      if (action === 'delete' && await platform.confirm(label('confirmDeleteAccount')) && valid()) {
        const deleted = await online.deleteAccount(); if (deleted && isOnline()) { session = localSession; }
        if (valid()) accountMessage = deleted ? label('accountDeleted') : errorText(online.error, t());
      }
    } catch (error) { if (valid()) accountMessage = /^(?:WECHAT_PRIVACY|WECHAT_PROFILE)/.test(error.message)
      ? label(error.message.startsWith('WECHAT_PRIVACY') ? 'profilePrivacyRequired' : 'wechatProfileUnavailable')
      : action === 'name' || action === 'avatar' || action === 'wechat'
      ? label(error.message === 'INVALID_DISPLAY_NAME' ? 'nicknameInvalid' : error.message === 'PROFILE_LOCAL_SAVE_FAILED' ? 'profileLocalFailed' : 'profileSaveFailed')
      : ACCOUNT_ERRORS[error.message]?.[language === 'en' ? 1 : 0] || copy.retry; }
    finally { accountBusy = false; redraw(); }
  }
  async function saveWechatProfile(profile, valid) {
    const uid = online.account?.uid, patch = { displayName: profile.displayName };
    let avatarFailed = false;
    if (profile.avatarUrl) {
      try { patch.avatarDataUrl = (await platform.importAvatar(profile.avatarUrl)).dataUrl; }
      catch (_) { avatarFailed = true; }
    }
    if (!valid() || online.account?.uid !== uid) return;
    await online.saveProfile(patch, { localFirst: true });
    if (valid()) accountMessage = [avatarFailed ? label('wechatAvatarImportFailed') : '',
      label(online.account?.profileSync === 'pending' ? 'profileLocalSaved' : 'profileSaved')].filter(Boolean).join('\n');
  }
  async function quickAction(action) {
    const current = session, epoch = current.epoch, life = online.lifecycle, room = online.room, generation = cabinGeneration;
    const valid = () => appVisible && session === current && session.epoch === epoch && generation === cabinGeneration
      && scene === 'game' && !session.hidden && (!isOnline() || (online.lifecycle === life
        && online.room?.code === room?.code && online.room?.matchId === room?.matchId
        && online.room?.seq === room?.seq && online.room?.stateHash === room?.stateHash));
    const release = current.holdClock();
    try {
      if (action === 'leave') {
        if (isOnline() && await platform.confirm(label('confirmLeave')) && valid()) {
          if (await online.command('leave')) { online.detach(); session = localSession; closeCabin(); }
        }
        return;
      }
      if (!canPlay() || cabin) return;
      if (action === 'resign' && !await platform.confirm(label('confirmResign'))) return;
      if (!valid() || !canPlay()) return;
      selected = null;
      if (action === 'hint') await session.hint();
      else await play({ type: action });
    } finally { release(); redraw(); }
  }
  function returnToBoard() {
    if (!appVisible || session.hidden) return;
    helpGeneration++; friendsGeneration++;
    cancelFileTask();
    // Returning closes the panel, not the match, replay or lesson. The online
    // pause policy preserves in-flight verification; local play stays paused.
    pauseForPanel(); clearBoardView(); closeCabin(false);
  }
  async function goHome() {
    cabin = null; cabinGeneration++;
    helpGeneration++; friendsGeneration++;
    cancelFileTask();
    if (isOnline()) { online.detach(); session = localSession; scene = 'home'; selected = null; redraw(); return; }
    selected = null; session.pause();
    if (session.tutorial) await session.exitTutorial();
    if (session.replayIndex !== null) await session.exitReplay();
    session.pause(); scene = 'home'; redraw();
  }
  async function startNew() {
    if (isOnline()) return;
    const compatible = controllerChoices(playerCount, draftSettings());
    if (Object.values(draftControllers()).some(profile => !compatible.includes(profile))) {
      await platform.message(label('incompatiblePlayers')); openCabin('board'); return;
    }
    const current = session, epoch = session.epoch, previousScene = scene, generation = cabinGeneration, releaseClock = current.holdClock();
    try {
      if (session.snapshot && !session.snapshot.gameOver && session.actions.length && !await platform.confirm(label('confirmNew'))) return;
      if (session !== current || session.epoch !== epoch || scene !== previousScene || generation !== cabinGeneration || session.hidden) return;
      if (session === localSession && session.snapshot && session.actions.length && !session.tutorial) archiveCurrent({ bestEffort: true });
      clearEmote(); invalidateContribution(); cabin = null; cabinGeneration++; selected = null; scene = 'game';
      await session.newGame(size, playerCount > 2 ? 'human' : mode, difficulty, playerCount,
        { startPlayer, controllers, playOptions, boardShape, startingPointMode, initialPositions }); beginContribution(); redraw();
    } finally { releaseClock(); }
  }
  function persistPreferences() {
    rememberPlayerDraft();
    try { savePreferences(platform.storage, { size, mode, difficulty, terminology, playerCount, boardShape, startingPointMode, initialPositions,
      ...(startPlayer !== 'BLACK' ? { startPlayer } : {}), ...(controllers ? { controllers } : {}),
      ...(Object.keys(playerDrafts).length > 1 ? { playerDrafts } : {}),
      ...(optionsConfigured ? { playOptions } : {}) }); }
    catch (_) { void platform.message(label('saveError')); }
    redraw();
  }
  function openStartingPoints() {
    if (session.hidden || (isOnline() && !online.canEditSettings())) return;
    if (isOnline()) {
      const settings = online.room.settings;
      size = settings.gridSize; playerCount = 2; boardShape = settings.boardShape || 'triangle';
      startingPointMode = settings.startingPointMode || 'default'; initialPositions = settings.initialPositions || null;
    }
    pauseForPanel(); cabin = null; cabinGeneration++; startSeat = playerIds(playerCount)[0]; startPoint = null;
    try { startDraft = resolveInitialPositions(size, playerCount, initialPositions, boardShape); }
    catch (_) { startDraft = resolveInitialPositions(size, playerCount, null, boardShape); }
    scene = 'starts'; clearBoardView(); redraw();
  }
  async function configureDuration() {
    const epoch = localSession.epoch;
    const input = await platform.input(label('durationPrompt'), String(playOptions.turnTimeLimitSeconds));
    if (scene !== 'options' || localSession.hidden || localSession.epoch !== epoch || input == null) return;
    if (!/^\d+$/.test(String(input).trim()) || Number(input) < 15 || Number(input) > 200) {
      return platform.message(label('invalidDuration'));
    }
    playOptions = normalizePlayOptions({ ...playOptions, turnTimeLimitSeconds: Number(input) });
    optionsConfigured = true; persistPreferences();
  }
  async function configureController(player) {
    const epoch = localSession.epoch, count = draftPlayerCount(), generation = cabinGeneration;
    const choices = controllerMenuChoices(count);
    const valid = () => scene === 'players' && !localSession.hidden && localSession.epoch === epoch && count === draftPlayerCount() && generation === cabinGeneration;
    const choice = choices[await platform.choose(choices.map(profile => profile === 'models' ? label('moreModels') : label(`controller-${profile}`)),
      { previousLabel: label('previousPage'), nextLabel: label('nextPage'), isCurrent: valid })];
    if (!choice || !valid()) return;
    if (choice === 'models') { modelTarget = { kind: 'controller', player }; modelPage = 0; scene = 'models'; redraw(); return; }
    selectController(player, choice);
  }
  function pauseForPanel() {
    // Friend games have no local AI/clock to pause. Keep an incoming room's
    // verification alive while reading; cancelling it would lose that update.
    if (isOnline()) session.stopReplayPlayback();
    else session.pause();
  }
  function openDisplay(previous) { pauseForPanel(); displayReturn = previous; scene = 'display'; redraw(); }
  function visibleInspection() {
    return session.replayIndex !== null && inspection?.session === session && inspection.snapshot === session.snapshot
      && inspection.cursor === session.replayIndex && inspection.hash === session.replayStateHash ? inspection : null;
  }
  function replayMenu() {
    if (session.replayIndex === null || session.hidden) return;
    session.pause(); scene = 'replay-tools'; redraw();
  }
  async function branchReplay() {
    if (scene !== 'branch' || isOnline() || session.hidden) return;
    invalidateContribution();
    const current = session, pending = current.forkReplay({ keepPlayers: keepBranchPlayers, archive: payload => library.save(payload) });
    const epoch = current.epoch, loaded = await pending;
    if (loaded && session === current && current.epoch === epoch && scene === 'branch' && !current.hidden) {
      inspection = null; analysis = null; selected = null; scene = 'game';
    }
    redraw();
  }
  async function replayAction(choice) {
    if (session.replayIndex === null) return;
    session.pause();
    const current = session, epoch = session.epoch, sourceScene = scene;
    const valid = () => ['game', 'replay-tools'].includes(sourceScene) && !cabin && scene === sourceScene
      && session === current && session.epoch === epoch && !session.hidden && session.replayIndex !== null;
    if (!valid()) return;
    if (choice === 'branchReplay' && !isOnline() && !session.snapshot?.gameOver) { keepBranchPlayers = false; scene = 'branch'; }
    if (choice === 'displayOptions') openDisplay('replay-tools');
    if (choice === 'firstReplay' || choice === 'lastReplay') {
      scene = 'game'; await session.replay(choice === 'firstReplay' ? 0 : session.actions.length);
    }
    if (choice === 'analyzeReplay') {
      const key = `${session.replayStateHash}:${session.replayIndex}`;
      if (analysisPosition?.session !== session || analysisPosition.key !== key) {
        analysisResults = []; analysisPosition = { session, key };
      }
      scene = 'analysis'; void runAnalysis(analysisProfile);
    }
    if (choice === 'jumpReplay') {
      const input = await platform.input(`${label('jumpReplay')} · 0–${session.actions.length}`);
      if (!valid() || input === null || input === undefined) return;
      if (!/^\d+$/.test(String(input).trim()) || Number(input) > session.actions.length) return platform.message(label('invalidReplayStep'));
      scene = 'game'; await session.replay(Number(input));
    }
    if (choice === 'replaySpeed') {
      const index = await platform.choose(['0.5×', '1×', '2×']);
      if (valid() && index >= 0 && index < 3) { session.replayInterval = [2000, 1000, 500][index]; scene = 'game'; }
    }
    if (choice === 'inspectReplay') {
      scene = 'game';
      const pending = session.inspectReplay(), inspectEpoch = session.epoch;
      const result = await pending;
      if (!result || session !== current || scene !== 'game' || session.hidden || session.epoch !== inspectEpoch) return;
      const type = { player_move: 'move', player_skip: 'skip', player_resign: 'resign' }[result.action?.type] || result.action?.type;
      const lines = [label('inspectReadOnly'), result.action
        ? `${result.cursor} · ${playerLabel(result.actor)} · ${label({ move: 'played', skip: 'passed', resign: 'resigned' }[type])}${type === 'move' ? ` (${result.action.point.join(', ')})` : ''}`
        : label('initialPosition')];
      const effects = result.effects;
      inspection = { session, snapshot: session.snapshot, cursor: session.replayIndex, hash: result.stateHash, effects };
      redraw();
      for (const player of result.snapshot.players) {
        const delta = effects.territoryDelta[player] || 0;
        lines.push(`${playerLabel(player)} · ${label('score')} ${result.snapshot.territories[player].area} (${delta > 0 ? '+' : ''}${delta}) · ${label('addedLinks')} ${effects.addedEdgesByPlayer[player].length}`);
      }
      lines.push(`${label('clearedPoints')} ${effects.capturedPoints.length}`,
        `${label('legalPoints')} ${result.snapshot.legalMoves.length}`);
      if (effects.gameEnded) lines.push(label('result'));
      await platform.message(lines.join('\n'));
    }
    redraw();
  }
  async function runAnalysis(profile) {
    if (scene !== 'analysis' || session.replayIndex === null || session.hidden) return;
    if (!controllerChoices(session.settings.playerCount, session.settings).includes(profile) || profile === 'human')
      profile = defaultAIProfile(session.settings.playerCount, session.settings);
    const current = session;
    analysisProfile = profile; analysis = null;
    const pending = current.analyzeReplay(profile), epoch = current.epoch;
    redraw();
    const result = await pending;
    if (scene !== 'analysis' || session !== current || current.hidden || current.epoch !== epoch || !result) return;
    analysis = result;
    analysisResults = [...analysisResults.filter(item => item.profile !== profile), result].slice(-6);
    redraw();
  }
  async function configureAnalysis() {
    session.pause(); const current = session, epoch = session.epoch;
    const choices = controllerMenuChoices(session.settings.playerCount, session.settings).filter(profile => profile !== 'human');
    const valid = () => scene === 'analysis' && session === current && session.epoch === epoch && !session.hidden;
    const choice = choices[await platform.choose(choices.map(profile => profile === 'models' ? label('moreModels') : label(`controller-${profile}`)),
      { previousLabel: label('previousPage'), nextLabel: label('nextPage'), isCurrent: valid })];
    if (!choice || !valid()) return;
    if (choice === 'models') { modelTarget = { kind: 'analysis' }; modelPage = 0; scene = 'models'; redraw(); }
    else await runAnalysis(choice);
  }
  function refreshLibrary() {
    const record = library.read();
    libraryEntries = record.entries;
    redraw();
    return record;
  }
  async function openLibrary() {
    localSession.pause(); selected = null; scene = 'library';
    const record = refreshLibrary();
    if (record.recovered) await platform.message(label('libraryRecovered'));
  }
  function archiveCurrent({ bestEffort = false } = {}) {
    if (!localSession.snapshot || localSession.tutorial) return;
    try {
      const id = library.save(localSession.capture()); archiveNotice = ''; return id;
    } catch (error) {
      if (!bestEffort) throw error;
      // Archiving is optional; a storage problem must not lock a player out of
      // the next match. The library itself preserves its last readable index.
      archiveNotice = label('archiveSkipped'); redraw(); return null;
    }
  }
  function cancelFileTask() {
    fileGeneration++;
    if (fileBusy) scheduler.cancel();
    fileBusy = false;
  }
  async function fileTask(run) {
    if (fileBusy || scene !== 'library' || localSession.hidden) return;
    invalidateContribution(); localSession.pause();
    const generation = ++fileGeneration, epoch = localSession.epoch;
    const current = () => generation === fileGeneration && scene === 'library'
      && localSession.epoch === epoch && !localSession.hidden;
    const check = () => { if (!current()) throw new Error('CANCELLED'); };
    const compute = async (kind, payload) => {
      check();
      const result = await scheduler.request(kind, payload, localSession.context(), 0);
      check(); return result;
    };
    fileBusy = true; redraw();
    try { await run({ check, compute }); }
    catch (error) { if (current() && error.message !== 'CANCELLED') await platform.message(errorText(error.message, t())); }
    finally { if (generation === fileGeneration) { fileBusy = false; redraw(); } }
  }
  async function importReplay() {
    return fileTask(async ({ check, compute }) => {
      if (!platform.readClipboard) throw new Error('CLIPBOARD_UNAVAILABLE');
      const source = await platform.readClipboard(); check();
      const result = await compute('IMPORT_REPLAY', { text: source });
      const payload = { session: createLocalGameSession(result.settings, result.actions), mode: 'human', difficulty: 'normal' };
      library.save(payload); refreshLibrary();
      await platform.message(label('replayImported'));
    });
  }
  async function exportReplay(payload) {
    return fileTask(async ({ check, compute }) => {
      if (!platform.writeClipboard) throw new Error('CLIPBOARD_UNAVAILABLE');
      const document = await compute('EXPORT_REPLAY', { settings: payload.session.settings, actions: payload.session.actions });
      check(); await platform.writeClipboard(JSON.stringify(document));
      check(); await platform.message(label('replayCopied'));
    });
  }
  async function savedGameMenu(entry) {
    const generation = fileGeneration;
    const choices = ['replay', 'continue', 'exportReplay', 'deleteReplay'];
    const choice = choices[await platform.choose(choices.map(label))];
    if (scene !== 'library' || generation !== fileGeneration || localSession.hidden || fileBusy) return;
    if (choice === 'exportReplay') return exportReplay(entry.payload);
    if (choice === 'deleteReplay') {
      if (await platform.confirm(label('confirmDeleteReplay')) && scene === 'library' && generation === fileGeneration) {
        library.remove(entry.id); refreshLibrary();
      }
      return;
    }
    if (!['replay', 'continue'].includes(choice)) return;
    return fileTask(async ({ check, compute }) => {
      const payload = entry.payload;
      // Validate in isolation before replacing or archiving the current game.
      await compute('STATE', { settings: payload.session.settings, actions: payload.session.actions });
      if (localSession.snapshot && localSession.actions.length && !await platform.confirm(label('confirmLoadReplay'))) return;
      check(); archiveCurrent({ bestEffort: true });
      if (localSession.replayIndex !== null) await localSession.exitReplay();
      selected = null; scene = 'game';
      const loaded = await localSession.load(payload.session.settings, payload.session.actions, { ...payload, paused: true, autoplay: false });
      if (loaded && choice === 'replay') await localSession.replay(0);
      redraw();
    });
  }
  async function friendsMenu(invitation = null, directKind = null) {
    if (!appVisible) return;
    if (!online.enabled) return platform.message(label('onlineOff'));
    const generation = ++friendsGeneration, current = session, epoch = current.epoch, previousScene = scene, cabinEpoch = cabinGeneration;
    const valid = () => appVisible && generation === friendsGeneration && session === current
      && current.epoch === epoch && scene === previousScene && cabinGeneration === cabinEpoch;
    const showRoomError = message => {
      scene = 'game'; cabin = 'battle'; cabinGeneration++; selected = null;
      accountMessage = message; roomFeedbackPending = true; redraw();
    };
    if (!await ensureOnlineConsent({ online, platform, language, isCurrent: valid }) || !valid()) return;
    const withAi = directKind === 'create-ai';
    let kind = invitation ? 'join' : withAi ? 'create' : directKind, value = invitation;
    if (directKind && !invitation) value = kind === 'resume' ? online.savedCode : kind === 'create' ? null : (await platform.input(label('roomCode')))?.trim().toUpperCase();
    if (!kind) {
      const choices = online.savedCode ? ['resumeRoom', 'createRoom', 'joinRoom'] : ['createRoom', 'joinRoom'];
      const i = await platform.choose(choices.map(label));
      if (!valid() || !choices[i]) return;
      kind = choices[i] === 'resumeRoom' ? 'resume' : choices[i] === 'createRoom' ? 'create' : 'join';
      value = kind === 'resume' ? online.savedCode : kind === 'create' ? null : (await platform.input(label('roomCode')))?.trim().toUpperCase();
    }
    if (!valid()) return;
    if (kind === 'create') value = onlineSettings({ rulesVersion: 'territory-v3',
      ...(withAi ? { botCount: 1 } : {}) }, null);
    if (kind === 'join' && value == null) return;
    if (kind !== 'create' && !/^[A-Z2-9]{8}$/.test(value || '')) {
      roomRetryCode = null; showRoomError(label('invalidRoomCode')); return;
    }
    accountMessage = ''; roomRetryCode = kind === 'create' ? null : value;
    invalidateContribution(); localSession.pause(); session = online.game; cabin = null; cabinGeneration++; scene = 'game'; selected = null; redraw();
    try { await online.enter(kind, value); if (generation === friendsGeneration) roomRetryCode = null; }
    catch (error) {
      if (generation === friendsGeneration && appVisible && isOnline() && scene === 'game') {
        online.detach(); session = localSession;
        showRoomError(error.message === 'NETWORK_ERROR' ? language === 'en'
          ? 'Cannot reach the server. Retry joining, or enter another room code.'
          : '暂时连不上服务器。请重试加入，或重新输入房间码。' : errorText(error.message, t()));
      }
    }
  }
  async function settingsMenu() {
    session.pause(); scene = 'setup'; redraw();
  }
  function canPractice() { return !isOnline() && !session.tutorial && session.replayIndex === null; }
  function openReader(kind, previous = 'guide') {
    if (session.hidden) return;
    readerCache.clear();
    helpGeneration++; pauseForPanel(); cabin = null; cabinGeneration++; readerReturn = previous;
    readerKind = kind; readerPage = 0; scene = 'reader'; redraw();
  }
  async function deleteAccount() {
    if (!online.enabled || online.deleting || session.hidden || scene !== 'reader' || readerKind !== 'privacy') return;
    const generation = helpGeneration, current = session, epoch = current.epoch;
    const confirmed = await platform.confirm(label('confirmDeleteAccount'));
    if (!confirmed || generation !== helpGeneration || current !== session || current.epoch !== epoch
      || session.hidden || scene !== 'reader' || readerKind !== 'privacy') return;
    const deleted = await online.deleteAccount();
    if (deleted && isOnline()) { session = localSession; readerReturn = 'battle'; }
    if (generation === helpGeneration && !session.hidden && scene === 'reader' && readerKind === 'privacy') {
      await platform.message(deleted ? label('accountDeleted') + (online.error ? `\n${label('deleteLocalCleanup')}` : '') : errorText(online.error, t()));
    }
    redraw();
  }
  async function gameMenu() {
    const generation = cabinGeneration;
    if (isOnline()) {
      const current = session, epoch = current.epoch, life = online.lifecycle, room = online.room;
      const valid = () => appVisible && !cabin && generation === cabinGeneration && scene === 'game' && session === current && current.epoch === epoch
        && online.lifecycle === life && room && online.room?.code === room.code && online.room.matchId === room.matchId
        && online.room.seq === room.seq && online.room.stateHash === room.stateHash;
      const choices = ['shareRoom', 'skip', 'resign', 'leaveRoom'];
      const i = await platform.choose(choices.map(label));
      if (!valid()) return;
      if (i === 0) platform.share(online.sharePayload());
      if (i === 1) { selected = null; await play({ type: 'skip' }); }
      if (i === 2 && canPlay() && await platform.confirm(label('confirmResign')) && valid()) await play({ type: 'resign' });
      if (i === 3 && await platform.confirm(label('confirmLeave')) && valid()) {
        if (await online.command('leave') && scene === 'game' && session === current && online.lifecycle === life) await goHome();
      }
      return;
    }
    const current = session, epoch = session.epoch, releaseClock = current.holdClock();
    const valid = () => !cabin && generation === cabinGeneration && session === current && scene === 'game' && session.epoch === epoch && !session.hidden;
    try {
      const options = ['skip', ...(session.settings.hintEnabled !== false ? ['hint'] : []), 'replay', 'library', 'again', 'resign'];
      const i = await platform.choose(options.map(key => key === 'hint' ? `${label(key)} · ${session.hintsRemaining}/${session.settings.hintMaxCount}` : label(key)));
      if (!valid()) return;
      const choice = options[i];
      if (choice === 'skip') { selected = null; await session.act({ type: 'skip' }); }
      if (choice === 'hint') { selected = null; await session.hint(); }
      if (choice === 'replay') { selected = null; await session.replay(0); }
      if (choice === 'library') await openLibrary();
      if (choice === 'again') await startNew();
      if (choice === 'resign' && session.canPlay() && await platform.confirm(label('confirmResign')) && valid()) await session.act({ type: 'resign', player: session.snapshot.currentPlayer });
    } finally { releaseClock(); }
  }
  function tap(x, y) {
    const hit = [...buttons].reverse().find((b) => x >= b.x && y >= b.y && x <= b.x + b.width && y <= b.y + b.height);
    if (hit) {
      if (hit.set) { if (!hit.disabled) hit.set(x); return; }
      if (!hit.disabled) Promise.resolve().then(hit.action).catch(error => platform.message(errorText(error.message, t())));
      return;
    }
    if (!currentView()) { redraw(); return; }
    if (scene === 'starts' && layout && inBoard(x, y)) {
      if (!zoomFocus && layout.spacing < 28) { zoomFocus = pointAtScreen(x, y, layout); startPoint = null; }
      else startPoint = hitPoint(x, y, layout);
      redraw(); return;
    }
    if (scene === 'game' && !cabin && layout && inBoard(x, y) && canPlay()) {
      if (!zoomFocus && layout.spacing < 28) { zoomFocus = pointAtScreen(x, y, layout); selected = null; }
      else selected = hitPoint(x, y, layout);
      redraw();
    }
  }
  platform.touchStart((event) => {
    const p = event.touches?.length === 1 && event.touches[0];
    startTouch = p && currentView() ? { x: p.clientX, y: p.clientY, moved: false, view,
      scroll: scrollArea && p.clientY >= scrollArea.y && p.clientY <= scrollArea.y + scrollArea.height ? cabinScroll : null,
      slider: sliders.find(item => !item.disabled && p.clientX >= item.x && p.clientX <= item.x + item.width && p.clientY >= item.y && p.clientY <= item.y + item.height),
      cabinEpoch: cabinGeneration, focus: zoomFocus && inBoard(p.clientX, p.clientY) ? [...zoomFocus] : null, layout } : null;
  });
  platform.touchMove((event) => {
    const p = event.touches?.length === 1 && event.touches[0], touch = startTouch;
    if (!p || !touch || !currentView() || touch.view !== view) { startTouch = null; return; }
    const dx = p.clientX - touch.x, dy = p.clientY - touch.y;
    if (Math.hypot(dx, dy) >= 14) touch.moved = true;
    if (touch.cabinEpoch !== cabinGeneration) { startTouch = null; return; }
    if (touch.slider && Math.abs(dx) > Math.abs(dy)) { touch.slider.set(p.clientX); touch.moved = true; return; }
    if (touch.moved && touch.scroll !== null) { cabinScroll = Math.max(0, Math.min(scrollMax, touch.scroll - dy)); redraw(); return; }
    if (touch.moved && touch.focus) { zoomFocus = panBoardFocus(touch.focus, dx, dy, touch.layout); selected = null; redraw(); }
  });
  platform.touchEnd((event) => {
    const p = event.changedTouches?.[0], touch = startTouch;
    startTouch = null;
    if (p && touch && !event.touches?.length && !touch.moved && currentView() && touch.view === view
      && Math.hypot(p.clientX - touch.x, p.clientY - touch.y) < 14) tap(p.clientX, p.clientY);
  });
  platform.touchCancel(() => { startTouch = null; });
  platform.onHide(() => { clearEmote(); clearUserInfoControl(); appVisible = false; contribution.setForeground(false); visibilityGeneration++; profileHideCount++; friendsGeneration++; helpGeneration++; cabinGeneration++; cancelFileTask(); clearBoardView(); isOnline() ? online.background() : session.hide(); });
  platform.onShow((options = {}) => {
    if (disposed) return;
    appVisible = true;
    contribution.setForeground(true);
    const visibility = ++visibilityGeneration;
    const current = () => !disposed && appVisible && visibility === visibilityGeneration;
    const restoreForeground = () => {
      if (!current()) return;
      // Reveal the existing session without restarting its AI or paused clock.
      // An interrupted room entry may not have a room for foreground() yet.
      session.show();
      if (isOnline()) void online.foreground().catch(error => {
        if (current()) { online.error = error.message; redraw(); }
      });
      redraw();
    };
    if (options.query?.room) {
      void friendsMenu(options.query.room).catch(error => {
        if (current()) { accountMessage = errorText(error.message, t()); redraw(); }
      }).finally(() => {
        // Declining, invalid or expired invitations must not strand the game
        // hidden. A successful entry already owns its new foreground socket.
        if (current() && (session.hidden || (isOnline() && !online.active))) restoreForeground();
      });
      return;
    }
    restoreForeground();
  });
  const stopNetworkListener = platform.onNetworkStatusChange?.(status => {
    if (disposed) return;
    contribution.networkChanged(status);
    if (appVisible && isOnline()) void online.networkChanged(status);
  });
  platform.onResize(resize);
  platform.setupShare(() => isOnline() ? online.sharePayload() : { title: 'LIFELINE · 生命线' });
  resize();
  void localSession.restore().then(async restored => {
    if (disposed || !appVisible || session !== localSession || scene !== 'game' || cabin) return;
    // A damaged save remains untouched; retry is an explicit player action.
    if (!restored && !localSession.error && !localSession.snapshot) await localSession.newGame(size,
      playerCount > 2 ? 'human' : mode, difficulty, playerCount,
      { startPlayer, controllers, playOptions, boardShape, startingPointMode, initialPositions });
    if (!restored && localSession.snapshot && !localSession.actions.length) beginContribution();
    if (disposed || !appVisible || session !== localSession || scene !== 'game' || cabin) return;
    if (restored && localSession.snapshot && !localSession.error) localSession.resume();
    const invite = platform.launchOptions?.().query?.room;
    if (invite) void friendsMenu(invite);
    redraw();
  });
  // Returned only to the caller; preview tests can inspect the same UI geometry.
  return { get session() { return session; }, online, getButtons: () => buttons.map(({ action, ...rest }) => rest), getLayout: () => layout,
    getScene: () => scene, getCabin: () => scene === 'home' ? 'board' : cabin, tap, redraw, dispose: () => { clearEmote(); clearUserInfoControl(); if (typeof privacyAuthorization === 'function') privacyAuthorization(); else privacyAuthorization?.dispose?.(); disposed = true; stopNetworkListener?.(); guideImages.dispose(); appVisible = false; friendsGeneration++; helpGeneration++;
      readerCache.clear(); cancelFileTask(); contribution.dispose?.(); localSession.hide(); online.detach(); scheduler.cancel(); models.clear(); } };
}
