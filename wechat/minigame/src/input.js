// Keep one gesture owner when desktop WeChat emits both mouse and touch events.
// Coordinates are logical window pixels, matching the Canvas UI hit regions.
export function createWxInput(api, { now = Date.now } = {}) {
  const callbacks = {}, listeners = [];
  let active = null, lastPoint = null, recent = null, paired = false, disposed = false;
  const point = event => {
    const x = event?.clientX ?? event?.x, y = event?.clientY ?? event?.y;
    return Number.isFinite(x) && Number.isFinite(y) ? { clientX: x, clientY: y } : null;
  };
  const listen = (name, handler) => {
    if (typeof api[`on${name}`] !== 'function') return;
    const wrapped = event => { if (!disposed) handler(event || {}); };
    // Desktop APIs may exist in an older mobile base library but reject calls.
    try { api[`on${name}`](wrapped); listeners.push([name, wrapped]); }
    catch (error) { if (!name.startsWith('Mouse') && name !== 'Wheel') throw error; }
  };
  const duplicate = (source, p) => recent && recent.source !== source && now() - recent.time < 500
    && p && Math.hypot(p.clientX - recent.point.clientX, p.clientY - recent.point.clientY) < 24;
  const finish = (source, p) => {
    if (p) recent = { source: paired ? 'mouse' : source, point: p, time: now() };
    active = null; paired = false;
  };
  const resetInput = () => {
    if (active) callbacks.cancel?.({ touches: [] });
    active = null; paired = false; lastPoint = null;
  };
  listen('TouchStart', event => {
    const p = point(event.touches?.[0]);
    if (active === 'mouse') {
      paired = Boolean(p && lastPoint && Math.hypot(p.clientX - lastPoint.clientX, p.clientY - lastPoint.clientY) < 24);
      return;
    }
    if (duplicate('touch', p)) return;
    active = 'touch'; lastPoint = p; callbacks.start?.(event);
  });
  listen('TouchMove', event => {
    if (active !== 'touch' && !(active === 'mouse' && paired)) return;
    lastPoint = point(event.touches?.[0]) || lastPoint; callbacks.move?.(event);
  });
  listen('TouchEnd', event => {
    if (active !== 'touch' && !(active === 'mouse' && paired)) return;
    callbacks.end?.(event);
    if (!event.touches?.length) finish('touch', point(event.changedTouches?.[0]) || lastPoint);
  });
  listen('TouchCancel', event => {
    if (active !== 'touch' && !(active === 'mouse' && paired)) return;
    callbacks.cancel?.(event); finish('touch', lastPoint);
  });
  listen('MouseDown', event => {
    if (event.button !== undefined && event.button !== 0 && event.button !== 'left') return;
    const p = point(event);
    if (!p) return;
    if (active === 'touch') {
      paired = Boolean(lastPoint && Math.hypot(p.clientX - lastPoint.clientX, p.clientY - lastPoint.clientY) < 24);
      return;
    }
    if (active || duplicate('mouse', p)) return;
    active = 'mouse'; lastPoint = p; callbacks.start?.({ touches: [p], pointerType: 'mouse' });
  });
  listen('MouseMove', event => {
    const p = point(event);
    if (p) lastPoint = p;
    if (active !== 'mouse' && !(active === 'touch' && paired)) return;
    if (event.buttons === 0) { resetInput(); return; }
    if (p) callbacks.move?.({ touches: [p], pointerType: 'mouse' });
  });
  listen('MouseUp', event => {
    if (event.button !== undefined && event.button !== 0 && event.button !== 'left') return;
    if (active !== 'mouse' && !(active === 'touch' && paired)) return;
    const p = point(event) || lastPoint;
    callbacks.end?.({ touches: [], changedTouches: p ? [p] : [], pointerType: 'mouse' });
    finish('mouse', p);
  });
  listen('Wheel', event => {
    const p = point(event) || lastPoint;
    const deltaY = Number.isFinite(event.deltaY) ? event.deltaY
      : Number.isFinite(event.wheelDelta) ? -event.wheelDelta : 0;
    if (!deltaY) return;
    callbacks.wheel?.({ ...p, deltaY, deltaMode: event.deltaMode || 0 });
  });
  return {
    touchStart: fn => { callbacks.start = fn; }, touchMove: fn => { callbacks.move = fn; },
    touchEnd: fn => { callbacks.end = fn; }, touchCancel: fn => { callbacks.cancel = fn; },
    wheel: fn => { callbacks.wheel = fn; }, resetInput,
    disposeInput: () => {
      resetInput(); disposed = true;
      for (const [name, handler] of listeners) {
        try { api[`off${name}`]?.(handler); } catch (_) { /* Already detached or unsupported. */ }
      }
    },
  };
}
