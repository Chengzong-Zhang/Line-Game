import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../quiet-transfer.mjs', import.meta.url));
for (const args of [
  ['--unknown-secret=PRIVATE_TEST_VALUE_DO_NOT_PRINT'],
  ['--execute=PRIVATE_TEST_VALUE_DO_NOT_PRINT'],
]) {
  test(`malformed ${args[0].split('=')[0]} is reported without raw arguments`, () => {
    const child = spawnSync(process.execPath, [script, ...args], {
      encoding: 'utf8', timeout: 10_000, windowsHide: true,
    });
    assert.equal(child.error, undefined);
    assert.equal(child.status, 1);
    assert.equal(child.stderr, '');
    assert.equal(child.stdout.includes('PRIVATE_TEST_VALUE_DO_NOT_PRINT'), false);
    const result = JSON.parse(child.stdout);
    assert.equal(result.status, 'STOPPED_NO_AUTOMATIC_RETRY');
    assert.match(result.errorCode, /^ERR_PARSE_ARGS_[A-Z_]+$/);
    assert.deepEqual(result.rejectedIps, []);
    assert.equal(result.receiptDirectory, undefined);
  });
}
