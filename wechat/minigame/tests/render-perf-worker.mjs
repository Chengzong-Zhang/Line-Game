import { parentPort, workerData } from 'node:worker_threads';
import fs from 'node:fs';
import vm from 'node:vm';
vm.runInNewContext(fs.readFileSync(workerData.source, 'utf8'), {
  worker: { onMessage: callback => parentPort.on('message', callback), postMessage: data => parentPort.postMessage(data) },
});
