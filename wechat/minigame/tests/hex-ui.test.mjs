import test from 'node:test';
import assert from 'node:assert/strict';
import { sut, until, memoryStorage } from './helpers.mjs';
import { uiHarness } from './ui-harness.mjs';
import { TEXT } from '../src/i18n.js';
import { drawPlayers } from '../src/screens.js';
import { drawResult, readerLayout } from '../src/help-ui.js';
import { help } from './helpers.mjs';
const profile = 'hex-player-policy-v1';
const ready = async h => { await until(() => h.app.session.snapshot && !h.app.session.busy); await h.render(); };
const choose = async (h, player, index) => { h.p.choose = async () => index; await h.scrollTo(`controller-${player}`); await h.tap(`controller-${player}`); };
const stableCapture = session => { const saved = session.capture(); delete saved.session.savedAt; return JSON.stringify(saved); };

test('hexagonal overview, hit testing, orientation and zoom cover every valid node including all six corners', () => {
  for (const count of [4, 5, 6]) for (const size of [5, 7, 15]) for (const width of [260, 330]) {
    const rect = { x: 30, y: 290, width, height: 106 }, layout = sut.boardLayout(size, rect, count);
    const points = sut.getBoardPositions(size, count), r = size - 1;
    assert.equal(points.length, 3 * size * r + 1);
    assert.deepEqual(sut.getBoardVertices(size, count), [[r, 0], [2*r, 0], [2*r, r], [r, 2*r], [0, 2*r], [0, r]]);
    for (const p of points) {
      const pixel = sut.toScreen(p, layout); assert.deepEqual(sut.hitPoint(...pixel, layout), p);
      assert.ok(pixel[0] >= rect.x - 1e-8 && pixel[0] <= rect.x + rect.width + 1e-8);
      assert.ok(pixel[1] >= rect.y - 1e-8 && pixel[1] <= rect.y + rect.height + 1e-8);
      const zoom = sut.focusBoardLayout(size, rect, p, 44, count), [x, y] = sut.toScreen(p, zoom);
      assert.ok(Math.abs(x - rect.x - rect.width / 2) < 1e-8 && Math.abs(y - rect.y - rect.height / 2) < 1e-8);
      assert.deepEqual(sut.hitPoint(x + 12, y, zoom), p);
    }
    const corners = sut.getBoardVertices(size, count).map(p => sut.toScreen(p, layout));
    assert.equal(corners[0][1], corners[1][1]); assert.ok(corners[0][1] < corners[3][1]);
    assert.ok(corners[0][0] < corners[1][0]); assert.ok(corners[2][0] > corners[1][0]);
    assert.equal(sut.hitPoint(...sut.toScreen([0, 0], layout), layout), null);
    for (const [dx, dy] of [[10000, 0], [-10000, 0], [0, 10000], [0, -10000], [10000, -10000]]) {
      const zoom = sut.focusBoardLayout(size, rect, [r, r], 44, count), [x, y] = sut.panBoardFocus(zoom.focus, dx, dy, zoom);
      assert.ok(x >= -1e-8 && y >= -1e-8 && x <= 2*r + 1e-8 && y <= 2*r + 1e-8 && x+y >= r-1e-8 && x+y <= 3*r+1e-8);
    }
  }
});

test('2–6 player drafts keep separate seats and starters across switching, restart and applying a six-player game', async () => {
  const storage = memoryStorage(), h = uiHarness({ storage }); let second;
  try {
    await ready(h); const hash = h.app.session.stateHash; await h.tap('cabin-board');
    for (const count of [2, 3, 4, 5, 6]) {
      await h.slide('player-count', count, 2, 6); const last = sut.playerIds(count).at(-1);
      await choose(h, last, 1); await h.tap(`starter-${last}`);
    }
    for (const count of [6, 4, 2, 5, 3, 6]) {
      await h.slide('player-count', count, 2, 6); const preferences = sut.readPreferences(storage), last = sut.playerIds(count).at(-1);
      assert.equal(preferences.playerCount, count); assert.equal(preferences.startPlayer, last);
      assert.equal(preferences.controllers[last], count >= 4 ? profile : count === 3 ? 'three-player-policy-v1' : 'greedy');
      assert.equal(preferences.mode, count === 3 ? 'three-human' : count === 2 ? 'ai-white' : 'human');
    }
    assert.equal(h.app.session.stateHash, hash);
    h.app.dispose(); second = uiHarness({ storage }); await ready(second); await second.tap('cabin-board');
    for (const count of [2, 3, 4, 5, 6]) { await second.slide('player-count', count, 2, 6); assert.equal(sut.readPreferences(storage).startPlayer, sut.playerIds(count).at(-1)); }
    await second.slide('board-size', 5, 5, 15); await second.tap('cabin-close'); await second.tap('new-game');
    await until(() => second.app.session.settings.playerCount === 6 && second.app.session.actions.length === 1 && !second.app.session.busy);
    assert.equal(second.app.session.settings.startPlayer, 'CYAN'); assert.equal(second.app.session.actions[0].player, 'CYAN');
    assert.equal(second.app.session.snapshot.currentPlayer, 'BLACK'); assert.equal(second.app.session.error, null);
  } finally { h.app.dispose(); second?.app.dispose(); }
});

test('every hexagon seat offers compatible Hex AI versions, rejects stale menu choices and offers training contribution', async () => {
  const h = uiHarness({ config: { apiBase: 'https://example.invalid', onlineEnabled: false }, platformOverrides: { contributionRequest: async () => ({}) } }); let finish;
  try {
    await ready(h); await h.tap('cabin-board'); h.p.choose = () => new Promise(resolve => { finish = resolve; });
    await h.tap('controller-BLACK'); await h.slide('player-count', 6, 2, 6); finish(4); await h.render();
    assert.equal(sut.readPreferences(h.p.storage).controllers, undefined);
    for (const player of sut.playerIds(6)) {
      let labels; h.p.choose = async options => { labels = options; return 1; };
      await h.scrollTo(`controller-${player}`); await h.tap(`controller-${player}`);
      assert.deepEqual(labels, ['human', profile, 'hex-player-search-v5',
        'multiplayer-easy-v1', 'multiplayer-medium-v1', 'multiplayer-hard-v1'].map(item => TEXT.zh[`controller-${item}`]));
      assert.equal(sut.readPreferences(h.p.storage).controllers[player], profile);
    }
    await h.scrollTo('training-contribution'); await h.render();
    assert.equal(h.app.getButtons().find(button => button.id === 'training-contribution').disabled, true,
      'the V2-only contribution policy is unavailable for default V3 games');
    assert.ok(h.texts.some(text => /仅 V2/.test(text)));
  } finally { finish?.(-1); h.app.dispose(); }
});

test('four, five and six-player hints and replay analysis remain read-only and choose Hex AI in both languages', async () => {
  for (const count of [4, 5, 6]) for (const language of ['zh', 'en']) {
    const h = uiHarness({ language, width: 320, height: 568, top: 64 });
    try {
      await ready(h); await h.tap('cabin-board'); await h.slide('player-count', count, 2, 6); await h.slide('board-size', 5, 5, 15);
      await h.tap('cabin-close'); await h.tap('new-game'); await until(() => h.app.session.canPlay());
      const hash = h.app.session.stateHash; await h.tap('hint'); await until(() => !h.app.session.busy && h.app.session.hintPoint);
      assert.equal(h.app.session.stateHash, hash); assert.equal(h.app.session.hintsUsed, 1);
      await h.app.session.act({ type: 'move', point: [...h.app.session.hintPoint] }); const live = stableCapture(h.app.session);
      await h.app.session.replay(0); await h.render(); await h.tap('replay-analyzeReplay');
      await until(() => !h.app.session.busy); await h.render();
      assert.ok(h.texts.includes(TEXT[language][`controller-${profile}`]));
      assert.equal(h.texts.some(text => /\d+(?:\.\d+)?%/.test(text)), false);
      let offered; h.p.choose = async options => { offered = options; return 0; };
      await h.tap('analysis-choose'); await until(() => !h.app.session.busy); await h.render();
      assert.deepEqual(offered, [profile, 'hex-player-search-v5',
        'multiplayer-easy-v1', 'multiplayer-medium-v1', 'multiplayer-hard-v1'].map(item => TEXT[language][`controller-${item}`]));
      await h.tap('analysis-move-0'); assert.equal(stableCapture(h.app.session), live); assert.equal(h.app.session.hintsUsed, 1);
      assert.equal(h.texts.includes('undefined'), false); assert.equal(h.app.session.error, null);
    } finally { h.app.dispose(); }
  }
});

test('compact six-player results and paged seat controls remain inside safe areas, with readable bilingual rules', () => {
  for (const language of ['zh', 'en']) for (const [width, height, top] of [[320, 568, 104], [390, 844, 128]]) {
    const boxes = [], texts = [], ui = { metrics: { width, height, bottom: 24 }, top, language,
      ctx: { font: '', measureText: text => ({ width: [...String(text)].length * 8 }) },
      label: key => TEXT[language][key], rect: (x,y,width,height) => boxes.push({ x,y,width,height }),
      text: (value,x,y,font) => { assert.notEqual(value, undefined); texts.push({value,x,y,font}); },
      wrap: (value,x,y,width,font) => { assert.notEqual(value, undefined); texts.push({value,x,y,font}); return 32; },
      button: (id,title,x,y,width,action,options={}) => boxes.push({id,x,y,width,height:options.height||48}) };
    const players = sut.playerIds(6), controllers = Object.fromEntries(players.map(player => [player, profile]));
    drawPlayers(ui, { playerCount: 6, controllers, startPlayer: 'CYAN', page: 1 }, {});
    for (const box of boxes) assert.ok(box.x >= 0 && box.y >= 0 && box.x+box.width <= width && box.y+box.height <= height-24, JSON.stringify(box));
    boxes.length = 0;
    drawResult(ui, { result: { winner: 'CYAN', reason: 'resignation', rows: players.map((player,i)=>({player,area:120+i,winner:player==='CYAN',resigned:player!=='CYAN'})) },
      playerLabel: player => TEXT[language][sut.PLAYER_LABEL_KEYS[player]] }, {});
    for (const box of boxes) assert.ok(box.x >= 0 && box.y >= 0 && box.x+box.width <= width && box.y+box.height <= height-24, JSON.stringify(box));
    const footer = boxes.find(box => box.id === 'result-replay').y;
    assert.ok(boxes.filter(box=>!box.id).every(box=>box.y+box.height<footer));
    for (const kind of ['rules','rules-essential','rules-war','rules-math']) {
      const sections = help.helpDocument(kind, language), layout = readerLayout(ui, sections);
      assert.ok(layout.font >= 16);
      if (kind === 'rules-math') {
        const geometry = sections.find(section => section.id === 'rulesMath-mathematics-geometry');
        assert.ok(geometry, 'the mathematical guide includes both board geometries');
        assert.match(geometry.paragraphs.join(' '), language === 'zh' ? /六边形/ : /hexagon/);
        assert.match(geometry.paragraphs.join(' '), /631/);
      } else assert.ok(sections.some(section => section.id === 'multiplayer-board'));
      for (const section of sections) assert.equal(layout.pages.filter(page=>page.id===section.id).flatMap(page=>page.lines).join('').replace(/\s/g,''),section.paragraphs.join('').replace(/\s/g,''));
    }
  }
});
