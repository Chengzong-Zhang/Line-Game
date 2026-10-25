import { build } from '../tools/native-build.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const result = await build({ stdin: { contents: ['core', 'state', 'integrity', 'storage', 'scheduler', 'session', 'worker-runtime', 'board', 'app', 'platform', 'online', 'library', 'preferences', 'controllers', 'play-options', 'turn-clock', 'model-catalog', 'model-assets', 'display'].map(n => `export * from './src/${n}.js';`).join('\n'), resolveDir: root },
  bundle: true, format: 'esm', platform: 'node', write: false, loader: { '.md': 'text' }, plugins: [{ name: 'queries', setup(b) {
    b.onResolve({ filter: /\?v=/ }, a => ({ path: path.resolve(a.resolveDir, a.path.split('?')[0]) }));
  } }] });
export const sut = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
const helpResult = await build({ entryPoints: [path.join(root, 'src/help-content.js')], bundle: true, format: 'esm', platform: 'node', write: false, loader: { '.md': 'text' } });
export const help = await import(`data:text/javascript;base64,${Buffer.from(helpResult.outputFiles[0].text).toString('base64')}`);
const webSource = await fs.readFile(path.resolve(root, '../../web/web前端/GameEngine.js'), 'utf8');
export const web = await import(`data:text/javascript;base64,${Buffer.from(webSource).toString('base64')}`);
export const plain = value => JSON.parse(JSON.stringify(value));
// Model an object-copying native message bridge that normalizes key order.
export function wireClone(value) {
  if (Object.prototype.toString.call(value) === '[object ArrayBuffer]') return new Uint8Array(value).slice().buffer;
  if (ArrayBuffer.isView(value)) return new value.constructor(value);
  if (Array.isArray(value)) return value.map(wireClone);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, wireClone(value[key])]));
  }
  return value;
}
export const memoryStorage = () => {
  const map = new Map();
  return { map, get: k => map.get(k), set: (k, v) => map.set(k, v) };
};
export function fakeWorker() {
  return { sent: [], terminated: false, postMessage(m) { this.sent.push(m); },
    onMessage(fn) { this.receive = fn; }, onError(fn) { this.error = fn; }, onProcessKilled(fn) { this.killed = fn; },
    terminate() { this.terminated = true; }, reply(result = {}, index = this.sent.length - 1) {
      const m = this.sent[index]; this.receive({ id: m.id, context: m.context, ok: true, result });
    } };
}
export function localScheduler() {
  return new sut.ComputeScheduler(() => {
    const w = fakeWorker(); w.postMessage = m => setTimeout(async () => {
      if (w.terminated) return;
      const result = await sut.handleWorkerMessage(wireClone(m));
      if (!w.terminated) w.receive(wireClone(result));
    }, 1);
    return w;
  });
}
export async function until(predicate, timeout = 10000) {
  const end = Date.now() + timeout;
  while (!predicate() && Date.now() < end) await new Promise(r => setTimeout(r, 5));
  assert.ok(predicate(), 'Condition did not settle');
}
