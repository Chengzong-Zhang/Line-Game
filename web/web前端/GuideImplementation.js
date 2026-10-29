import { MATH_CHAPTERS } from './GuideMathChapters.js?v=20261029-unified-r1';
import { TECHNICAL_CHAPTERS } from './GuideTechnicalChapters.js?v=20261029-unified-r1';
import { blockText, blockMarkdown, guideHeadingId } from './GuideArticleFormat.js?v=20261029-unified-r1';

export function guideChapters(kind = 'rulesMath') {
  return kind === 'whyCode' ? TECHNICAL_CHAPTERS : MATH_CHAPTERS;
}

function intro(kind, lang) {
  const code = kind === 'whyCode';
  return {
    id: `${kind}-intro`, level: 1,
    title: lang === 'zh' ? code ? 'Code：LIFELINE 算法技术报告' : '抽象废话版：LIFELINE 的形式模型与理论分析'
      : code ? 'Code: LIFELINE Algorithm Report' : 'LIFELINE: Formal Model and Theory',
    paragraphs: lang === 'zh' ? [
      code ? '摘要：本报告按数学、算法、AI、拓扑棋盘四大章组织。重点是数据结构、执行顺序、伪代码、源码摘录、复杂度与实现边界；让读者能从一条规则追踪到实际函数及返回值。'
        : '摘要：本文在固定 territory-v3 规则下建立包含历史的有限博弈模型，推导状态与步数上界、连通和洪水算法正确性、收紧终止性、极小极大误差界及拓扑表示的条件性优势。全文按数学、算法、AI、拓扑棋盘四大章组织。',
      code ? '2026-10-25 基础报告；拓扑第四章于 2026-10-29 补充并核对源码。编号伪代码是控制流说明，标明来源的摘录才是原始代码。模型训练、导出推理和 Web/小程序可用性分别说明；配套数学版给出定义、命题与证明。'
        : '2026-10-25 基础推导；拓扑第四章于 2026-10-29 由主智能体独立推导并核对源码。所有命题在文内给出假设与证明或证明思路；编码上界不冒充可达性下界，表示通路优势不冒充棋力实验。实现细节与源码审计见配套 Code 技术报告。',
      '阅读路径：第一章建立符号和完整状态，第二章讨论规则算法，第三章讨论 AI，第四章给出三角剖分、代数拓扑、双把手构造与稳固连接证书。目录可直接定位各章与小节。territory-v3 始终计算己方占点，并逐个加入与外界隔绝且无敌方点的空腔；正式集合给出 area 与 renderPoints；显示领土可另用与棋盘面片取交的凸包／收紧轮廓，不沿单线铺色，孔洞和真实外部不染色。显示不能改变分数，旧棋谱保留原规则版本。',
    ] : [
      code ? 'Abstract. This report has four chapters: Mathematics, Algorithms, AI and Topology. It emphasizes data structures, execution order, pseudocode, source excerpts, complexity and implementation limits, connecting each rule to functions and outputs.'
        : 'Abstract. Under fixed territory-v3 rules, we formulate a history-complete finite game and derive state/horizon bounds, connectivity and flood correctness, tightening termination, minimax error bounds and conditional benefits of topology. The four chapters are Mathematics, Algorithms, AI and Topology.',
      code ? 'Base source inspection: 2026-10-25; topology chapter added and inspected on 2026-10-29. Numbered pseudocode explains control flow; attributed excerpts quote actual source. Training, exported inference and Web/Mini Game availability are distinguished. The companion mathematical edition supplies definitions and proofs.'
        : 'Base derivations: 2026-10-25; topology chapter independently derived by the primary agent and source-checked on 2026-10-29. Claims state assumptions and proofs or proof sketches. Encoding upper bounds are not reachability lower bounds, and communication-path benefits are not strength experiments. See the companion Code report for implementation and source audits.',
      'Reading path: chapter I defines notation and full state; II develops rule algorithms; III develops AI; IV gives triangulation, algebraic topology, a double-torus construction and permanent-connection certificates. In territory-v3 the score always counts owned points and separately adds enemy-free pockets cut off from the exterior. The official set supplies area and renderPoints. Display may use hull/tightened polygons intersected with actual board faces, without ribbons along lone lines or shading holes/exterior. Display never changes scores; old replays retain their recorded rule versions.',
    ],
  };
}

export function implementationSections(kind = 'rulesMath', language = 'zh') {
  const lang = language === 'en' ? 'en' : 'zh';
  const sections = [intro(kind, lang)];
  for (const chapter of guideChapters(kind)) {
    sections.push({ id: `${kind}-${chapter.id}`, title: chapter.title[lang], level: 2,
      paragraphs: [blockText(chapter.overview, lang)] });
    for (const section of chapter.sections) sections.push({
      id: `${kind}-${chapter.id}-${section.id}`, title: section.title[lang], level: 3,
      paragraphs: section.blocks.map(block => blockText(block, lang)),
    });
  }
  return sections;
}

export function withGuideContents(sections, language = 'zh') {
  const entries = sections.slice(1).map(section => ({ target: section.id, title: section.title, level: section.level || 3 }));
  return [sections[0], { id: `${sections[0].id}-contents`, title: language === 'en' ? 'Contents' : '目录',
    paragraphs: entries.map(entry => entry.title), entries }, ...sections.slice(1)];
}

export function implementationMarkdown(kind = 'rulesMath', language = 'zh') {
  const lang = language === 'en' ? 'en' : 'zh', introduction = intro(kind, lang);
  const sections = implementationSections(kind, lang).slice(1);
  const contents = sections.map(section => `${section.level === 2 ? '' : '- '}[${section.title}](#${guideHeadingId(section.title)})`).join('\n\n');
  const parts = [`# ${introduction.title}`, ...introduction.paragraphs, `**${lang === 'en' ? 'Contents' : '目录'}**`, contents];
  for (const chapter of guideChapters(kind)) {
    parts.push(`## ${chapter.title[lang]}`, blockMarkdown(chapter.overview, lang));
    for (const section of chapter.sections) parts.push(`### ${section.title[lang]}`, ...section.blocks.map(block => blockMarkdown(block, lang)));
  }
  return `${parts.join('\n\n')}\n`;
}
