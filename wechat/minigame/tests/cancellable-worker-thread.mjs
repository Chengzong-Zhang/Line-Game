import { parentPort } from 'node:worker_threads';
import fs from 'node:fs/promises';
import vm from 'node:vm';
const source = await fs.readFile(new URL('../dist/workers/index.js', import.meta.url), 'utf8');
vm.runInNewContext(source, { worker: {
  onMessage: fn => parentPort.on('message', message => {
    parentPort.postMessage({ started: message.id, kind: message.kind });
    fn(message);
  }),
  postMessage: data => parentPort.postMessage(data),
} });
