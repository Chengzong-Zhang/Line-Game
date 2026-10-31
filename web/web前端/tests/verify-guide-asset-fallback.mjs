import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { getGuideMarkdown, getGuideMarkdownAsset, loadGuideMarkdownAssets, parseGuideMarkdown } from '../GuideContent.js';

const originalWarn = console.warn;
console.warn = () => {};
try {
  for (const language of ['zh', 'en']) {
    const embedded = getGuideMarkdown('whyTheory', language);
    const asset = new URL(`../${getGuideMarkdownAsset('whyTheory', language)}`, import.meta.url);
    assert.equal(await fs.readFile(asset, 'utf8'), embedded, 'online and embedded Theory must have one current source');
    assert.ok(embedded.includes('2026-08-26') && embedded.includes('PASS'));
    assert.ok(embedded.includes('1680') && embedded.includes('120'));
    assert.ok(embedded.includes('\\frac'), 'TeX must retain backslashes through the JavaScript template');
    assert.ok(parseGuideMarkdown(embedded).some(block => block.type === 'heading2'));
    const fallbackFetchers = [
      async () => { throw new TypeError('offline'); },
      async () => ({ ok: false, status: 404, text: async () => 'stale server error' }),
      async () => ({ ok: true, text: async () => { throw new Error('body interrupted'); } }),
      async () => ({ ok: true, text: async () => '  ' }),
    ];
    for (const fetcher of fallbackFetchers) {
      const overrides = await loadGuideMarkdownAssets(language, fetcher);
      assert.equal(overrides.whyTheory, undefined);
      assert.equal(overrides.whyTheory || getGuideMarkdown('whyTheory', language), embedded);
    }
    const loaded = await loadGuideMarkdownAssets(language, async url => {
      const file = new URL(`../${url}`, import.meta.url);
      return { ok: true, text: () => fs.readFile(file, 'utf8') };
    });
    assert.equal(loaded.whyTheory, embedded);
    // Keep the original formal article as evidence with its original scope.
    const historical = await fs.readFile(new URL(`../guide/interesting/why-theory.20260826.${language}.md`, import.meta.url), 'utf8');
    assert.ok(historical.includes('2026-08-26'));
  }
} finally {
  console.warn = originalWarn;
}
const app = await fs.readFile(new URL('../OnlineApp.js', import.meta.url), 'utf8');
assert.ok(app.includes('await loadGuideMarkdownAssets(value)'));
assert.ok(app.includes('loadId === guideMarkdownLoadId'), 'a late language response must not replace the current article');
console.log('PASS: bilingual successful assets, offline/non-200/body/empty fallbacks, TeX, history, and generation guard.');
