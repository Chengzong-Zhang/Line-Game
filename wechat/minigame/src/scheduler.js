function sameContext(received, expected) {
  // Context is a flat record of primitive request metadata. Native Worker
  // bridges may reorder its keys; keep the key set and values strict.
  if (!received || !expected || typeof received !== 'object' || typeof expected !== 'object'
    || Array.isArray(received) || Array.isArray(expected)) return false;
  const keys = Object.keys(expected);
  return Object.keys(received).length === keys.length && keys.every(key =>
    Object.prototype.hasOwnProperty.call(received, key) && received[key] === expected[key]);
}

export class ComputeScheduler {
  constructor(createWorker, { timeoutMs = 15000 } = {}) {
    this.createWorker = createWorker;
    this.timeoutMs = timeoutMs;
    this.sequence = 0;
    this.queue = [];
    this.active = null;
    this.worker = null;
    this.generation = 0;
  }
  request(kind, payload, context, priority = 1) {
    return new Promise((resolve, reject) => {
      this.queue.push({ id: ++this.sequence, kind, payload, context, priority, resolve, reject });
      this.queue.sort((a, b) => a.priority - b.priority || a.id - b.id);
      this.pump();
    });
  }
  pump() {
    if (this.active || !this.queue.length) return;
    const task = this.queue.shift();
    this.active = task;
    const generation = this.generation;
    try {
      if (!this.worker) {
        const instance = this.createWorker();
        this.worker = instance;
        instance.onMessage((message) => {
          if (this.worker !== instance || this.generation !== generation) return;
          const current = this.active;
          if (!current || message?.id !== current.id) return;
          if (!sameContext(message.context, current.context)) {
            this.fail(new Error('STALE_WORKER_CONTEXT')); return;
          }
          clearTimeout(current.timer);
          this.active = null;
          if (message.ok) current.resolve(message.result);
          else current.reject(new Error(message.error || 'COMPUTE_FAILED'));
          this.pump();
        });
        instance.onError?.(() => this.worker === instance && this.fail(new Error('WORKER_ERROR')));
        instance.onProcessKilled?.(() => this.worker === instance && this.fail(new Error('WORKER_KILLED')));
      }
      task.timer = setTimeout(() => this.fail(new Error('COMPUTE_TIMEOUT')), this.timeoutMs);
      this.worker.postMessage({ id: task.id, kind: task.kind, payload: task.payload, context: task.context });
    } catch (error) { this.fail(error); }
  }
  fail(error) {
    const task = this.active;
    if (task) clearTimeout(task.timer);
    this.active = null;
    this.destroyWorker();
    task?.reject(error);
    this.pump();
  }
  destroyWorker() {
    const instance = this.worker;
    this.worker = null;
    this.generation++;
    // A process-killed notification may arrive after the native Worker died.
    try { instance?.terminate(); } catch (_) { /* It is already detached. */ }
  }
  cancel({ keepIdle = false } = {}) {
    const tasks = [...(this.active ? [this.active] : []), ...this.queue];
    this.active = null; this.queue = [];
    // Normal turns arrive after the previous response. Keep that idle realm
    // warm; active cancellation, hide/dispose and failures still detach it.
    // Never retain a Worker which may still be executing cancelled work.
    if (!keepIdle || tasks.length) this.destroyWorker();
    for (const task of tasks) {
      clearTimeout(task.timer);
      task.reject(new Error('CANCELLED'));
    }
  }
}
