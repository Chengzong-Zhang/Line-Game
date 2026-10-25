import { GUIDE_EDITIONS, GUIDE_ASSETS } from './guide-assets.js';
import { PLAYER_COLORS } from './display.js';

// No ellipsis: the reader measures every line and carries overflow to a new page.
export function readingLines(ctx, text, width, font = 16) {
  ctx.font = `${font}px sans-serif`;
  const lines = [];
  for (const paragraph of String(text).split(/\r?\n/)) {
    let line = '';
    for (const token of paragraph.match(/[A-Za-z0-9]+(?:[-'][A-Za-z0-9]+)*[,.!?;:)\]}，。！？；：、）》」』】”’）…]*|\s+|[([{（《「『【“‘]*[^\s][,.!?;:)\]}，。！？；：、）》」』】”’）…]*/gu) || []) {
      if (!token.trim()) { if (line) line += token; continue; }
      if (line && ctx.measureText(line + token).width > width) { lines.push(line.trimEnd()); line = ''; }
      // Keep trailing punctuation with the preceding character even when an
      // overlong Latin word must be split. Both paths handle mixed text such
      // as "AI。" and "100）", without changing or omitting the source text.
      for (const group of token.match(/[([{（《「『【“‘]*[^\s][,.!?;:)\]}，。！？；：、）》」』】”’）…]*/gu) || []) {
        if (line && ctx.measureText(line + group).width > width) { lines.push(line.trimEnd()); line = ''; }
        line += group;
      }
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

export function paginateHelp(ctx, sections, width, height, font = 16, lineHeight = 25) {
  const capacity = Math.max(1, Math.floor(height / lineHeight));
  return sections.flatMap(section => {
    if (section.entries) {
      const pages = [];
      let entries = [], used = 0;
      const flush = () => {
        if (entries.length) pages.push({ ...section, entries, lines: entries.flatMap(entry => entry.lines) });
        entries = []; used = 0;
      };
      for (const entry of section.entries) {
        const lines = readingLines(ctx, entry.title, width - 20, font);
        const entryHeight = Math.max(44, lines.length * lineHeight + 12);
        if (used && used + entryHeight > height) flush();
        entries.push({ ...entry, lines, height: entryHeight });
        used += entryHeight + 6;
      }
      flush();
      return pages;
    }
    if (section.image) return [...paginateHelp(ctx, [{ ...section, image: undefined }], width, height, font, lineHeight),
      { ...section, lines: [] }];
    const lines = section.paragraphs.flatMap((paragraph, i) => [
      ...(i ? [''] : []), ...readingLines(ctx, paragraph, width, font),
    ]);
    const pages = [];
    for (let start = 0; start < lines.length;) {
      while (lines[start] === '') start++;
      if (start >= lines.length) break;
      pages.push({ ...section, lines: lines.slice(start, start + capacity) });
      start += capacity;
    }
    return pages;
  });
}

export function readerLayout(ui, sections) {
  const footer = ui.metrics.height - ui.metrics.bottom - 160;
  const y = ui.top + 88, font = ui.language === 'en' ? 16 : 17, lineHeight = font + 9;
  return { y, footer, font, lineHeight,
    pages: paginateHelp(ui.ctx, sections, ui.metrics.width - 64, footer - y - 16, font, lineHeight) };
}

// One decoded image per original illustration; callbacks cannot redraw a disposed app.
export function createGuideImages(createImage, invalidate = () => {}) {
  const entries = new Map(), paths = new Set(GUIDE_ASSETS.map(asset => asset.path));
  let disposed = false;
  return {
    get(path) {
      if (disposed || !paths.has(path)) return { status: 'unavailable' };
      if (entries.has(path)) return entries.get(path);
      const entry = { status: 'loading', image: null };
      entries.set(path, entry);
      try {
        if (typeof createImage !== 'function') throw Error('IMAGE_UNAVAILABLE');
        const image = createImage();
        image.onload = () => {
          if (disposed) return;
          entry.status = image.width > 0 && image.height > 0 ? 'ready' : 'failed';
          entry.image = image; invalidate();
        };
        image.onerror = () => { if (!disposed) { entry.status = 'failed'; invalidate(); } };
        entry.image = image; image.src = path;
      } catch (_) { entry.status = 'failed'; }
      return entry;
    },
    dispose() {
      disposed = true;
      for (const entry of entries.values()) if (entry.image) entry.image.onload = entry.image.onerror = null;
      entries.clear();
    },
  };
}

const guideLabel = (kind, lang, fallback) =>
  GUIDE_EDITIONS.find(edition => edition.kind === kind)?.[lang === 'en' ? 'en' : 'zh']
    || (kind === 'why-code' ? (lang === 'en' ? 'How the game works' : '代码里的棋盘结构') : fallback);

// Embeds into the game's four-cabin workspace without owning navigation or match state.
export function drawGuideCabin(ui, state, actions, area) {
  const { text, button } = ui, en = ui.language === 'en'; let y = area.y;
  const group = title => { text(title, area.x, y + 12, 17, '#2a2118', 'left', 'bold'); y += 36; };
  const item = (id, title, kind, primary = false) => { button(id, title, area.x, y, area.width,
    () => actions.select(kind), { height: 44, font: 15, primary }); y += 52; };
  group(en ? 'Rules' : '规则');
  for (const edition of GUIDE_EDITIONS) item(`guide-${edition.kind}`, edition[en ? 'en' : 'zh'], edition.kind, edition.kind === 'rules-essential');
  group(en ? 'Why it works' : '妙处');
  item('guide-why-talk', en ? 'Expansion, defence & weak points' : '扩张、防守与破绽', 'why-talk');
  item('guide-why-code', en ? 'How the game works' : '代码里的棋盘结构', 'why-code');
  item('guide-why-theory', en ? 'A mathematical view' : '博弈与数学视角', 'rules-math');
  group(en ? 'Credits' : '致谢');
  item('guide-credits', en ? 'People behind the game' : '制作与致谢', 'credits');
  return y - area.y;
}

export function drawReader(ui, state, actions) {
  const { metrics: { width: w }, top, text, rect, button, label } = ui;
  const { pages, footer: textFooter, y, font, lineHeight } = state.layout || readerLayout(ui, state.sections), page = Math.max(0, Math.min(pages.length - 1, state.page));
  const current = pages[page];
  if (!current) return;
  // The caption page already has a practice link. Give its diagram that row's space.
  const footer = current.image ? textFooter + 51 : textFooter;
  readingLines(ui.ctx, current.title, w - 48, 19).forEach((line, i) =>
    text(line, 24, top + i * 24, 19, '#244d3d', 'left', 'bold'));
  text(`${page + 1} / ${pages.length}`, w - 24, top + 57, 13, '#738476', 'right');
  text(guideLabel(state.kind, ui.language, label(`help-${state.kind}`)), 24, top + 57, 13, '#738476');
  rect(20, y - 16, w - 40, footer - y + 2, 14);
  if (current.entries) {
    let entryY = y - 8;
    for (const entry of current.entries) {
      const target = pages.findIndex(candidate => !candidate.entries && candidate.id === entry.target);
      button(`reader-section-${entry.target}`, '', 32, entryY, w - 64,
        () => { if (target >= 0) actions.page(target); }, { height: entry.height, disabled: target < 0 });
      entry.lines.forEach((line, index) => text(line, 42, entryY + 6 + lineHeight / 2 + index * lineHeight,
        font, '#244d3d', 'left', entry.level === 2 ? 'bold' : 'normal'));
      entryY += entry.height + 6;
    }
  } else if (current.image) {
    const loaded = ui.guideImages?.get(current.image.path);
    // A caption gets its own normal text page before the image, so small screens
    // never shrink body type or crop the board to make both fit.
    const imageArea = { x: 28, y: y - 8, width: w - 56, height: footer - y - 16 };
    if (loaded?.status === 'ready') {
      const scale = Math.min(imageArea.width / loaded.image.width, imageArea.height / loaded.image.height);
      const iw = loaded.image.width * scale, ih = loaded.image.height * scale;
      ui.ctx.drawImage(loaded.image, imageArea.x + (imageArea.width - iw) / 2, imageArea.y + (imageArea.height - ih) / 2, iw, ih);
    } else {
      const status = loaded?.status === 'loading' ? (ui.language === 'en' ? 'Loading diagram…' : '图示加载中…')
        : (ui.language === 'en' ? 'Diagram unavailable. The preceding page explains the rule.' : '图示暂不可用，前一页保留完整规则说明。');
      readingLines(ui.ctx, status, w - 64, font).forEach((line, i) => text(line, 32, y + i * lineHeight, font, '#738476'));
    }
  } else current.lines.forEach((line, i) => text(line, 32, y + i * lineHeight, font, '#244d3d'));
  const half = (w - 60) / 2;
  button('reader-prev', label('previousPage'), 24, footer, half, () => actions.page(page - 1), { height: 44, disabled: page === 0 });
  button('reader-next', label('nextPage'), 36 + half, footer, half, () => actions.page(page + 1), { height: 44, disabled: page + 1 >= pages.length });
  if (!current.image && Number.isInteger(current.lesson) && state.canPractice) button('reader-practice', `${label('practiceLesson')} ${current.lesson + 1}`,
    24, footer + 51, w - 48, () => actions.practice(current.lesson), { height: 44, primary: true });
  const contentsPage = pages.findIndex(candidate => candidate.entries);
  if (!current.image && !Number.isInteger(current.lesson) && contentsPage >= 0 && !current.entries) {
    button('reader-contents', ui.language === 'en' ? 'Contents' : '目录', 24, footer + 51, w - 48,
      () => actions.page(contentsPage), { height: 44 });
  }
  if (state.kind === 'privacy' && state.onlineEnabled) button('delete-account', label('deleteAccount'), 24, footer + 51, w - 48,
    actions.deleteAccount, { height: 42, disabled: state.deleting });
  button('reader-back', label(state.returnLabel || 'backToGuide'), 24, footer + (current.image ? 51 : 102), w - 48, actions.back, { height: 48 });
}

export function drawResult(ui, state, actions) {
  const { metrics: { width: w, height: h, bottom }, top, text, rect, wrap, button, label } = ui;
  const { result, playerLabel } = state, compact = h - bottom - top < 470;
  text(result.winner === 'DRAW' ? label('draw') : `${playerLabel(result.winner)} ${label('wins')}`,
    24, top, 25, '#244d3d', 'left', 'bold');
  text(label('resultScoreUnits'), 24, top + 34, 12, '#738476');
  const columns = result.rows.length >= 4 ? 2 : 1;
  const step = compact ? 50 : 68, cardHeight = compact ? 44 : 58, cardWidth = (w - 48 - (columns - 1) * 8) / columns;
  result.rows.forEach((row, index) => {
    const x = 24 + (index % columns) * (cardWidth + 8), y = top + 61 + Math.floor(index / columns) * step;
    rect(x, y, cardWidth, cardHeight, 13, row.winner ? '#e2ecdd' : '#fffef9');
    const color = PLAYER_COLORS[row.player];
    text(playerLabel(row.player), x + 12, y + (compact ? 14 : 20), columns > 1 ? 14 : 16, color, 'left', 'bold');
    text(label(row.resigned ? columns > 1 ? 'resignedShort' : 'resultResigned' : row.winner ? 'wins' : 'resultCounted'), x + 12, y + (compact ? 32 : 42), 11, '#738476');
    text(row.area, x + cardWidth - 12, y + cardHeight / 2, columns > 1 ? 21 : 24, row.resigned ? '#738476' : '#244d3d', 'right', 'bold');
  });
  wrap(label(`result-${result.reason}`), 24, top + 76 + Math.ceil(result.rows.length / columns) * step, w - 48, 12, '#738476', compact ? 4 : 5);
  const half = (w - 60) / 2, footer = h - bottom - 108;
  button('result-replay', label('replay'), 24, footer, half, actions.replay, { primary: true });
  button('result-save', label('saveResult'), 36 + half, footer, half, actions.save, { disabled: state.online });
  button('result-back', label('backToReplay'), 24, footer + 54, w - 48, actions.back);
}
