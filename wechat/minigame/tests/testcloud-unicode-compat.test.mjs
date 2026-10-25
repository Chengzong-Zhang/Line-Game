import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGuideMarkdown } from '../../../web/web前端/GuideContent.js';
import { guideHeadingId, isGuideAnchorId } from '../../../web/web前端/GuideArticleFormat.js';

test('guide headings and links preserve Chinese and Latin identifiers', () => {
  assert.equal(guideHeadingId('汉字 ABC 123'), '汉字-abc-123');
  assert.equal(isGuideAnchorId('汉字-abc'), true);
  assert.equal(isGuideAnchorId('a!'), false);
  const blocks = parseGuideMarkdown('# 汉字 ABC 123\n\nSee [这里](#汉字-abc) and [bad](#a!)');
  assert.equal(blocks[0].id, '汉字-abc-123');
  assert.deepEqual(blocks[1].tokens.filter(token => token.type === 'anchor'),
    [{ type: 'anchor', text: '这里', href: '#汉字-abc' }]);
  assert.equal(blocks[1].tokens.at(-1).text, '[bad](#a!)');
});

test('guide headings still load when the runtime rejects Unicode property escapes', async () => {
  const original = globalThis.RegExp;
  globalThis.RegExp = function (pattern, flags) {
    if (String(pattern).includes('\\p{')) throw new SyntaxError('Unsupported Unicode property escape');
    return new original(pattern, flags);
  };
  try {
    const fallback = await import(`../../../web/web前端/GuideArticleFormat.js?testcloud=${Date.now()}`);
    assert.equal(fallback.guideHeadingId('汉字 ABC 123'), '汉字-abc-123');
    assert.equal(fallback.isGuideAnchorId('汉字-abc'), true);
    assert.equal(fallback.isGuideAnchorId('a!'), false);
  } finally {
    globalThis.RegExp = original;
  }
});
