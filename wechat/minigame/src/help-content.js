import creditsZh from '../../../web/web前端/guide/Thanks.md';
import creditsEn from '../../../web/web前端/guide/Thanks.en.md';
import { guideDocument, multiplayerGuideSections } from './guide-content.js';

// Mobile reading edition of guide/rule/essential rule.md and GuideContent.js.
// Turn completion and scoring follow GameEngine; practice uses TutorialRunner.
const RULES = {
  zh: [
    ['territory', '围出领土，赢下对局', [
      '玩家轮流在三角或六边形棋盘的格点落子。己方节点与连线经过的格点始终计分，不要求闭合。己方点线隔开、与棋盘外界不连通的空腔逐个判断；没有敌方元素的空腔计分，包括甜甜圈形状的内孔。',
      '同一格点只计一次，棋盘上方的“领土”显示最终格点数，不比较色块看起来有多大。正常结算时，未认输玩家中领土最多者获胜；最高分相同则平局。',
    ], 1],
    ['connect', '连回你的起点', [
      '同一方向上无遮挡的己方节点会自动连线。你的节点与连线必须始终有一条路径连回己方初始点。',
      '点选棋盘，再点“确认落子”。开启“合法落点”时，小点会提示当前可落子的位置；不能落子的位置不会改变棋局。',
    ], 0],
    ['cut', '切断与清除', [
      '可以在敌方连线上落子，将那条连线切断。若敌方的一部分结构因此失去所有通往其初始点的路径，失联的节点与连线就会被清除。',
      '切断一条线不一定清除整片结构：如果还有其他路径连回起点，它们就仍然存活。',
    ], 2],
    ['protection', '起步保护', [
      '每一方初始点旁的有效相邻位置受到保护：三角形角点旁为两个，六边形角点旁为三个。其他玩家不能在那里落子，直接切线也不例外。',
    ]],
    ['triangle', '三点限制', [
      '不能主动摆出三个节点两两紧挨的最小三角形。',
      '例外是这一步直接落在敌方连线上进行切断；此时可豁免三点限制，其他合法性规则仍需满足。',
    ], 3],
    ['repetition', '同形禁手', [
      '不能用落子把全局节点与连线恢复到本局历史中已出现过的状态，避免双方反复切断、无限循环。',
      '因此，两个看起来相同的棋盘，若此前的历史不同，合法落点也可能不同。复盘试走会保留起点之前的完整动作历史。',
    ]],
    ['finish', '跳过、认输与结算', [
      '可以主动跳过；没有合法落点的玩家会自动跳过。当所有仍在场的玩家连续各跳过一次时，对局结束并比较领土。中间有人落子，连续跳过计数就重新开始。',
      '认输后不再参与轮转和胜者比较。其余未认输玩家继续；只剩一人时立即结束，由剩下的玩家获胜，即使其领土分数较低。',
      '本地计时若已开启，真人回合超时也会跳过；AI 计算、暂停、弹窗和切到后台时不计时。',
    ], 4],
  ],
  en: [
    ['territory', 'Enclose territory', [
      'Players take turns placing nodes on a triangular or hexagonal board. Your nodes and link points always score, even without a loop. Each pocket cut off from the board exterior by your points is checked separately; an enemy-free pocket counts, including a donut-shaped inner hole.',
      'Each grid point counts once. Use the territory score above the board, not the visual size of a colored region. At normal settlement, the highest score among players who have not resigned wins. Equal highest scores are a draw.',
    ], 1],
    ['connect', 'Stay connected', [
      'Friendly nodes on the same grid direction connect automatically when nothing blocks the line of sight. Your nodes and links must have a path back to your starting node.',
      'Tap a point, then Confirm move. With Legal points enabled, small dots show available moves. An illegal placement does not change the game.',
    ], 0],
    ['cut', 'Cut and clear', [
      'Place on an enemy link to cut it. Enemy nodes and links that lose every path back to their starting node are removed.',
      'One cut does not always clear the whole structure: another route back to the starting node can keep it alive.',
    ], 2],
    ['protection', 'Protected openings', [
      'All valid neighbors of each starting node are protected: two at triangular corners and three at hexagonal corners. Opponents cannot play there, even to cut a link.',
    ]],
    ['triangle', 'Three-point limit', [
      'You cannot voluntarily form the smallest triangle of three mutually adjacent nodes.',
      'A move placed directly on an enemy link to cut it is exempt from this formation limit. All other legality rules still apply.',
    ], 3],
    ['repetition', 'No repeating positions', [
      'A placement cannot recreate a global node-and-link state already reached in this game. This prevents endless cut-and-recut loops.',
      'Identical-looking boards can have different legal moves if their histories differ. Replay branches retain the full action history up to their starting point.',
    ]],
    ['finish', 'Passing and settling', [
      'You may pass. A player with no legal move passes automatically. The game ends when all remaining players pass consecutively once each; territory then decides the result. A placement resets the consecutive-pass count.',
      'Resigned players leave the turn order and cannot win. The remaining players continue. When only one player remains, that player wins immediately, even with a lower territory score.',
      'If the local turn clock is enabled, a human timeout also passes. AI calculation, pause, dialogs and background time do not consume turn time.',
    ], 4],
  ],
};

const CONTROLS = {
  zh: [
    ['play', '在手机上下棋', ['点选格点后确认落子，避免误触。密集棋盘可放大；放大后拖动查看其他区域。', '“棋盘”里可调整领土、合法点、上一步、坐标和清晰配色。教学会保留必要标记。']],
    ['pause', '暂停与继续', ['离开棋盘阅读帮助，会暂停本地 AI 和计时。返回后点“继续对局”再下。好友房间不会因你阅读帮助而暂停，对方仍可行动。', '每一步会保存在本机。“我的棋谱”保留最近 100 局，存满后自动删除最早保存的棋谱，不影响开始新局。空间不足时会优先清理旧棋谱；重要对局可提前导出。手机系统清理数据或换设备可能使本机记录丢失。']],
    ['replay', '复盘与试走', ['在棋盘舱进入复盘，可逐步查看、自动播放或跳到指定步数。棋盘上方直接提供本步解读、策略建议和从此步试走。', '试走先保存完整原局，再从当前步建立新局；在线房间和终局不能直接试走。策略分值不是胜率。', '在“我的棋谱”可主动复制或粘贴单份网页 JSON 棋谱。导入先校验，不会直接覆盖正在玩的棋局。']],
  ],
  en: [
    ['play', 'Playing on a phone', ['Select a point, then confirm the move. Zoom in on dense boards and drag to inspect other areas.', 'Board options control territory, legal points, last move, coordinates and contrast. Lessons keep essential markers visible.']],
    ['pause', 'Pause and continue', ['Opening help pauses the local AI and clock. Use Continue game after returning. A friend room keeps running while you read; your opponent can still play.', 'Each move is saved on this device. My replays keeps the latest 100 games and removes the oldest saved replay when full, without blocking a new game. Older replays may also be removed when storage is low; export important games first. Device cleanup or changing phones can lose local records.']],
    ['replay', 'Review and try a line', ['Open Replay in the Board cabin to step through, play back or jump to a move. Move inspection, strategy suggestions and branching appear directly above the board.', 'A branch saves the complete original before starting from the displayed position. Online rooms and terminal positions cannot branch. Strategy scores are not win probabilities.', 'My replays lets you explicitly copy or paste one Web JSON replay. Imports are validated before use and do not immediately replace the active game.']],
  ],
};

export function helpDocument(kind, language, onlineEnabled = false) {
  const lang = language === 'en' ? 'en' : 'zh';
  const guide = guideDocument(kind, lang);
  if (guide) return guide;
  if (kind === 'rules' || kind === 'controls') return [
    ...(kind === 'rules' ? RULES : CONTROLS)[lang].map(([id, title, paragraphs, lesson]) => ({ id, title, paragraphs, lesson })),
    ...(kind === 'rules' ? multiplayerGuideSections(lang) : [])];
  if (kind === 'credits') return (lang === 'zh' ? creditsZh : creditsEn).trim().split(/\r?\n/).filter(Boolean).map((line, index) => {
    // Preserve the exact contributor wording/order, including language differences.
    const separator = line.search(/[:：]/), title = separator < 0 ? (lang === 'zh' ? '致谢' : 'Credits') : line.slice(0, separator);
    return { id: `credits-${index}`, title, paragraphs: [separator < 0 ? line : line.slice(separator + 1).trim()], sourceLine: line };
  });
  if (kind === 'privacy') return [{ id: 'privacy', title: lang === 'zh' ? '数据与隐私' : 'Data & privacy', paragraphs: lang === 'zh' ? [
    '本地对局、棋谱、教程进度和偏好保存在本机。AI 训练贡献默认关闭；当前贡献协议仅接受 territory-v2 对局，默认 territory-v3 新局不会上传或混入旧数据集。主动同意后，仅符合协议的后续完整本地对局才会提交，供研究筛选。关闭可清除待传记录，已收到的记录不会自动撤回。游戏昵称和头像由你主动编辑、选择，或授权从微信导入；仅处理所选图片，不读取通讯录。只有主动导入或复制棋谱时才读写剪贴板。',
    '实验 AI 在本机计算，首次使用会通过微信下载模型分包。普通电脑与基础玩法无需加载这些模型。符合 territory-v2 协议的贡献记录可包含 2–6 人、三角或六边形棋盘及不同起点，并标注 AI、提示、计时与悔棋使用情况。当前默认 territory-v3 新局不符合此协议，不会上传。好友联机目前只支持双人，不参与本地训练贡献。',
    onlineEnabled ? '进入微信账号或好友对战时会先提示联机说明，确认后使用微信登录标识建立游戏账号，服务器保存房间与动作以便重连。本机会记录你确认的服务地址、说明版本和本机时间；服务地址或说明更新后，再次进入时会重新提示。可选择通过一次性绑定码关联已有网页版账号。首次导入微信昵称和头像需点击微信授权按钮；已授权后可再次读取。自选昵称和头像先在本机按账号保存，再尝试同步服务器；同步失败会标为待同步。头像会裁切、缩小，不上传原始照片；同步后的资料会在联机中展示。解除关联保留原网页版账号。删除微信联机账号会另行确认并核验微信身份，清除该账号的本机资料及服务器相关房间，本地单机存档和原网页版账号保留。不读取好友列表。'
      : '此版本尚未开放好友联机，不会为离线游戏发起微信账号登录。没有接入广告、支付或自由聊天。',
  ] : [
    'Local games, replays, lesson progress and preferences stay on this device. AI training contribution is off by default. The current protocol accepts territory-v2 games only; new default territory-v3 games are not uploaded or mixed into that older dataset. With explicit consent, only eligible complete local games started afterward are submitted for research review. Turning it off clears pending uploads; received records are not automatically withdrawn. You edit or choose your game name and avatar, or authorize importing them from WeChat. Only the selected image is processed. Contacts are never read. Clipboard access occurs only when you choose import or copy.',
    'Experimental AI runs on the device. First use downloads model packages through WeChat. Standard AI and basic play do not need these packages. Eligible territory-v2 records may cover 2–6 players, either board shape, different starting points and AI types, with hint, timer and undo use marked. The current default territory-v3 games are not eligible and will not upload. Friend rooms currently have two players and are excluded from local training contribution.',
    onlineEnabled ? 'Opening WeChat accounts or friend play and consenting uses your WeChat login identifier. Rooms and actions are stored for reconnection. This device records the service address, notice version and local confirmation time; a different service or notice prompts again on entry. You may link an existing Web account using a one-time code. Importing your WeChat name and avatar first requires tapping the WeChat authorization button; authorized information can be read again later. Your chosen profile is saved on this device per account before a server sync is attempted; failures remain pending. Avatars are cropped and resized; the original photograph is not uploaded. Synced profiles are displayed in online play. Unlinking preserves the original Web account. Deleting the WeChat identity requires fresh confirmation and removes its local profile and server rooms, while local games and the original Web account remain. Friend lists are never read.'
      : 'Friend play is not enabled in this version. Offline play does not request a WeChat account login. Ads, payments and free-form chat are not included.',
  ] }];
  throw new Error('UNKNOWN_HELP_DOCUMENT');
}

// Winner and scores come from the exact engine snapshot, never display geometry.
export function summarizeResult(snapshot) {
  if (!snapshot?.gameOver) return null;
  const resigned = new Set(snapshot.resignedPlayers || []);
  const remaining = snapshot.players.filter(player => !resigned.has(player));
  return { winner: snapshot.winner,
    reason: resigned.size && remaining.length === 1 ? 'resignation' : 'territory',
    rows: snapshot.players.map(player => ({ player, area: snapshot.territories[player].area,
      resigned: resigned.has(player), winner: player === snapshot.winner })),
  };
}
