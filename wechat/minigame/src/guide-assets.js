// Keep the original Web illustrations; no remote request is needed to read rules.
export const GUIDE_ASSETS = Object.freeze([
  { id: 'playable', source: '可以走的区域png.png', path: 'guide/playable.png' },
  { id: 'cut1', source: '切断1.png', path: 'guide/cut-before.png' },
  { id: 'cut2', source: '切断2.png', path: 'guide/cut-after.png' },
  { id: 'start', source: '起点限制.png', path: 'guide/opening.png' },
  { id: 'triangle', source: '三点限制.png', path: 'guide/triangle.png' },
  { id: 'three-balance', source: '三人制衡.jpg', path: 'guide/three-balance.jpg' },
]);

export const GUIDE_EDITIONS = Object.freeze([
  { kind: 'rules-essential', zh: '简明规则', en: 'Essentials', hintZh: '先读这一篇，再开始落子', hintEn: 'The rules you need to play' },
  { kind: 'rules-war', zh: '战场故事', en: 'Battlefield', hintZh: '用补给线理解连接与切断', hintEn: 'Understand links as supply lines' },
  { kind: 'rules-math', zh: '数学视角', en: 'Math view', hintZh: '图、历史与离散计分', hintEn: 'Graphs, history and scoring' },
]);
export const GUIDE_SOURCE_NOTE = Object.freeze({
  zh: '取自网页版指南舱，按当前玩法整理。',
  en: 'Adapted from the Web Guide for the current rules.',
});
