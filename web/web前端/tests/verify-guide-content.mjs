import assert from "node:assert/strict";
import fs from "node:fs";
import { parseGuideMarkdown, getGuideMarkdown, getGuideMarkdownAsset, ensureGuideRuleImages } from "../GuideContent.js?v=20261025-unified1";
import { guideChapters, implementationSections } from "../GuideImplementation.js?v=20261025-unified1";

const sourceUrl = "https://github.com/Chengzong-Zhang/Line-Game/blob/main/README.md";
const source = parseGuideMarkdown(`[源码](${sourceUrl})`);
assert.equal(source[0].type, "paragraph", "a URL colon must not split a link into metadata");
assert.deepEqual(source[0].tokens, [{ type: "link", text: "源码", href: sourceUrl }]);

for (const href of ["javascript:alert(1)", "data:text/html,<script>", "//example.com", "https://example.com/\u0000"] ) {
  const blocks = parseGuideMarkdown(`[unsafe](${href})`);
  assert.equal(blocks.flatMap((block) => block.tokens ?? []).some((token) => token.type === "link"), false);
}
const mixed = parseGuideMarkdown(`正文 **强调**、\`grid\` 与 [源码](${sourceUrl})。`);
assert.deepEqual(mixed[0].tokens.filter((token) => token.type !== "text").map((token) => token.type), ["strong", "code", "link"]);
assert.equal(parseGuideMarkdown("状态：兼容试用")[0].type, "meta");

for (const language of ["zh", "en"]) {
  for (const [kind, relative] of [["whyCode", `interesting/why-code.${language}.md`],
    ["rulesMath", `rule/math rule${language === 'en' ? '.en' : ''}.md`]]) {
    const markdown = fs.readFileSync(new URL(`../guide/${relative}`, import.meta.url), "utf8");
    assert.equal(markdown, getGuideMarkdown(kind, language), `${kind}/${language}: fetched text must match embedded text`);
    const blocks = parseGuideMarkdown(markdown);
    const headings = blocks.filter(block => block.type === "heading2").map(block => block.text);
    const targets = blocks.filter(block => /^heading[23]$/.test(block.type)).map(block => `#${block.id}`);
    const contents = blocks.flatMap(block => block.tokens ?? []).filter(token => token.type === 'anchor');
    assert.deepEqual(contents.map(token => token.href), targets, 'every contents link resolves to its chapter or section');
    assert.equal(new Set(targets).size, targets.length);
    if (kind === 'rulesMath') {
      const illustrated = ensureGuideRuleImages(kind, blocks, language);
      const firstChapter = illustrated.findIndex(block => block.type === 'heading2');
      assert.equal(illustrated.slice(0, firstChapter).filter(block => block.type === 'image').length, 0,
        'illustrations must not interrupt the contents');
      assert.equal(illustrated.filter(block => block.type === 'image').length, 5);
    }
    assert.equal(headings.length, 3, 'exactly three main chapters');
    assert.deepEqual(headings, guideChapters(kind).map(chapter => chapter.title[language]));
    assert.deepEqual(blocks.filter(block => block.type === 'heading3').map(block => block.text),
      implementationSections(kind, language).filter(section => section.level === 3).map(section => section.title));
    assert.ok(blocks.filter(block => block.type === (kind === 'rulesMath' ? 'mathblock' : 'codeblock')).length >= 10,
      'paper needs display equations; technical report needs actual code/pseudocode blocks');
    assert.equal(blocks.filter(block => block.type === 'mathblock').length,
      guideChapters(kind).flatMap(chapter => chapter.sections).flatMap(section => section.blocks).filter(block => block.kind === 'math').length);
    const nativeSections = implementationSections(kind, language);
    assert.equal(new Set(nativeSections.map(section => section.id)).size, nativeSections.length);
    assert.ok(nativeSections.every(section => section.paragraphs.every(text => typeof text === 'string' && text.length)));
    assert.ok(!nativeSections.some(section => section.paragraphs.some(text => text.includes('$$') || text.includes('\\begin{'))),
      'Canvas receives readable equations, not raw TeX');
    assert.ok(getGuideMarkdownAsset(kind, language));
    assert.ok(markdown.includes("territory-v2"));
  }
}

const normalizedText = text => String(text).replace(/\s+/g, " ").trim();
const v3ScoringChecks = {
  zh: [
    ["friendly nodes and link points always count", /(?:己方节点.{0,24}(?:连线|补给线)|士兵所在格点.{0,24}补给线).{0,32}(?:始终计入|始终计分|直接计入)/],
    ["owned points count without a closed loop", /(?:不要求闭合|无需形成单一闭环)/],
    ["safe pockets are evaluated individually", /(?:多个空腔|空腔逐个判断|每个空腔|安全空腔)/],
    ["donut inner holes count", /甜甜圈(?:形状的)?内孔/],
    ["enemy-containing pockets are excluded", /含敌方元素的空腔不计|含敌军的空腔不计/],
    ["each grid point counts once", /同一格点只算一次/],
    ["displayArea does not determine official score", /显示轮廓（displayArea）仅用于展示，不决定正式分数/],
  ],
  en: [
    ["friendly nodes and link points always count", /(?:nodes and link points|troops and supply lines).{0,40}always count/i],
    ["owned points count without a closed loop", /no (?:single )?closed loop is required|no loop is required/i],
    ["safe pockets are counted individually", /(?:every enemy-free pocket|multiple pockets).{0,120}(?:counts?|evaluated separately)/i],
    ["donut inner holes count", /inner hole of a donut-shaped structure|donut holes?/i],
    ["enemy-containing pockets are excluded", /pockets? containing an enemy (?:are|is) excluded/i],
    ["each grid point counts once", /each point counts once/i],
    ["displayArea does not determine official score", /displayed outline \(displayArea\).{0,100}does not determine the official score/i],
  ],
};
function assertV3ScoringSemantics(text, language, label) {
  const normalized = normalizedText(text);
  for (const [meaning, pattern] of v3ScoringChecks[language]) {
    assert.match(normalized, pattern, `${label}: missing V3 scoring meaning: ${meaning}`);
  }
}

for (const key of ["rulesEssential", "rulesWar"]) {
  assertV3ScoringSemantics(getGuideMarkdown(key, "zh"), "zh", `embedded ${key}/zh`);
  assertV3ScoringSemantics(getGuideMarkdown(key, "en"), "en", `embedded ${key}/en`);
}
for (const [key, relative] of [
  ["rulesEssential", "rule/essential rule.md"],
  ["rulesWar", "rule/war rule.md"],
]) {
  assert.equal(getGuideMarkdownAsset(key, "zh"), `./guide/${relative.replaceAll(" ", "%20")}`);
  const rawAsset = fs.readFileSync(new URL(`../${getGuideMarkdownAsset(key, "zh")}`, import.meta.url), "utf8");
  assertV3ScoringSemantics(rawAsset, "zh", `raw ${key}/zh`);
}

const normalize = text => text.replace(/\s+/g, ' ').trim();
let excerpts = 0;
for (const chapter of guideChapters('whyCode')) for (const section of chapter.sections) for (const block of section.blocks) {
  if (!block.source) continue;
  const source = fs.readFileSync(new URL(`../../../${block.source.file}`, import.meta.url), 'utf8');
  assert.ok(normalize(source).includes(normalize(block.code)), `${block.source.file}: ${block.source.symbol} excerpt drift`);
  excerpts++;
}
assert.ok(excerpts >= 8);
for (const language of ['zh', 'en']) {
  assert.notEqual(getGuideMarkdown('rulesMath', language), getGuideMarkdown('whyCode', language));
}
console.log(`verify-guide-content: PASS (four articles, three main chapters each, distinct paper/report, readable equations, ${excerpts} verified source excerpts)`);
