import { handleWorkerMessage } from '../worker-runtime.js';

// The build is self-contained: this Worker never requires parent directories,
// calls wx APIs, downloads files or depends on the experimental Worker V2.
// Model bytes arrive through the supported message bridge and are revalidated.
worker.onMessage((message) => {
  const response = handleWorkerMessage(message);
  if (response?.then) response.then(result => worker.postMessage(result));
  else worker.postMessage(response);
});
