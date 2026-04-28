import { Player } from "./GameEngine.js?v=20260421a";
import { ALL_PLAYERS } from "./OnlineAppState.js?v=20260421a";

// 文案、比分格式化和错误提示都集中放在这里，避免 UI 文件里散落大量字符串。

const EN_TEXTS = Object.freeze({
  pageTitle: "LIFELINE",
  languageLabel: "Language",
  heroTitle: "LIFELINE",
  heroCopy: "Rules still run in the browser. The FastAPI relay server only creates rooms and forwards match actions.",
  statusLabel: "Match Feed",
  stageFocusEyebrow: "Center Stage",
  boardDockTitle: "Board Deck",
  boardDockCopy: "Setup, status, and local actions",
  guideDockTitle: "Guide Deck",
  guideDockCopy: "Rules, design notes, and credits",
  guideDockBadge: "3 groups",
  networkDockTitle: "Lobby Deck",
  localShort: "Local",
  networkDockCopy: "Online rooms and account",
  guideEyebrow: "Reading Room",
  guideTitle: "Guide",
  guideRulesEyebrow: "Rules",
  guideRulesTitle: "Rules",
  guideRulesCopy: "Keep this section folded by default, then open the version you want to read in the centered panel.",
  guideRulesOpen: "Open the three rule versions",
  guideRuleSimpleTitle: "Essential",
  guideRuleSimpleSubtitle: "The shortest way to learn",
  guideRuleWarTitle: "Metaphor",
  guideRuleWarSubtitle: "Understand it as a war story",
  guideRuleMathTitle: "Abstract",
  guideRuleMathSubtitle: "Graph theory and game theory flavor",
  guideWhyEyebrow: "Why It Works",
  guideWhyTitle: "Why It Works",
  guideWhySubtitle: "What makes this game special",
  guideWhyTalkTitle: "Talk",
  guideWhyTalkSubtitle: "Expansion and fragile supply lines",
  guideWhyCodeTitle: "Code",
  guideWhyCodeSubtitle: "Physical grid, logical graph",
  guideWhyTheoryTitle: "Theory",
  guideWhyTheorySubtitle: "Quadratic board, cubic visibility",
  guideThanksEyebrow: "Thanks",
  guideThanksTitle: "Thanks",
  guideThanksSubtitle: "All agents involved in the game",
  guideCloseAction: "Close",
  guideIllustrationCaption: "Board sketch: nodes auto-connect, cutting an enemy line can erase its disconnected parts.",
  openPanelAction: "Open Panel",
  languageZhAction: "中文",
  languageEnAction: "English",
  toggleOn: "ON",
  toggleOff: "OFF",
  skipTurnAction: "Skip Turn",
  closePanel: "Close Panel",
  boardTitle: "Triangular Board",
  boardEyebrow: "Board",
  boardAriaLabel: "TriAxis triangular board",
  localControls: "Local Controls",
  controlsEyebrow: "Local Controls",
  duelDeskTitle: "Duel Desk",
  currentTurnLabel: "Current Turn",
  boardStatus: "Board Status",
  boardStatusEyebrow: "Match State",
  onlineMatch: "Online Match",
  onlineEyebrow: "Relay Room",
  authEyebrow: "Account",
  authTitle: "Player Login",
  authLoggedIn: "Welcome",
  authRequired: "Log in before connecting to online rooms.",
  authUsername: "Username",
  authPassword: "Password",
  authLoginTab: "Login",
  authRegisterTab: "Register",
  authLoginAction: "Log In",
  authRegisterAction: "Create Account",
  authLogout: "Log Out",
  authRegisterSuccess: "Registration succeeded. Please log in with your new account.",
  connectServer: "Connect Server",
  createRoom: "Create Room",
  joinRoom: "Join Room",
  leaveRoom: "Leave Room",
  readyAction: "Ready",
  cancelReadyAction: "Cancel Ready",
  closePrompt: "Close Prompt",
  roomLobby: "Room Lobby",
  roomControls: "Host Controls",
  roomPlayers: "Players",
  roomYou: "You",
  roomHost: "Host",
  roomReadyTag: "Ready",
  roomIdleTag: "Idle",
  roomOfflineTag: "Offline",
  starterLabel: "First Move",
  startCountdown: "Starting Soon",
  roomId: "Room ID",
  roomPlaceholder: "Enter 4-digit room ID",
  roomLabel: "Room",
  playerLabel: "Player",
  playerCountLabel: "Players",
  gridSizeLabel: "Board Size",
  turnTimerLabel: "Turn Timer",
  turnTimerDurationLabel: "Timer Seconds",
  turnTimerHint: "Enable a per-turn countdown. When it reaches zero, the current side auto-skips.",
  yourSide: "Your Side",
  turnCount: "Turn Count",
  legalMoves: "Legal Moves",
  blueTerritory: "Blue Territory",
  redTerritory: "Red Territory",
  purpleTerritory: "Purple Territory",
  setupLabel: "Match Setup",
  lockedLabel: "Locked",
  area: "Area",
  territorySuffix: " Territory",
  turnSuffix: " Turn",
  gameOver: "Game Over",
  whatIsConnect: 'What does "Connect Server" do?',
  connectExplanation: "It connects to the configured WebSocket server so you can create rooms, join rooms, and sync moves. This stays as a separate button because solo play does not need the network.",
  soloHelp: "In solo mode you can click the board, skip a turn, or reset the match at any time.",
  onlineOverHelp: "This online round is over. Starting the next round keeps the same room and all players.",
  onlinePlayHelp: "Any player may skip on their own turn. If a side has no legal moves, the engine auto-skips that turn. Restarting an unfinished online match is treated as a resignation request.",
  startNewSolo: "Start New Solo Match",
  resetBoard: "Reset Board",
  concedeAction: "Concede",
  startNextOnline: "Start Next Online Match",
  resignAndRestart: "Resign And Restart",
  countdownLabel: (seconds) => `Countdown ${seconds}s`,
  countdownPaused: "Countdown Paused",
  countdownFinished: "Countdown Ended",
  skipNotice: (player) => `${player} skipped the turn.`,
  idle: "Idle",
  connecting: "Connecting",
  connected: "Connected",
  reconnecting: "Reconnecting",
  disconnected: "Disconnected",
  error: "Connection Error",
  solo: "Solo Mode",
  waiting: "Waiting",
  lobby: "Lobby",
  countdown: "Countdown",
  ready: "Room Ready",
  offline: "Room Offline",
  inProgress: "In Progress",
  draw: "Draw",
  unassigned: "Unassigned",
  waitingStatus: (roomId) => `Room ${roomId ?? "--"} is waiting for more players.`,
  lobbyStatus: "Everyone is in the room. Adjust settings or click Ready to begin the next round.",
  countdownStatus: (seconds) => `Both sides agreed. Match starts in ${seconds}s.`,
  turnTimerStatus: (seconds) => `Turn timer: ${seconds}s`,
  offlineStatus: "Connection was lost. Reconnect to the relay server before continuing the online match.",
  playingStatus: "Both sides are ready and the match is live.",
  finalStatus: (winner, scoreLine) => `${winner}. Final score: ${scoreLine}.`,
  victorySuffix: " Wins",
  defeatSuffix: " Loses",
  localTurnStatus: (side) => `It is your turn as ${side}. Click a legal point to play, skip the turn, or resign and restart.`,
  remoteTurnStatus: "It is another player's turn. The board stays locked until their move arrives through WebSocket.",
  soloBlueStatus: "Solo mode: Blue to move.",
  soloRedStatus: "Solo mode: Red to move.",
  soloPurpleStatus: "Solo mode: Purple to move.",
  waitingHint: "The room exists, but the board stays locked until every player is present.",
  notYourTurnHint: "It is another player's turn. Their move will be applied to your local board automatically.",
  networkUnavailableHint: "Network unavailable. Reconnect before continuing the online match.",
  opponentOfflineHint: "Another player disconnected, so the board stays locked until the room is ready again.",
  multiplayerHint: "Skipping is synchronized for everyone in the room. Restarting an unfinished online match requires every player to confirm.",
  soloHint: "Solo mode is still available. Click a board vertex to place a node.",
  joinRoomRequired: "Please enter a 4-digit room ID before joining.",
  invalidWebSocket: "Please enter a valid WebSocket address.",
  connectFailed: (url) => `Failed to connect to ${url}. Make sure the server is running.`,
  socketClosed: "The WebSocket connection was closed. Reconnect to the server and try again.",
  websocketNotConnected: "The WebSocket is not connected yet. Click Connect Server first.",
  websocketSendBlocked: "The connection is not open yet, so the message cannot be sent.",
  timeout: "Timed out while waiting for the server response. Please try again.",
  invalidJson: "The server returned invalid JSON data.",
  invalidPayload: "The server returned an unsupported payload.",
  roomNotFound: (roomId) => `Room ${roomId} does not exist. Check the room ID and try again.`,
  roomFull: (roomId) => `Room ${roomId} is full.`,
  playerAlreadyConnected: "This player session is already connected elsewhere.",
  authTokenRequired: "Please log in before connecting to an online room.",
  authInvalidToken: "Your login has expired or is invalid. Please log in again.",
  authUsernameExists: "That username is already taken.",
  authInvalidCredentials: "Incorrect username or password.",
  authUsernameEmpty: "Username cannot be empty.",
  opponentLeft: "A player left the room. Waiting for the room to fill again or for a reconnect.",
  roomNeedReady: "The room is full. Waiting for everyone to get ready.",
  roomSettingsChanged: "The host updated the room settings, so every ready status was reset.",
  hostOnlyAction: "Only the host can change this room option.",
  roomCapacityConflict: "The new player count is smaller than the number of players already in the room.",
  unknownServer: "The server returned an unknown error.",
  continueMatch: "Continue Match",
  leaveRoomAfterMatch: "Leave Room",
  matchInProgress: "Match is already in progress.",
  resignedSummary: (winner, loser) => `${winner}. ${loser} resigned and the board has been reset.`,
});

const ZH_TEXTS = Object.freeze({
  pageTitle: "生命线",
  languageLabel: "语言",
  heroTitle: "生命线",
  heroCopy: "规则计算仍在浏览器内完成，FastAPI 中继服务只负责创建房间、同步状态和转发对局操作。",
  statusLabel: "对局播报",
  stageFocusEyebrow: "核心棋盘",
  boardDockTitle: "棋盘舱",
  boardDockCopy: "收纳设置、状态与本地操作",
  guideDockTitle: "指南舱",
  guideDockCopy: "收纳规则、设计妙处与致谢",
  guideDockBadge: "3组",
  networkDockTitle: "联机舱",
  localShort: "本地",
  networkDockCopy: "收纳联机对局与账号系统",
  guideEyebrow: "阅读区",
  guideTitle: "指南",
  guideRulesEyebrow: "规则",
  guideRulesTitle: "规则",
  guideRulesCopy: "这个板块默认折叠，展开后可以选择三个版本，并在中间弹窗里阅读。",
  guideRulesOpen: "展开三个规则版本",
  guideRuleSimpleTitle: "简洁版",
  guideRuleSimpleSubtitle: "最短时间上手规则",
  guideRuleWarTitle: "比喻版",
  guideRuleWarSubtitle: "用战争故事来理解",
  guideRuleMathTitle: "抽象废话版",
  guideRuleMathSubtitle: "图论、博弈论与强化学习视角",
  guideWhyEyebrow: "妙处",
  guideWhyTitle: "妙处",
  guideWhySubtitle: "这个游戏好在哪",
  guideWhyTalkTitle: "Talk（直觉）",
  guideWhyTalkSubtitle: "扩张与脆弱的战争张力",
  guideWhyCodeTitle: "Code（工程）",
  guideWhyCodeSubtitle: "物理与逻辑的优雅分离",
  guideWhyTheoryTitle: "Theory（理论）",
  guideWhyTheorySubtitle: "算力深渊与上帝的简洁逻辑",
  guideThanksEyebrow: "致谢",
  guideThanksTitle: "致谢",
  guideThanksSubtitle: "参与这个游戏的所有智能体",
  guideCloseAction: "关闭阅读",
  guideIllustrationCaption: "规则插图：同色节点会自动连线，切断敌线后，失去连通的部分会被清掉。",
  openPanelAction: "打开面板",
  languageZhAction: "中文",
  languageEnAction: "English",
  toggleOn: "ON",
  toggleOff: "OFF",
  skipTurnAction: "跳过回合",
  closePanel: "关闭面板",
  boardTitle: "三角棋盘",
  boardEyebrow: "棋盘",
  boardAriaLabel: "TriAxis 三角棋盘",
  localControls: "本地操作",
  controlsEyebrow: "本地操作",
  duelDeskTitle: "对弈模块",
  currentTurnLabel: "当前回合",
  boardStatus: "棋盘状态",
  boardStatusEyebrow: "对局状态",
  onlineMatch: "联机对局",
  onlineEyebrow: "联机房间",
  authEyebrow: "账号系统",
  authTitle: "玩家登录",
  authLoggedIn: "欢迎",
  authRequired: "进入联机房间前，请先登录账号。",
  authUsername: "用户名",
  authPassword: "密码",
  authLoginTab: "登录",
  authRegisterTab: "注册",
  authLoginAction: "登录",
  authRegisterAction: "创建账号",
  authLogout: "退出登录",
  authRegisterSuccess: "注册成功，请使用新账号登录。",
  connectServer: "连接服务器",
  createRoom: "创建房间",
  joinRoom: "加入房间",
  leaveRoom: "离开房间",
  readyAction: "准备",
  cancelReadyAction: "取消准备",
  closePrompt: "关闭提示框",
  roomLobby: "房间大厅",
  roomControls: "房主控制",
  roomPlayers: "房间成员",
  roomYou: "你",
  roomHost: "房主",
  roomReadyTag: "准备中",
  roomIdleTag: "未准备",
  roomOfflineTag: "离线",
  starterLabel: "先手方",
  startCountdown: "即将开局",
  roomId: "房间号",
  roomPlaceholder: "输入 4 位房间号",
  roomLabel: "房间",
  playerLabel: "玩家",
  playerCountLabel: "玩家人数",
  gridSizeLabel: "棋盘边长",
  turnTimerLabel: "读秒开关",
  turnTimerDurationLabel: "读秒时长",
  turnTimerHint: "开启后，每回合都会独立倒计时；归零时会自动跳过当前回合。",
  yourSide: "你的阵营",
  turnCount: "回合数",
  legalMoves: "合法落点",
  blueTerritory: "蓝方领地",
  redTerritory: "红方领地",
  purpleTerritory: "紫方领地",
  setupLabel: "对局设置",
  lockedLabel: "已锁定",
  area: "面积",
  territorySuffix: "领土",
  turnSuffix: "回合",
  gameOver: "对局结束",
  whatIsConnect: "“连接服务器”是做什么的？",
  connectExplanation: "它会连接已配置好的 WebSocket 服务器，用来创建房间、加入房间并同步联机对局。之所以保留单独的连接按钮，是因为本地模式不需要联网。",
  soloHelp: "本地模式下，你可以随时点击棋盘、跳过回合，或直接重开一局。",
  onlineOverHelp: "这一局联机对战已经结束。开始下一局时会保留当前房间和所有玩家。",
  onlinePlayHelp: "所有玩家都可以在自己的回合选择跳过。若一方没有合法落点，引擎会自动跳过。联机中途重开会被视为发起重置确认。",
  startNewSolo: "开始新的本地对局",
  resetBoard: "重置棋盘",
  concedeAction: "认输",
  startNextOnline: "开始下一局联机对战",
  resignAndRestart: "认输并重开",
  countdownLabel: (seconds) => `读秒 ${seconds} 秒`,
  countdownPaused: "读秒暂停",
  countdownFinished: "读秒结束",
  skipNotice: (player) => `${player}刚刚选择了跳过回合。`,
  idle: "未连接",
  connecting: "连接中",
  connected: "已连接",
  reconnecting: "重连中",
  disconnected: "已断开",
  error: "连接异常",
  solo: "本地模式",
  waiting: "等待中",
  lobby: "大厅中",
  countdown: "倒计时",
  ready: "房间已就绪",
  offline: "房间离线",
  inProgress: "对局进行中",
  draw: "平局",
  unassigned: "未分配",
  waitingStatus: (roomId) => `房间 ${roomId ?? "--"} 已创建，等待其余玩家加入。`,
  lobbyStatus: "房间成员已到齐。你可以调整设置，或点击“准备”进入下一局。",
  countdownStatus: (seconds) => `双方都已同意，将在 ${seconds} 秒后开始对局。`,
  turnTimerStatus: (seconds) => `当前读秒：${seconds} 秒`,
  offlineStatus: "连接已断开，继续联机对局前请先重新连接服务器。",
  playingStatus: "双方已准备，对局已开始。",
  finalStatus: (winner, scoreLine) => `${winner}。最终比分：${scoreLine}。`,
  victorySuffix: "胜利",
  defeatSuffix: "失败",
  localTurnStatus: (side) => `现在轮到你操作，你是${side}。点击合法落点即可下子，也可以选择跳过回合或认输重开。`,
  remoteTurnStatus: "现在是其他玩家的回合，棋盘会暂时锁定，等待对方通过 WebSocket 传来操作。",
  soloBlueStatus: "本地模式中，现在轮到蓝方。",
  soloRedStatus: "本地模式中，现在轮到红方。",
  soloPurpleStatus: "本地模式中，现在轮到紫方。",
  waitingHint: "房间已经存在，但所有玩家进入前，棋盘会保持锁定。",
  notYourTurnHint: "现在不是你的回合。对方的操作会自动同步到你的本地棋盘。",
  networkUnavailableHint: "网络不可用，请先重新连接，再继续联机对局。",
  opponentOfflineHint: "有玩家断开连接，房间重新就绪前棋盘会保持锁定。",
  multiplayerHint: "跳过回合同步给房间内所有人。重开未结束的联机对局需要所有玩家确认，最后确认的人会被记为该轮获胜方。",
  soloHint: "你也可以继续本地单机模式，直接点击棋盘顶点落子。",
  joinRoomRequired: "加入房间前，请先输入 4 位房间号。",
  invalidWebSocket: "请输入有效的 WebSocket 地址。",
  connectFailed: (url) => `无法连接到 ${url}。请确认服务器是否已启动。`,
  socketClosed: "WebSocket 连接已关闭，请重新连接服务器。",
  websocketNotConnected: "WebSocket 尚未连接，请先点击“连接服务器”。",
  websocketSendBlocked: "连接尚未建立完成，暂时无法发送消息。",
  timeout: "等待服务器响应超时，请稍后重试。",
  invalidJson: "服务器返回了无效的 JSON 数据。",
  invalidPayload: "服务器返回了无法识别的数据。",
  roomNotFound: (roomId) => `房间 ${roomId} 不存在，请检查房间号。`,
  roomFull: (roomId) => `房间 ${roomId} 已满。`,
  playerAlreadyConnected: "这个玩家会话已经在别处连接。",
  authTokenRequired: "进入联机房间前，请先登录账号。",
  authInvalidToken: "登录状态已失效，请重新登录。",
  authUsernameExists: "这个用户名已经被占用。",
  authInvalidCredentials: "用户名或密码错误。",
  authUsernameEmpty: "用户名不能为空。",
  opponentLeft: "有玩家离开了房间，正在等待重新加入或新的连接。",
  roomNeedReady: "房间成员已到齐，等待所有人准备后开始。",
  roomSettingsChanged: "房主修改了房间设置，所有人的准备状态已重置。",
  hostOnlyAction: "只有房主可以修改这个房间选项。",
  roomCapacityConflict: "新的人数设置小于当前房间人数，无法应用。",
  unknownServer: "服务器返回了未知错误。",
  continueMatch: "继续",
  leaveRoomAfterMatch: "离开房间",
  matchInProgress: "对局已经开始，不能再次准备。",
  resignedSummary: (winner, loser) => `${winner}，${loser}认输，棋盘已重置。`,
});

export function getInitialLanguage() {
  const stored = globalThis.localStorage?.getItem("triaxis-language");
  return stored === "en" ? "en" : "zh";
}

export function getTexts(language) {
  return language === "en" ? EN_TEXTS : ZH_TEXTS;
}

export function formatArea(value) {
  return String(Math.round(Number(value ?? 0)));
}

export function formatPlayerName(player, language = "zh") {
  const texts = getTexts(language);
  if (player === Player.BLACK) {
    return language === "en" ? "Blue" : "蓝方";
  }
  if (player === Player.WHITE) {
    return language === "en" ? "Red" : "红方";
  }
  if (player === Player.PURPLE) {
    return language === "en" ? "Purple" : "紫方";
  }
  return texts.unassigned;
}

export function formatWinner(winner, language = "zh") {
  const texts = getTexts(language);
  if (winner === Player.BLACK) {
    return language === "en" ? "Blue Wins" : "蓝方获胜";
  }
  if (winner === Player.WHITE) {
    return language === "en" ? "Red Wins" : "红方获胜";
  }
  if (winner === Player.PURPLE) {
    return language === "en" ? "Purple Wins" : "紫方获胜";
  }
  if (winner === "DRAW") {
    return texts.draw;
  }
  return texts.inProgress;
}

export function formatConnectionState(state, language = "zh") {
  const texts = getTexts(language);
  return texts[state] ?? state;
}

export function formatFinalScoreLine(scores, language = "zh", players = ALL_PLAYERS) {
  const parts = players
    .filter((player) => scores && Object.prototype.hasOwnProperty.call(scores, player))
    .map((player) => `${formatPlayerName(player, language)}${language === "en" ? " " : ""}${formatArea(scores[player])}`);

  return parts.join(language === "en" ? ", " : "，");
}

export function formatResetVoteMessage(confirmedVotes, requiredVotes, language = "zh") {
  if (language === "en") {
    return `Reset confirmed ${confirmedVotes}/${requiredVotes}. Waiting for the remaining players.`;
  }
  return `重置已确认 ${confirmedVotes}/${requiredVotes}，等待其余玩家确认。`;
}

export function getNextPlayer(player) {
  const currentIndex = ALL_PLAYERS.indexOf(player);
  if (currentIndex < 0) {
    return null;
  }
  return ALL_PLAYERS[(currentIndex + 1) % ALL_PLAYERS.length];
}

export function localizeErrorMessage(message, language = "zh") {
  const texts = getTexts(language);
  if (!message) {
    return texts.unknownServer;
  }
  if (message === "Please enter a room ID before joining.") {
    return texts.joinRoomRequired;
  }
  if (message === "connect(url) requires a valid WebSocket URL.") {
    return texts.invalidWebSocket;
  }
  if (message.startsWith("Failed to connect to ")) {
    return texts.connectFailed(message.slice("Failed to connect to ".length));
  }
  if (message.startsWith("WebSocket closed:")) {
    return texts.socketClosed;
  }
  if (message === "WebSocket is not connected. Call connect(url) first.") {
    return texts.websocketNotConnected;
  }
  if (message === "Cannot send WebSocket message before the connection is open.") {
    return texts.websocketSendBlocked;
  }
  if (message.startsWith("Timed out waiting for ")) {
    return texts.timeout;
  }
  if (message === "Failed to parse incoming WebSocket payload as JSON.") {
    return texts.invalidJson;
  }
  if (message === "Incoming WebSocket payload must be a JSON object.") {
    return texts.invalidPayload;
  }
  if (message.startsWith("Room not found: ")) {
    return texts.roomNotFound(message.slice("Room not found: ".length));
  }
  if (message.startsWith("Room is full: ")) {
    return texts.roomFull(message.slice("Room is full: ".length));
  }
  if (message === "Player session is already connected.") {
    return texts.playerAlreadyConnected;
  }
  if (message === "Authentication token is required. Please log in first.") {
    return texts.authTokenRequired;
  }
  if (message === "WebSocket closed: 4401 invalid_token" || message === "WebSocket closed: 4401 missing_token") {
    return texts.authInvalidToken;
  }
  if (message === "Username already exists.") {
    return texts.authUsernameExists;
  }
  if (message === "Invalid username or password.") {
    return texts.authInvalidCredentials;
  }
  if (message === "Username cannot be empty.") {
    return texts.authUsernameEmpty;
  }
  if (message === "Only the host can update room settings.") {
    return texts.hostOnlyAction;
  }
  if (message === "The new player count is smaller than the current room roster.") {
    return texts.roomCapacityConflict;
  }
  if (message === "The room is still in the lobby. Wait for everyone to get ready.") {
    return texts.roomNeedReady;
  }
  if (message === "Match is already in progress.") {
    return texts.matchInProgress;
  }
  return message;
}
