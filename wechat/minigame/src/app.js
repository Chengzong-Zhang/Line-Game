import { ComputeScheduler } from './scheduler.js';
import { SaveStore } from './storage.js';
import { GameSession } from './session.js';
import { TUTORIAL_LEVELS, TopologyRulesVersion, createLocalGameSession, resolveInitialPositions, resolveInitialRoots, randomInitialPositions, randomInitialRoots, requiresExplicitStartingPoints } from './core.js';
import { TEXT, errorText } from './i18n.js';
import { boardLayout, drawBoard, hitPoint, pointAtScreen, focusBoardLayout, panBoardFocus } from './board.js';
import { createLatestMoveTracker } from './latest-moves.js';
import { OnlineClient, ONLINE_EMOTES } from './online.js';
import { ReplayLibrary } from './library.js';
import { readPreferences, savePreferences } from './preferences.js';
import { BASIC_CONTROLLERS, playerIds, controllerChoices, normalControllerChoices, experimentControllerChoices, defaultAIProfile, presetControllers, controllersMode } from './controllers.js';
import { drawSetup, drawPlayers, drawPlayOptions, drawLessons, drawLibrary, libraryPageSize, drawModels, drawAnalysis } from './screens.js';
import { normalizePlayOptions } from './play-options.js';
import { withNewGameProtectionRule, withoutInactiveProtectionRule } from './state.js';
import { MODEL_CATALOG, MULTIPLAYER_AI_CATALOG, controllerLabel } from './model-catalog.js';
import { ModelAssets } from './model-assets.js';
import { readDisplay, saveDisplay, PLAYER_COLORS, PLAYER_LABEL_KEYS } from './display.js';
import { drawReplayPrimary, drawReplayTools, drawReplayTransport, drawBranch, drawDisplayOptions } from './replay-ui.js';
import { replayAnalysisChoices } from './analysis-options.js';
import { helpDocument, summarizeResult } from './help-content.js';
import { drawReader, drawResult, drawGuideCabin, createGuideImages } from './help-ui.js';
import { createReaderCache } from './reader-cache.js';
import { drawCabinDock, drawCabinFrame, drawBoardCabin, drawBattleCabin, drawTutorialCabin } from './cabins-ui.js';
import { ACCOUNT_COPY, ACCOUNT_ERRORS } from './account-ui.js';
import { TrainingContribution, contributionContext, CONTRIBUTION_NOTICE, CONTRIBUTION_NOTICE_EN,
  CLEAR_PENDING_NOTICE, CLEAR_PENDING_NOTICE_EN } from './training-contribution.js';
import { ensureOnlineConsent } from './online-consent.js';
import { roomSettingsFromBoard, roomPlayerFromController, roomControllerFromPlayer,
  normalizeRoomPlayerSetup } from '../../../web/web前端/OnlineRoomSettings.js';
import { LadderClient, ladderResultText } from './ladder.js';
import { rankedSetupInput } from './ranked-setup.js';
import { layoutTopologyBoard, hitTopologyVertex, drawTopologyBoard, layoutTopologyDraft, hitTopologyDraftPoint, drawTopologyDraft } from './topology-board.js';
import { buildSurfaceCells, createDepthRenderer, initialSurfacePitch } from './topology/TopologySurface3D.js';
import { createSoftwareSurfaceRenderer } from './topology-software-surface.js';
import { readBoardSelection, saveBoardSelection } from './board-selection.js';
import { renderBoardEditor, hitTestBoardEditor } from './board-editor-ui.js';
import { drawTurnOrderStrip } from './turn-order-ui.js';
import { topologyStartingRoots } from './topology/TopologyStartingPoints.js';
import { GameEngine } from './core.js';
import { createTopologySetup, addTopologyBoundaryVertex, extendTopologyBoundary, undoTopologyBoundary, closeTopologyBoundary, changeTopologyStarts,
  selectTopologyBoundaryOccurrence, toggleTopologySeamDirection, addSelectedTopologySeam,
  useTopologyPreset, generateTopologyBoard, reconcileTopologySetupPlayers, topologySetupResult } from './topology-setup.js';
import { createTopologyEditorLegacyDefinition, startTopologyBoundaryRing, deleteTopologyBoundaryRing,
  removeTopologySeam, setTopologyRootAtVertex, topologyEditorRootsByCoordinate } from './topology-setup.js';

const THEME = { background: '#f4ede1', ink: '#2a2118', muted: '#695749', border: '#dfd1bb', white: '#fff9ee' };

export function createApp(platform, config = {}) {
  const canvas = platform.canvas, ctx = canvas.getContext('2d');
  const latestMoveTracker = createLatestMoveTracker();
  let language = 'zh';
  try { if (platform.storage.get('lifeline-wx-language') === 'en') language = 'en'; } catch (_) { /* First run. */ }
  const preferences = readPreferences(platform.storage);
  const savedBoardSelection = readBoardSelection(platform.storage);
  let scene = 'game', cabin = null, cabinGeneration = 0, disposed = false, selected = null, actionMode = 'move', size = preferences.size, mode = preferences.mode, difficulty = preferences.difficulty;
  let startPlayer = preferences.startPlayer || 'BLACK', controllers = preferences.controllers || null;
  let turnOrder = preferences.turnOrder || null, invalidTurnOrder = Boolean(preferences.invalidTurnOrder);
  let playerCount = preferences.playerCount ?? (mode === 'three-human' ? 3 : 2), playersPage = 0;
  let boardShape = preferences.boardShape || (playerCount >= 4 ? 'hexagon' : 'triangle');
  let rootMode = playerCount === 2 ? preferences.rootMode || 'classic' : 'classic';
  let startingPointMode = preferences.startingPointMode || (requiresExplicitStartingPoints(playerCount, boardShape) ? 'random' : 'default'), initialPositions = preferences.initialPositions || null;
  let initialRoots = preferences.initialRoots || null;
  let startDraft = null, startDraftRoots = null, startPreviewRandom = false, preparedStarts = null;
  let startSeat = 'BLACK', startPoint = null, startSeatPage = 0;
  let scorePage = 0, scorePosition = null, resultPage = 0;
  let roomDraft = null;
  let topologySetup = savedBoardSelection?.kind === 'topology' ? createTopologySetup({ definition: savedBoardSelection.definition }) : null;
  let topologyDraftLayout = null, topologyDraftSelectedIndex = null, topologyControllers = savedBoardSelection?.controllers || {};
  let topologyExpanded = Boolean(savedBoardSelection?.expanded), topologyPreset = savedBoardSelection?.kind === 'topology' ? savedBoardSelection.preset : null;
  let editorSetup = null, editorSource = null, editorTool = 'root', editorPlayer = 'BLACK', editorRing = null;
  let editorLayout = null, editorMessage = '', editorPage = 0, editorMoveFrom = null, editorZoom = 1, editorPan = { x: 0, y: 0 };
  let numberEditing = null, numberHandle = null, numberToken = 0, orderDrag = null, orderArmed = null, orderRegions = [];
  // null means the player explicitly selected a normal board for the next game;
  // undefined follows the current saved game, including restored topology games.
  let nextTopologyChoice = savedBoardSelection?.kind === 'ordinary' ? null : savedBoardSelection?.kind === 'topology' ? 'selected' : undefined;
  const topologyPreviewCache = new WeakMap();
  let topologyPreviewLayout = null, topologyRandomCounter = 0;
  let surface3dCanvas = null, surface3dRenderer = null, surface3dData = null, surface3dRect = null, surface3dYaw = 0.45, surface3dPitch = -0.3, surface3dZoom = 1;
  let surface3dPaused = false, surface3dTimer = null, surface3dSoftware = false, surface3dDrawKey = null;
  const draftSettings = () => selectedTopologyDefinition()
    ? { gridSize: size, playerCount, turnOrder: currentTurnOrder(null), startPlayer, boardShape: 'custom', rootMode: 'classic', rulesVersion: 'surface-v1',
      boardDefinition: selectedTopologyDefinition(), boardHash: topologySetup?.boardHash || session.settings?.boardHash,
      topologyProtocolVersion: 'board-topology-v1' }
    : { gridSize: size, playerCount, turnOrder: currentTurnOrder(null), startPlayer, boardShape, rootMode, rulesVersion: 'territory-v3' };
  const startLayoutKey = settings => JSON.stringify([settings.gridSize, settings.playerCount, settings.boardShape,
    settings.rootMode || 'classic', settings.startPlayer || 'BLACK']);
  const startRandom = config.startRandom || Math.random;
  const playerDrafts = preferences.playerDrafts || {};
  const draftPlayerCount = () => playerCount;
  const draftControllers = () => draftSettings().rulesVersion === 'surface-v1'
    ? Object.fromEntries(playerIds(playerCount).map(player => [player, topologyControllers[player] || 'human']))
    : controllers || presetControllers(mode, difficulty, draftPlayerCount(), draftSettings());
  const controllerMenuChoices = (count, settings = draftSettings()) => {
    if (settings.rulesVersion === 'surface-v1') return ['human', 'topology-generic'];
    const ordinary = normalControllerChoices(count, settings);
    return experimentControllerChoices(count, settings).length ? [...ordinary, 'models'] : ordinary;
  };
  function rememberPlayerDraft() {
    playerDrafts[draftPlayerCount()] = { mode, startPlayer, ...(invalidTurnOrder || turnOrder != null ? { turnOrder: Array.isArray(turnOrder) ? [...turnOrder] : turnOrder } : {}),
      ...(invalidTurnOrder ? { invalidTurnOrder: true } : {}), controllers: controllers ? { ...controllers } : null,
      boardShape, rootMode, startingPointMode, initialPositions, initialRoots };
  }
  function changePlayerCount(count) {
    if (!Number.isInteger(count) || count < 2 || count > 15 || count === draftPlayerCount()) return;
    preparedStarts = null;
    rememberPlayerDraft(); cabinGeneration++;
    const oldOrder = currentTurnOrder();
    const saved = playerDrafts[count];
    playerCount = count; playersPage = 0;
    mode = saved?.mode || (count === 3 ? 'three-human' : count >= 4 ? 'human' : 'ai-white');
    startPlayer = saved?.startPlayer || 'BLACK'; controllers = saved?.controllers ? { ...saved.controllers } : null;
    turnOrder = [...oldOrder.filter(player => playerIds(count).includes(player)), ...playerIds(count).filter(player => !oldOrder.includes(player))];
    startPlayer = turnOrder[0]; invalidTurnOrder = invalidTurnOrder || Boolean(saved?.invalidTurnOrder);
    if (count === 2 && controllers) {
      const ai = Object.values(controllers).filter(profile => profile !== 'human');
      if (ai.length && ai.every(profile => profile === ai[0]))
        difficulty = ({ greedy: 'simple', 'minimax-2': 'simple', 'minimax-3': 'medium', 'minimax-4': 'hard' })[ai[0]] || difficulty;
    }
    boardShape = saved?.boardShape || (count >= 4 ? 'hexagon' : 'triangle');
    rootMode = count === 2 ? saved?.rootMode || 'classic' : 'classic';
    if (count === 2 && boardShape === 'hexagon') difficulty = 'simple';
    startingPointMode = saved?.startingPointMode
      || (requiresExplicitStartingPoints(count, boardShape) ? 'random' : 'default');
    if (requiresExplicitStartingPoints(count, boardShape) && startingPointMode === 'default') startingPointMode = 'random';
    initialPositions = saved?.initialPositions || null;
    initialRoots = saved?.initialRoots || null;
    if (initialPositions) try { initialPositions = resolveInitialPositions(size, count, initialPositions, boardShape); }
    catch (_) {
      initialPositions = null;
      if (startingPointMode === 'custom') startingPointMode
        = requiresExplicitStartingPoints(count, boardShape) ? 'random' : 'default';
    }
    if (initialRoots) try { initialRoots = resolveInitialRoots(size, count, initialRoots, boardShape, rootMode, initialPositions); }
    catch (_) { initialRoots = null; }
    if (nextTopologyChoice === 'selected' && count > 6) { nextTopologyChoice = null; topologyPreset = null; saveOrdinaryChoice(); }
    if (nextTopologyChoice === 'selected' && topologySetup?.compiled) {
      const result = reconcileTopologySetupPlayers(topologySetup, count);
      if (result.ok) { topologySetup = result.setup; persistTopologyChoice(); }
    }
    persistPreferences();
  }
  function selectController(player, profile) {
    const count = draftPlayerCount();
    if (!playerIds(count).includes(player) || !controllerChoices(count, draftSettings()).includes(profile)) return;
    controllers = { ...draftControllers(), [player]: profile };
    if (count === 2 && (profile === 'greedy' || /^minimax-[234]$/.test(profile)))
      difficulty = ({ greedy: 'simple', 'minimax-2': 'simple', 'minimax-3': 'medium', 'minimax-4': 'hard' })[profile];
    mode = count === 3 ? 'three-human' : controllersMode(controllers); persistPreferences();
  }
  let playOptions = normalizePlayOptions(preferences.playOptions), optionsConfigured = Boolean(preferences.playOptions);
  let buttons = [], layout = null, metrics = platform.metrics(), frame = null, startTouch = null;
  let baseLayout = null, boardRect = null, zoomFocus = null, view = null;
  let modelTarget = null, modelPage = 0, modelGroup = 'research';
  let analysis = null, analysisProfile = 'minimax-2', analysisResults = [], analysisPosition = null;
  let display = readDisplay(platform.storage), displayReturn = 'options';
  let inspection = null, keepBranchPlayers = false;
  let replaySeekDraft = null;
  let readerReturn = 'guide', readerKind = 'rules', readerPage = 0, helpGeneration = 0;
  const readerCache = createReaderCache(helpDocument);
  let friendsGeneration = 0, visibilityGeneration = 0, appVisible = true;
  let roomRetryCode = null, roomFeedbackPending = false;
  let roomClockTimer = null;
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
  const online = new OnlineClient(platform, config, scheduler, () => { syncRoomClock(); syncEmoteError(); redraw(); });
  const ladder = new LadderClient(online, redraw);
  online.game.models = models;
  let session = localSession;
  function syncRoomClock() {
    clearTimeout(roomClockTimer); roomClockTimer = null;
    if (appVisible && session === online.game && online.room?.status === 'playing' && online.room.turnDeadline)
      roomClockTimer = setTimeout(() => { roomClockTimer = null; redraw(); syncRoomClock(); }, 500);
  }
  online.onEmote = event => { if (appVisible && isOnline()) showEmote(event); };
  const contribution = new TrainingContribution({ storage: platform.storage, request: platform.contributionRequest, origin: config.apiBase, version: 4,
    createReplay: (settings, actions) => scheduler.request('EXPORT_REPLAY', { settings, actions }, localSession.context(), 2),
    canRun: () => appVisible && !localSession.busy && !isOnline()
      && Boolean(localSession.snapshot?.gameOver || localSession.paused), onChange: redraw });
  function invalidateContribution() {
    contribution.invalidateMatch(contributionTicket); contribution.invalidateMatch(pendingContribution);
    contributionTicket = pendingContribution = null;
  }
  function beginContribution() {
    contributionEpoch = localSession.settings;
    contributionTicket = contribution.beginMatch({ settings: localSession.settings, context: contributionContext(localSession, 4), source: 'local', actionCount: localSession.actions.length });
  }
  function checkContribution() {
    if (!contributionTicket || localSession.settings !== contributionEpoch || !localSession.snapshot?.gameOver || localSession.busy || localSession.tutorial || localSession.replayIndex !== null) return;
    const ticket = contributionTicket; contributionTicket = null;
    // Seal the finished trajectory before a reset can cancel the shared Worker.
    // Validation and upload run later while the game is idle.
    contribution.captureCompletedMatch(ticket, { settings: localSession.settings, actions: localSession.actions,
      context: contributionContext(localSession, 4), source: 'local', terminal: true });
  }
  const t = () => TEXT[language];
  const warTerms = { zh: { confirm: '确认部署', choose: '点选前线，再确认部署', selected: '已选位置，确认部署', hint: '参谋', played: '部署', resultScoreUnits: '控制的领土格点' }, en: { confirm: 'Deploy', choose: 'Choose a position, then deploy', selected: 'Position selected. Deploy to confirm.', hint: 'Advice', played: 'deployed', resultScoreUnits: 'Controlled territory points' } };
  const label = (key) => key.startsWith('controller-') ? controllerLabel(key.slice(11), t()) : terminology === 'war' && warTerms[language][key] || t()[key];
  const playerLabel = player => label(PLAYER_LABEL_KEYS[player] || 'draw');
  const isOnline = () => session === online.game;
  const roomControllers = settings => Object.fromEntries(playerIds(settings.playerCount).map(player =>
    [player, roomControllerFromPlayer(normalizeRoomPlayerSetup(settings)[player], settings)]));
  const settingsWithControllers = (settings, seats) => roomSettingsFromBoard(settings, Object.fromEntries(
    playerIds(settings.playerCount).map(player => [player, roomPlayerFromController(seats[player] || 'human', settings)])));
  function openRoomSetup(kind = 'settings') {
    if (session.hidden || kind === 'settings' && !online.room) return;
    if (kind === 'create' && invalidTurnOrder) { openCabin('board'); return; }
    const base = draftSettings(), order = currentTurnOrder(null);
    const settings = kind === 'create' ? withNewGameProtectionRule({ ...playOptions, ...base,
      startPlayer: order[0], turnOrder: order,
      ...(base.rulesVersion === 'surface-v1' ? { rootMode: 'classic', rootRulesVersion: 'root-v1' }
        : { startingPointMode, ...(initialPositions && startingPointMode !== 'random' ? { initialPositions } : {}),
          ...(initialRoots && startingPointMode !== 'random' ? { initialRoots } : {}),
          ...(rootMode !== 'classic' ? { rootMode, rootRulesVersion: 'root-v2' } : {}) }) })
      : JSON.parse(JSON.stringify(online.room.pendingSettings || online.room.settings));
    const seats = kind === 'create' ? { ...draftControllers() } : roomControllers(settings);
    const hostSeatAdded = kind === 'create' && Object.values(seats).every(profile => profile !== 'human');
    if (hostSeatAdded) seats.BLACK = 'human';
    roomDraft = { kind, settings, controllers: seats, hostSeatAdded };
    pauseForPanel(); friendsGeneration++; cabinGeneration++; cabinScroll = 0; cabin = null; scene = 'home'; redraw();
  }
  function editRoomDraft(overrides) {
    if (!roomDraft || isOnline() && !online.canEditSettings()) return;
    closeNumberInput();
    const previous = roomDraft.settings; let settings = { ...previous, ...overrides };
    if (startLayoutKey(settings) !== startLayoutKey(previous)) preparedStarts = null;
    if (settings.startPlayer !== previous.startPlayer && settings.startingPointMode === 'random') {
      delete settings.initialPositions; delete settings.initialRoots;
    }
    if (settings.playerCount !== previous.playerCount) {
      const oldOrder = currentTurnOrder(previous), players = playerIds(settings.playerCount);
      settings.turnOrder = [...oldOrder.filter(p => players.includes(p)), ...players.filter(p => !oldOrder.includes(p))];
      settings.startPlayer = settings.turnOrder[0];
      settings.boardShape = settings.playerCount >= 4 ? 'hexagon' : 'triangle';
      settings.startingPointMode = requiresExplicitStartingPoints(settings.playerCount, settings.boardShape) ? 'random' : 'default';
      delete settings.initialPositions; delete settings.initialRoots;
      if (settings.playerCount !== 2) { delete settings.rootMode; delete settings.rootRulesVersion; }
    }
    if (settings.gridSize !== previous.gridSize || settings.boardShape !== previous.boardShape) {
      delete settings.initialPositions; delete settings.initialRoots;
      if (settings.startingPointMode === 'custom') settings.startingPointMode
        = requiresExplicitStartingPoints(settings.playerCount, settings.boardShape) ? 'random' : 'default';
    }
    if (requiresExplicitStartingPoints(settings.playerCount, settings.boardShape)
      && (!settings.startingPointMode || settings.startingPointMode === 'default')) {
      settings.startingPointMode = 'random'; delete settings.initialPositions;
    }
    if (!playerIds(settings.playerCount).includes(settings.startPlayer)) settings.startPlayer = 'BLACK';
    settings = roomDraft.kind === 'create' ? withNewGameProtectionRule(settings) : withoutInactiveProtectionRule(settings);
    roomDraft.settings = settings;
    roomDraft.controllers = Object.fromEntries(playerIds(settings.playerCount).map(player => {
      const profile = roomDraft.controllers[player] || 'human';
      return [player, profile];
    }));
    cabinGeneration++; redraw();
  }
  async function submitRoomDraft() {
    if (!roomDraft || session.hidden || online.sending || roomDraft.settings.invalidTurnOrder) return;
    const draft = roomDraft, compatible = draft.settings.rulesVersion === 'surface-v1' ? ['human'] : controllerChoices(draft.settings);
    if (Object.values(draft.controllers).some(profile => !compatible.includes(profile))) return platform.message(label('incompatiblePlayers'));
    if (Object.values(draft.controllers).every(profile => profile !== 'human'))
      return platform.message(language === 'en' ? 'Keep at least one human seat for the host.' : '请至少保留一个真人席位给房主。');
    let settings;
    try {
      settings = settingsWithControllers(draft.settings, draft.controllers);
      settings = draft.kind === 'create' ? withNewGameProtectionRule(settings) : withoutInactiveProtectionRule(settings);
      if (requiresExplicitStartingPoints(settings.playerCount, settings.boardShape)
        && (!settings.startingPointMode || settings.startingPointMode === 'default')) settings.startingPointMode = 'random';
      if (settings.startingPointMode === 'random' && settings.rootMode && settings.rootMode !== 'classic') {
        delete settings.initialPositions;
        if (!settings.initialRoots) settings.initialRoots = randomInitialRoots(settings.gridSize, settings.playerCount, settings.rootMode, Math.random, settings.boardShape);
      } else if (settings.startingPointMode === 'random' && !settings.initialPositions) {
        settings.initialPositions = randomInitialPositions(settings.gridSize, settings.playerCount, Math.random, settings.boardShape);
      }
      if (settings.startingPointMode === 'default') { delete settings.initialPositions; delete settings.initialRoots; }
    } catch (error) { return platform.message(errorText(error.message, t())); }
    if (draft.kind === 'create') return friendsMenu(null, 'create', settings);
    if (await online.updateSettings(settings) && roomDraft === draft) { roomDraft = null; closeCabin(false); }
  }
  const canPlay = () => isOnline() ? online.canPlay() : session.canPlay();
  const failedRoomBot = () => isOnline() && online.room?.lastBotResult?.success === false
    && online.room.lastBotResult.matchId === online.room.matchId && online.room.lastBotResult.seq === online.room.seq
    && online.room.bots?.includes(online.room.currentPlayer);
  const play = async action => { const played = await (isOnline() ? online.act(action) : session.act(action)); if (played) actionMode = 'move'; return played; };
  const isTopologySnapshot = snapshot => snapshot?.rulesVersion === TopologyRulesVersion.SURFACE_V1 && Boolean(snapshot?.topology?.viewBoard);
  function selectedTopologyDefinition() {
    if (nextTopologyChoice === null) return null;
    if (nextTopologyChoice === 'selected' && topologySetup?.definition) return topologySetup.definition;
    return isTopologySnapshot(session.snapshot) ? session.settings?.boardDefinition : null;
  }
  const currentView = () => view?.session === session && view.epoch === session.epoch && view.snapshot === session.snapshot && view.scene === scene;
  const inBoard = (x, y) => boardRect && x >= boardRect.x && y >= boardRect.y
    && x <= boardRect.x + boardRect.width && y <= boardRect.y + boardRect.height;
  function clearBoardView() { selected = null; actionMode = 'move'; zoomFocus = null; startTouch = null; replaySeekDraft = null; }

  function topologyErrorText(result) {
    const errors = result?.errors ?? result?.setup?.errors ?? topologySetup?.errors ?? [];
    const first = Array.isArray(errors) ? errors[0] : null;
    const code = first?.code;
    const messages = {
      NON_LATTICE_EDGE: ['请沿格纸的直线连接两点。', 'Connect points along a straight grid line.'],
      OPEN_BOUNDARY: ['请把边界最后一段连接到起点，再闭合。', 'Connect the final edge to the first point before closing.'],
      DEGENERATE_BOUNDARY: ['请选择至少三个不共线的边界点。', 'Choose at least three non-collinear boundary points.'],
      EMPTY_INTERIOR: ['这个边界没有围出可用棋盘，请扩大轮廓。', 'The boundary has no playable area. Draw a larger outline.'],
      SELF_INTERSECTION: ['边界不能交叉，请撤销最后一段后重试。', 'The boundary crosses itself. Undo the last edge and try again.'],
      SELF_TOUCH: ['边界不能重复经过同一个点，请撤销后重试。', 'The boundary cannot revisit a point. Undo and try again.'],
      BOARD_NOT_READY: ['请先选择曲面、生成棋盘或闭合自定义边界。', 'Choose a surface, generate a board, or close your boundary first.'],
      SEAM_SELECTION_INCOMPLETE: ['请先选中两条未粘合的边。', 'Choose two unpaired boundary edges first.'],
      START_ROOTS_FULL: ['这方最多可以设置六个起点。', 'Each player can have at most six starting nodes.'],
      INVALID_STARTING_LAYOUT: ['这个起点布局不可用，请选择其他格点。', 'This starting layout is unavailable. Choose another grid point.'],
      NO_FEASIBLE_SURFACE: ['当前尺寸和人数没有可用的随机曲面，请调整后重试。', 'No random surface is supported for this size and player count. Change the setup and retry.'],
    };
    return messages[code]?.[language === 'en' ? 1 : 0]
      || (language === 'en' ? 'This board setup could not be used. Check the outline, seams and starting nodes, then try again.' : '当前棋盘设置无法使用，请检查边界、粘边和起点后重试。');
  }
  function adoptTopologySetup(result, { quiet = false } = {}) {
    const next = result?.setup ?? result;
    if (next?.contractVersion) topologySetup = next;
    if (result?.ok === false && !quiet) void platform.message(topologyErrorText(result));
    redraw();
    return result?.ok !== false;
  }
  function currentTurnOrder(settings = roomDraft?.settings) {
    const count = settings?.playerCount ?? playerCount, players = playerIds(count);
    const requested = settings ? settings.turnOrder : turnOrder;
    if (Array.isArray(requested) && requested.length === players.length && new Set(requested).size === players.length
      && requested.every(player => players.includes(player))) return [...requested];
    const first = settings ? settings.startPlayer || 'BLACK' : startPlayer, index = Math.max(0, players.indexOf(first));
    return [...players.slice(index), ...players.slice(0, index)];
  }
  function setTurnOrder(order) {
    const count = roomDraft?.settings.playerCount ?? playerCount, players = playerIds(count);
    if (!Array.isArray(order) || order.length !== players.length || new Set(order).size !== players.length
      || order.some(player => !players.includes(player))) return;
    if (roomDraft) { editRoomDraft({ turnOrder: [...order], startPlayer: order[0] }); delete roomDraft.settings.invalidTurnOrder; }
    else { turnOrder = [...order]; startPlayer = order[0]; invalidTurnOrder = false; preparedStarts = null; persistPreferences(); }
    redraw();
  }
  function saveOrdinaryChoice() {
    try { saveBoardSelection(platform.storage, { schemaVersion: 1, kind: 'ordinary', shape: boardShape, expanded: topologyExpanded }); }
    catch (_) { void platform.message(label('saveError')); return false; }
    return true;
  }
  function persistTopologyChoice() {
    if (!topologySetup?.compiled) return false;
    try { saveBoardSelection(platform.storage, { schemaVersion: 1, kind: 'topology', size, playerCount,
      preset: topologyPreset || 'custom', expanded: topologyExpanded, controllers: topologyControllers,
      definition: topologySetup.definition, boardHash: topologySetup.boardHash }); }
    catch (_) { void platform.message(label('saveError')); return false; }
    return true;
  }
  function toggleTopologyMenu() {
    closeNumberInput(); topologyExpanded = !topologyExpanded;
    if (!roomDraft) { if (nextTopologyChoice === 'selected') persistTopologyChoice(); else saveOrdinaryChoice(); }
    redraw();
  }
  function selectTopologyBoard(result, preset = 'custom') {
    if (!result?.ok || !result.setup?.compiled) { editorMessage = topologyErrorText(result); redraw(); return false; }
    const next = result.setup;
    if (roomDraft) {
      const order = currentTurnOrder(roomDraft.settings);
      roomDraft.settings = { ...roomDraft.settings, startPlayer: order[0], turnOrder: order,
        rulesVersion: 'surface-v1', boardShape: 'custom', rootMode: 'classic', rootRulesVersion: 'root-v1',
        boardDefinition: next.definition, boardHash: next.boardHash, topologyProtocolVersion: 'board-topology-v1' };
      delete roomDraft.settings.initialPositions; delete roomDraft.settings.initialRoots;
      roomDraft.controllers = Object.fromEntries(playerIds(roomDraft.settings.playerCount).map(player =>
        [player, roomDraft.controllers[player] === 'topology-generic' ? 'topology-generic' : 'human']));
      roomDraft.topologyPreset = preset; editorMessage = ''; redraw(); return true;
    }
    try { saveBoardSelection(platform.storage, { schemaVersion: 1, kind: 'topology', size, playerCount,
      preset, expanded: topologyExpanded, controllers: topologyControllers, definition: next.definition, boardHash: next.boardHash }); }
    catch (_) { editorMessage = label('saveError'); redraw(); return false; }
    topologySetup = next; topologyPreset = preset; nextTopologyChoice = 'selected'; preparedStarts = null;
    editorMessage = ''; persistPreferences(); return true;
  }
  function selectTopologyPreset(name) {
    if (isOnline() && !online.canEditSettings()) return;
    closeNumberInput();
    if (roomDraft) { if (roomDraft.settings.playerCount > 6) editRoomDraft({ playerCount: 6 }); }
    else if (playerCount > 6) changePlayerCount(6);
    const count = roomDraft?.settings.playerCount ?? playerCount, gridSize = roomDraft?.settings.gridSize ?? size;
    selectTopologyBoard(useTopologyPreset(createTopologySetup(), name, { gridSize, playerCount: count }), name);
  }
  function generateTopologyRandomBoard() {
    if (isOnline() && !online.canEditSettings()) return;
    closeNumberInput();
    if (roomDraft) { if (roomDraft.settings.playerCount > 6) editRoomDraft({ playerCount: 6 }); }
    else if (playerCount > 6) changePlayerCount(6);
    const count = roomDraft?.settings.playerCount ?? playerCount, gridSize = roomDraft?.settings.gridSize ?? size;
    const seed = `${Date.now()}-${++topologyRandomCounter}-${Math.floor(Math.random() * 0x100000000)}`;
    selectTopologyBoard(generateTopologyBoard(createTopologySetup(), { gridSize, playerCount: count }, seed), 'random');
  }
  function openBoardEditor({ blank = false } = {}) {
    if (session.hidden || (isOnline() && !online.canEditSettings())) return;
    closeNumberInput();
    const settings = roomDraft?.settings || { ...draftSettings(), initialPositions, initialRoots, startingPointMode, rootMode };
    const definition = !blank && (settings.boardDefinition || selectedTopologyDefinition());
    editorSource = { settings: JSON.parse(JSON.stringify(settings)), ordinary: !definition, room: roomDraft, generation: cabinGeneration };
    editorPlayer = playerIds(settings.playerCount)[0]; editorTool = definition ? 'root' : blank ? 'contour' : 'root';
    editorRing = null; editorPage = 0; editorMoveFrom = null; editorMessage = ''; editorZoom = 1; editorPan = { x: 0, y: 0 };
    if (definition) editorSetup = createTopologySetup({ definition });
    else if (settings.playerCount <= 6 && !blank) {
      try {
        let roots = settings.initialRoots;
        if (!roots) {
          let positions = settings.initialPositions;
          if (!positions) positions = requiresExplicitStartingPoints(settings.playerCount, settings.boardShape)
            ? randomInitialPositions(settings.gridSize, settings.playerCount, startRandom, settings.boardShape)
            : resolveInitialPositions(settings.gridSize, settings.playerCount, null, settings.boardShape);
          roots = Object.fromEntries(Object.entries(positions).map(([player, point]) => [player, [point]]));
        }
        editorSetup = createTopologySetup({ definition: createTopologyEditorLegacyDefinition({ ...settings, initialRoots: roots }) });
      } catch (error) { editorSetup = createTopologySetup(); editorMessage = errorText(error.message, t()); }
    } else editorSetup = createTopologySetup();
    if (settings.playerCount > 6) {
      const positions = settings.initialPositions || randomInitialPositions(settings.gridSize, settings.playerCount, startRandom, settings.boardShape);
      editorSource.ordinaryRoots = Object.fromEntries(Object.entries(positions).map(([player, point]) => [player, [point]]));
    }
    pauseForPanel(); cabin = null; cabinGeneration++; clearBoardView(); scene = 'board-editor'; redraw();
  }
  function adoptEditor(result) {
    if (result?.setup) editorSetup = result.setup;
    editorMessage = result?.ok === false ? topologyErrorText(result) : '';
    redraw();
  }
  function closeEditorContour() {
    const result = closeTopologyBoundary(editorSetup);
    if (result.ok && !Object.keys(result.setup.definition?.startingVertices || {}).length) {
      return adoptEditor(changeTopologyStarts(result.setup, { mode: 'default', playerCount: Math.min(6, editorSource.settings.playerCount) }));
    }
    adoptEditor(result);
  }
  function saveBoardEditor() {
    const source = editorSource;
    if (!source || source.room !== roomDraft) return;
    try {
      if (source.ordinary && !editorSetup.geometryChanged) {
        const roots = source.ordinaryRoots || topologyEditorRootsByCoordinate(editorSetup);
        const positions = Object.fromEntries(Object.entries(roots).map(([player, values]) => [player, values[0]]));
        const normalized = resolveInitialRoots(source.settings.gridSize, source.settings.playerCount, roots,
          source.settings.boardShape, source.settings.rootMode || 'classic', positions);
        if (roomDraft) editRoomDraft({ ...(source.settings.rootMode && source.settings.rootMode !== 'classic' ? { initialRoots: normalized } : { initialRoots: undefined }), initialPositions: positions, startingPointMode: 'custom' });
        else { initialRoots = normalized; initialPositions = positions; startingPointMode = 'custom'; preparedStarts = null; persistPreferences(); saveOrdinaryChoice(); }
      } else {
        if (source.settings.playerCount > 6) throw new Error('TOPOLOGY_PLAYER_LIMIT');
        const prepared = topologySetupResult(editorSetup);
        if (!prepared.ok) { editorMessage = topologyErrorText(prepared); redraw(); return; }
        if (!selectTopologyBoard({ ok: true, setup: editorSetup }, 'custom')) return;
      }
      editorSetup = editorSource = null; editorLayout = null; openCabin('board');
    } catch (error) {
      editorMessage = language === 'en' ? 'Keep a valid starting layout for every player before saving.' : '请为每方保留符合当前规则的起点，再保存配置。'; redraw();
    }
  }
  function closeNumberInput(commitCurrent = false) {
    if (commitCurrent && numberEditing?.commit) { numberEditing.commit(numberEditing.text); return; }
    numberToken++; numberHandle?.close(); numberHandle = null; numberEditing = null; platform.numberKeyboard?.close?.();
  }
  function editNumber(key) {
    closeNumberInput();
    const rules = { undoMaxCount: ['undo-count', 1, 100], turnTimeLimitSeconds: ['clock-duration', 15, 200], hintMaxCount: ['hint-count', 1, 10] };
    if (!rules[key] || !(scene === 'home' || cabin === 'board') || isOnline() && !online.canEditSettings()) return;
    const [id, min, max] = rules[key], token = ++numberToken, draft = roomDraft, generation = cabinGeneration;
    const settings = roomDraft?.settings || playOptions, original = settings[key];
    numberEditing = { id, text: String(original), error: '', key };
    const valid = () => numberToken === token && appVisible && !disposed && roomDraft === draft && cabinGeneration === generation
      && (scene === 'home' || scene === 'game' && cabin === 'board');
    const update = raw => {
      if (!valid()) return;
      const text = String(raw).slice(0, 4); numberEditing.text = text;
      numberEditing.error = /^\d+$/.test(text) && Number(text) >= min && Number(text) <= max ? ''
        : language === 'en' ? `${min}–${max}` : `请输入 ${min}–${max}`;
      redraw();
    };
    const commit = raw => {
      if (!valid()) return;
      update(raw);
      if (!numberEditing.error) {
        const value = Number(numberEditing.text);
        if (roomDraft) { roomDraft.settings = { ...roomDraft.settings, [key]: value }; redraw(); }
        else { playOptions = normalizePlayOptions({ ...playOptions, [key]: value }); optionsConfigured = true; persistPreferences(); }
      }
      closeNumberInput(); redraw();
    };
    numberEditing.commit = commit;
    if (!platform.numberKeyboard?.begin) { numberEditing.error = language === 'en' ? 'Keyboard unavailable' : '当前环境未提供数字键盘'; redraw(); return; }
    numberHandle = platform.numberKeyboard.begin({ value: String(original), onInput: update, onConfirm: commit,
      onBlur: () => { if (valid()) commit(numberEditing.text); } }); redraw();
  }

  function openSurface3D() {
    const snapshot = session.snapshot;
    if (!isTopologySnapshot(snapshot)) return;
    pauseForPanel();
    clearTimeout(surface3dTimer); surface3dTimer = null; surface3dPaused = false; surface3dSoftware = false;
    try {
      surface3dCanvas = platform.createWebGLCanvas?.(512, 512) || null;
      surface3dRenderer = surface3dCanvas && createDepthRenderer(surface3dCanvas);
      surface3dData = buildSurfaceCells(snapshot);
      surface3dPitch = initialSurfacePitch(snapshot.boardDefinition);
    } catch (_) { surface3dRenderer = null; }
    if (!surface3dRenderer) useSoftwareSurface();
    scene = 'topology-3d'; redraw();
  }
  function useSoftwareSurface() {
    surface3dRenderer?.destroy(); surface3dRenderer = null; surface3dSoftware = true;
    try {
      surface3dCanvas = platform.createSurfaceCanvas?.(320, 320) || null;
      surface3dRenderer = surface3dCanvas && createSoftwareSurfaceRenderer(surface3dCanvas);
      if (!surface3dData) surface3dData = buildSurfaceCells(session.snapshot);
    } catch (_) { surface3dRenderer = null; }
  }

  function clearUserInfoControl() {
    userInfoControl?.destroy(); userInfoControl = null; userInfoControlKey = null;
  }
  function syncUserInfoControl() {
    if (startTouch?.cabin === 'battle' && startTouch.scroll !== null) { userInfoControl?.hide(); return; }
    const target = !disposed && appVisible && scene === 'game' && cabin === 'battle' && !accountBusy && !online.deleting
      && online.account && buttons.find(item => item.id === 'profile-wechat' && !item.disabled);
    if (!target || typeof platform.createUserInfoControl !== 'function') { clearUserInfoControl(); return; }
    const uid = online.account.uid, generation = cabinGeneration, key = `${uid}:${generation}:${language}`;
    if (userInfoUnavailableKey === key) return;
    const bounds = { x: target.x, y: target.y, width: target.width, height: target.height };
    if (userInfoControlKey === key && userInfoControl) {
      if (userInfoControl.update({ bounds, language }) === false) { clearUserInfoControl(); userInfoUnavailableKey = key; }
      else userInfoControl?.show();
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
  function redraw() { if (frame === null) frame = platform.frame(() => {
    frame = null; draw(); syncUserInfoControl();
    if (scene === 'topology-3d' && surface3dRenderer && !surface3dPaused && appVisible && !disposed && surface3dTimer === null) {
      surface3dTimer = setTimeout(() => {
        surface3dTimer = null;
        if (scene === 'topology-3d' && !surface3dPaused && appVisible && !disposed) { surface3dYaw += 0.035; redraw(); }
      }, surface3dSoftware ? 100 : 32);
    }
  }); }
  function resize() {
    const next = platform.metrics();
    if (['width', 'height', 'dpr', 'top', 'bottom'].some(key => next[key] !== metrics[key])) clearBoardView();
    closeNumberInput(); orderDrag = null; orderArmed = null; startTouch = null; platform.resetInput?.(); metrics = next;
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
    const trackX = x + 50, trackWidth = width - 100;
    button(`${id}-decrease`, '−', x, y + 20, 42, () => change(Math.max(min, value - 1)),
      { height: 42, disabled: disabled || value <= min, font: 22 });
    button(`${id}-increase`, '+', x + width - 42, y + 20, 42, () => change(Math.min(max, value + 1)),
      { height: 42, disabled: disabled || value >= max, font: 22 });
    rect(trackX, y + 38, trackWidth, 5, 2, '#dfd1bb');
    const knob = trackX + 12 + (trackWidth - 24) * (value - min) / (max - min);
    rect(knob - 11, y + 29, 22, 22, 11, disabled ? '#bdb4a6' : '#2a2118');
    const item = { id, x: trackX, y: y + 20, width: trackWidth, height: 42, disabled,
      action: () => {}, set: point => change(Math.max(min, Math.min(max, Math.round(min + (point - trackX - 12) / (trackWidth - 24) * (max - min))))) };
    if (!clipArea || item.y >= clipArea.y && item.y + item.height <= clipArea.y + clipArea.height) { buttons.push(item); sliders.push(item); }
  }
  function numberField(field) {
    const { id, x, y, width, enabled, disabled, onToggle, onFocus } = field;
    const left = Math.round(width * 0.65), active = numberEditing?.id === id;
    const toggleId = { 'undo-count': 'undo-enabled', 'clock-duration': 'clock-enabled', 'hint-count': 'hint-enabled' }[id];
    button(toggleId, `${enabled ? '●' : '○'}  ${field.label}`, x, y, left - 8, onToggle,
      { height: 44, font: 12, primary: enabled, disabled });
    button(id, active ? `${numberEditing.text || ' '}│` : String(field.value), x + left, y, width - left,
      onFocus, { height: 44, font: 18, disabled });
    if (active && numberEditing.error) text(numberEditing.error, x + width, y + 47, 10, '#a43730', 'right');
  }
  function orderStrip(options) {
    const result = drawTurnOrderStrip({ text, rect }, options);
    orderRegions = result.regions.filter(item => !clipArea || item.y >= clipArea.y && item.y + item.height <= clipArea.y + clipArea.height)
      .map(item => ({ ...item, disabled: options.disabled, order: [...options.order] }));
    for (const item of orderRegions) buttons.push({ id: `order-${item.player}`, ...item, action: () => { orderArmed = item.player; redraw(); }, disabled: options.disabled });
    return result;
  }
  function seekBar(id, value, max, x, y, width, change, disabled) {
    const shown = replaySeekDraft ?? value, trackWidth = Math.max(1, width - 24);
    text(`${shown} / ${max}`, x + width / 2, y + 10, 11, THEME.muted, 'center');
    rect(x + 12, y + 29, trackWidth, 4, 2, THEME.border);
    const knob = x + 12 + trackWidth * shown / Math.max(1, max);
    rect(knob - 9, y + 22, 18, 18, 9, disabled ? '#bdb4a6' : THEME.ink);
    const item = { id, x, y, width, height: 44, disabled, action: () => {},
      set: point => { replaySeekDraft = Math.max(0, Math.min(max, Math.round((point - x - 12) / trackWidth * max))); redraw(); },
      commit: () => { const cursor = replaySeekDraft; replaySeekDraft = null; if (cursor !== null) change(cursor); } };
    buttons.push(item); sliders.push(item);
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
    text(label('title'), 62, middle, nativeLeft < 220 ? 20 : 23, THEME.ink, 'left', 'bold');
    if (!onStage) button('home', label('backToBoard'), 16, metrics.top + 8, 96, returnToBoard, { height: 40, font: 14 });
    return metrics.top + (onStage ? 8 : 64);
  }
  function draw() {
    if (!currentView()) {
      clearBoardView(); view = { session, epoch: session.epoch, snapshot: session.snapshot, scene };
    }
    const { width: w, height: h, dpr } = metrics;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.fillStyle = THEME.background; ctx.fillRect(0, 0, w, h);
    buttons = []; sliders = []; orderRegions = []; scrollArea = null; clipArea = null; layout = null; boardRect = null; baseLayout = null; const navTop = header(), top = navTop + ((scene === 'game' || scene === 'home') ? 52 : 0);
    const ui = { metrics, top, text, rect, wrap, button, slider, numberField, orderStrip, seekBar, label, ctx, language, guideImages };
    const cabinUi = { ...ui, top: navTop };
    if (scene === 'topology-3d') {
      text(surface3dData?.surface?.kind === 'atlas' ? (language === 'en' ? 'Unfolded atlas' : '展开面片图') : (language === 'en' ? '3D surface' : '三维曲面'), 24, top, 21, THEME.ink, 'left', 'bold');
      const side = Math.max(100, Math.min(w - 48, h - metrics.bottom - top - 273));
      surface3dRect = { x: 24, y: top + 25, width: side, height: side };
      if (surface3dRenderer && surface3dData) {
        try {
          const rotate = ([x, y, z]) => {
            const a = x * Math.cos(surface3dYaw) - z * Math.sin(surface3dYaw), b = x * Math.sin(surface3dYaw) + z * Math.cos(surface3dYaw);
            return [a, y * Math.cos(surface3dPitch) - b * Math.sin(surface3dPitch), y * Math.sin(surface3dPitch) + b * Math.cos(surface3dPitch)];
          };
          const renderSize = surface3dSoftware ? 320 : 512;
          const key = [surface3dYaw, surface3dPitch, surface3dZoom, renderSize, 1].join(':');
          if (surface3dDrawKey?.data !== surface3dData || surface3dDrawKey?.renderer !== surface3dRenderer || surface3dDrawKey?.key !== key) {
            surface3dRenderer.draw(surface3dData, renderSize, renderSize, rotate, surface3dZoom, {}, 1);
            surface3dDrawKey = { data: surface3dData, renderer: surface3dRenderer, key };
          }
          ctx.drawImage(surface3dCanvas, 24, top + 25, side, side);
        } catch (_) {
          if (!surface3dSoftware) { useSoftwareSurface(); redraw(); }
          else { surface3dRenderer?.destroy(); surface3dRenderer = null; }
        }
      }
      if (!surface3dRenderer) wrap(language === 'en' ? '3D preview is unavailable on this device. The atlas board remains playable.' : '此设备暂时无法显示三维预览，仍可使用展开棋盘继续对局。', 24, top + 45, w - 48, 14, THEME.muted, 4);
      const rowY = top + side + 38, half = (w - 56) / 2;
      button('surface-left', language === 'en' ? 'Rotate left' : '向左旋转', 24, rowY, half, () => { surface3dYaw -= 0.3; redraw(); }, { height: 40 });
      button('surface-right', language === 'en' ? 'Rotate right' : '向右旋转', 32 + half, rowY, half, () => { surface3dYaw += 0.3; redraw(); }, { height: 40 });
      button('surface-up', language === 'en' ? 'Tilt up' : '向上旋转', 24, rowY + 48, half, () => { surface3dPitch = Math.max(-1.5, surface3dPitch - 0.3); redraw(); }, { height: 40 });
      button('surface-down', language === 'en' ? 'Tilt down' : '向下旋转', 32 + half, rowY + 48, half, () => { surface3dPitch = Math.min(1.5, surface3dPitch + 0.3); redraw(); }, { height: 40 });
      button('surface-minus', '−', 24, rowY + 96, half, () => { surface3dZoom = Math.max(0.4, surface3dZoom / 1.2); redraw(); }, { height: 40 });
      button('surface-plus', '+', 32 + half, rowY + 96, half, () => { surface3dZoom = Math.min(2.5, surface3dZoom * 1.2); redraw(); }, { height: 40 });
      button('surface-pause', language === 'en' ? (surface3dPaused ? 'Auto rotate' : 'Pause rotation') : (surface3dPaused ? '自动旋转' : '暂停旋转'), 24, rowY + 144, w - 48,
        () => { surface3dPaused = !surface3dPaused; redraw(); }, { height: 40 });
      button('surface-back', language === 'en' ? 'Back to board' : '返回棋盘', 24, rowY + 192, w - 48, () => { clearTimeout(surface3dTimer); surface3dTimer = null; surface3dRenderer?.destroy(); surface3dRenderer = null; surface3dCanvas = null; surface3dData = null; scene = 'game'; redraw(); }, { height: 40 });
      return;
    }
    if (scene === 'starts') {
      const setup = roomDraft?.settings || { gridSize: size, playerCount, boardShape };
      const startSize = setup.gridSize, startCount = setup.playerCount, startShape = setup.boardShape;
      text(startPreviewRandom ? (language === 'en' ? 'Random starts preview' : '随机起点预览') : label('customStarts'), 24, top, 20, THEME.ink, 'left', 'bold');
      wrap(startPreviewRandom ? (language === 'en' ? 'Use these starts for the next game, or shuffle again.' : '下局使用这组起点，也可以重新随机。') : label('customStartsHelp'), 24, top + 32, w - 48, 13, THEME.muted, 2);
      const seats = playerIds(startCount), columns = 3, cell = (w - 64) / columns;
      const seatsPerPage = startCount > 6 && h - metrics.bottom - 108 - top < 293 ? 3 : 6;
      const seatPages = Math.ceil(seats.length / seatsPerPage); startSeatPage = Math.max(0, Math.min(seatPages - 1, startSeatPage));
      const visibleSeats = seats.slice(startSeatPage * seatsPerPage, (startSeatPage + 1) * seatsPerPage);
      visibleSeats.forEach((player, index) => button(`start-seat-${player}`, `${playerLabel(player)} ${startPreviewRandom ? startDraftRoots[player].map(point => `(${point.join(',')})`).join(' ') : `(${startDraft[player].join(',')})`}`,
        24 + index % columns * (cell + 8), top + 70 + Math.floor(index / columns) * 45, cell,
        () => { startSeat = player; startPoint = null; redraw(); }, { height: 39, font: 12, primary: startSeat === player }));
      const footer = h - metrics.bottom - 108, seatRows = Math.ceil(visibleSeats.length / columns), pageSpace = seatPages > 1 ? 44 : 0;
      if (seatPages > 1) {
        const pageY = top + 73 + seatRows * 45;
        button('start-seats-prev', label('previousPage'), 24, pageY, 84, () => { startSeatPage--; redraw(); }, { height: 36, font: 12, disabled: startSeatPage <= 0 });
        text(`${startSeatPage + 1} / ${seatPages}`, w / 2, pageY + 18, 13, THEME.muted, 'center');
        button('start-seats-next', label('nextPage'), w - 108, pageY, 84, () => { startSeatPage++; redraw(); }, { height: 36, font: 12, disabled: startSeatPage >= seatPages - 1 });
      }
      boardRect = { x: 30, y: top + 76 + seatRows * 45 + pageSpace,
        width: w - 60, height: Math.max(65, footer - top - 94 - seatRows * 45 - pageSpace) };
      baseLayout = boardLayout(startSize, boardRect, startCount, startShape);
      layout = zoomFocus ? focusBoardLayout(startSize, boardRect, zoomFocus, 44, startCount, startShape) : baseLayout;
      const extent = startShape === 'hexagon' ? 2 * startSize - 1 : startSize;
      const matrix = Array.from({ length: extent }, () => Array(extent).fill(0));
      seats.forEach((player, index) => { for (const [x, y] of startPreviewRandom ? startDraftRoots[player] : [startDraft[player]]) matrix[y][x] = 2 * index + 1; });
      if (zoomFocus) { ctx.save(); ctx.beginPath(); ctx.rect(boardRect.x, boardRect.y, boardRect.width, boardRect.height); ctx.clip(); }
      drawBoard(ctx, { gridSize: startSize, boardShape: startShape, players: seats, initialPositions: startDraft,
        ...(startPreviewRandom ? { roots: startDraftRoots } : {}), boardMatrix: matrix,
        territories: {}, edges: {}, legalMoves: [], gameOver: false }, layout,
        { selected: startPoint, target: startDraft[startSeat], display: { ...display, coordinates: true } });
      if (zoomFocus) ctx.restore();
      const duplicate = startPoint && seats.some(player => player !== startSeat && startDraft[player].every((v, i) => v === startPoint[i]));
      if (duplicate) text(label('startPointOccupied'), w / 2, footer - 12, 13, '#a43730', 'center');
      if (startPreviewRandom) button('starts-shuffle', language === 'en' ? 'Shuffle again' : '再随机一组', 24, footer, w - 48,
        () => { try { shuffleStartPreview(); } catch (error) { void platform.message(errorText(error.message, t())); } }, { height: 44, primary: true });
      else button('start-point-confirm', `${label('confirmStart')} · ${playerLabel(startSeat)}`, 24, footer, w - 48,
        () => { if (!startPoint || duplicate) return; startDraft = { ...startDraft, [startSeat]: [...startPoint] }; startPoint = null;
          startSeat = seats[(seats.indexOf(startSeat) + 1) % seats.length]; startSeatPage = Math.floor(seats.indexOf(startSeat) / seatsPerPage); redraw(); }, { height: 44, primary: true, disabled: !startPoint || duplicate });
      button('starts-save', label('saveStarts'), 24, footer + 54, (w - 60) / 2, async () => {
        if (startPreviewRandom) {
          const settings = roomDraft?.settings || { ...draftSettings(), startPlayer };
          const layout = (settings.rootMode || 'classic') === 'classic'
            ? { initialPositions: resolveInitialPositions(startSize, startCount, startDraft, startShape) }
            : { initialRoots: resolveInitialRoots(startSize, startCount, startDraftRoots, startShape, settings.rootMode) };
          if (roomDraft) editRoomDraft({ startingPointMode: 'random', initialPositions: undefined, initialRoots: undefined, ...layout });
          else { startingPointMode = 'random'; initialPositions = null; initialRoots = null; preparedStarts = { key: startLayoutKey(settings), layout }; persistPreferences(); }
          openCabin('board'); return;
        }
        const positions = resolveInitialPositions(startSize, startCount, startDraft, startShape);
        preparedStarts = null;
        if (roomDraft) editRoomDraft({ startingPointMode: 'custom', initialPositions: positions, initialRoots: undefined });
        else { initialPositions = positions; initialRoots = null; startingPointMode = 'custom'; persistPreferences(); }
        openCabin('board'); }, { height: 44, disabled: Boolean(startPoint) });
      button('starts-cancel', label('cancelStarts'), 36 + (w - 60) / 2, footer + 54, (w - 60) / 2, () => openCabin('board'), { height: 44 });
      if (baseLayout.spacing < 44) button('start-zoom', label(zoomFocus ? 'overviewShort' : 'zoomShort'), w - 81, boardRect.y - 12, 57,
        () => { zoomFocus = zoomFocus ? null : startPoint || startDraft[startSeat]; startPoint = null; redraw(); }, { height: 36, font: 12 });
      return;
    }
    if (scene === 'board-editor') {
      const source = editorSource?.settings, setup = editorSetup;
      if (!source || !setup) { openCabin('board'); return; }
      const en = language === 'en', seats = playerIds(source.playerCount), third = (w - 64) / 3;
      text(en ? 'Custom board & starting nodes' : '自定义棋盘与起点', 24, top, 20, THEME.ink, 'left', 'bold');
      const hint = editorMessage || setup.errors?.[0] && topologyErrorText({ errors: setup.errors })
        || (setup.warnings?.length ? (en ? 'Some seams or roots were removed. Check the highlighted layout before saving.' : '轮廓变化移除了部分接缝或起点，请检查并补齐。')
          : editorTool === 'root' ? (en ? 'Choose a colour, then tap a point. Your saved board changes only after Save.' : '选择颜色后点图放置起点；保存后仅更新下局配置。')
            : editorTool === 'seam' ? (en ? 'Tap two boundary edges to pair them; tap a paired edge to remove its seam.' : '点选两条边后添加接缝；点已有接缝可移除。')
              : (en ? 'Tap corners along grid lines; tap the first point to close a contour.' : '沿格线点选轮廓转角，点回起点闭合，可添加多个边界。'));
      wrap(hint, 24, top + 31, w - 48, 12, editorMessage || setup.errors?.length ? '#a43730' : THEME.muted, 2);
      ['contour', 'seam', 'root'].forEach((tool, i) => button(`editor-tool-${tool}`, en ? ['Contours', 'Seams', 'Starts'][i] : ['轮廓', '粘边', '起点'][i],
        24 + i * (third + 8), top + 66, third, () => { editorTool = tool; editorMoveFrom = null; editorMessage = ''; redraw(); },
        { height: 38, font: 13, primary: editorTool === tool, disabled: source.playerCount > 6 && tool !== 'root' }));
      let editorTop = top + 112;
      if (editorTool === 'root') {
        const visible = seats.slice(editorPage * 6, editorPage * 6 + 6), columns = Math.min(6, visible.length), tile = (w - 48 - (columns - 1) * 6) / columns;
        visible.forEach((player, i) => {
          const bx = 24 + i * (tile + 6);
          button(`editor-player-${player}`, `${playerLabel(player)}${editorPlayer === player ? ' ✓' : ''}`, bx, editorTop, tile,
            () => { editorPlayer = player; editorMoveFrom = null; redraw(); }, { height: 38, font: 11, primary: editorPlayer === player });
          rect(bx + 5, editorTop + 32, tile - 10, 3, 1, PLAYER_COLORS[player]);
        });
        editorTop += 46;
        if (seats.length > 6) {
          button('editor-players-prev', '‹', 24, editorTop, 54, () => { editorPage--; redraw(); }, { height: 36, disabled: editorPage === 0 });
          text(`${editorPage + 1}/${Math.ceil(seats.length / 6)}`, w / 2, editorTop + 15, 12, THEME.muted, 'center');
          button('editor-players-next', '›', w - 78, editorTop, 54, () => { editorPage++; redraw(); }, { height: 36, disabled: (editorPage + 1) * 6 >= seats.length });
          editorTop += 42;
        }
      }
      const footer = h - metrics.bottom - 50, toolbarY = footer - 97;
      boardRect = { x: 24, y: editorTop, width: w - 48, height: Math.max(48, toolbarY - editorTop - 9) };
      if (source.ordinaryRoots) {
        const roots = source.ordinaryRoots, ids = seats, extent = source.boardShape === 'hexagon' ? 2 * source.gridSize - 1 : source.gridSize;
        const matrix = Array.from({ length: extent }, () => Array(extent).fill(0));
        ids.forEach((player, i) => roots[player].forEach(([x, y]) => { matrix[y][x] = i * 2 + 1; }));
        layout = boardLayout(source.gridSize, boardRect, source.playerCount, source.boardShape);
        drawBoard(ctx, { gridSize: source.gridSize, boardShape: source.boardShape, players: ids, boardMatrix: matrix,
          initialPositions: Object.fromEntries(ids.map(player => [player, roots[player][0]])), roots,
          territories: {}, edges: {}, legalMoves: [], gameOver: false }, layout, { display: { ...display, coordinates: true } });
        editorLayout = null;
      } else {
        editorLayout = renderBoardEditor(ctx, boardRect, setup, { gridSize: source.gridSize, selectedRing: editorRing, zoom: editorZoom, pan: editorPan });
        button('editor-zoom', editorZoom === 1 ? (en ? 'Zoom' : '放大') : (en ? 'Overview' : '总览'),
          boardRect.x + boardRect.width - 62, boardRect.y + 2, 60,
          () => { editorZoom = editorZoom === 1 ? 4 : 1; editorPan = { x: 0, y: 0 }; redraw(); }, { height: 36, font: 12 });
      }
      if (editorTool === 'contour' || editorTool === 'select-ring') {
        const actionRow = (index, id, title, action, disabled = false) => button(id, title, 24 + index % 3 * (third + 8), toolbarY + Math.floor(index / 3) * 44,
          third, action, { height: 37, font: 12, disabled });
        actionRow(0, 'editor-new-boundary', en ? 'Add contour' : '新增边界', () => { adoptEditor(startTopologyBoundaryRing(setup)); editorTool = 'contour'; editorRing = null; }, !setup.draft?.closed);
        actionRow(1, 'editor-close-boundary', en ? 'Close contour' : '闭合边界', closeEditorContour, Boolean(setup.draft?.closed));
        actionRow(2, 'editor-undo', en ? 'Undo' : '撤销', () => adoptEditor(undoTopologyBoundary(setup)));
        actionRow(3, 'editor-select-boundary', en ? 'Select contour' : '选择轮廓', () => { editorTool = 'select-ring'; redraw(); });
        actionRow(4, 'editor-delete-boundary', en ? 'Delete contour' : '删除所选边界', () => { adoptEditor(deleteTopologyBoundaryRing(setup, editorRing)); editorRing = null; }, editorRing === null || !setup.draft?.closed);
        actionRow(5, 'editor-clear', en ? 'New drawing' : '重新绘制', () => { editorSetup = createTopologySetup(); editorTool = 'contour'; editorSource.ordinary = false; editorRing = null; redraw(); });
      } else if (editorTool === 'seam') {
        button('editor-seam-direction', en ? `Direction · ${setup.seamReverse ? 'reverse' : 'forward'}` : `方向 · ${setup.seamReverse ? '反向' : '正向'}`,
          24, toolbarY, (w - 56) / 2, () => { editorSetup = toggleTopologySeamDirection(setup); redraw(); }, { height: 38, font: 13 });
        button('editor-add-seam', en ? 'Pair selected edges' : '粘合所选两边', 32 + (w - 56) / 2, toolbarY, (w - 56) / 2,
          () => adoptEditor(addSelectedTopologySeam(setup)), { height: 38, font: 13, disabled: setup.selectedBoundaryOccurrenceIds?.length !== 2 });
      } else {
        const countText = source.ordinaryRoots ? seats.map(p => source.ordinaryRoots[p].length).join(' / ')
          : seats.map(p => topologyStartingRoots(setup.compiled || {})[p]?.length || 0).join(' / ');
        wrap(`${en ? 'Roots by colour' : '各方起点数'} · ${countText}`, 24, toolbarY + 14, w - 48, 13, THEME.muted, 2);
        if (source.ordinary) wrap(en ? 'Tap an existing root to select it, then tap its new position.' : '点击已有起点选中，再点新位置移动；普通棋盘保留原规则。', 24, toolbarY + 54, w - 48, 12, THEME.muted, 2);
        else button('editor-random-roots', en ? 'Random roots' : '随机起点', 24, toolbarY + 44, w - 48,
          () => adoptEditor(changeTopologyStarts(setup, { mode: 'random', playerCount: source.playerCount })), { height: 37, font: 13, disabled: !setup.compiled });
      }
      button('editor-save', en ? 'Save board settings' : '保存棋盘配置', 24, footer, (w - 56) / 2, saveBoardEditor, { height: 42, font: 13, primary: true });
      button('editor-cancel', en ? 'Cancel' : '取消', 32 + (w - 56) / 2, footer, (w - 56) / 2,
        () => { editorSetup = editorSource = null; editorLayout = null; openCabin('board'); }, { height: 42, font: 13 });
      return;
    }
    if (scene === 'setup') {
      drawSetup(ui, { size, mode, difficulty, controllers, playerCount, boardShape }, { start: startNew, players: () => { playersPage = 0; scene = 'players'; redraw(); }, change: (key, value) => {
        if (key === 'size') {
          const nextSize = Math.max(5, Math.min(15, value));
          if (nextSize !== size) {
            size = nextSize; initialPositions = null; initialRoots = null; preparedStarts = null;
            if (startingPointMode === 'custom') startingPointMode
              = requiresExplicitStartingPoints(playerCount, boardShape) ? 'random' : 'default';
          }
        }
        if (key === 'mode') {
          rememberPlayerDraft(); const nextCount = value === 'three-human' ? 3 : 2;
          if (nextCount !== playerCount) {
            playerCount = nextCount; initialPositions = null; initialRoots = null; preparedStarts = null;
            startingPointMode = requiresExplicitStartingPoints(playerCount, boardShape) ? 'random' : 'default';
          }
          mode = value; controllers = null; if (startPlayer !== 'BLACK') preparedStarts = null; startPlayer = 'BLACK';
        }
        if (key === 'difficulty') {
          difficulty = value;
          if (controllers && draftPlayerCount() === 2) controllers = Object.fromEntries(Object.entries(controllers).map(([player, profile]) =>
            [player, profile === 'greedy' || /^minimax-[234]$/.test(profile)
              ? boardShape === 'hexagon' ? 'greedy' : ({ simple: 'minimax-2', medium: 'minimax-3', hard: 'minimax-4' })[difficulty] : profile]));
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
        starter: player => { if (startPlayer !== player) preparedStarts = null; startPlayer = player; persistPreferences(); },
        swap: () => { if (draftPlayerCount() !== 2) return; const previous = controllers || presetControllers(mode, difficulty);
          controllers = { BLACK: previous.WHITE, WHITE: previous.BLACK }; mode = controllersMode(controllers); persistPreferences(); },
      }); return;
    }
    if (scene === 'display') {
      drawDisplayOptions(ui, display, {
        change: (key, value) => { if (session.hidden) return; display = saveDisplay(platform.storage, { ...display, [key]: value }); redraw(); },
        back: () => { if (displayReturn === 'board') openCabin('board'); else { scene = displayReturn; redraw(); } },
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
      const result = isOnline() && online.room?.rankedForfeit ? { forfeited: true, winner: null, reason: 'resignation',
        rows: session.snapshot.players.map(player => ({ player, area: session.snapshot.territories[player].area,
          resigned: player === online.room.player, winner: false })) } : summarizeResult(session.snapshot);
      if (!result) { scene = 'game'; redraw(); return; }
      drawResult(ui, { result, playerLabel, online: isOnline(), page: resultPage, ladderText: isOnline() ? ladderResultText(online.room?.ladderResult, online.room?.player, language) : "" }, {
        page: value => { resultPage = value; redraw(); },
        back: () => { scene = 'game'; redraw(); },
        replay: () => { scene = 'game'; selected = null; void session.replay(0); redraw(); },
        save: async () => { if (!isOnline() && !session.hidden) { archiveCurrent(); await platform.message(label('replaySaved')); } },
      }); return;
    }
    if (scene === 'replay-hub') {
      text(language === 'en' ? 'Replay workspace' : '复盘模式', 24, top + 10, 22, THEME.ink, 'left', 'bold');
      button('replay-current', label('replay'), 24, top + 46, w - 48, () => { invalidateContribution(); scene = 'game'; void session.replay(0); redraw(); }, { disabled: !session.actions.length, primary: true });
      button('library', label('library'), 24, top + 104, w - 48, openLibrary, { disabled: isOnline() });
      return;
    }
    if (scene === 'replay-tools') {
      drawReplayTools(ui, { cursor: session.replayIndex, total: session.actions.length, busy: session.busy,
        compactActions: session.snapshot?.players.length >= 4 && h - metrics.top - metrics.bottom < 620,
        canBranch: session.replayIndex !== null && !session.snapshot?.gameOver,
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
      const modelSettings = modelTarget?.kind === 'analysis' ? session.settings : roomDraft?.settings || draftSettings();
      const compatible = controllerChoices(modelSettings.playerCount, modelSettings);
      const multiplayer = modelSettings.playerCount > 2;
      const models = multiplayer
        ? MULTIPLAYER_AI_CATALOG.filter(model => !model.profile.startsWith('multiplayer-') && compatible.includes(model.profile))
          .map(model => ({ ...model, id: model.profile }))
        : MODEL_CATALOG.filter(model => compatible.includes(model.profile) && model.research === (modelGroup === 'research'));
      drawModels(ui, { models, multiplayer,
        page: modelPage, group: modelGroup, target: modelTarget?.kind === 'analysis' ? label('analyzeReplay') : playerLabel(modelTarget?.player) }, {
        select: profile => {
          if (session.hidden) return;
          if (modelTarget?.kind === 'analysis') { scene = 'analysis'; void runAnalysis(profile); }
          else if (modelTarget?.player && controllerChoices(modelSettings).includes(profile)) {
            if (roomDraft) roomDraft.controllers = { ...roomDraft.controllers, [modelTarget.player]: profile };
            else { controllers = { ...(controllers || presetControllers(mode, difficulty)), [modelTarget.player]: profile }; mode = controllersMode(controllers); persistPreferences(); }
            scene = modelTarget.returnCabin ? 'home' : 'players';
          }
          redraw();
        },
        page: delta => { modelPage += delta; redraw(); },
        group: value => { modelGroup = value; modelPage = 0; redraw(); },
        info: () => platform.message(label(multiplayer ? 'modelInfoMulti' : 'modelInfo')),
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
    const multiScore = snapshot.players.length >= 4, scoresPerPage = snapshot.players.length > 6 && compact ? 3 : 6;
    const scorePages = Math.ceil(snapshot.players.length / scoresPerPage), scoreRows = Math.ceil(Math.min(scoresPerPage, snapshot.players.length) / 3);
    const positionKey = `${session.epoch}:${session.replayIndex}:${snapshot.currentPlayer}:${snapshot.gameOver}`;
    if (scorePosition !== positionKey) { scorePage = Math.floor(snapshot.players.indexOf(snapshot.currentPlayer) / scoresPerPage); scorePosition = positionKey; }
    scorePage = Math.max(0, Math.min(scorePages - 1, scorePage));
    const scoreExtra = (multiScore ? (scoreRows - 1) * 48 : 0) + (scorePages > 1 ? 42 : 0);
    const replaying = session.replayIndex !== null;
    const compactReplayTools = replaying && compact && multiScore;
    const undoVoting = isOnline() && !session.tutorial && !replaying && Boolean(online.room?.undo?.pending);
    const boardOffset = (session.tutorial ? 160 : compactReplayTools ? 96 : replaying ? visibleInspection() ? 190 : 172 : 132) + scoreExtra, statusTop = top + scoreExtra;
    const footer = h - metrics.bottom - (replaying ? 154 : 102);
    boardRect = { x: 30, y: top + boardOffset, width: w - 60, height: Math.max(replaying ? 24 : 60, footer - top - boardOffset - (undoVoting ? 72 : 18)) };
    const topologyBoard = isTopologySnapshot(snapshot);
    if (topologyBoard) {
      zoomFocus = null;
      baseLayout = layoutTopologyBoard(snapshot, boardRect);
      layout = baseLayout;
    } else {
      baseLayout = boardLayout(snapshot.gridSize, boardRect, snapshot.players.length, snapshot.boardShape);
      layout = zoomFocus ? focusBoardLayout(snapshot.gridSize, boardRect, zoomFocus, 44, snapshot.players.length, snapshot.boardShape) : baseLayout;
      if (zoomFocus) zoomFocus = layout.focus;
    }
    const zoomAvailable = !topologyBoard && baseLayout.spacing < 44 && !session.saveError;
    const secondaryX = 24, secondaryW = w - 48;
    const ownSide = isOnline() ? online.room?.player : null;
    const roundWidth = 64, scoreGap = 6;
    const scoreWidth = multiScore ? (w - 44) / 3 : (w - 32 - roundWidth - snapshot.players.length * scoreGap) / snapshot.players.length;
    const scoreOrder = snapshot.players.length === 2 ? [snapshot.players[0], null, snapshot.players[1]] : multiScore ? snapshot.players.slice(scorePage * scoresPerPage, (scorePage + 1) * scoresPerPage) : [...snapshot.players, null];
    const rankedForfeit = isOnline() && online.room?.rankedForfeit && session.replayIndex === null;
    const roundNumber = Math.max(1, (session.replayIndex ?? session.actions.length) + (snapshot.gameOver || rankedForfeit ? 0 : 1));
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
      const activeTurn = !snapshot.gameOver && !rankedForfeit && snapshot.currentPlayer === player;
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
    if (scorePages > 1) {
      button('score-prev', label('previousPage'), 24, top + scoreRows * 48, 84, () => { scorePage--; redraw(); }, { height: 36, font: 12, disabled: scorePage <= 0 });
      text(`${scorePage + 1} / ${scorePages}`, w / 2, top + scoreRows * 48 + 18, 13, THEME.muted, 'center');
      button('score-next', label('nextPage'), w - 108, top + scoreRows * 48, 84, () => { scorePage++; redraw(); }, { height: 36, font: 12, disabled: scorePage >= scorePages - 1 });
    }
    let instruction = session.busy ? label('thinking') : snapshot.gameOver
      ? `${label('result')} · ${snapshot.winner === 'DRAW' ? label('draw') : `${playerLabel(snapshot.winner)} ${label('wins')}`}`
      : session.paused ? label('resume') : language === 'en' ? 'Your move' : '轮到你落子';
    const lesson = session.tutorial && TUTORIAL_LEVELS[session.tutorial.index];
    // Replay retains the full log; only the displayed prefix may identify the last action.
    const lastAction = !lesson && !session.busy ? session.actions[(session.replayIndex ?? session.actions.length) - 1] : null;
    const lastType = { player_move: 'move', player_skip: 'skip', player_resign: 'resign',
      player_root_relocate: 'root_relocate', player_root_add: 'root_add' }[lastAction?.type] || lastAction?.type;
    let target = null, blocked = null;
    if (lesson) {
      instruction = `${session.tutorial.index + 1}/5 · ${session.tutorial.done ? label('lessonDone') : (language === 'zh' ? lesson.titleZh : lesson.titleEn).replace(/^.*?[：:]\s*/, '')}`;
      target = lesson.objective.point;
      if (lesson.restriction && !session.tutorial.restrictionObserved) target = blocked = lesson.restriction.point;
    }
    if (session.replayIndex !== null) instruction = `${label('replay')} · ${session.replayIndex} / ${session.actions.length}`;
    if (isOnline() && session.replayIndex === null) instruction = `${online.room?.code || ''} · ${online.room?.status === 'waiting' ? label('roomWaiting') : online.room?.status === 'closed' ? label('roomClosed') : snapshot.gameOver ? label('result') : playerLabel(snapshot.currentPlayer)}`;
    if (isOnline() && online.room?.rankedAI && session.replayIndex === null)
      instruction = rankedForfeit ? (language === 'en' ? 'AI challenge forfeited' : 'AI 挑战已认输结算')
        : `${language === 'en' ? 'Ranked AI' : 'AI 排位'} · ${snapshot.players.length} ${language === 'en' ? 'seats' : '人'} · ${playerLabel(snapshot.currentPlayer)}`;
    const hasResult = (snapshot.gameOver || rankedForfeit) && !lesson && session.replayIndex === null;
    if (hasResult && !rankedForfeit) instruction = snapshot.winner === 'DRAW' ? label('draw') : `${playerLabel(snapshot.winner)} ${label('wins')}`;
    if (isOnline() || !session.settings.undoEnabled || replaying || lesson || snapshot.gameOver)
      text(instruction, session.replayIndex !== null || hasResult ? 24 : w / 2, statusTop + (compact && !lesson ? 59 : 65), 15, THEME.ink,
        session.replayIndex !== null || hasResult ? 'left' : 'center');
    if (session.replayIndex !== null) button('replay-options', label('replayTools'), w - 106, statusTop + (compact ? 44 : 47), 82, replayMenu, { height: 36, font: 13 });
    if (replaying && !compactReplayTools) drawReplayPrimary(ui, { busy: session.busy,
      canBranch: !snapshot.gameOver, canAnalyze: !snapshot.gameOver }, { select: replayAction }, statusTop + 84);
    if (hasResult) button('result-detail', label('resultDetails'), w - 106, statusTop + (compact ? 44 : 47), 82,
      () => { if (!session.hidden) { session.pause(); resultPage = 0; scene = 'result'; redraw(); } }, { height: 36, disabled: session.busy });
    if (lesson) wrap(session.tutorial.done ? (language === 'zh' ? lesson.successZh : lesson.successEn)
      : session.tutorial.restrictionObserved && lesson.allowedInstructionZh
        ? (language === 'zh' ? lesson.allowedInstructionZh : lesson.allowedInstructionEn)
        : (language === 'zh' ? lesson.instructionZh : lesson.instructionEn), 24, top + 103, w - 48, 13, THEME.muted, 3);
    else {
      const error = isOnline() ? online.error || session.error : session.error;
      const clockVisible = session.settings.turnTimerEnabled && session.replayIndex === null && !snapshot.gameOver
        && (!isOnline() || online.room?.status === 'playing');
      const clockLabel = clockVisible ? isOnline()
        ? online.room?.turnDeadline ? `${label('clockRemaining')} ${Math.max(0, Math.ceil(online.room.turnDeadline - Date.now() / 1000))}s` : label('clockPaused')
        : session.clock.running ? `${label('clockRemaining')} ${Math.ceil(session.clock.remaining() / 1000)}s` : label('clockPaused') : '';
      const help = session.replayIndex !== null ? label(visibleInspection() ? 'inspectionMarks' : 'replayHelp')
        : isOnline() && online.room?.status === 'waiting' ? label('roomHelp')
        : isOnline() && online.room?.status === 'closed' ? label('roomClosed')
        : rankedForfeit ? (language === 'en' ? 'Challenge settled; view results or play again.' : '挑战已结算，可查看结果或再来一局。')
        : isOnline() && snapshot.gameOver ? (snapshot.winner === 'DRAW' ? label('draw') : `${playerLabel(snapshot.winner)} ${label('wins')}`)
        : snapshot.gameOver ? label('gameOverHelp')
        : session.modelLoading ? `${label('modelLoading')} ${session.modelLoading.progress}%`
        : session.busy ? label('thinking')
        : !isOnline() && session.paused ? label('pausedHelp')
        : selected ? label('selected') : isOnline() && online.room?.player !== snapshot.currentPlayer ? label('pending')
        : zoomFocus ? label('zoomedHelp') : !topologyBoard && baseLayout.spacing < 28 ? label('zoomHelp') : label('choose');
      const replayActionLabel = replaying && lastAction && !visibleInspection() && { move: 'played', skip: 'passed', resign: 'resigned', root_relocate: 'rootMoved', root_add: 'rootAdded' }[lastType];
      const botResult = isOnline() && online.room?.lastBotResult?.matchId === online.room?.matchId ? online.room.lastBotResult : null;
      const botNotice = failedRoomBot() ? (language === 'en' ? 'AI could not move. Reconnect to retry.' : 'AI 暂未完成行动，请重新连接重试。')
        : botResult?.fallback ? (language === 'en' ? 'AI used a fallback legal action this turn.' : 'AI 本回合使用了备用合法行动。') : '';
      if (!compactReplayTools) wrap(error ? errorText(error, t()) : emoteMessage || botNotice || archiveNotice || (replayActionLabel ? `${label('lastAction')} · ${label(replayActionLabel)}` : help), 24, statusTop + (replaying ? 146 : 96), w - 48, compact ? 13 : 14,
        error ? '#ac554c' : THEME.muted, visibleInspection() ? 2 : 1);
      if ((lastAction || clockVisible) && !error && !visibleInspection() && !replaying) {
        const actionLabel = { move: 'played', skip: 'passed', resign: 'resigned' }[lastType];
        text([actionLabel ? `${label('lastAction')} · ${label(actionLabel)}` : '', clockLabel].filter(Boolean).join(' · '),
          w / 2, statusTop + 117, 12, THEME.muted, 'center');
      }
    }
    if (!lesson && session.replayIndex === null && !snapshot.gameOver && !rankedForfeit) {
      button('skip', label('skip'), 24, statusTop + 48, 58, () => quickAction('skip'), { height: 36, font: 14, disabled: !canPlay() });
      button('hint', label('hint'), w - 82, statusTop + 48, 58, () => quickAction('hint'), { height: 36, font: 14, disabled: !canPlay() || !session.hintsRemaining });
      const dynamicRootType = snapshot.rootMode === 'relocate' ? 'relocate' : snapshot.rootMode === 'add' ? 'add' : null;
      const rootAvailable = dynamicRootType && (snapshot.rootActionsRemaining?.[snapshot.currentPlayer]?.[dynamicRootType] || 0) > 0;
      if (dynamicRootType) button('root-action', `${actionMode === 'root' ? '✓ ' : ''}${language === 'en' ? (dynamicRootType === 'relocate' ? 'Relocate' : 'Add root') : (dynamicRootType === 'relocate' ? '迁移' : '增设')}`,
        !isOnline() && session.settings.undoEnabled ? w / 2 - 78 : w / 2 - 54, statusTop + 48, !isOnline() && session.settings.undoEnabled ? 74 : 108,
        () => { actionMode = actionMode === 'root' ? 'move' : 'root'; selected = null; redraw(); },
        { height: 36, font: 13, disabled: !canPlay() || !rootAvailable, primary: actionMode === 'root' });
      if (!isOnline() && session.settings.undoEnabled) button('undo', `${label('undo')} · ${session.undoRemaining}`, dynamicRootType ? w / 2 + 2 : w / 2 - 49, statusTop + 48, dynamicRootType ? 76 : 98,
        async () => { selected = null; const current = session; if (await current.undo()) {
          // Undo retains this local match's settings and its existing opt-in
          // ticket. Terminal capture checks the original signature and records
          // final retained actions plus actual undo usage; never mint a ticket
          // here for pre-consent, restored, replayed or imported games.
          inspection = null; analysis = null;
        } redraw(); },
        { height: 36, font: 14, disabled: !session.undoAvailable });
    }
    if (topologyBoard) {
      drawTopologyBoard(ctx, snapshot, layout, { selected, hint: session.hintPoint, target: session.tutorial?.done ? null : target,
        lastMove: lastType === 'move' ? lastAction?.vertexId : null,
        effects: visibleInspection()?.effects,
        display: lesson ? { ...display, legalMoves: true, territories: true } : display });
      button('topology-3d', '3D', boardRect.x + boardRect.width - 50, boardRect.y + 5, 44, openSurface3D, { height: 34, font: 12 });
    } else {
      if (zoomFocus) { ctx.save(); ctx.beginPath(); ctx.rect(boardRect.x, boardRect.y, boardRect.width, boardRect.height); ctx.clip(); }
      drawBoard(ctx, snapshot, layout, { selected, hint: session.hintPoint, target: session.tutorial?.done ? null : target, blocked,
        lastMoves: lesson ? {} : latestMoveTracker(session.settings, session.actions, snapshot, session.replayIndex ?? session.actions.length), effects: visibleInspection()?.effects,
        display: lesson ? { ...display, legalMoves: true, territories: true } : display });
      if (zoomFocus) { ctx.restore(); ctx.strokeStyle = THEME.border; ctx.lineWidth = 1; ctx.strokeRect(boardRect.x, boardRect.y, boardRect.width, boardRect.height); }
    }
    if (session.saveError) {
      wrap(label('saveError'), 24, footer - 28, w - 48, 12, '#ac554c', 2);
      button('save-retry', label('retrySave'), 24, footer + (replaying ? 106 : 54), session.replayIndex !== null ? boxW : w - 48, () => { session.save(); redraw(); });
    }
    if (session.replayIndex !== null) {
      drawReplayTransport(ui, { cursor: session.replayIndex, total: session.actions.length, busy: session.busy,
        playing: session.replayPlaying, interval: session.replayInterval }, {
        seek: cursor => { selected = null; session.pause(); void session.replay(cursor); },
        toggle: () => session.replayPlaying ? session.pause() : session.startReplayPlayback(),
        speed: () => replayAction('replaySpeed'),
      }, footer);
      button('exit-replay', label('backGame'), session.saveError ? 36 + boxW : secondaryX, footer + 106, session.saveError ? boxW : secondaryW, () => { selected = null; void session.exitReplay(); }, { primary: true });
    } else if (isOnline() && online.room?.status === 'closed') {
      button('room-closed', label('backHome'), 24, footer, w - 48, goHome, { primary: true });
    } else if (isOnline() && (!online.connected || online.error || online.pending || failedRoomBot())) {
      button('room-retry', label(online.sending ? 'thinking' : 'reconnect'), 24, footer, w - 48,
        async () => { await online.refresh(); if (online.pending) await online.retryPending(); await online.connect(); }, { primary: true, disabled: online.sending || session.busy });
    } else if (isOnline() && online.room?.status === 'waiting') {
      button('room-ready', label(online.room.ready[online.room.player] ? 'readyWaiting' : 'ready'), 24, footer, w - 48,
        () => online.command('ready'), { primary: true, disabled: online.sending || online.room.ready[online.room.player] });
    } else if (isOnline() && online.room?.undo?.pending) {
      const voted = online.room.undo.votes.includes(online.room.player);
      button('undo-accept', voted ? (language === 'en' ? 'Waiting for votes' : '等待真人确认') : (language === 'en' ? 'Accept undo' : '同意悔棋'),
        24, footer - 54, boxW, () => online.voteUndo(true), { primary: true, disabled: voted || online.sending });
      button('undo-reject', language === 'en' ? 'Reject undo' : '拒绝悔棋', 36 + boxW, footer - 54, boxW,
        () => online.voteUndo(false), { disabled: online.sending });
      // Voting has its own row above the match controls and the emote row.
      button('room-wait', label('pending'), 24, footer, w - 48, () => {}, { disabled: true });
    } else if (isOnline() && (snapshot.gameOver || rankedForfeit)) {
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
        () => { const p = selected; selected = null; const rootType = snapshot.rootMode === 'relocate' ? 'root_relocate' : 'root_add';
          void play(passLesson ? { type: 'skip' } : topologyBoard
            ? { type: 'move', vertexId: p }
            : { type: actionMode === 'root' ? rootType : 'move', point: p }); },
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
        if (!snapshot.gameOver && !rankedForfeit && (!isOnline() || online.room?.status !== 'closed')) {
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
    if (isOnline() && !lesson && !replaying && online.room?.settings?.undoEnabled
      && online.room.actions.length && !undoVoting)
      button('undo', `${label('undo')} · ${Math.max(0, online.room.settings.undoMaxCount - (online.room.undo?.usedCount || 0))}`,
        24, boardRect.y - 4, 98, () => online.voteUndo(true),
        { height: 36, font: 14, disabled: online.sending || (online.room.undo?.usedCount || 0) >= online.room.settings.undoMaxCount
          || !online.room.actions.some(action => action.type === 'move' && action.player === online.room.player) });
    if (zoomAvailable) button('board-zoom', label(zoomFocus ? 'overviewShort' : 'zoomShort'), w - 81, boardRect.y - 4, 57,
      () => {
        const radius = snapshot.gridSize - 1;
        zoomFocus = zoomFocus ? null : selected || session.hintPoint || target || (snapshot.boardShape === 'hexagon'
          ? [radius, radius] : snapshot.boardShape === 'diamond' ? [radius / 2, radius / 2] : [radius / 3, radius / 3]);
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
      const boardDraft = roomDraft?.settings;
      if (active === 'board') contentHeight = drawBoardCabin(ui, content, { language, terminology,
        size: boardDraft?.gridSize ?? size, online: isOnline(), roomSetup: roomDraft?.kind,
        roomBusy: online.sending, nextGame: isOnline() && ['playing', 'finished'].includes(online.room?.status),
        hostSeatAdded: roomDraft?.hostSeatAdded,
        canEditOnline: isOnline() && online.canEditSettings(),
        playerCount: boardDraft?.playerCount ?? draftPlayerCount(),
        boardShape: boardDraft?.boardShape || (selectedTopologyDefinition() ? 'custom' : boardShape),
        rootMode: boardDraft?.rootMode || rootMode,
        startingPointMode: boardDraft?.startingPointMode || startingPointMode,
        turnOrder: orderDrag?.preview || currentTurnOrder(), invalidTurnOrder: boardDraft ? Boolean(boardDraft.invalidTurnOrder) : invalidTurnOrder,
        topologyExpanded, topologyPreset: roomDraft ? roomDraft.topologyPreset || null : topologyPreset, topologySelected: Boolean(boardDraft?.boardDefinition || selectedTopologyDefinition()),
        startPlayer: boardDraft?.startPlayer || startPlayer, controllers: roomDraft?.controllers || online.room?.aiControllers || draftControllers(),
        playOptions: boardDraft ? normalizePlayOptions(boardDraft) : playOptions,
        compatibleProfiles: (boardDraft || draftSettings()).rulesVersion === 'surface-v1' ? ['human', 'topology-generic'] : controllerChoices(boardDraft || draftSettings()),
        hasActions: Boolean(session.actions.length), rulesVersion: session.settings?.rulesVersion || 'territory-v3',
        contribution: contribution.enabled, contributionStatus: contribution.snapshot(),
        contributionAvailable: Boolean(contribution.origin && platform.contributionRequest) }, {
        language: toggleLanguage, terminology: () => { terminology = terminology === 'math' ? 'war' : 'math'; persistPreferences(); },
        playerLabel, submitRoom: submitRoomDraft, players: count => roomDraft ? editRoomDraft({ playerCount: count }) : changePlayerCount(count),
        controller: async player => { const generation = cabinGeneration, draft = roomDraft, settings = draft?.settings || draftSettings();
          const count = settings.playerCount, choices = controllerMenuChoices(count, settings);
          const valid = () => generation === cabinGeneration && roomDraft === draft && count === (roomDraft?.settings.playerCount || draftPlayerCount())
            && scene === 'home' && (!isOnline() || online.canEditSettings()) && !session.hidden;
          const profile = choices[await platform.choose(choices.map(item => item === 'models' ? label('moreModels') : label(`controller-${item}`)),
            { previousLabel: label('previousPage'), nextLabel: label('nextPage'), isCurrent: valid })];
          if (!profile || !valid()) return;
          if (profile === 'models') { modelTarget = { kind: 'controller', player, returnCabin: true }; modelPage = 0; modelGroup = count > 2 ? 'native' : 'research'; scene = 'models'; redraw(); return; }
          if (roomDraft) { roomDraft.controllers = { ...roomDraft.controllers, [player]: profile }; redraw(); }
          else if (selectedTopologyDefinition()) { topologyControllers[player] = profile; persistTopologyChoice(); redraw(); } else selectController(player, profile); },
        turnOrder: setTurnOrder, resetTurnOrder: () => setTurnOrder(playerIds(roomDraft?.settings.playerCount ?? playerCount)),
        changeNumber: (key, raw) => { if (raw && typeof raw === 'object' && raw.focus) editNumber(key); },
        shape: value => { if (roomDraft) { roomDraft.topologyPreset = null; return editRoomDraft({ boardShape: value, rulesVersion: 'territory-v3',
          boardDefinition: undefined, boardHash: undefined, topologyProtocolVersion: undefined, rootMode: 'classic', rootRulesVersion: 'root-v1' }); }
          const wasTopology = Boolean(selectedTopologyDefinition()); nextTopologyChoice = null; topologyPreset = null;
          if (boardShape === value) { saveOrdinaryChoice(); if (wasTopology) { cabinGeneration++; redraw(); } return; }
          boardShape = value; initialPositions = null; initialRoots = null; preparedStarts = null;
          if (draftPlayerCount() === 2 && controllers) {
            controllers = Object.fromEntries(Object.entries(controllers).map(([player, profile]) =>
              [player, profile === 'greedy' || /^minimax-[234]$/.test(profile)
                ? value === 'hexagon' ? 'greedy' : ({ simple: 'minimax-2', medium: 'minimax-3', hard: 'minimax-4' })[difficulty]
                : profile]));
          }
          if (draftPlayerCount() === 2 && value === 'hexagon') difficulty = 'simple';
          const explicitStartsRequired = requiresExplicitStartingPoints(draftPlayerCount(), value);
          if (startingPointMode === 'custom' || startingPointMode === 'default' && explicitStartsRequired)
            startingPointMode = explicitStartsRequired ? 'random' : 'default';
          topologyPreset = null; saveOrdinaryChoice(); cabinGeneration++; persistPreferences(); },
        rootMode: value => { const count = roomDraft?.settings.playerCount ?? playerCount; if (!['classic','fixed-double','relocate','add'].includes(value) || count !== 2) return; preparedStarts = null; if (roomDraft) return editRoomDraft({rootMode:value, rootRulesVersion: value === 'classic' ? 'root-v1' : 'root-v2', startingPointMode: 'default', initialRoots: undefined, initialPositions: undefined}); rootMode=value; startingPointMode='default'; initialPositions=null; initialRoots=null; controllers=null; cabinGeneration++; persistPreferences(); },
        startingPoints: value => {
          const settings = roomDraft?.settings || { playerCount, boardShape };
          if (value === 'default' && requiresExplicitStartingPoints(settings.playerCount, settings.boardShape)) return;
          const activeDefinition = roomDraft ? roomDraft.settings.boardDefinition : selectedTopologyDefinition();
          if (activeDefinition) {
            const setup = roomDraft ? createTopologySetup({ definition: activeDefinition }) : topologySetup || createTopologySetup({ definition: activeDefinition });
            const result = changeTopologyStarts(setup, { mode: value, playerCount: settings.playerCount });
            selectTopologyBoard(result, topologyPreset || 'custom'); return;
          }
          if (value === 'random') return openRandomStartingPoints();
          if (value === 'custom') { openBoardEditor(); } else if (roomDraft) { preparedStarts = null; editRoomDraft({ startingPointMode: value, initialPositions: undefined, initialRoots: undefined }); }
          else { preparedStarts = null; startingPointMode = value; initialPositions = null; initialRoots = null; persistPreferences(); } },
        size: value => {
          const previousSize = size;
          const preset = roomDraft?.topologyPreset || topologyPreset, selected = roomDraft ? roomDraft.settings.boardDefinition : selectedTopologyDefinition();
          if (roomDraft) editRoomDraft({ gridSize: value });
          else { size = value; }
          if (selected && preset && !['custom', 'random'].includes(preset)) { selectTopologyPreset(preset); return; }
          if (selected && preset === 'random') { generateTopologyRandomBoard(); return; }
          if (roomDraft) return;
          if (previousSize !== value) { initialPositions = null; initialRoots = null; preparedStarts = null; if (startingPointMode === 'custom') startingPointMode
            = requiresExplicitStartingPoints(playerCount, boardShape) ? 'random' : 'default'; }
          size = value; persistPreferences(); }, option: (key, value) => { closeNumberInput();
          if (roomDraft) return editRoomDraft({ ...(key === 'hintEnabled' && value
            ? { hintMaxCount: Math.max(1, roomDraft.settings.hintMaxCount ?? 3) } : {}), [key]: value });
          playOptions = normalizePlayOptions({ ...playOptions, ...(key === 'hintEnabled' && value ? { hintMaxCount: Math.max(1, playOptions.hintMaxCount) } : {}), [key]: value });
          optionsConfigured = true; persistPreferences(); },
        contribution: toggleContribution,
        topology: toggleTopologyMenu, preset: selectTopologyPreset, randomTopology: generateTopologyRandomBoard,
        customBoard: () => openBoardEditor(), reset: startNew,
        replay: () => { invalidateContribution(); closeCabin(false); scene = 'replay-hub'; redraw(); },
        library: () => { closeCabin(false); void openLibrary(); }, display: () => { closeCabin(false); openDisplay('board'); },
      });
      if (active === 'battle') contentHeight = drawBattleCabin(ui, content, { online: isOnline(), code: online.room?.code, enabled: online.enabled,
        ladder: { ...ladder.view(), result: isOnline() ? online.room?.ladderResult : null, player: online.room?.player }, rankedAI: online.room?.rankedAI,
        roomProfiles: online.room?.playerProfiles, ownPlayer: online.room?.player,
        playerCount: online.room?.settings?.playerCount, bots: online.room?.bots, ready: online.room?.ready,
        controllers: online.room ? roomControllers(online.room.settings) : null,
        account: online.account, savedCode: online.savedCode, retryCode: roomRetryCode, busy: online.deleting || accountBusy, message: accountMessage }, {
        create: () => openRoomSetup('create'), settings: () => openRoomSetup('settings'),
        join: () => friendsMenu(null, 'join'), resume: () => friendsMenu(null, 'resume'),
        retry: () => roomRetryCode && friendsMenu(roomRetryCode),
        account: () => accountAction('load'), link: () => accountAction('link'), delete: () => accountAction('delete'),
        editName: () => accountAction('name'), editAvatar: () => accountAction('avatar'), avatar: drawAvatar,
        importWechat: () => accountAction('wechat'), privacyContract: () => accountAction('privacyContract'),
        privacy: () => openReader('privacy', 'battle'),
        share: () => platform.share(online.sharePayload()), refresh: async () => { await online.refresh(); await online.connect(); },
        leave: () => quickAction('leave'),
        ladder: { load: loadLadder, rules: () => openReader('ladder', 'battle'), start: () => friendsMenu(null, 'ai') },
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
    if (!available || !['territory-v3', TopologyRulesVersion.SURFACE_V1].includes(localSession.settings?.rulesVersion) && !pending) return;
    if (await platform.confirm(language === 'en' ? CONTRIBUTION_NOTICE_EN : CONTRIBUTION_NOTICE) && generation === cabinGeneration && scene === 'home' && appVisible) contribution.setEnabled(true);
  }
  function toggleLanguage() {
    language = language === 'zh' ? 'en' : 'zh';
    try { platform.storage.set('lifeline-wx-language', language); } catch (_) {}
    redraw();
  }
  function openCabin(key) {
    closeNumberInput(); orderDrag = null; orderArmed = null;
    if (session.hidden) return;
    if (key === 'board' && isOnline() && !roomDraft) { openRoomSetup('settings'); return; }
    if (key !== 'board') roomDraft = null;
    helpGeneration++; friendsGeneration++; cabinGeneration++;
    pauseForPanel(); selected = null; cabinScroll = 0; accountMessage = '';
    scene = key === 'board' ? 'home' : 'game'; cabin = key === 'board' ? null : key; redraw();
    if (key === 'battle' && ladder.kind && online.account && !ladder.loading)
      void ladder.load(ladder.kind, ladder.data?.offset || 0);
  }
  function closeCabin(resume = true) {
    closeNumberInput(); orderDrag = null; orderArmed = null;
    roomDraft = null;
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
  const resignationPrompt = () => isOnline() && online.room?.aiControllers
    ? (language === 'en' ? 'End this AI challenge as a loss to every AI opponent?' : '确认结束本次 AI 挑战，并按负于所有 AI 对手结算？')
    : label('confirmResign');
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
      if (action === 'resign' && !await platform.confirm(resignationPrompt())) return;
      if (!valid() || !canPlay()) return;
      selected = null;
      if (action === 'hint') await (isOnline() ? online.hint() : session.hint());
      else await play({ type: action });
    } finally { release(); redraw(); }
  }
  function returnToBoard() {
    if (!appVisible || session.hidden) return;
    clearTimeout(surface3dTimer); surface3dTimer = null;
    helpGeneration++; friendsGeneration++;
    surface3dRenderer?.destroy(); surface3dRenderer = null; surface3dCanvas = null; surface3dData = null; surface3dRect = null;
    cancelFileTask();
    // Returning closes the panel, not the match, replay or lesson. The online
    // pause policy preserves in-flight verification; local play stays paused.
    pauseForPanel(); clearBoardView(); closeCabin(false);
  }
  async function goHome() {
    roomDraft = null;
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
    closeNumberInput();
    if (invalidTurnOrder) { openCabin('board'); return; }
    let definition = selectedTopologyDefinition(), preparedTopology;
    if (definition) {
      const setup = topologySetup?.definition === definition ? topologySetup : createTopologySetup({ definition });
      const reconciled = reconcileTopologySetupPlayers(setup, Math.min(6, playerCount));
      preparedTopology = topologySetupResult(reconciled.setup);
      if (!reconciled.ok || !preparedTopology.ok) { editorMessage = topologyErrorText(reconciled.ok ? preparedTopology : reconciled); openCabin('board'); return; }
      topologySetup = reconciled.setup; definition = preparedTopology.definition;
    }
    const compatible = definition ? ['human', 'topology-generic'] : controllerChoices(playerCount, draftSettings());
    if (Object.values(draftControllers()).some(profile => !compatible.includes(profile))) {
      await platform.message(label('incompatiblePlayers')); openCabin('board'); return;
    }
    const current = session, epoch = current.epoch, previousScene = scene, generation = cabinGeneration, releaseClock = current.holdClock();
    try {
      if (current.snapshot && !current.snapshot.gameOver && current.actions.length && !await platform.confirm(label('confirmNew'))) return;
      if (session !== current || current.epoch !== epoch || scene !== previousScene || generation !== cabinGeneration || current.hidden) return;
      if (current === localSession && current.snapshot && current.actions.length && !current.tutorial) archiveCurrent({ bestEffort: true });
      clearEmote(); invalidateContribution(); cabin = null; cabinGeneration++; selected = null; scene = 'game';
      const order = currentTurnOrder(null); startPlayer = order[0];
      let started;
      if (definition) {
        started = await current.newTopologyGame({ gridSize: size, playerCount, startPlayer, turnOrder: order,
          rulesVersion: 'surface-v1', boardShape: 'custom', boardDefinition: definition, boardHash: preparedTopology.boardHash,
          topologyProtocolVersion: 'board-topology-v1', rootMode: 'classic', rootRulesVersion: 'root-v1', ...playOptions },
        'human', difficulty, { controllers: draftControllers() });
      } else {
        const prepared = startingPointMode === 'random' && preparedStarts?.key === startLayoutKey({ ...draftSettings(), startPlayer })
          ? preparedStarts.layout : undefined;
        started = await current.newGame(size, playerCount > 2 ? 'human' : mode, difficulty, playerCount,
          { startPlayer, turnOrder: order, controllers, playOptions, boardShape, rootMode, startingPointMode, initialPositions,
            startRandom, ...(prepared ? { preparedStarts: prepared } : {}),
            ...(startingPointMode !== 'random' && initialRoots ? { initialRoots } : {}) });
      }
      if (started) { nextTopologyChoice = definition ? 'selected' : null; preparedStarts = null; beginContribution(); }
      redraw();
    } finally { releaseClock(); }
  }
  function persistPreferences() {
    rememberPlayerDraft();
    try { savePreferences(platform.storage, { size, mode, difficulty, terminology, playerCount, boardShape, rootMode, startingPointMode, initialPositions, initialRoots,
      ...(invalidTurnOrder || turnOrder != null ? { turnOrder } : {}), ...(invalidTurnOrder ? { invalidTurnOrder: true } : {}),
      ...(startPlayer !== 'BLACK' ? { startPlayer } : {}), ...(controllers ? { controllers } : {}),
      ...(Object.keys(playerDrafts).length > 1 ? { playerDrafts } : {}),
      ...(optionsConfigured ? { playOptions } : {}) }); }
    catch (_) { void platform.message(label('saveError')); }
    redraw();
  }
  function openStartingPoints() {
    if (session.hidden || (isOnline() && !online.canEditSettings())) return;
    const setup = roomDraft?.settings || { gridSize: size, playerCount, boardShape, initialPositions };
    startPreviewRandom = false; startDraftRoots = null;
    pauseForPanel(); cabin = null; cabinGeneration++; startSeat = playerIds(setup.playerCount)[0]; startPoint = null; startSeatPage = 0;
    try { startDraft = resolveInitialPositions(setup.gridSize, setup.playerCount, setup.initialPositions, setup.boardShape); }
    catch (_) { startDraft = requiresExplicitStartingPoints(setup.playerCount, setup.boardShape)
      ? randomInitialPositions(setup.gridSize, setup.playerCount, Math.random, setup.boardShape)
      : resolveInitialPositions(setup.gridSize, setup.playerCount, null, setup.boardShape); }
    scene = 'starts'; clearBoardView(); redraw();
  }
  function randomStartLayout(settings) {
    const mode = settings.rootMode || 'classic';
    return mode === 'classic'
      ? { initialPositions: randomInitialPositions(settings.gridSize, settings.playerCount, startRandom, settings.boardShape) }
      : { initialRoots: randomInitialRoots(settings.gridSize, settings.playerCount, mode, startRandom, settings.boardShape) };
  }
  function shuffleStartPreview() {
    const settings = roomDraft?.settings || { ...draftSettings(), startPlayer };
    const layout = randomStartLayout(settings);
    startDraftRoots = layout.initialRoots || Object.fromEntries(Object.entries(layout.initialPositions).map(([player, point]) => [player, [point]]));
    startDraft = Object.fromEntries(Object.entries(startDraftRoots).map(([player, roots]) => [player, roots[0]]));
    startPoint = null; redraw();
  }
  function openRandomStartingPoints() {
    if (session.hidden || (isOnline() && !online.canEditSettings())) return;
    const settings = roomDraft?.settings || { ...draftSettings(), startPlayer };
    try { shuffleStartPreview(); } catch (error) { void platform.message(errorText(error.message, t())); return; }
    startPreviewRandom = true;
    pauseForPanel(); cabin = null; cabinGeneration++; startSeat = playerIds(settings.playerCount)[0]; startSeatPage = 0;
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
    if (choice === 'models') { modelTarget = { kind: 'controller', player }; modelPage = 0; modelGroup = count > 2 ? 'native' : 'research'; scene = 'models'; redraw(); return; }
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
    if (scene !== 'branch' || session.hidden) return;
    invalidateContribution();
    const current = session, fromRoom = isOnline(), target = fromRoom ? localSession : current, generation = cabinGeneration;
    const canCommit = () => appVisible && session === current && scene === 'branch' && !current.hidden && cabinGeneration === generation;
    const pending = current.forkReplay({ keepPlayers: keepBranchPlayers, target, canCommit, archive: payload => {
      // Keep both the room's complete replay and any previous local game before
      // replacing the local automatic save with an independent trial.
      if (fromRoom && localSession.snapshot) {
        const previous = localSession.tutorial ? localSession.savedGame : localSession.capture();
        if (previous?.session.actions.length) {
          const { snapshot: _snapshot, stateHash: _stateHash, ...payload } = previous;
          library.save(payload);
        }
      }
      library.save(payload);
    } });
    const epoch = current.epoch, loaded = await pending;
    if (loaded && session === current && current.epoch === epoch && scene === 'branch' && !current.hidden) {
      if (fromRoom) { online.detach(); session = target; }
      inspection = null; analysis = null; selected = null; scene = 'game';
      session.resume();
    }
    redraw();
  }
  async function replayAction(choice) {
    if (session.replayIndex === null) return;
    const wasPlaying = session.replayPlaying;
    session.pause();
    const current = session, epoch = session.epoch, sourceScene = scene;
    const valid = () => ['game', 'replay-tools'].includes(sourceScene) && !cabin && scene === sourceScene
      && session === current && session.epoch === epoch && !session.hidden && session.replayIndex !== null;
    if (!valid()) return;
    if (choice === 'branchReplay' && !session.snapshot?.gameOver) { keepBranchPlayers = false; scene = 'branch'; }
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
      if (valid() && index >= 0 && index < 3) {
        session.replayInterval = [2000, 1000, 500][index]; scene = 'game';
        if (wasPlaying) session.startReplayPlayback();
      }
    }
    if (choice === 'inspectReplay') {
      scene = 'game';
      const pending = session.inspectReplay(), inspectEpoch = session.epoch;
      const result = await pending;
      if (!result || session !== current || scene !== 'game' || session.hidden || session.epoch !== inspectEpoch) return;
      const type = { player_move: 'move', player_skip: 'skip', player_resign: 'resign',
        player_root_relocate: 'root_relocate', player_root_add: 'root_add' }[result.action?.type] || result.action?.type;
      const lines = [label('inspectReadOnly'), result.action
        ? `${result.cursor} · ${playerLabel(result.actor)} · ${label({ move: 'played', skip: 'passed', resign: 'resigned', root_relocate: 'rootMoved', root_add: 'rootAdded' }[type])}${result.action.vertexId ? ` (${result.action.vertexId})` : Array.isArray(result.action.point) ? ` (${result.action.point.join(', ')})` : ''}`
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
    const choices = replayAnalysisChoices(session.settings);
    const valid = () => scene === 'analysis' && session === current && session.epoch === epoch && !session.hidden;
    const choice = choices[await platform.choose(choices.map(({ profile, supported }) => `${label(`controller-${profile}`)}${profile === "greedy" ? " · Greedy" : ""}${supported ? '' : language === 'en' ? ' · unavailable on this board' : ' · 当前棋盘不适用'}`),
      { previousLabel: label('previousPage'), nextLabel: label('nextPage'), isCurrent: valid })];
    if (!choice || !valid()) return;
    if (!choice.supported) return platform.message(language === 'en'
      ? 'This AI does not support the current player count, board shape or size. Choose an available AI for this position.'
      : '该 AI 暂不支持当前人数、棋盘形状或边长。请选择当前局面可用的 AI。');
    await runAnalysis(choice.profile);
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
  async function friendsMenu(invitation = null, directKind = null, preparedSettings = null) {
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
    let kind = invitation ? 'join' : directKind, value = invitation;
    if (directKind && !invitation) {
      if (kind === 'ai') {
        if (invalidTurnOrder) { openCabin('board'); return; }
        try { value = rankedSetupInput({ ...draftSettings(), startPlayer, startingPointMode, initialPositions }, draftControllers()); }
        catch (_) { await platform.message(language === 'en' ? 'In Board cabin, keep one human seat and choose compatible AI for every other seat.' : '请在棋盘舱保留一个真人席位，其余席位选择当前棋盘兼容的 AI。'); return; }
        const summary = Object.entries(value.controllers).map(([p, profile]) => `${playerLabel(p)} · ${label(`controller-${profile}`)}`).join('\n');
        if (!await platform.confirm((language === 'en' ? 'Use the Board cabin setup for ranked AI?\n' : '按棋盘舱配置开始 AI 排位？\n')
          + `${playerCount} ${language === 'en' ? 'seats' : '人'} · ${size} ${language === 'en' ? 'size' : '路'} · ${label(boardShape === 'hexagon' ? 'hexBoard' : boardShape === 'diamond' ? 'diamondBoard' : 'triangleBoard')}\n`
          + `${startingPointMode === 'random' ? (language === 'en' ? 'Server-drawn random starts' : '服务器随机起点') : startingPointMode === 'custom' ? (language === 'en' ? 'Custom starts' : '自定义起点') : (language === 'en' ? 'Default starts' : '默认起点')}\n`
          + summary + (language === 'en' ? '\nHints and undo are disabled.' : '\n排位关闭提示和悔棋。')) || !valid()) return;
      } else value = kind === 'resume' ? online.savedCode : kind === 'create' ? null : (await platform.input(label('roomCode')))?.trim().toUpperCase();
    }
    if (!kind) {
      const choices = online.savedCode ? ['resumeRoom', 'createRoom', 'joinRoom'] : ['createRoom', 'joinRoom'];
      const i = await platform.choose(choices.map(label));
      if (!valid() || !choices[i]) return;
      kind = choices[i] === 'resumeRoom' ? 'resume' : choices[i] === 'createRoom' ? 'create' : 'join';
      value = kind === 'resume' ? online.savedCode : kind === 'create' ? null : (await platform.input(label('roomCode')))?.trim().toUpperCase();
    }
    if (!valid()) return;
    if (kind === 'create') {
      if (!preparedSettings) { openRoomSetup('create'); return; }
      value = preparedSettings;
    }
    if (kind === 'ai' && !value) return;
    if (kind === 'join' && value == null) return;
    if (!['create', 'ai'].includes(kind) && !/^[A-Z2-9]{8}$/.test(value || '')) {
      roomRetryCode = null; showRoomError(label('invalidRoomCode')); return;
    }
    accountMessage = ''; roomRetryCode = ['create', 'ai'].includes(kind) ? null : value;
    invalidateContribution(); localSession.pause(); session = online.game; cabin = null; roomDraft = null; cabinGeneration++; scene = 'game'; selected = null; redraw();
    try { await online.enter(kind, value, { confirmDeparture: room => platform.confirm(language === 'en'
      ? `You are still in room ${room.code}. Leave it before continuing? Leaving a playing game counts as resignation; a ranked AI challenge counts as a loss.`
      : `你仍在房间 ${room.code}。退出旧房间后继续？正在进行的对局会按认输处理；AI 排位会按失败结算。`) }); if (generation === friendsGeneration) roomRetryCode = null; }
    catch (error) {
      if (generation === friendsGeneration && appVisible && isOnline() && scene === 'game') {
        online.detach(); session = localSession;
        if (error.message === 'CANCELLED') { scene = 'game'; cabin = 'battle'; cabinGeneration++; redraw(); return; }
        showRoomError(error.message === 'NETWORK_ERROR' ? language === 'en'
          ? 'Cannot reach the server. Retry joining, or enter another room code.'
          : '暂时连不上服务器。请重试加入，或重新输入房间码。' : errorText(error.message, t()));
      }
    }
  }
  async function settingsMenu() {
    session.pause(); scene = 'setup'; redraw();
  }
  async function loadLadder(kind, offset = 0) {
    const generation = cabinGeneration;
    const valid = () => !disposed && appVisible && cabin === 'battle' && generation === cabinGeneration;
    if (await ensureOnlineConsent({ online, platform, language, isCurrent: valid }) && valid()) await ladder.load(kind, offset);
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
      if (i === 2 && canPlay() && await platform.confirm(resignationPrompt()) && valid()) await play({ type: 'resign' });
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
    if (numberEditing && hit?.id !== numberEditing.id) closeNumberInput(true);
    if (hit) {
      if (hit.set) { if (!hit.disabled) { hit.set(x); hit.commit?.(); } return; }
      if (!hit.disabled) Promise.resolve().then(hit.action).catch(error => platform.message(errorText(error.message, t())));
      return;
    }
    if (!currentView()) { redraw(); return; }
    if (scene === 'board-editor' && editorSetup && editorSource && inBoard(x, y)) {
      if (editorSource.ordinaryRoots) {
        const point = hitPoint(x, y, layout); if (!point) return;
        const occupied = Object.entries(editorSource.ordinaryRoots).some(([player, roots]) => player !== editorPlayer
          && roots.some(root => root.every((value, i) => value === point[i])));
        if (occupied) { editorMessage = label('startPointOccupied'); redraw(); return; }
        editorSource.ordinaryRoots[editorPlayer] = [[...point]]; editorMessage = ''; redraw(); return;
      }
      const hit = hitTestBoardEditor(editorLayout, x, y, editorTool);
      if (!hit) return;
      if (hit.type === 'coordinate') {
        const path = editorSetup.draft?.path || [];
        const closing = path.length >= 3 && path[0].every((v, i) => v === hit.coordinate[i]);
        const result = extendTopologyBoundary(editorSetup, hit.coordinate, { close: closing });
        if (result.ok && closing && !Object.keys(result.setup.definition?.startingVertices || {}).length)
          adoptEditor(changeTopologyStarts(result.setup, { mode: 'default', playerCount: editorSource.settings.playerCount }));
        else adoptEditor(result);
      } else if (hit.type === 'ring') { editorRing = hit.index; redraw(); }
      else if (hit.type === 'edge') adoptEditor(selectTopologyBoundaryOccurrence(editorSetup, hit.occurrenceId));
      else if (hit.type === 'seam') adoptEditor(removeTopologySeam(editorSetup, hit.seamId));
      else if (hit.type === 'vertex') {
        const roots = topologyStartingRoots(editorSetup.compiled);
        if (editorSource.ordinary) {
          if (hit.owner === editorPlayer) { editorMoveFrom = hit.vertexId; editorMessage = ''; redraw(); return; }
          const result = setTopologyRootAtVertex(editorSetup, editorPlayer, hit.vertexId,
            { moveFrom: editorMoveFrom || roots[editorPlayer]?.[0] });
          adoptEditor(result); if (result.ok) editorMoveFrom = null;
        } else adoptEditor(setTopologyRootAtVertex(editorSetup, editorPlayer, hit.vertexId));
      }
      return;
    }
    if (scene === 'starts' && layout && inBoard(x, y)) {
      if (startPreviewRandom) return;
      if (!zoomFocus && layout.spacing < 28) { zoomFocus = pointAtScreen(x, y, layout); startPoint = null; }
      else startPoint = hitPoint(x, y, layout);
      redraw(); return;
    }
    if (scene === 'game' && !cabin && layout && inBoard(x, y) && canPlay()) {
      if (isTopologySnapshot(session.snapshot)) { selected = hitTopologyVertex(x, y, layout); redraw(); return; }
      if (!zoomFocus && layout.spacing < 28) { zoomFocus = pointAtScreen(x, y, layout); selected = null; }
      else selected = hitPoint(x, y, layout);
      redraw();
    }
  }
  platform.touchStart((event) => {
    const touches = event.touches ?? [];
    const insideSurface = p => surface3dRect && Number.isFinite(p?.clientX) && Number.isFinite(p?.clientY)
      && p.clientX >= surface3dRect.x && p.clientX <= surface3dRect.x + surface3dRect.width
      && p.clientY >= surface3dRect.y && p.clientY <= surface3dRect.y + surface3dRect.height;
    if (scene === 'topology-3d' && currentView() && touches.length === 2 && touches.every(insideSurface)) {
      const distance = Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
      startTouch = distance > 0 ? { moved: true, view, cabinEpoch: cabinGeneration, pinch: { distance, zoom: surface3dZoom } } : null;
      return;
    }
    const p = event.touches?.length === 1 && event.touches[0];
    const orderHit = p && orderRegions.find(item => !item.disabled && p.clientX >= item.x && p.clientX <= item.x + item.width
      && p.clientY >= item.y && p.clientY <= item.y + item.height);
    if (orderHit && currentView()) {
      closeNumberInput();
      orderDrag = { player: orderHit.player, preview: [...orderHit.order], generation: cabinGeneration, draft: roomDraft, view,
        armed: orderArmed === orderHit.player, time: Date.now() };
      startTouch = { x: p.clientX, y: p.clientY, moved: false, view, cabinEpoch: cabinGeneration,
        scroll: cabinScroll, order: true };
      return;
    }
    startTouch = p && currentView() ? { x: p.clientX, y: p.clientY, moved: false, view,
      scroll: scrollArea && p.clientX >= scrollArea.x && p.clientX <= scrollArea.x + scrollArea.width
        && p.clientY >= scrollArea.y && p.clientY <= scrollArea.y + scrollArea.height ? cabinScroll : null,
      slider: sliders.find(item => !item.disabled && p.clientX >= item.x && p.clientX <= item.x + item.width && p.clientY >= item.y && p.clientY <= item.y + item.height),
      surface: scene === 'topology-3d' && surface3dRect && p.clientX >= surface3dRect.x && p.clientX <= surface3dRect.x + surface3dRect.width
        && p.clientY >= surface3dRect.y && p.clientY <= surface3dRect.y + surface3dRect.height ? { yaw: surface3dYaw, pitch: surface3dPitch } : null,
      cabinEpoch: cabinGeneration, cabin, axis: null,
      editorPan: scene === 'board-editor' && editorZoom > 1 && inBoard(p.clientX, p.clientY) ? { ...editorPan } : null,
      focus: zoomFocus && inBoard(p.clientX, p.clientY) ? [...zoomFocus] : null, layout } : null;
    if (startTouch?.cabin === 'battle' && startTouch.scroll !== null) userInfoControl?.hide();
  });
  platform.touchMove((event) => {
    const touch = startTouch;
    if (touch?.pinch && event.touches?.length === 2 && currentView() && touch.view === view && touch.cabinEpoch === cabinGeneration) {
      const [a, b] = event.touches;
      const distance = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      if (Number.isFinite(distance) && distance > 0) {
        surface3dPaused = true; surface3dZoom = Math.max(0.4, Math.min(2.5, touch.pinch.zoom * distance / touch.pinch.distance)); redraw();
      }
      return;
    }
    const p = event.touches?.length === 1 && event.touches[0];
    if (!p || !touch || !currentView() || touch.view !== view) { startTouch = null; return; }
    if (touch.order) {
      if (!orderDrag || orderDrag.generation !== cabinGeneration || orderDrag.draft !== roomDraft) { orderDrag = null; startTouch = null; return; }
      const dx = p.clientX - touch.x, dy = p.clientY - touch.y;
      if (!orderDrag.armed && Date.now() - orderDrag.time < 200 && Math.abs(dy) >= 8 && Math.abs(dy) > Math.abs(dx)) {
        orderDrag = null; orderArmed = null; touch.order = false; touch.axis = 'y'; touch.moved = true;
      } else {
      touch.moved = true;
      const target = orderRegions.find(item => p.clientX >= item.x && p.clientX <= item.x + item.width
        && p.clientY >= item.y && p.clientY <= item.y + item.height);
      if (target && target.player !== orderDrag.player) {
        const next = [...orderDrag.preview], from = next.indexOf(orderDrag.player), to = next.indexOf(target.player);
        next.splice(from, 1); next.splice(to, 0, orderDrag.player); orderDrag.preview = next; redraw();
      }
      return;
      }
    }
    const dx = p.clientX - touch.x, dy = p.clientY - touch.y;
    if (Math.hypot(dx, dy) >= 14) touch.moved = true;
    if (touch.cabinEpoch !== cabinGeneration) { startTouch = null; return; }
    if (touch.moved && touch.editorPan) {
      const limit = Math.max(boardRect.width, boardRect.height) * editorZoom;
      editorPan = { x: Math.max(-limit, Math.min(limit, touch.editorPan.x + dx)),
        y: Math.max(-limit, Math.min(limit, touch.editorPan.y + dy)) }; redraw(); return;
    }
    if (touch.moved && touch.surface) { surface3dPaused = true; surface3dYaw = touch.surface.yaw + dx * 0.01; surface3dPitch = Math.max(-1.5, Math.min(1.5, touch.surface.pitch + dy * 0.01)); redraw(); return; }
    if (!touch.axis && Math.hypot(dx, dy) >= 8) touch.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
    if (touch.slider && touch.axis === 'x') {
      touch.slider.set(p.clientX); touch.moved = true;
      // Changing the player draft invalidates menus, but this same slider owns
      // the drag until release; don't stop at the first intermediate count.
      if (touch.cabin === cabin && touch.view === view && currentView()) touch.cabinEpoch = cabinGeneration;
      return;
    }
    if (touch.moved && touch.scroll !== null) { closeNumberInput(); cabinScroll = Math.max(0, Math.min(scrollMax, touch.scroll - dy)); redraw(); return; }
    if (touch.moved && touch.focus) { zoomFocus = panBoardFocus(touch.focus, dx, dy, touch.layout); selected = null; redraw(); }
  });
  platform.touchEnd((event) => {
    const p = event.changedTouches?.[0], touch = startTouch;
    startTouch = null;
    if (touch?.order) {
      const drag = orderDrag; orderDrag = null;
      if (drag && drag.generation === cabinGeneration && drag.draft === roomDraft && currentView() && touch.view === view) {
        orderArmed = drag.player;
        if (touch.moved && drag.preview.some((player, i) => player !== currentTurnOrder()[i])) setTurnOrder(drag.preview);
      }
      redraw(); return;
    }
    if (touch?.cabin === 'battle' && touch.scroll !== null) redraw();
    if (p && touch?.slider?.commit && !event.touches?.length && currentView() && touch.view === view) {
      touch.slider.set(p.clientX); touch.slider.commit(); return;
    }
    if (p && touch && !event.touches?.length && !touch.moved && currentView() && touch.view === view
      && Math.hypot(p.clientX - touch.x, p.clientY - touch.y) < 14) tap(p.clientX, p.clientY);
  });
  platform.touchCancel(() => { orderArmed = null; orderDrag = null; startTouch = null; replaySeekDraft = null; redraw(); });
  platform.wheel?.((event) => {
    if (!disposed && appVisible && currentView() && scene === 'topology-3d' && surface3dRect && Number.isFinite(event.deltaY)
      && Number.isFinite(event.clientX) && Number.isFinite(event.clientY)
      && event.clientX >= surface3dRect.x && event.clientX <= surface3dRect.x + surface3dRect.width
      && event.clientY >= surface3dRect.y && event.clientY <= surface3dRect.y + surface3dRect.height) {
      const delta = event.deltaY * (event.deltaMode === 1 ? 20 : event.deltaMode === 2 ? surface3dRect.height : 1);
      surface3dPaused = true; surface3dZoom = Math.max(0.4, Math.min(2.5, surface3dZoom * Math.exp(-delta * 0.001))); startTouch = null; redraw(); return;
    }
    if (disposed || !appVisible || !currentView() || !scrollArea || !scrollMax || !Number.isFinite(event.deltaY)) return;
    if (Number.isFinite(event.clientX) && (event.clientX < scrollArea.x || event.clientX > scrollArea.x + scrollArea.width)) return;
    if (Number.isFinite(event.clientY) && (event.clientY < scrollArea.y || event.clientY > scrollArea.y + scrollArea.height)) return;
    const scale = event.deltaMode === 1 ? 20 : event.deltaMode === 2 ? scrollArea.height : 1;
    const next = Math.max(0, Math.min(scrollMax, cabinScroll + event.deltaY * scale));
    closeNumberInput(); orderDrag = null; orderArmed = null; startTouch = null;
    if (next !== cabinScroll) { cabinScroll = next; redraw(); }
  });
  platform.onHide(() => { closeNumberInput(); orderDrag = null; orderArmed = null; platform.resetInput?.(); clearEmote(); clearUserInfoControl(); appVisible = false; contribution.setForeground(false); visibilityGeneration++; profileHideCount++; friendsGeneration++; helpGeneration++; cabinGeneration++; cancelFileTask(); clearBoardView(); isOnline() ? online.background() : session.hide(); });
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
  platform.setupShare(() => isOnline() ? online.sharePayload() : { title: TEXT.zh.title });
  resize();
  void localSession.restore().then(async restored => {
    if (disposed || !appVisible || session !== localSession || scene !== 'game' || cabin) return;
    // A damaged save remains untouched; retry is an explicit player action.
    if (!restored && invalidTurnOrder) { openCabin('board'); return; }
    if (!restored && !localSession.error && !localSession.snapshot && selectedTopologyDefinition()) await startNew();
    if (!restored && !localSession.error && !localSession.snapshot) await localSession.newGame(size,
      playerCount > 2 ? 'human' : mode, difficulty, playerCount,
      { startPlayer: currentTurnOrder(null)[0], turnOrder: currentTurnOrder(null), controllers, playOptions, boardShape, rootMode, startingPointMode, initialPositions,
        ...(startingPointMode !== 'random' && initialRoots ? { initialRoots } : {}) });
    if (!restored && localSession.snapshot && !localSession.actions.length) beginContribution();
    if (disposed || !appVisible || session !== localSession || scene !== 'game' || cabin) return;
    if (restored && localSession.snapshot && !localSession.error) localSession.resume();
    const invite = platform.launchOptions?.().query?.room;
    if (invite) void friendsMenu(invite);
    redraw();
  });
  // Returned only to the caller; preview tests can inspect the same UI geometry.
  return { get session() { return session; }, online, getButtons: () => buttons.map(({ action, ...rest }) => rest), getLayout: () => layout,
    getStartPreview: () => scene === 'starts' && startPreviewRandom ? JSON.parse(JSON.stringify(startDraftRoots)) : null,
    getTopologyLayout: () => topologyDraftLayout ?? topologyPreviewLayout, getEditorLayout: () => editorLayout,
    getScene: () => scene, getCabin: () => scene === 'home' ? 'board' : cabin, tap, redraw, dispose: () => { closeNumberInput(); platform.numberKeyboard?.destroy?.(); orderDrag = null; clearTimeout(surface3dTimer); surface3dRenderer?.destroy(); surface3dRenderer = null; platform.disposeInput?.(); clearTimeout(roomClockTimer); clearEmote(); clearUserInfoControl(); if (typeof privacyAuthorization === 'function') privacyAuthorization(); else privacyAuthorization?.dispose?.(); disposed = true; stopNetworkListener?.(); guideImages.dispose(); appVisible = false; friendsGeneration++; helpGeneration++;
      readerCache.clear(); cancelFileTask(); contribution.dispose?.(); localSession.hide(); online.detach(); scheduler.cancel(); models.clear(); } };
}
