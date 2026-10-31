import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  REPLAY_IMPORT_MAX_BYTES,
  createReplayImportClient,
  normalizeReplayImportResult,
  replayTextByteLength,
} from '../src/replay-import-client.js';

const exactLimit = 'a'.repeat(REPLAY_IMPORT_MAX_BYTES);
assert.equal(replayTextByteLength(exactLimit), REPLAY_IMPORT_MAX_BYTES);
assert.equal(normalizeReplayImportResult({ status: 'selected', text: exactLimit }).text.length, REPLAY_IMPORT_MAX_BYTES);
assert.throws(() => normalizeReplayImportResult({ status: 'selected', text: `${exactLimit}a` }), { code: 'too-large' });
assert.equal(replayTextByteLength('棋谱😀'), new TextEncoder().encode('棋谱😀').byteLength);
assert.equal(normalizeReplayImportResult({ status: 'cancelled' }).status, 'cancelled');
assert.throws(() => normalizeReplayImportResult({ status: 'failed', message: 'private path' }), { code: 'invalid-response' });
assert.throws(() => normalizeReplayImportResult({ status: 'selected', text: '{}', path: '/private/replay.json' }), { code: 'invalid-response' });
assert.throws(() => normalizeReplayImportResult({ status: 'selected', text: '{}', uri: 'content://private' }), { code: 'invalid-response' });

let token = 'page-one';
const client = createReplayImportClient({ select: async () => ({ status: 'selected', text: '{"ok":true}' }), getOwnerToken: () => token });
assert.deepEqual(await client.importReplay(), { status: 'selected', text: '{"ok":true}' });

const cancelledClient = createReplayImportClient({ select: async () => ({ status: 'cancelled' }) });
assert.deepEqual(await cancelledClient.importReplay(), { status: 'cancelled' });

let settleSelection;
const raceClient = createReplayImportClient({
  select: () => new Promise((resolve) => { settleSelection = resolve; }),
  getOwnerToken: () => token,
});
const firstRequest = raceClient.importReplay();
await Promise.resolve();
await assert.rejects(raceClient.importReplay(), { code: 'busy' });
raceClient.invalidate();
settleSelection({ status: 'selected', text: '{"stale":true}' });
assert.deepEqual(await firstRequest, { status: 'cancelled' });

const ownershipClient = createReplayImportClient({
  select: () => new Promise((resolve) => { settleSelection = resolve; }),
  getOwnerToken: () => token,
});
const ownedRequest = ownershipClient.importReplay();
await Promise.resolve();
token = 'page-two';
settleSelection({ status: 'selected', text: '{"late":true}' });
assert.deepEqual(await ownedRequest, { status: 'cancelled' });
token = 'page-one';

const failedClient = createReplayImportClient({ select: async () => { throw new Error('URI: content://private/document'); } });
await assert.rejects(failedClient.importReplay(), (error) => {
  assert.equal(error.code, 'read-failed');
  assert.doesNotMatch(error.message, /content:|private|document/);
  return true;
});

const busyClient = createReplayImportClient({ select: async () => {
  const error = new Error('private native detail');
  error.code = 'busy';
  throw error;
} });
await assert.rejects(busyClient.importReplay(), (error) => {
  assert.equal(error.code, 'busy');
  assert.equal(error.message, 'A replay file selection is already active.');
  assert.doesNotMatch(error.message, /private|native/);
  return true;
});

const replayUi = await readFile(new URL('../../web/web前端/OnlineApp.js', import.meta.url), 'utf8');
assert.match(replayUi, /importReplay === "function"[\s\S]*emit\("import-native"/,
  'native platforms route replay import through the system picker event');
assert.match(replayUi, /file\.arrayBuffer\(\)/, 'browser fallback measures and reads raw bytes');
assert.match(replayUi, /new TextDecoder\("utf-8", \{ fatal: true \}\)/, 'browser fallback rejects malformed UTF-8');
assert.match(replayUi, /handleReplayPanelImportNative[\s\S]*LifelinePlatform\.importReplay\(\)/,
  'native selection joins the existing import lifecycle');
assert.match(replayUi, /parsed\?\.format === TOPOLOGY_REPLAY_FORMAT[\s\S]*await validateTopologyReplayDocument\(parsed\)[\s\S]*await parseAndValidateReplay\(text\)[\s\S]*if \(!result\.success\)[\s\S]*replayDocument\.value = result\.document/,
  'both topology and ordinary replay formats must pass their validators before replacement');

console.log('PASS replay-import client boundaries, privacy, cancellation, concurrency, and stale-owner handling');
