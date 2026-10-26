import test from 'node:test';
import assert from 'node:assert/strict';
import { isolatedProxyTransfer, LOCKED_CANDIDATE_ID, LOCKED_IP, LOCKED_CANDIDATE_RECEIPT_SHA256 } from '../isolated-proxy-transfer.mjs';
const record = { version: '0.12.15', candidateId: LOCKED_CANDIDATE_ID, candidateReceiptSha256: LOCKED_CANDIDATE_RECEIPT_SHA256 };
test('plan never starts core, SDK or transfer', async () => {
  const result = await isolatedProxyTransfer({}, { plan: async () => record, withRoute: () => assert.fail('route'), transfer: () => assert.fail('transfer'), loadSdk: () => assert.fail('SDK') });
  assert.equal(result.status, 'PLAN_ONLY_NO_PROXY_NO_KEY_NO_UPLOAD');
});
test('wrong candidate and missing allowlist assertion stop before route', async () => {
  await assert.rejects(isolatedProxyTransfer({ execute: true }, { plan: async () => ({ ...record, version: '0.12.14' }), withRoute: () => assert.fail('route') }), /ONLY_REVIEWED/);
  await assert.rejects(isolatedProxyTransfer({ execute: true }, { plan: async () => record, withRoute: () => assert.fail('route') }), /ALLOWLISTED_IP/);
});
test('candidate change during route preflight stops before transfer', async () => {
  let calls = 0;
  await assert.rejects(isolatedProxyTransfer({ execute: true, allowlistedIp: LOCKED_IP }, { plan: async () => ({ ...record, candidateReceiptSha256: calls++ === 0 ? LOCKED_CANDIDATE_RECEIPT_SHA256 : 'changed' }),
    withRoute: async (_, visit) => visit({ proxyUrl: 'http://127.0.0.1:12345' }), transfer: () => assert.fail('transfer') }), /CANDIDATE_CHANGED/);
});
test('same SDK instance receives isolated proxy before exactly one transfer', async () => {
  let transfers = 0, proxy = null; const module = { default: { proxy: value => { proxy = value; } } };
  const result = await isolatedProxyTransfer({ execute: true, allowlistedIp: LOCKED_IP }, {
    plan: async () => record, withRoute: async (options, visit) => { assert.equal(options.expectedIp, LOCKED_IP); return visit({ proxyUrl: 'http://127.0.0.1:12345' }); },
    loadSdk: async () => module, transfer: async (_, deps) => { transfers++; assert.equal(await deps.loadSdk(), module); assert.equal(proxy, 'http://127.0.0.1:12345'); return { status: 'MOCK_ONLY' }; },
  }); assert.equal(result.status, 'MOCK_ONLY'); assert.equal(transfers, 1);
});
test('route rejection never reads SDK or initiates transfer', async () => {
  await assert.rejects(isolatedProxyTransfer({ execute: true, allowlistedIp: LOCKED_IP }, { plan: async () => record,
    withRoute: async () => { throw Error('ALLOWLISTED_EXIT_IP_CHANGED'); }, loadSdk: () => assert.fail('SDK'), transfer: () => assert.fail('transfer') }), /EXIT_IP_CHANGED/);
});
