import { spawnSync } from 'node:child_process';
import { access, mkdtemp, readdir, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const mobileRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(mobileRoot, '..');
const isWindows = process.platform === 'win32';
const executableNames = (name) => isWindows ? [`${name}.exe`, name] : [name];
const suites = new Map([
  ['capabilities', 'verify-android-capabilities.py'],
  ['credential-store', 'verify-android-credential-store.py'],
  ['network-status', 'verify-android-network-status.py'],
  ['haptics', 'verify-android-haptics.py'],
  ['session-store', 'verify-android-session-store.py'],
  ['main-page-recovery', 'verify-android-main-page-recovery.py'],
  ['replay-import', 'verify-android-replay-import.py'],
  ['replay-share', 'verify-android-replay-share.py'],
  ['tutorial-host', 'verify-android-tutorial-host.py'],
  ['app-host', 'verify-android-app-host.py'],
]);
const CHILD_TIMEOUT_MS = 240_000;
const MAX_BUFFER_BYTES = 8 * 1024 * 1024;

async function executableIn(directory, name) {
  for (const candidate of executableNames(name)) {
    const fullPath = path.resolve(directory, candidate);
    try {
      await access(fullPath, constants.X_OK);
      return fullPath;
    } catch (_error) {
      // Continue through platform-specific executable suffixes.
    }
  }
  return null;
}

async function findOnPath(name) {
  for (const directory of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    const found = await executableIn(directory, name);
    if (found) return found;
  }
  return null;
}

function supportsPython310(command, args) {
  const result = spawnSync(command, [
    ...args,
    '-c', 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")',
  ], { encoding: 'utf8', timeout: 5000, windowsHide: true });
  if (result.error || result.status !== 0) return false;
  const match = /^(\d+)\.(\d+)\s*$/m.exec(result.stdout ?? '');
  return Boolean(match && Number(match[1]) === 3 && Number(match[2]) >= 10);
}

async function discoverPython() {
  const candidates = [];
  if (process.env.PYTHON) candidates.push({ command: process.env.PYTHON, args: [] });
  if (isWindows) candidates.push({ command: await findOnPath('py'), args: ['-3'] });
  for (const name of (isWindows ? ['python', 'python3'] : ['python3', 'python'])) {
    candidates.push({ command: await findOnPath(name), args: [] });
  }
  for (const candidate of candidates) {
    if (candidate.command && supportsPython310(candidate.command, candidate.args)) return candidate;
  }
  throw new Error('Python >=3.10 was not found. Install a supported Python version or add it to PATH (or set PYTHON).');
}

async function jdkBin(directory) {
  const javac = await executableIn(directory, 'javac');
  const java = await executableIn(directory, 'java');
  return javac && java ? path.resolve(directory) : null;
}

async function discoverJdk() {
  const candidates = [];
  if (process.env.JAVA_HOME) candidates.push(path.join(process.env.JAVA_HOME, 'bin'));
  for (const name of ['javac', 'java']) {
    const executable = await findOnPath(name);
    if (executable) candidates.push(path.dirname(executable));
  }
  const localToolchain = path.join(mobileRoot, 'local_artifacts', 'toolchain');
  try {
    const entries = await readdir(localToolchain, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) candidates.push(path.join(localToolchain, entry.name, 'bin'));
    }
  } catch (_error) {
    // A local toolchain is optional when JAVA_HOME or PATH provides a JDK.
  }

  for (const candidate of candidates) {
    const found = await jdkBin(candidate);
    if (found) return found;
  }
  throw new Error('A JDK with both javac and java was not found. Set JAVA_HOME, add a JDK to PATH, or provide one under mobile/local_artifacts/toolchain.');
}

function selectedSuites() {
  const args = process.argv.slice(2);
  if (args.length === 0) return [...suites.keys()];
  if (args.length !== 2 || args[0] !== '--only' || !suites.has(args[1])) {
    throw new Error(`Usage: node tools/verify-android-host.mjs [--only ${[...suites.keys()].join('|')}]`);
  }
  return [args[1]];
}

function runSuite(name, verifier, python, javaBin, credentialOutputRoot) {
  const command = [
    ...python.args,
    '-X', 'utf8', '-B', path.join(mobileRoot, 'tests', verifier),
    '--java-bin', javaBin,
  ];
  if (name === 'credential-store') command.push('--output', path.join(credentialOutputRoot, 'evidence'));
  return spawnSync(python.command, command, {
    cwd: repositoryRoot,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER_BYTES,
    timeout: CHILD_TIMEOUT_MS,
    windowsHide: true,
  });
}

async function main() {
  const selected = selectedSuites();
  const [python, javaBin] = await Promise.all([discoverPython(), discoverJdk()]);
  const statuses = [];

  for (const name of selected) {
    const credentialOutputRoot = name === 'credential-store'
      ? await mkdtemp(path.join(os.tmpdir(), 'lifeline-android-credential-store-'))
      : null;
    try {
      console.log(`Running Android host-stub suite: ${name}`);
      const result = runSuite(name, suites.get(name), python, javaBin, credentialOutputRoot);
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      if (result.error) throw result.error;
      if (result.status !== 0) {
        const detail = result.signal ? ` (terminated by ${result.signal})` : '';
        throw new Error(`${name} exited with status ${result.status ?? 'unknown'}${detail}.`);
      }
      statuses.push(name);
    } finally {
      if (credentialOutputRoot) await rm(credentialOutputRoot, { recursive: true, force: true });
    }
  }

  console.log(`PASS-SCOPED: ${statuses.join(', ')}; Android host-stub/JDK checks only, not Android SDK or device acceptance.`);
}

main().catch((error) => {
  console.error(`verify-android-host: ${error.message}`);
  process.exitCode = 1;
});
