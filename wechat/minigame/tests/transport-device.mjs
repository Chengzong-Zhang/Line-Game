// Loopback-only adapter: real HTTP, WebSocket and compiled rule Workers.
// The fixture substitutes WeChat login only; no production endpoint is allowed.
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { sut, memoryStorage } from './helpers.mjs';

const mutationWindows = new Map();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function paceMutations(name) {
  const times = mutationWindows.get(name) || [];
  mutationWindows.set(name, times);
  while (true) {
    const now = Date.now();
    while (times.length && times[0] <= now - 60000) times.shift();
    // Exercise the unchanged production rate limit at a bounded client pace.
    if (times.length < 70) { times.push(now); return; }
    await sleep(Math.max(1, times[0] + 60050 - now));
  }
}

export function device(origin, name, storage = memoryStorage(), { paced = false } = {}) {
  assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  const faults = { dropReply: false, dropMessages: false };
  const metrics = { logins: 0, requests: 0 };
  const frames = [];
  let activeSocket = null, deliver = null;
  const scheduler = new sut.ComputeScheduler(() => {
    const worker = new Worker(new URL('./worker-thread.mjs', import.meta.url));
    return { onMessage: fn => worker.on('message', fn), onError: fn => worker.on('error', fn),
      postMessage: data => worker.postMessage(data), terminate: () => void worker.terminate() };
  });
  const platform = { storage, login: async () => { metrics.logins++; return name; },
    request: async options => {
      const route = new URL(options.url).pathname;
      if (paced && options.method === 'POST' && route.startsWith('/api/wechat/rooms')) await paceMutations(name);
      metrics.requests++;
      const response = await fetch(origin + route, { method: options.method, headers: options.header || { 'Content-Type': 'application/json' },
        body: options.data === undefined ? undefined : JSON.stringify(options.data), signal: AbortSignal.timeout(20000) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || `HTTP_${response.status}`);
      if (faults.dropReply && route.endsWith('/actions')) { faults.dropReply = false; throw new Error('NETWORK_ERROR'); }
      return data;
    },
    connectSocket: url => {
      const ws = new WebSocket(origin.replace('http:', 'ws:') + new URL(url).pathname);
      activeSocket = ws; frames.length = 0;
      ws.addEventListener('error', () => {});
      return { onOpen: fn => ws.addEventListener('open', fn), onMessage: fn => {
        deliver = data => fn({ data });
        ws.addEventListener('message', event => {
          if (faults.dropMessages) return;
          frames.push(event.data); if (frames.length > 8) frames.shift();
          fn(event);
        });
      },
      onClose: fn => ws.addEventListener('close', fn), onError: fn => ws.addEventListener('error', fn),
      send: options => { try { ws.send(options.data); } catch (_) { options.fail?.(); } }, close: options => ws.close(options.code) };
    } };
  const client = new sut.OnlineClient(platform, { onlineEnabled: true, apiBase: 'https://test.invalid' }, scheduler);
  return { client, faults, storage, metrics,
    disconnect() { activeSocket.close(4000, 'fixture interruption'); },
    async replayFrames() {
      assert.ok(frames.length >= 2, 'need distinct received revisions to reorder');
      const history = [...frames];
      await deliver(history.at(-1)); // duplicate latest acknowledgement
      await deliver(history[0]); // then an older revision
    },
    stop() { client.detach(); scheduler.cancel(); },
  };
}
