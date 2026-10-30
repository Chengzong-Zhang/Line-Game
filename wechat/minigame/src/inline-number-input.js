// Native inline number keyboard adapter. A session owns its listeners until it
// confirms, blurs, is explicitly closed, or the app is hidden/destroyed.
export function createNumberKeyboard(api) {
  let serial = 0, active = null, destroyed = false;

  function detach(entry, { hide = false, notifyBlur = false } = {}) {
    if (!entry || active !== entry) return;
    active = null;
    for (const [off, handler] of entry.listeners) {
      try { off?.(handler); } catch (_) { /* The platform may already have detached it. */ }
    }
    entry.listeners.length = 0;
    if (notifyBlur) entry.onBlur?.(entry.value);
    if (hide) {
      try { api.hideKeyboard?.({}); } catch (_) { /* Closing is best effort. */ }
    }
  }

  const onHide = () => {
    const entry = active;
    if (entry) detach(entry, { notifyBlur: true });
  };
  try { api.onHide?.(onHide); } catch (_) { /* Some preview APIs omit lifecycle hooks. */ }

  function begin({ value = '', onInput = () => {}, onConfirm = () => {}, onBlur = () => {} } = {}) {
    if (destroyed) return { close() {}, update() {} };
    if (active) detach(active, { hide: true, notifyBlur: true });
    const token = ++serial;
    const entry = { token, value: String(value ?? ''), onInput, onConfirm, onBlur, listeners: [] };
    active = entry;
    const current = () => !destroyed && active === entry && entry.token === token;
    const listen = (name, callback) => {
      const on = api[`on${name}`], off = api[`off${name}`];
      if (typeof on !== 'function') return;
      const handler = event => { if (current()) callback(event || {}); };
      try { on.call(api, handler); entry.listeners.push([typeof off === 'function' ? off.bind(api) : null, handler]); }
      catch (_) { /* Missing keyboard event support is reported by showKeyboard below. */ }
    };
    listen('KeyboardInput', event => {
      entry.value = String(event.value ?? '');
      entry.onInput(entry.value, event);
    });
    listen('KeyboardConfirm', event => {
      if (event.value !== undefined) entry.value = String(event.value ?? '');
      entry.onConfirm(entry.value, event);
    });
    listen('KeyboardComplete', event => {
      if (event.value !== undefined) entry.value = String(event.value ?? '');
      detach(entry, { notifyBlur: true });
    });
    try {
      if (typeof api.showKeyboard !== 'function') throw new Error('NATIVE_KEYBOARD_UNAVAILABLE');
      api.showKeyboard({ defaultValue: entry.value, maxLength: 3, multiple: false, confirmHold: false,
        confirmType: 'done', type: 'number' });
    } catch (error) {
      detach(entry);
      throw error;
    }
    return {
      close: () => detach(entry, { hide: true, notifyBlur: true }),
      update: next => {
        if (!current()) return false;
        entry.value = String(next?.value ?? next ?? '');
        try { api.updateKeyboard?.({ value: entry.value }); } catch (_) { /* Optional API. */ }
        return true;
      },
    };
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    if (active) detach(active, { hide: true, notifyBlur: true });
    try { api.offHide?.(onHide); } catch (_) { /* Already detached. */ }
  }

  return { begin, close: () => active && detach(active, { hide: true, notifyBlur: true }), destroy };
}
