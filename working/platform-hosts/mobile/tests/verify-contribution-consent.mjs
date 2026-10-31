import assert from 'node:assert/strict';
import * as VueRuntime from 'vue';
import { ContributionPanel, TrainingContribution } from '../../web/web前端/TrainingContribution.js';
import { syntheticContribution } from '../../web/web前端/tests/fixtures/create-training-fixture.mjs';
import { validateContribution } from '../../web/tools/validate_contribution.mjs';

function makeRenderer() {
  const detach = (node) => {
    if (!node.parent) return;
    const siblings = node.parent.children;
    const index = siblings.indexOf(node);
    if (index >= 0) siblings.splice(index, 1);
    node.parent = null;
  };
  return VueRuntime.createRenderer({
    createElement: (type) => ({ type, props: {}, children: [], parent: null, text: '' }),
    createText: (text) => ({ type: '#text', text, parent: null }),
    createComment: (text) => ({ type: '#comment', text, parent: null }),
    setText: (node, text) => { node.text = text; },
    setElementText: (node, text) => { node.children = []; node.text = text; },
    patchProp: (node, key, _previous, next) => { node.props[key] = next; },
    insert: (node, parent, anchor = null) => {
      detach(node);
      node.parent = parent;
      const index = anchor ? parent.children.indexOf(anchor) : -1;
      if (index < 0) parent.children.push(node); else parent.children.splice(index, 0, node);
    },
    remove: detach,
    parentNode: (node) => node.parent,
    nextSibling: (node) => {
      if (!node.parent) return null;
      return node.parent.children[node.parent.children.indexOf(node) + 1] ?? null;
    },
  });
}

const compiledPanel = { ...ContributionPanel, render: VueRuntime.compile(ContributionPanel.template) };
const originalRuntime = globalThis.__LIFELINE_RUNTIME_CONFIG__;
globalThis.__LIFELINE_RUNTIME_CONFIG__ = { trainingContributionUrl: 'https://lifelinegame.cn/api/training/contributions' };

function textContent(node) { return `${node.text ?? ''}${(node.children ?? []).map(textContent).join('')}`; }
function findNode(root, predicate) {
  if (predicate(root)) return root;
  for (const child of root.children ?? []) {
    const found = findNode(child, predicate);
    if (found) return found;
  }
  return null;
}
function findButton(root, text) {
  const node = findNode(root, (candidate) => candidate.type === 'button' && textContent(candidate).includes(text));
  assert.ok(node, `button containing ${JSON.stringify(text)} exists`);
  return node;
}
function click(node) { assert.equal(typeof node.props.onClick, 'function'); node.props.onClick(); }

async function mountPanel({ mobileShell, language = 'zh', client, transitions }) {
  const languageRef = VueRuntime.ref(language);
  const stateRef = VueRuntime.ref(client.snapshot());
  const wrapper = {
    setup() {
      return () => VueRuntime.h(compiledPanel, {
        language: languageRef.value,
        mobileShell,
        state: stateRef.value,
        onToggle: (enabled) => {
          transitions.push(enabled);
          client.setEnabled(enabled);
          stateRef.value = client.snapshot();
          void client.flush();
        },
        onRetry: () => { void client.flush(); },
      });
    },
  };
  const host = { type: 'root', children: [], parent: null };
  const app = makeRenderer().createApp(wrapper);
  app.mount(host);
  await VueRuntime.nextTick();
  return { app, host, languageRef, stateRef };
}

try {
  const values = new Map();
  let posts = 0;
  const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  const client = new TrainingContribution({
    storage,
    initialEnabled: false,
    fetcher: async (_url, options) => {
      posts++;
      assert.equal(options.credentials, 'omit');
      const verified = await validateContribution(JSON.parse(options.body));
      return { ok: true, json: async () => ({ status: 'awaiting_review', game_id: verified.game_id }) };
    },
  });
  const transitions = [];
  const panel = await mountPanel({ mobileShell: true, client, transitions });
  let input = findNode(panel.host, (node) => node.type === 'input');
  const firstEnableAttempt = { target: { checked: true } };
  input.props.onChange(firstEnableAttempt);
  await VueRuntime.nextTick();
  assert.equal(firstEnableAttempt.target.checked, false, 'an unconfirmed native checkbox immediately returns to off');
  assert.equal(input.props.checked, false, 'the rendered checkbox remains visibly off until confirmation');
  assert.equal(client.enabled, false, 'opening the disclosure alone does not enable contributions');
  assert.equal(client.queue.length, 0, 'opening the disclosure creates no queued replay');
  assert.equal(posts, 0, 'opening the disclosure sends no request');
  assert.deepEqual(transitions, [], 'opening the disclosure emits no toggle');
  const disclosure = findNode(panel.host, (node) => node.type === 'section' && node.props.class === 'contribution-disclosure');
  assert.ok(disclosure);
  assert.match(findButton(disclosure, '取消').props.class, /action-button-secondary/);
  assert.match(findNode(disclosure, (node) => node.type === 'div' && node.props.class === 'contribution-disclosure-actions actions').props.class, /actions/);
  assert.equal(findNode(disclosure, (node) => node.type === 'code').props.style['overflow-wrap'], 'anywhere');
  assert.match(textContent(disclosure), /完整棋局配置/);
  assert.match(textContent(disclosure), /AI 扮演的角色、模型和搜索参数/);
  assert.match(textContent(disclosure), /IP 地址等常规连接元数据/);
  assert.match(textContent(disclosure), /https:\/\/lifelinegame\.cn\/api\/training\/contributions/);
  click(findButton(disclosure, '取消'));
  await VueRuntime.nextTick();
  assert.equal(client.enabled, false, 'cancel leaves contributions disabled');
  assert.deepEqual(transitions, [], 'cancel emits no toggle');
  assert.equal(posts, 0, 'cancel sends no request');
  assert.equal(findNode(panel.host, (node) => node.type === 'section' && node.props.class === 'contribution-disclosure'), null);
  assert.match(findButton(panel.host, '查看贡献说明').props.class, /action-button-secondary/);

  input = findNode(panel.host, (node) => node.type === 'input');
  const unmountEnableAttempt = { target: { checked: true } };
  input.props.onChange(unmountEnableAttempt);
  await VueRuntime.nextTick();
  assert.equal(unmountEnableAttempt.target.checked, false);
  const pendingConfirmation = findNode(panel.host, (node) => node.type === 'section' && node.props.class === 'contribution-disclosure');
  const staleConfirmButton = findButton(pendingConfirmation, '我已了解，开启贡献');
  panel.app.unmount();
  click(staleConfirmButton);
  assert.equal(client.enabled, false, 'an old confirmation event after parent unmount cannot opt in');
  assert.equal(client.queue.length, 0, 'unmounting a pending confirmation creates no queue');
  assert.equal(posts, 0, 'unmounting a pending confirmation sends no request');

  const remountedPanel = await mountPanel({ mobileShell: true, client, transitions });
  assert.equal(findNode(remountedPanel.host, (node) => node.type === 'section' && node.props.class === 'contribution-disclosure'), null, 'a fresh mount does not restore an unconfirmed prompt');
  assert.equal(findNode(remountedPanel.host, (node) => node.type === 'input').props.checked, false);
  input = findNode(remountedPanel.host, (node) => node.type === 'input');
  input.props.onChange({ target: { checked: true } });
  await VueRuntime.nextTick();
  const confirmation = findNode(remountedPanel.host, (node) => node.type === 'section' && node.props.class === 'contribution-disclosure');
  const confirmButton = findButton(confirmation, '我已了解，开启贡献');
  assert.match(confirmButton.props.class, /action-button-primary/);
  click(confirmButton);
  click(confirmButton);
  await VueRuntime.nextTick();
  assert.equal(client.enabled, true, 'explicit confirmation enables contributions');
  assert.deepEqual(transitions, [true], 'one confirmation causes exactly one root toggle');
  assert.equal(posts, 0, 'enabling alone sends no replay without a completed match');
  assert.ok(findButton(remountedPanel.host, '查看贡献说明'), 'enabled users can reopen the explanation');

  const fixture = await syntheticContribution(405);
  assert.equal(await client.enqueue(fixture.replay.config, fixture.replay.actions, fixture.context), true);
  await client.flush();
  assert.equal(posts, 1, 'the enabled real contribution queue sends one completed synthetic replay');
  assert.equal(client.queue.length, 0);

  findButton(remountedPanel.host, '查看贡献说明').props.onClick();
  remountedPanel.languageRef.value = 'en';
  await VueRuntime.nextTick();
  const englishDisclosure = findNode(remountedPanel.host, (node) => node.type === 'section' && node.props.class === 'contribution-disclosure');
  assert.match(textContent(englishDisclosure), /full match configuration/);
  assert.match(textContent(englishDisclosure), /AI roles, model and search settings/);
  click(findButton(englishDisclosure, 'Close details'));
  await VueRuntime.nextTick();

  remountedPanel.languageRef.value = 'zh';
  await VueRuntime.nextTick();
  input = findNode(remountedPanel.host, (node) => node.type === 'input');
  input.props.onChange({ target: { checked: false } });
  await VueRuntime.nextTick();
  assert.equal(client.enabled, false, 'turning off still reaches the real contribution client');
  assert.equal(client.queue.length, 0, 'turning off clears local pending records');
  assert.deepEqual(transitions, [true, false]);

  remountedPanel.app.unmount();

  let releaseRequest;
  let abortedPosts = 0;
  const abortValues = new Map();
  const abortClient = new TrainingContribution({
    storage: { getItem: (key) => abortValues.get(key) ?? null, setItem: (key, value) => abortValues.set(key, value) },
    initialEnabled: false,
    fetcher: (_url, options) => {
      abortedPosts++;
      return new Promise((resolve) => { releaseRequest = () => resolve({ ok: true, json: async () => ({ status: 'awaiting_review', game_id: 'b'.repeat(64) }) }); });
    },
  });
  abortClient.setEnabled(true);
  assert.equal(await abortClient.enqueue(fixture.replay.config, fixture.replay.actions, fixture.context), true);
  const abortSignal = { value: null };
  const originalFetch = abortClient.fetcher;
  abortClient.fetcher = (url, options) => { abortSignal.value = options.signal; return originalFetch(url, options); };
  const pendingRequest = abortClient.flush();
  await Promise.resolve();
  assert.equal(abortedPosts, 1);
  abortClient.setEnabled(false);
  assert.equal(abortSignal.value.aborted, true, 'turning off aborts the active local request');
  assert.equal(abortClient.queue.length, 0);
  releaseRequest();
  await pendingRequest;
  assert.equal(abortClient.enabled, false, 'a late success response cannot turn contribution back on');
  assert.equal(abortClient.queue.length, 0, 'a late response cannot restore a cleared local queue');
  assert.equal(abortClient.lastReceipt, null, 'a late response after opt-out is not presented as a new local receipt');

  const webValues = new Map();
  const webClient = new TrainingContribution({ storage: { getItem: (key) => webValues.get(key) ?? null, setItem: (key, value) => webValues.set(key, value) }, initialEnabled: false, fetcher: async () => { throw new Error('unexpected upload'); } });
  const webTransitions = [];
  const webPanel = await mountPanel({ mobileShell: false, client: webClient, transitions: webTransitions });
  const webInput = findNode(webPanel.host, (node) => node.type === 'input');
  webInput.props.onChange({ target: { checked: true } });
  await VueRuntime.nextTick();
  assert.deepEqual(webTransitions, [true], 'ordinary web keeps the existing direct toggle behavior');
  assert.equal(findNode(webPanel.host, (node) => node.type === 'section' && node.props.class === 'contribution-disclosure'), null);
  webPanel.app.unmount();

  process.stdout.write(JSON.stringify({ status: 'PASS', mobile_opt_in_requires_confirmation: true, checkbox_stays_off_until_confirmed: true, cancel_creates_no_queue_or_post: true, pending_confirmation_unmount_safe: true, confirmation_toggles_once: true, completed_synthetic_replay_posts_once: true, web_toggle_unchanged: true, language_and_reentry: true, abort_and_late_receipt_after_opt_out: true }) + '\n');
} finally {
  if (originalRuntime === undefined) delete globalThis.__LIFELINE_RUNTIME_CONFIG__;
  else globalThis.__LIFELINE_RUNTIME_CONFIG__ = originalRuntime;
}
