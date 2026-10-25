// Local human-turn clock. Durations, never wall-clock deadlines, enter a save.
export class TurnClock {
  constructor(onTick, onExpire, { now = () => globalThis.performance?.now?.() ?? Date.now(),
    schedule = (callback, delay) => globalThis.setTimeout(callback, delay),
    cancel = timer => globalThis.clearTimeout(timer) } = {}) {
    this.now = now; this.schedule = schedule; this.cancel = cancel;
    this.onTick = onTick; this.onExpire = onExpire;
    this.left = 0; this.deadline = null; this.timer = null; this.generation = 0;
  }
  get running() { return this.deadline !== null; }
  remaining() { return this.running ? Math.max(0, Math.min(this.left, this.deadline - this.now())) : this.left; }
  suspend() {
    this.left = this.remaining(); this.deadline = null;
    this.generation++; this.cancel(this.timer); this.timer = null;
  }
  reset(duration) { this.suspend(); this.left = duration; }
  start() {
    if (this.running) return;
    const generation = ++this.generation;
    this.deadline = this.now() + this.left;
    const tick = () => {
      if (generation !== this.generation || !this.running) return;
      this.left = this.remaining();
      if (!this.left) {
        this.deadline = null; this.timer = null;
        this.onExpire(); this.onTick(); return;
      }
      this.onTick();
      if (generation === this.generation && this.running) this.timer = this.schedule(tick, Math.min(250, this.left));
    };
    this.timer = this.schedule(tick, Math.min(250, this.left));
  }
}
