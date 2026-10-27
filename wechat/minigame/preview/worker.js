// Browser-only host bridge, excluded from the WeChat package.
self.worker = { onMessage: (fn) => self.addEventListener('message', (event) => fn(event.data)), postMessage: (data) => self.postMessage(data) };
importScripts('/dist/workers/index.js');
