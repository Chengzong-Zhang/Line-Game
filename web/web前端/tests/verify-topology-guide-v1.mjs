import assert from 'node:assert/strict';
import fs from 'node:fs';
import { getGuideMarkdown, parseGuideMarkdown } from '../GuideContent.js';
const meanings = {
  zh: [/规范(?:棋位|顶点|点)/, /展开图/, /边界/, /Superko/, /极点/, /起点/, /棋力/, /同调/],
  en: [/canonical (?:vertices|vertex|points)/i, /(?:unfolded|atlas)/i, /boundar/i, /Superko/i, /pole/i, /starts|roots/i, /strength/i, /homology/i],
};
for (const language of ['zh', 'en']) {
  const markdown = getGuideMarkdown('rulesMath', language);
  assert.equal(getGuideMarkdown('topologyGuide', language), markdown, `${language}: legacy alias must resolve to the math guide`);
  for (const meaning of meanings[language]) assert.match(markdown, meaning, `${language}: missing ${meaning}`);
  const headings = parseGuideMarkdown(markdown).filter(block => block.id === 'rulesMath-topology');
  assert.equal(headings.length, 1, `${language}: the topology chapter anchor must be unique`);
}
const app = fs.readFileSync(new URL('../OnlineApp.js', import.meta.url), 'utf8');
assert.match(app, /entryKey === "topology" \? "rules-math-topology"/);
assert.match(app, /getElementById\("rulesMath-topology"\)/);
assert.doesNotMatch(app, /v-if="topologyEntry"/);
console.log('verify-topology-guide-v1: PASS (bilingual topology chapter, legacy alias, unique anchor and direct entry)');
