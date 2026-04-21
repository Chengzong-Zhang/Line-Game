import { Player } from "./GameEngine.js?v=20260420a";
import { ALL_PLAYERS } from "./OnlineAppState.js?v=20260420a";

const EN_TEXTS = Object.freeze({
  pageTitle: "TriAxis Web Arena",
  languageLabel: "Language",
  heroTitle: "TriAxis Web Arena",
  heroCopy: "Rules still run in the browser. The FastAPI relay server only creates rooms and forwards match actions.",
  statusLabel: "Match Feed",
  boardTitle: "Triangular Board",
  boardEyebrow: "Board",
  boardAriaLabel: "TriAxis triangular board",
  localControls: "Local Controls",
  controlsEyebrow: "Local Controls",
  boardStatus: "Board Status",
  boardStatusEyebrow: "Match State",
  onlineMatch: "Online Match",
  onlineEyebrow: "Relay Room",
  connectServer: "Connect Server",
  createRoom: "Create Room",
  joinRoom: "Join Room",
  leaveRoom: "Leave Room",
  serverAddress: "Server Address",
  roomId: "Room ID",
  roomPlaceholder: "Enter 4-digit room ID",
  roomLabel: "Room",
  playerLabel: "Player",
  playerCountLabel: "Players",
  gridSizeLabel: "Board Size",
  yourSide: "Your Side",
  turnCount: "Turn Count",
  legalMoves: "Legal Moves",
  blueTerritory: "Blue Territory",
  redTerritory: "Red Territory",
  purpleTerritory: "Purple Territory",
  setupLabel: "Match Setup",
  lockedLabel: "Locked",
  area: "Area",
  turnSuffix: "Turn",
  gameOver: "Game Over",
  whatIsConnect: "What does \"Connect Server\" do?",
  connectExplanation: "It connects to the WebSocket address above so you can create rooms, join rooms, and sync moves. This stays as a separate button because solo play does not need the network, and you may want to edit the local or cloud server address before opening the connection.",
  soloHelp: "In solo mode you can click the board, skip a turn, or reset the match at any time.",
  onlineOverHelp: "This online round is over. Starting the next round keeps the same room and all players.",
  onlinePlayHelp: "Any player may skip on their own turn. If a side has no legal moves, the engine auto-skips that turn. Restarting an unfinished online match is treated as a resignation request.",
  startNewSolo: "Start New Solo Match",
  resetBoard: "Reset Board",
  startNextOnline: "Start Next Online Match",
  resignAndRestart: "Resign And Restart",
  idle: "Idle",
  connecting: "Connecting",
  connected: "Connected",
  reconnecting: "Reconnecting",
  disconnected: "Disconnected",
  error: "Connection Error",
  solo: "Solo Mode",
  waiting: "Waiting",
  ready: "Room Ready",
  offline: "Room Offline",
  inProgress: "In Progress",
  draw: "Draw",
  unassigned: "Unassigned",
  waitingStatus: (roomId) => `Room ${roomId ?? "--"} is waiting for more players.`,
  offlineStatus: "Connection was lost. Reconnect to the relay server before continuing the online match.",
  finalStatus: (winner, scoreLine) => `${winner}. Final score: ${scoreLine}.`,
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
  opponentLeft: "A player left the room. Waiting for the room to fill again or for a reconnect.",
  unknownServer: "The server returned an unknown error.",
  continueMatch: "Continue Match",
  resignedSummary: (winner, loser) => `${winner}. ${loser} resigned and the board has been reset.`,
});

const ZH_TEXTS = Object.freeze({
  pageTitle: "TriAxis 网页版",
  languageLabel: "语言",
  heroTitle: "TriAxis 网页版",
  heroCopy: "规则计算仍在浏览器内完成，FastAPI 中继服务只负责创建房间、同步状态和转发对局操作。",
  statusLabel: "对局播报",
  boardTitle: "三角棋盘",
  boardEyebrow: "棋盘",
  boardAriaLabel: "TriAxis 三角棋盘",
  localControls: "本地操作",
  controlsEyebrow: "本地操作",
  boardStatus: "棋盘状态",
  boardStatusEyebrow: "对局状态",
  onlineMatch: "联机对局",
  onlineEyebrow: "联机房间",
  connectServer: "连接服务器",
  createRoom: "创建房间",
  joinRoom: "加入房间",
  leaveRoom: "离开房间",
  serverAddress: "服务器地址",
  roomId: "房间号",
  roomPlaceholder: "输入 4 位房间号",
  roomLabel: "房间",
  playerLabel: "玩家",
  playerCountLabel: "玩家人数",
  gridSizeLabel: "棋盘边长",
  yourSide: "你的阵营",
  turnCount: "回合数",
  legalMoves: "合法落点",
  blueTerritory: "蓝方领地",
  redTerritory: "红方领地",
  purpleTerritory: "紫方领地",
  setupLabel: "对局设置",
  lockedLabel: "已锁定",
  area: "面积",
  turnSuffix: "回合",
  gameOver: "对局结束",
  whatIsConnect: "“连接服务器”是做什么的？",
  connectExplanation: "它会连接上方填写的 WebSocket 地址，用来创建房间、加入房间并同步联机对局。之所以保留单独的连接按钮，是因为本地模式不需要联网，而且你可能会先修改本地或云端地址，再决定何时连接。",
  soloHelp: "本地模式下，你可以随时点击棋盘、跳过回合，或直接重开一局。",
  onlineOverHelp: "这一局联机对战已经结束。开始下一局时会保留当前房间和玩家。",
  onlinePlayHelp: "所有玩家都可以在自己的回合选择跳过。若一方没有合法落点，引擎会自动跳过。联机中途重开需要所有玩家确认。",
  startNewSolo: "开始新的本地对局",
  resetBoard: "重置棋盘",
  startNextOnline: "开始下一局联机对战",
  resignAndRestart: "认输并重开",
  idle: "未连接",
  connecting: "连接中",
  connected: "已连接",
  reconnecting: "重连中",
  disconnected: "已断开",
  error: "连接异常",
  solo: "本地模式",
  waiting: "等待中",
  ready: "房间已就绪",
  offline: "房间离线",
  inProgress: "对局进行中",
  draw: "平局",
  unassigned: "未分配",
  waitingStatus: (roomId) => `房间 ${roomId ?? "--"} 已创建，等待其余玩家加入。`,
  offlineStatus: "连接已断开，继续联机对局前请先重新连接服务器。",
  finalStatus: (winner, scoreLine) => `${winner}。最终比分：${scoreLine}。`,
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
  opponentLeft: "有玩家离开了房间，正在等待重新加入或新的连接。",
  unknownServer: "服务器返回了未知错误。",
  continueMatch: "继续",
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
  return message;
}
