import { implementationSections, withGuideContents } from '../../../web/web前端/GuideImplementation.js';
import essentialZh from '../../../web/web前端/guide/rule/essential rule.md';
import warZh from '../../../web/web前端/guide/rule/war rule.md';
import { getGuideMarkdown, parseGuideMarkdown } from '../../../web/web前端/GuideContent.js';
import { GUIDE_ASSETS } from './guide-assets.js';

export function multiplayerGuideSections(language) {
  return language === 'en' ? [
    { id: 'multiplayer-board', title: 'Players, shape and starting points', paragraphs: [
      'Choose 2–15 players and either a triangular or hexagonal board in the Board cabin. The default is a triangle for two or three players and a hexagon for four to fifteen. Games with 7–15 players require random or custom starting nodes. Side length means grid points along each outer side, from 5 to 15.',
      'Starting points can be Default, Random or Custom. Random points are drawn once when a new game starts and kept in saves and replays. For Custom, choose a distinct valid point for each side. Any participating side may start.',
      'With default hexagonal starting points, number corners clockwise from the upper left, 1–6. Four players occupy 1, 2, 4 and 5 in Blue, Red, Purple, Green order. Five occupy 1–5; Orange is fifth. Six occupy all corners; Cyan is sixth.',
      'Every valid neighbor of an enemy starting node is protected, including random and custom starting points. The number depends on its actual position: a triangular corner has two and a hexagonal corner has three. Direct cuts do not bypass this protection. Both shapes share the connection, capture, three-point and Superko rules.',
    ] },
    { id: 'multiplayer-ai', title: 'Local players, AI and shared rules', paragraphs: [
      'Each side can be human or an AI compatible with the current player count, shape and side length. Three-player AI is for triangular three-player games; Hex AI is for hexagonal 4–6-player games. Choosing a non-default shape for a player count offers Greedy AI. Games with 7–15 players offer generic Greedy and Minimax AI without using the 3–6-player trained models.',
      'One, several or every seat may be AI. The list shows only compatible choices. If changing the board makes a selected AI incompatible, choose again before restarting; it is not silently replaced. Hints and replay analysis use a compatible strategy; policy scores are not probabilities.',
      'Each of the 2–15 player setups keep their own seats and first player. Editing settings preserves the running position; restart to apply them. Hints share a saved budget among humans. Replays can keep all players when branching.',
      'Resigned players leave the turn order. Play continues while at least two remain; a sole remaining player wins immediately. All remaining players passing consecutively settles territory. Shared online rooms also accept these player settings. Anonymous contribution is off by default; after explicit opt-in, only newly started complete territory-v3 local games for 2–6 players are eligible. Online, tutorial, replay and restored games are excluded.',
      'The original Web stories and illustrations below use triangular examples. Their local connection and cut mechanics also apply to the hexagon; use the shape and opening rules described above.',
    ] },
  ] : [
    { id: 'multiplayer-board', title: '人数、棋盘与初始点', paragraphs: [
      '在棋盘舱选择 2–15 人，每种人数都可选三角形或六边形棋盘。默认双人、三人为三角形，四至十五人为六边形；7–15 人仅支持随机或自定义起点。边长指每条外边上的格点数，可选 5–15。',
      '起点可选默认、随机或自定义。随机起点在重开时生成一次，实际位置随存档和复盘保留；自定义时，为每一方选择互不重合的有效格点。任意参与方都可先手。',
      '使用六边形默认起点时，从左上角顺时针编号 1–6。四人按蓝、红、紫、绿占据 1、2、4、5 号角；五人占据 1–5 号角，第五方为橙方；六人占满六角，第六方为青方。',
      '敌方起点旁所有有效相邻格点都受保护，随机与自定义起点也按实际位置确定：三角形角点旁为两个，六边形角点旁为三个，其他位置可能更多。直接切线也不能越过保护。两种棋盘沿用相同的连接、切断、三点限制和同形禁手。',
    ] },
    { id: 'multiplayer-ai', title: '同机玩家、AI 与共同规则', paragraphs: [
      '各席可分别选择真人，或与当前人数、形状、边长兼容的 AI。三人 AI 用于三角形三人局，六边形 AI 用于六边形 4–6 人局；选用该人数默认形状之外的棋盘时，可用贪心 AI。7–15 人提供通用贪心与 Minimax 搜索，不套用 3–6 人训练模型。',
      '一席、多席或全部 AI 都可开局，列表只显示兼容选项。更改棋盘后，若已选 AI 不兼容，需重选后再开局，不会自动换成另一种。提示与复盘分析使用兼容策略；策略评分不是概率。',
      '2–15 人各自保留席位和先手设置，切换时不会互相覆盖。修改设置会保留当前棋局，重开后才生效。所有真人共用本局提示次数，续局保留；复盘分支可沿用全部玩家配置。',
      '认输后退出轮转，至少还有两方就继续；只剩一方时立即获胜。所有未认输玩家连续各跳过一次后，按领土结算。好友联机也支持这些人数与起点设置。匿名棋谱贡献默认关闭；主动同意后，仅支持随后新开始并完整结束的 2–6 人 territory-v3 本地对局，联机、教学、复盘和恢复局均不参与。',
      '下方网页版故事与原图沿用三角棋盘示例。连接和切断等局部机制同样适用于六边形，棋盘形状与起步保护以上文为准。',
    ] },
  ];
}

const IMAGE_TEXT = {
  zh: {
    playable: ['可落子区域', '图中绿色标记展示示例局面的可落点。实际对局以当前棋盘上的合法落点为准。', 0],
    cut1: ['切断之前', '观察连回初始点的路径。攻击敌方连线，可能让整段结构失去连接。', 2],
    cut2: ['切断之后', '失去所有起点路径的节点与连线被清除；仍有其他连接的部分会保留。', 2],
    start: ['起步保护', '图中的三角形角点旁有两个保护点；六边形角点旁有三个。所有有效相邻点都禁止敌方落子。'],
    triangle: ['三点限制', '不能主动形成三个节点互相紧挨的最小三角形；直接切断敌方连线时可豁免这一项限制。', 3],
  },
  en: {
    playable: ['Playable points', 'Green markers show legal points in this example. Use the legal markers on your current board when playing.', 0],
    cut1: ['Before a cut', 'Look for paths back to the starting node. Cutting an enemy link may disconnect a whole structure.', 2],
    cut2: ['After a cut', 'Nodes and links with no remaining path to their start are removed. An alternative route keeps a structure alive.', 2],
    start: ['Protected opening', 'This triangular example has two protected neighbors at each corner. A hexagonal corner has three. Opponents cannot occupy any of these valid neighboring points.'],
    triangle: ['Three-point limit', 'Do not form the smallest triangle of three mutually adjacent nodes. A move cutting an enemy link is exempt from this limit.', 3],
  },
};
const imageSection = (id, lang) => {
  const [title, caption, lesson] = IMAGE_TEXT[lang][id];
  return { id: `diagram-${id}`, title, paragraphs: [caption], lesson,
    image: { ...GUIDE_ASSETS.find(asset => asset.id === id), alt: title } };
};
const clean = value => String(value).replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1');
const blockText = block => clean(block.label ? `${block.label}：${block.text}` : block.text || '')
  .replace('双方轮流在三角网格落子', '玩家轮流在三角或六边形棋盘的格点落子')
  .replace('靠近初始点的两个相邻位置', '靠近初始点的所有有效相邻位置（三角形角点旁两个、六边形角点旁三个；随机或自定义起点按实际位置确定）')
  .replace('Players take turns placing nodes on a triangular grid.', 'Players take turns placing nodes on a triangular or hexagonal board.')
  .replace("the two positions adjacent to a player's starting node", "all valid positions adjacent to a player's starting node (two at triangular corners, three at hexagonal corners; random and custom starts use their actual neighbors)");

function essentialSections(lang) {
  const blocks = parseGuideMarkdown(lang === 'zh' ? essentialZh : getGuideMarkdown('rulesEssential', 'en'));
  const sections = [];
  let current;
  for (const block of blocks) {
    if (block.type === 'image') continue; // Original figures are separate, comfortably sized pages below.
    if (block.type === 'callout') {
      current = { id: `essential-${sections.length}`, title: block.text.replace(/[【】]/g, ''), paragraphs: [] };
      sections.push(current);
    } else if (block.text) (current ||= sections[0] = { id: 'essential-0', title: lang === 'zh' ? '简明规则' : 'Essentials', paragraphs: [] })
      .paragraphs.push(blockText(block));
  }
  sections[0].lesson = 1;
  sections[1].lesson = 2;
  // Keep Web prose, followed by the current ending contract absent from the short Web edition.
  sections.push({
    id: 'essential-finish', title: lang === 'zh' ? '跳过、认输与结算' : 'Pass, resign and settle', lesson: 4,
    paragraphs: lang === 'zh' ? [
      '你可以主动跳过；没有合法落点时自动跳过。所有仍在场的玩家连续各跳过一次后结算，期间有人落子则重新计数。',
      '正常结算比较未认输玩家的离散领土点数，最高分相同则平局。认输后退出轮转；其余玩家继续，若只剩一人则立即由其获胜。',
    ] : [
      'You may pass voluntarily. Having no legal placement causes an automatic pass. The game settles after all remaining players pass consecutively once each. Any placement resets that count.',
      'Normal settlement compares discrete territory points among players who have not resigned. Equal highest scores draw. Resigning leaves the turn order; the other players continue. A sole remaining player wins immediately.',
    ],
  });
  return [...sections, ...['playable', 'cut1', 'cut2', 'start', 'triangle'].map(id => imageSection(id, lang))];
}

function warSections(lang) {
  const blocks = parseGuideMarkdown(lang === 'zh' ? warZh : getGuideMarkdown('rulesWar', 'en'));
  const paragraphs = blocks.filter(block => block.type !== 'image' && block.text).map(blockText);
  // The Web story used geometric "area", a tightened outline and no-move ending.
  // Replace those passages with the current territory-v3 contract.
  const accurateTerritory = lang === 'zh'
    ? '你的目标是扩大安全领土：己方节点与补给线经过的格点始终计分，不要求闭合。己方点线隔开的空腔逐个判断；没有敌方元素的空腔计分，包括甜甜圈形状的内孔。同一点只算一次。'
    : 'Your nodes and supply-line points always score, even without a loop. Each pocket cut off from the exterior by your points counts when it contains no enemy, including a donut-shaped inner hole. Each point counts once.';
  const accurateEnding = lang === 'zh'
    ? '想暂时按兵不动时，你可以主动跳过。所有仍在场的玩家连续各跳过一次，战役就结束并比较领土点数；认输的玩家退出轮转，只剩一人时立即获胜。去吧，指挥官，愿你的防线坚不可摧。'
    : 'You may hold position by passing. Once all remaining players pass consecutively once each, the battle ends and territory points decide the result. Resigned players leave the turn order; a sole remaining player wins immediately. Go on, Commander. May your lines hold.';
  const adjusted = paragraphs.map(paragraph =>
    /你的终极目标|Your ultimate objective/.test(paragraph) ? accurateTerritory
      : /当所有的硝烟|When the smoke clears/.test(paragraph) ? accurateEnding : paragraph);
  const titles = lang === 'zh'
    ? ['指挥官，欢迎', '补给就是生命线', '扩张与防守', '大本营的保护', '派兵与连线', '守住安全领土', '阵型与切断', '胜利与终局']
    : ['Welcome, Commander', 'Supply is your lifeline', 'Expansion and defense', 'Protecting headquarters', 'Deploy and connect', 'Secure territory', 'Formation limits', 'Cutting supply', 'Victory and settlement'];
  return [...adjusted.map((paragraph, i) => ({
    id: `war-${i}`, title: titles[i] || (lang === 'zh' ? '战场故事' : 'Battlefield story'), paragraphs: [paragraph],
  })), ...['start', 'playable', 'triangle', 'cut1', 'cut2'].map(id => imageSection(id, lang))];
}

export function guideDocument(kind, language) {
  const lang = language === 'en' ? 'en' : 'zh';
  if (kind === 'rules-math' || kind === 'why-code') {
    const sections = implementationSections(kind === 'rules-math' ? 'rulesMath' : 'whyCode', lang);
    if (kind === 'rules-math') {
      const afterConnectivity = sections.findIndex(section => section.id === 'rulesMath-algorithms-connectivity') + 1;
      sections.splice(afterConnectivity, 0, ...['start', 'cut1', 'cut2'].map(id => ({ ...imageSection(id, lang), level: 3 })));
    }
    return withGuideContents(sections, lang);
  }
  if (kind === 'why-talk') {
    const blocks = parseGuideMarkdown(getGuideMarkdown(kind === 'why-talk' ? 'whyTalk' : 'whyCode', lang));
    const sections = []; let section = { id: `${kind}-0`, title: lang === 'zh' ? '游戏的趣味' : 'Why 生命补给线?', paragraphs: [] };
    for (const block of blocks) {
      if (block.type.startsWith('heading')) { if (section.paragraphs.length) sections.push(section); section = { id: `${kind}-${sections.length}`, title: clean(block.text), paragraphs: [] }; }
      else if (block.type === 'codeblock') section.paragraphs.push(block.code);
      else if (block.type === 'table') section.paragraphs.push(block.headers.map(cell => clean(cell.text)).join(' · '),
        ...block.rows.map(row => row.map(cell => clean(cell.text)).join(' · ')));
      else if (block.text) section.paragraphs.push(blockText(block));
    }
    if (section.paragraphs.length) sections.push(section);
    if (kind === 'why-talk') sections.unshift({ id: 'why-current-rules', title: lang === 'zh' ? '阅读提示' : 'Current rules', paragraphs: [lang === 'zh' ? '下文沿用网页版的策略直觉。当前规则允许主动跳过；关于迫移的比喻不表示必须落子。' : 'This Web essay describes strategic intuition. Current rules allow passing; the zugzwang analogy does not require placing a stone.'] });
    if (kind === 'why-talk') sections.push({ id: 'why-three-balance', title: lang === 'zh' ? '三人制衡' : 'Three-player balance',
      paragraphs: [lang === 'zh' ? '网页版的三人局示例：一次行动可能同时改变另两方的机会。' : 'A Web three-player example: one move can change the opportunities of both other players.'],
      image: { ...GUIDE_ASSETS.find(asset => asset.id === 'three-balance') } });
    return sections;
  }
  if (kind === 'rules-essential') return [...multiplayerGuideSections(lang), ...essentialSections(lang)];
  if (kind === 'rules-war') return [...multiplayerGuideSections(lang), ...warSections(lang)];

  return null;
}
