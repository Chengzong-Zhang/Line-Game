import { SharedLadderSession } from './SharedLadderSession.js?v=20261029-unified-r1';

function validateLadder(kind, body) {
  if (body?.board !== kind || !Array.isArray(body.entries) || typeof body.total !== 'number'
    || !body.entries.every(entry => typeof entry.displayName === 'string' && Number.isFinite(entry.points) && Number.isFinite(entry.rank))) return { status: 'unavailable' };
  return { status: body.entries.length ? 'ready' : 'empty', body };
}

export const SharedLadderPanel = {
  props: { language: { type: String, default: 'zh' }, auth: { type: Object, default: () => ({}) } },
  setup(props) {
    const { ref, watch, onMounted, onBeforeUnmount } = globalThis.Vue;
    const kind = ref(''), result = ref(null), password = ref(''), passwordBusy = ref(false);
    const availability = ref('checking');
    let request = 0;
    const bridge = new SharedLadderSession({ onExpire() {
      request += 1; password.value = ''; passwordBusy.value = false;
      if (kind.value) result.value = { status: 'session-expired' };
    } });
    bridge.setIdentity(props.auth);
    async function probe() {
      const current = request;
      const value = await bridge.probe();
      if (current === request && value.status !== 'cancelled') availability.value = value.status;
    }
    onMounted(() => { void probe(); });
    watch(() => [props.auth?.username, props.auth?.token, props.auth?.authOrigin], () => {
      request += 1; bridge.setIdentity(props.auth);
      password.value = ''; passwordBusy.value = false; result.value = null;
      availability.value = 'checking';
      void probe();
    });
    onBeforeUnmount(() => { request += 1; bridge.dispose(); });
    async function fetchBoard(next, current, token) {
      const response = await bridge.request(`/api/wechat/ladder/${next}`, { headers: { Authorization: `Bearer ${token}` } });
      if (current !== request || response.status === 'cancelled') return;
      if (response.status === 'signed-out') { bridge.clear(); result.value = { status: 'session-expired' }; return; }
      result.value = response.status === 'ok' ? validateLadder(next, response.body) : response;
    }
    async function open(next) {
      const current = ++request;
      bridge.cancelPending(); password.value = ''; passwordBusy.value = false;
      kind.value = next; result.value = { status: 'loading' };
      const session = await bridge.ensure();
      if (current !== request || session.status === 'cancelled') return;
      if (session.status !== 'ready') { result.value = session; return; }
      await fetchBoard(next, current, session.token);
    }
    async function submitPassword() {
      if (passwordBusy.value || !password.value || !kind.value) return;
      const current = ++request, secret = password.value;
      bridge.cancelPending();
      password.value = ''; passwordBusy.value = true;
      const session = await bridge.verifyPassword(secret);
      if (current !== request || session.status === 'cancelled') return;
      passwordBusy.value = false;
      if (session.status === 'signed-out') { result.value = { status: 'password-invalid' }; return; }
      if (session.status !== 'ready') { result.value = session; return; }
      result.value = { status: 'loading' };
      await fetchBoard(kind.value, current, session.token);
    }
    return { kind, result, open, availability, password, passwordBusy, submitPassword };
  },
  template: `
    <section class="panel" :aria-label="language === 'zh' ? '排行榜' : 'Leaderboards'">
      <h2>{{ language === 'zh' ? '排行榜' : 'Leaderboards' }}</h2>
      <div class="actions">
        <button type="button" class="action-button action-button-secondary" :aria-pressed="kind === 'ai'" @click="open('ai')">{{ language === 'zh' ? 'AI 榜' : 'AI ladder' }}</button>
        <button type="button" class="action-button action-button-secondary" :aria-pressed="kind === 'human'" @click="open('human')">{{ language === 'zh' ? '联机榜' : 'Online ladder' }}</button>
      </div>
      <p class="help-copy">{{ language === 'zh' ? '拓扑棋盘是练习，不计入现有排行榜；拓扑 AI 棋力尚未评测。' : 'Topology games are practice and do not count toward these ladders; topology AI strength has not been evaluated.' }}</p>
      <p v-if="!result && availability === 'unavailable'" class="help-copy">{{ language === 'zh' ? '当前同源共享榜单服务不可用。' : 'The same-origin leaderboard service is unavailable.' }}</p>
      <div v-if="result" role="status">
        <p v-if="result.status === 'loading'">{{ language === 'zh' ? '正在读取排行榜…' : 'Loading leaderboard…' }}</p>
        <p v-else-if="result.status === 'signed-out'">{{ language === 'zh' ? '请先登录共享对战账号，再查看榜单。' : 'Sign in to the shared game account to view this leaderboard.' }}</p>
        <p v-else-if="result.status === 'origin-mismatch'">{{ language === 'zh' ? '当前网页账号的登录来源与榜单服务不同，或来源未知；请在此站点重新登录。' : 'The Web login origin differs from this leaderboard, or is unknown. Sign in again on this site.' }}</p>
        <p v-else-if="result.status === 'session-expired'">{{ language === 'zh' ? '共享会话已过期，请重新选择榜单。' : 'The shared session expired. Select the leaderboard again.' }}</p>
        <p v-else-if="result.status === 'unavailable'">{{ language === 'zh' ? '榜单暂时无法读取，请稍后重试。' : 'The leaderboard is unavailable. Please try again later.' }}</p>
        <form v-else-if="result.status === 'password-required' || result.status === 'password-invalid'" @submit.prevent="submitPassword">
          <p>{{ language === 'zh' ? '查看共享榜单前，请验证当前网页账号密码。密码只用于本次验证。' : 'Verify your Web account password to view shared rankings. The password is used only for this verification.' }}</p>
          <label>{{ language === 'zh' ? '账号：' : 'Account: ' }}{{ auth.username }}</label>
          <label>{{ language === 'zh' ? '密码' : 'Password' }} <input class="input-field" type="password" autocomplete="current-password" v-model="password" :disabled="passwordBusy" /></label>
          <p v-if="result.status === 'password-invalid'" class="error-copy">{{ language === 'zh' ? '账号或密码无效，请重试。' : 'The account or password is invalid. Try again.' }}</p>
          <button type="submit" class="action-button action-button-primary" :disabled="passwordBusy || !password">{{ language === 'zh' ? '验证并查看' : 'Verify and view' }}</button>
        </form>
        <p v-else-if="result.status === 'empty'">{{ language === 'zh' ? '这个榜单暂无成绩。' : 'There are no results on this leaderboard yet.' }}</p>
        <ol v-else><li v-for="(entry, index) in result.body.entries" :key="index">{{ entry.rank }}. {{ entry.displayName }} · {{ entry.points }} {{ language === 'zh' ? '分' : 'points' }}<span v-if="entry.provisional"> · {{ language === 'zh' ? '暂定' : 'provisional' }}</span></li></ol>
      </div>
    </section>`
};
