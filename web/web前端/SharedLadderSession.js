// Shared rankings have a separate identity from the legacy Web API. Every
// request below uses a fixed same-origin path and refuses redirects.
export class SharedLadderSession {
  constructor({ fetchImpl = globalThis.fetch?.bind(globalThis), now = Date.now, onExpire = () => {}, pageOrigin = globalThis.location?.origin } = {}) {
    this.fetchImpl = fetchImpl; this.now = now; this.onExpire = onExpire;
    this.pageOrigin = pageOrigin;
    this.identity = { username: '', token: '', authOrigin: '' }; this.generation = 0;
    this.controllers = new Set(); this.session = null; this.capability = null; this.timer = null;
  }
  cancelPending() {
    this.generation += 1;
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
  }
  clear() {
    this.cancelPending();
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null; this.session = null; this.capability = null;
  }
  setIdentity(identity) {
    const next = { username: typeof identity?.username === 'string' ? identity.username : '', token: typeof identity?.token === 'string' ? identity.token : '', authOrigin: typeof identity?.authOrigin === 'string' ? identity.authOrigin : '' };
    if (next.username !== this.identity.username || next.token !== this.identity.token || next.authOrigin !== this.identity.authOrigin) { this.clear(); this.identity = next; }
  }
  dispose() { this.clear(); this.identity = { username: '', token: '', authOrigin: '' }; }
  async request(path, options = {}) {
    const generation = this.generation, controller = new AbortController();
    this.controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await this.fetchImpl(path, { ...options, signal: controller.signal, redirect: 'error', cache: 'no-store' });
      if (generation !== this.generation || controller.signal.aborted) return { status: 'cancelled' };
      if (response.status === 401 || response.status === 403) return { status: 'signed-out' };
      if (!response.ok) return { status: 'unavailable' };
      const body = await response.json();
      if (generation !== this.generation || controller.signal.aborted) return { status: 'cancelled' };
      return { status: 'ok', body };
    } catch { return { status: generation !== this.generation ? 'cancelled' : 'unavailable' }; }
    finally { clearTimeout(timeout); this.controllers.delete(controller); }
  }
  async probe() {
    const result = await this.request('/api/wechat/status');
    if (result.status !== 'ok') return result;
    const value = result.body;
    if (value?.enabled !== true || value.protocol !== 1 || typeof value.ladder !== 'string' || !value.ladder) return { status: 'unavailable' };
    if (value.webLogin !== true) return { status: 'unavailable' };
    const mode = value.webAuthMode;
    if (mode !== 'legacy-jwt' && !(mode === 'password' && value.passwordLogin === true)) return { status: 'unavailable' };
    this.capability = { mode };
    return { status: 'ok', mode };
  }
  acceptSession(result) {
    if (result.status !== 'ok') return result;
    const body = result.body;
    if (body?.protocol !== 1 || typeof body.token !== 'string' || !body.token || body.token.length > 4096
      || !Number.isFinite(body.expiresIn) || body.expiresIn <= 0 || body.expiresIn > 86400) return { status: 'unavailable' };
    const duration = Math.max(1, body.expiresIn - 60) * 1000;
    this.session = { token: body.token, expiresAt: this.now() + duration };
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.clear(); this.onExpire(); }, duration);
    this.timer?.unref?.();
    return { status: 'ready', token: body.token };
  }
  async ensure() {
    if (this.session && this.session.expiresAt > this.now()) return { status: 'ready', token: this.session.token };
    if (this.session) { this.clear(); this.onExpire(); }
    const capability = this.capability ? { status: 'ok', ...this.capability } : await this.probe();
    if (capability.status !== 'ok') return capability;
    if (!this.identity.username || !this.identity.token) return { status: 'signed-out' };
    if (!this.pageOrigin || this.identity.authOrigin !== this.pageOrigin) return { status: 'origin-mismatch' };
    if (capability.mode === 'password') return { status: 'password-required' };
    const response = await this.request('/api/wechat/login/web', {
      method: 'POST', headers: { Authorization: `Bearer ${this.identity.token}`, 'Content-Type': 'application/json' }, body: '{}',
    });
    return this.acceptSession(response);
  }
  async verifyPassword(password) {
    if (!this.identity.username || !this.identity.token) return { status: 'signed-out' };
    if (!this.pageOrigin || this.identity.authOrigin !== this.pageOrigin) return { status: 'origin-mismatch' };
    if (!this.capability || this.capability.mode !== 'password' || typeof password !== 'string' || !password) return { status: 'unavailable' };
    const response = await this.request('/api/wechat/login/password-session', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: this.identity.username, password }),
    });
    return this.acceptSession(response);
  }
}
