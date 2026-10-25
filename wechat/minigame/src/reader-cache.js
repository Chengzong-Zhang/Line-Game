import { readerLayout } from './help-ui.js';

// Keep only the currently opened document and its current viewport. Guide prose
// is bundled with the app; opening another document or explicitly clearing this
// instance replaces it instead of accumulating every language and screen size.
export function createReaderCache(documentFor) {
  let document = null, layout = null;
  return {
    get(ui, kind, onlineEnabled = false) {
      const language = ui.language === 'en' ? 'en' : 'zh';
      const online = Boolean(onlineEnabled);
      if (!document || document.kind !== kind || document.language !== language || document.online !== online) {
        const sections = documentFor(kind, language, online);
        document = { kind, language, online, sections };
        layout = null;
      }
      const key = [ui.ctx, ui.ctx.measureText, ui.metrics.width, ui.metrics.height,
        ui.top, ui.metrics.bottom, ui.metrics.dpr];
      if (!layout || !key.every((value, index) => Object.is(value, layout.key[index]))) {
        layout = { key, value: readerLayout(ui, document.sections) };
      }
      return { sections: document.sections, layout: layout.value };
    },
    clear() { document = null; layout = null; },
  };
}
