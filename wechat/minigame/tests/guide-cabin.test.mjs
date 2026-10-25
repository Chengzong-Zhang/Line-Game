import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { build } from '../tools/native-build.mjs';
import { createHash } from 'node:crypto';
import { GUIDE_ASSETS, GUIDE_EDITIONS } from '../src/guide-assets.js';
import { readingLines, readerLayout, drawReader, drawGuideCabin, createGuideImages } from '../src/help-ui.js';
import { buildGame } from '../tools/build.mjs';
import { TEXT } from '../src/i18n.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const repo = path.resolve(root, '../..');
const bundled = await build({ entryPoints: [path.join(root, 'src/help-content.js')], bundle: true, format: 'esm',
  platform: 'node', loader: { '.md': 'text' }, write: false });
const { helpDocument } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
const noSpace = value => value.replace(/\s/g, '');
const sha = data => createHash('sha256').update(data).digest('hex');
const readerEditions = [...GUIDE_EDITIONS, { kind: 'why-code' }];

function uiFor(language, width, height, top) {
  const buttons = [], texts = [], draws = [];
  const ctx = { font: '', measureText(value) {
    const font = Number(this.font.match(/\d+/)?.[0] || 16);
    return { width: [...String(value)].reduce((n, c) => n + (/[^\u0000-\u007f]/.test(c) ? font : font * .55), 0) };
  }, drawImage: (...args) => draws.push(args) };
  const ui = { ctx, language, top, metrics: { width, height, bottom: 24 }, rect() {},
    text(value, x, y, font, color, align) { texts.push({ value, x, y, font, color, align }); },
    button(id, title, x, y, width, action, options) { buttons.push({ id, title, x, y, width, action, height: options?.height || 48 }); },
    label: key => TEXT[language][key], guideImages: { get: () => ({ status: 'ready', image: { width: 1386, height: 1208 } }) } };
  return { ui, buttons, texts, draws };
}
function assertSafeButtons(buttons, width, height, safeTop) {
  for (const button of buttons) {
    assert.ok(button.height >= 44, button.id);
    assert.ok(button.x >= 0 && button.x + button.width <= width && button.y >= safeTop && button.y + button.height <= height - 24, button.id);
  }
  for (let i = 0; i < buttons.length; i++) for (let j = i + 1; j < buttons.length; j++) {
    const a = buttons[i], b = buttons[j];
    assert.ok(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y,
      `Overlapping buttons: ${a.id}/${b.id}`);
  }
}

test('three guide editions keep Web essentials and original diagrams while clarifying current pass/score/history rules', async () => {
  const source = await fs.readFile(path.join(repo, 'web/web前端/guide/rule/essential rule.md'), 'utf8');
  const expected = source.replace(/【[^】]+】/g, '')
    .replace('双方轮流在三角网格落子', '玩家轮流在三角或六边形棋盘的格点落子')
    .replace('靠近初始点的两个相邻位置', '靠近初始点的所有有效相邻位置（三角形角点旁两个、六边形角点旁三个；随机或自定义起点按实际位置确定）');
  assert.equal(noSpace(helpDocument('rules-essential', 'zh').filter(s => s.id.startsWith('essential-') && s.id !== 'essential-finish')
    .flatMap(s => s.paragraphs).join('')), noSpace(expected));
  for (const language of ['zh', 'en']) {
    for (const edition of GUIDE_EDITIONS) {
      const sections = helpDocument(edition.kind, language);
      assert.ok(sections.length >= 6);
      assert.equal(new Set(sections.map(s => s.id)).size, sections.length);
      assert.ok(sections.every(s => s.title && s.paragraphs.length && s.paragraphs.every(p => typeof p === 'string' && p.length)));
      const images = sections.filter(s => s.image);
      assert.equal(images.length, edition.kind === 'rules-math' ? 3 : 5);
      assert.ok(images.every(s => GUIDE_ASSETS.some(asset => asset.path === s.image.path)));
    }
    const math = helpDocument('rules-math', language).flatMap(s => s.paragraphs).join(' ');
    assert.match(math, language === 'zh' ? /允许主动跳过/ : /Voluntary passing is allowed/);
    assert.match(math, language === 'zh' ? /完整状态/ : /complete state/);
    assert.match(math, language === 'zh' ? /三人及更多人/ : /three or more players/);
    assert.match(math, /631/);
    assert.ok(helpDocument('rules-essential', language).some(section => section.id === 'multiplayer-board'));
    const war = helpDocument('rules-war', language).flatMap(s => s.paragraphs).join(' ');
    assert.doesNotMatch(war, /最精简的防线|tightens your border|双方都无兵可派|neither side has any move/);
    assert.match(war, language === 'zh' ? /格点/ : /grid points?/);
  }
});

test('every guide paragraph survives mobile pagination at readable type sizes and each original diagram has a dedicated page', () => {
  for (const language of ['zh', 'en']) for (const [width, height, top] of [[320, 568, 136], [390, 844, 160], [430, 932, 160]]) {
    const { ui } = uiFor(language, width, height, top);
    for (const edition of readerEditions) {
      const sections = helpDocument(edition.kind, language), layout = readerLayout(ui, sections);
      assert.ok(layout.font >= 16 && layout.lineHeight >= 25);
      for (const section of sections) assert.equal(noSpace(layout.pages.filter(p => p.id === section.id).flatMap(p => p.lines).join('')),
        noSpace(section.paragraphs.join('')), `${language}/${width}/${section.id}`);
      assert.equal(layout.pages.filter(p => p.image).length, sections.filter(s => s.image).length);
      for (const page of layout.pages) {
        ui.ctx.font = `${layout.font}px sans-serif`;
        page.lines.forEach((line, i) => {
          assert.ok(ui.ctx.measureText(line).width <= width - 64 + .01, line);
          assert.ok(layout.y + i * layout.lineHeight + layout.font / 2 < layout.footer);
        });
        assert.ok(readingLines(ui.ctx, page.title, width - 48, 19).length <= 2, page.title);
      }
    }
  }
});

test('all guide pages and embedded cabin keep 44px actions inside phone safe areas', () => {
  for (const language of ['zh', 'en']) for (const [width, height, top] of [[320, 568, 136], [390, 844, 160], [430, 932, 160]]) {
    const actions = { page() {}, back() {}, select() {}, contents() {}, practice() {} };
    const hub = uiFor(language, width, height, top);
    for (const edition of readerEditions) {
      const sections = helpDocument(edition.kind, language), layout = readerLayout(hub.ui, sections);
      for (let page = 0; page < layout.pages.length; page++) {
        const h = uiFor(language, width, height, top);
        drawReader(h.ui, { sections, kind: edition.kind, page, canPractice: true }, actions);
        assertSafeButtons(h.buttons, width, height, top);
        assert.ok(h.texts.every(item => typeof item.value === 'string'),
          `${language}/${edition.kind}/${page}: reader labels must be defined`);
        if (layout.pages[page].image) {
          assert.equal(h.draws.length, 1);
          const [, x, y, w, hh] = h.draws[0];
          assert.ok(x >= 28 && x + w <= width - 28 && y >= layout.y - 8 && y + hh < layout.footer + 51);
        }
      }
    }
    for (const panelHeight of [240, 300]) {
      const h = uiFor(language, width, height, top);
      drawGuideCabin(h.ui, {}, actions, { x: 8, y: height - 24 - panelHeight, width: width - 16, height: panelHeight });
      // The embedding Canvas scroll view clips hit targets to its viewport.
      const visible = h.buttons.filter(b => b.y >= height - 24 - panelHeight && b.y + b.height <= height - 24);
      assertSafeButtons(visible, width, height, 0);
      assert.ok(h.buttons.some(b => b.id === 'guide-credits'), 'credits remain reachable by scrolling');
      assert.deepEqual(h.buttons.slice(0, 3).map(b => b.id), GUIDE_EDITIONS.map(e => `guide-${e.kind}`));
    }
  }
});

test('bilingual long-article contents jump to every chapter and return from the body', () => {
  for (const language of ['zh', 'en']) for (const [width, height, top] of [[320, 568, 136], [390, 844, 160], [430, 932, 160]]) {
    for (const kind of ['rules-math', 'why-code']) {
      const sections = helpDocument(kind, language), h = uiFor(language, width, height, top);
      assert.equal(sections.filter(section => section.level === 2).length, 3, 'three major chapters');
      assert.ok(!sections.some(section => section.paragraphs.some(text => text.includes('\\begin{') || text.includes('$$'))),
        'native reader must receive readable equations rather than TeX source');
      const layout = readerLayout(h.ui, sections), contents = layout.pages.findIndex(p => p.entries);
      assert.ok(contents >= 0);
      const targets = new Set();
      let selected = -1;
      const actions = { page(index) { selected = index; }, back() {}, practice() {} };
      for (let page = 0; page < layout.pages.length; page++) {
        if (!layout.pages[page].entries) continue;
        const current = uiFor(language, width, height, top);
        drawReader(current.ui, { sections, kind, page, canPractice: true }, actions);
        assertSafeButtons(current.buttons, width, height, top);
        for (const button of current.buttons.filter(b => b.id.startsWith('reader-section-'))) {
          button.action();
          const target = button.id.slice('reader-section-'.length);
          assert.equal(layout.pages[selected].id, target);
          assert.ok(!layout.pages[selected].entries);
          assert.ok(!targets.has(target), 'contents must not duplicate sections');
          targets.add(target);
        }
      }
      assert.deepEqual([...targets], sections.filter(s => !s.entries).slice(1).map(s => s.id));
      const body = layout.pages.findIndex(p => !p.entries && !p.image && !Number.isInteger(p.lesson) && p.id !== sections[0].id);
      const current = uiFor(language, width, height, top);
      drawReader(current.ui, { sections, kind, page: body, canPractice: true }, actions);
      current.buttons.find(b => b.id === 'reader-contents').action();
      assert.equal(selected, contents);
    }
  }
});

test('diagram cache only loads packaged paths once and ignores completion after disposal', () => {
  let requests = 0, invalidations = 0;
  const images = [];
  const cache = createGuideImages(() => { requests++; const image = { width: 100, height: 200 }; images.push(image); return image; }, () => invalidations++);
  assert.equal(cache.get('https://example.invalid/track.png').status, 'unavailable');
  assert.equal(requests, 0);
  const first = cache.get(GUIDE_ASSETS[0].path);
  assert.equal(first.status, 'loading'); assert.equal(cache.get(GUIDE_ASSETS[0].path), first); assert.equal(requests, 1);
  images[0].onload(); assert.equal(first.status, 'ready'); assert.equal(invalidations, 1);
  cache.get(GUIDE_ASSETS[1].path); const staleOnload = images[1].onload;
  cache.dispose(); staleOnload(); assert.equal(invalidations, 1); assert.equal(images[0].onload, null);
  assert.equal(cache.get(GUIDE_ASSETS[2].path).status, 'unavailable');
  const absent = createGuideImages(undefined);
  assert.equal(absent.get(GUIDE_ASSETS[0].path).status, 'failed');
});

test('fresh build copies original guide pixels, hashes their Web sources and includes them in package budgets', async t => {
  const tempParent = path.resolve(os.tmpdir());
  const output = await fs.mkdtemp(path.join(tempParent, 'lifeline-guide-package-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(output)), tempParent);
    assert.ok(path.basename(output).startsWith('lifeline-guide-package-'));
    await fs.rm(output, { recursive: true, force: true });
  });
  const manifest = await buildGame(output);
  for (const asset of GUIDE_ASSETS) {
    const relative = `web/web前端/guide/guide-images/${asset.source}`;
    const source = await fs.readFile(path.join(repo, relative)), packaged = await fs.readFile(path.join(output, asset.path));
    assert.deepEqual(packaged, source);
    assert.equal(manifest.sourceHashes[relative], sha(source));
    assert.equal(manifest.outputs.find(item => item.path === asset.path).sha256, sha(source));
  }
  assert.ok(manifest.mainPackageBytes < 3 * 1024 * 1024);
  assert.ok(manifest.totalBytes < 20 * 1024 * 1024);
});


test('why sections preserve Web prose and code as paginated text, with the three-player diagram', () => {
  for (const language of ['zh', 'en']) {
    const talk = helpDocument('why-talk', language), code = helpDocument('why-code', language);
    assert.ok(talk.length >= 3); assert.ok(code.length >= 3);
    assert.ok(talk.some(section => section.image?.id === 'three-balance'));
    assert.ok(talk[0].paragraphs[0].includes(language === 'zh' ? '主动跳过' : 'passing'));
    assert.ok(code.some(section => section.paragraphs.some(text => text.includes('def ') || text.includes('grid'))));
    assert.ok([...talk, ...code].every(section => section.title && section.paragraphs.length));
  }
});
