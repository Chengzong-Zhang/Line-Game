import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const mobileRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(await readFile(path.join(mobileRoot, 'package.json'), 'utf8'));
const lock = JSON.parse(await readFile(path.join(mobileRoot, 'package-lock.json'), 'utf8'));
const cliOverride = packageJson.overrides?.['@capacitor/cli@8.5.3'];
assert.deepEqual(Object.keys(packageJson.overrides ?? {}), ['@capacitor/cli@8.5.3'],
  'the advisory override stays scoped to the installed Capacitor CLI version');
assert.deepEqual(Object.keys(cliOverride ?? {}), ['xcode@3.0.1'],
  'the override stays scoped to xcode 3.0.1');
assert.deepEqual(cliOverride['xcode@3.0.1'], { uuid: '11.1.1' },
  'only xcode’s vulnerable uuid edge is overridden');

const lockedPackages = lock.packages ?? {};
assert.equal(lockedPackages['node_modules/@capacitor/cli']?.version, '8.5.3');
assert.equal(lockedPackages['node_modules/xcode']?.version, '3.0.1');
assert.equal(lockedPackages['node_modules/uuid']?.version, '11.1.1',
  'the lock resolves xcode’s uuid above GHSA-w5hq-g745-h8pq’s affected range (<11.1.1)');

const requireFromMobile = createRequire(import.meta.url);
const xcodeEntry = requireFromMobile.resolve('xcode');
const requireFromXcode = createRequire(xcodeEntry);
const uuidPackage = requireFromXcode('uuid/package.json');
const uuid = requireFromXcode('uuid');
assert.equal(uuidPackage.version, '11.1.1', 'xcode resolves the fixed uuid package through its own CommonJS path');
assert.equal(typeof uuid.v4, 'function', 'uuid 11 retains the CommonJS named v4 export used by xcode 3');
assert.match(uuid.v4(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  'CommonJS uuid.v4 returns an RFC 4122 version 4 identifier');

const namespaceUuidFunctions = [
  ['v3', 3, (buffer, offset) => uuid.v3('lifeline', uuid.v3.DNS, buffer, offset)],
  ['v5', 5, (buffer, offset) => uuid.v5('lifeline', uuid.v5.DNS, buffer, offset)],
  ['v6', 6, (buffer, offset) => uuid.v6({ msecs: 1_700_000_000_000 }, buffer, offset)],
];
for (const [name, version, generate] of namespaceUuidFunctions) {
  for (const [label, length, offset] of [
    ['short buffer', 15, 0],
    ['negative offset', 32, -1],
    ['end overflow', 32, 17],
  ]) {
    const buffer = new Uint8Array(length).fill(0xa5);
    const before = buffer.slice();
    assert.throws(() => generate(buffer, offset), RangeError, `${name} rejects ${label}`);
    assert.deepEqual(buffer, before, `${name} leaves the caller buffer unchanged after ${label}`);
  }
  const buffer = new Uint8Array(32).fill(0xa5);
  assert.equal(generate(buffer, 8), buffer, `${name} supports a valid caller buffer and offset`);
  assert.ok(buffer.subarray(0, 8).every((byte) => byte === 0xa5));
  assert.ok(buffer.subarray(24).every((byte) => byte === 0xa5));
  assert.equal(uuid.version(uuid.stringify(buffer, 8)), version, `${name} writes the requested UUID version at the valid offset`);
}

const xcode = requireFromMobile('xcode');
const project = xcode.project('toolchain-dependency-check.pbxproj');
project.hash = { project: { objects: {} } };
const generated = Array.from({ length: 128 }, () => project.generateUuid());
assert.ok(generated.every((value) => /^[A-F0-9]{24}$/.test(value)),
  'the real xcode.generateUuid API returns 24-character uppercase PBX identifiers');
assert.equal(new Set(generated).size, generated.length,
  'the real xcode.generateUuid API produces unique identifiers across repeated calls');

console.log('verify-toolchain-dependencies: PASS (scoped GHSA fix, CommonJS uuid.v4 and actual xcode.generateUuid behavior)');
