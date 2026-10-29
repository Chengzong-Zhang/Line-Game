// Browser fixture adapter, excluded from the Mini Game build.
export function fixtureAdapter(player, params, dialog) {
  if (!['blue', 'red'].includes(player)) throw new Error('Choose a fixture player: blue or red');
  function route(value, protocol) {
    const url = new URL(value);
    if (url.origin !== `${protocol}//preview.invalid` || !url.pathname.startsWith('/api/wechat/') || url.search || url.hash)
      throw new Error('Fixture accepts only local WeChat test routes');
    return url.pathname;
  }
  return {
    storage: { get: key => localStorage.getItem(`fixture:${player}:${key}`),
      set: (key, value) => localStorage.setItem(`fixture:${player}:${key}`, value) },
    login: async () => player,
    request: async options => {
      const response = await fetch(route(options.url, 'https:'), { method: options.method,
        headers: options.header || { 'Content-Type': 'application/json' },
        body: options.data === undefined ? undefined : JSON.stringify(options.data), signal: AbortSignal.timeout(20000) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || `HTTP_${response.status}`);
      return data;
    },
    connectSocket: url => {
      const ws = new WebSocket(location.origin.replace('http:', 'ws:') + route(url, 'wss:'));
      return { onOpen: fn => ws.addEventListener('open', fn), onMessage: fn => ws.addEventListener('message', fn),
        onClose: fn => ws.addEventListener('close', fn), onError: fn => ws.addEventListener('error', fn),
        send: options => { try { ws.send(options.data); } catch (_) { options.fail?.(); } },
        close: options => ws.close(options.code) };
    },
    launchOptions: () => ({ query: params.has('room') ? { room: params.get('room') } : {} }),
    share: payload => {
      const url = new URL(location.href); url.searchParams.set('player', player === 'blue' ? 'red' : 'blue');
      const room = new URLSearchParams(payload.query).get('room');
      if (room) url.searchParams.set('room', room);
      return dialog(`本机测试邀请 / Local test invitation\n${room || ''}\n${url.href}\n此链接仅用于浏览器夹具，不是微信分享。`, { cancel: false });
    },
  };
}
