// One semantic block model: TeX/code on the Web, readable plain text on Canvas.
export const p = (zh, en) => ({ kind: 'paragraph', text: { zh, en } });
export const m = (tex, plain) => ({ kind: 'math', tex, plain });
export const c = (code, language = 'text', source = null) => ({ kind: 'code', code, language, source });
export const s = (id, zh, en, blocks) => ({ id, title: { zh, en }, blocks });
export const ch = (id, zh, en, overview, sections) => ({ id, title: { zh, en }, overview, sections });
let letterOrNumber;
try {
  // Construct at runtime so older WeChat engines can load this module.
  letterOrNumber = new RegExp('^[\\p{L}\\p{N}]$', 'u');
} catch (_) {
  letterOrNumber = /^[A-Za-z0-9\u00c0-\u024f\u0400-\u052f\u0600-\u06ff\u0900-\u097f\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]$/u;
}
export function isGuideAnchorId(id) {
  return typeof id === 'string' && id.length > 0
    && [...id].every(character => character === '_' || character === '-' || letterOrNumber.test(character));
}
export function guideHeadingId(title) {
  return [...String(title).toLowerCase()]
    .filter(character => character === '_' || character === '-' || /\s/u.test(character) || letterOrNumber.test(character))
    .join('').trim().replace(/\s+/g, '-');
}
export function blockText(block, language) {
  return block.kind === 'math' ? block.plain : block.kind === 'code' ? block.code : block.text[language];
}
export function blockMarkdown(block, language) {
  if (block.kind === 'math') return `$$\n${block.tex}\n$$`;
  if (block.kind === 'code') return `\`\`\`${block.language}\n${block.code}\n\`\`\``;
  return block.text[language];
}
