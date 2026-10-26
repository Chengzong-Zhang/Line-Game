// Task-local reuse of the already-selected Clash node. No system/API mutation.
const fs = require('node:fs/promises'), sync = require('node:fs'), path = require('node:path');
const http = require('node:http'), net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');
const { randomUUID, createHash } = require('node:crypto');
const sdkRequire = createRequire(require.resolve('miniprogram-ci/package.json'));
const yaml = sdkRequire('js-yaml');
const check = (ok, code) => { if (!ok) throw Object.assign(new Error(code), { code }); };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const wait = ms => new Promise(done => setTimeout(done, ms));
const code = error => typeof error?.code === 'number' || /^[A-Z0-9_-]{1,80}$/.test(error?.code || '') ? error.code : 'DETAILS_OMITTED';
const get = (port, secret, endpoint) => new Promise((resolve, reject) => {
  const request = http.get({ host: '127.0.0.1', port, path: endpoint, timeout: 4000,
    headers: { Authorization: `Bearer ${secret}` } }, response => {
    let text = ''; response.on('data', data => { text += data; }); response.on('end', () => {
      try { check(response.statusCode === 200, 'CONTROLLER_STATUS'); resolve(JSON.parse(text)); } catch (error) { reject(error); }
    });
  });
  request.on('timeout', () => request.destroy(Object.assign(new Error('CONTROLLER_TIMEOUT'), { code: 'CONTROLLER_TIMEOUT' })));
  request.on('error', reject);
});
const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => {
    const port = server.address().port; server.close(() => resolve(port));
  });
});
async function snapshot(port, secret, configFile, profileFile) {
  const config = await get(port, secret, '/configs'), data = await get(port, secret, '/proxies');
  let node = data.proxies['🔰 选择节点'];
  while (Array.isArray(node?.all)) node = data.proxies[node.now];
  return { mode: config.mode, mixedPort: config['mixed-port'], selectedNode: node?.name, selectedType: node?.type,
    domesticSelection: data.proxies['🇨🇳 国内网站']?.now,
    configSha256: sha(await fs.readFile(configFile)), profilesSha256: sha(await fs.readFile(profileFile)) };
}
module.exports.withIsolatedWechatRoute = async function withIsolatedWechatRoute(options, visit) {
  const { clashDataDirectory, corePath, outputDirectory, expectedIp, expectedNode, expectedCoreSha256 } = options;
  check(net.isIP(expectedIp) === 4, 'EXPECTED_IPV4_REQUIRED');
  const configFile = path.join(clashDataDirectory, 'config.yaml'), profileFile = path.join(clashDataDirectory, 'profiles/list.yml');
  const original = yaml.load(await fs.readFile(configFile, 'utf8'));
  const existingPort = Number(original['external-controller'].split(':').at(-1));
  const before = await snapshot(existingPort, original.secret, configFile, profileFile);
  check(before.selectedNode === expectedNode && before.selectedType === 'Shadowsocks', 'SELECTED_NODE_CHANGED');
  check(sha(await fs.readFile(corePath)) === expectedCoreSha256, 'CLASH_CORE_CHANGED');
  const list = yaml.load(await fs.readFile(profileFile, 'utf8')), file = list.files?.[list.index]?.time;
  check(/^\d+\.ya?ml$/.test(file), 'PROFILE_ID_INVALID');
  const profile = yaml.load(await fs.readFile(path.join(clashDataDirectory, 'profiles', file), 'utf8'));
  const nodes = profile.proxies.filter(node => node.name === expectedNode);
  check(nodes.length === 1 && nodes[0].type === 'ss', 'SELECTED_NODE_CONFIGURATION_MISMATCH');
  await fs.mkdir(outputDirectory, { recursive: true }); const parent = path.resolve(outputDirectory);
  const run = path.resolve(parent, `task-${randomUUID()}`);
  check(path.dirname(run) === parent && path.basename(run).startsWith('task-'), 'UNSAFE_TASK_DIRECTORY');
  await fs.mkdir(run);
  const acl = spawnSync('icacls.exe', [run, '/inheritance:r', '/grant:r', `${process.env.USERDOMAIN}\\${process.env.USERNAME}:(OI)(CI)F`],
    { windowsHide: true, encoding: 'utf8' });
  check(acl.status === 0, 'TASK_ACL_FAILED');
  const receipt = { schema: 'lifeline-wechat-isolated-route-v1', startedAt: new Date().toISOString(),
    expectedIp, selectedNode: expectedNode, coreSha256: expectedCoreSha256, aclRestricted: true,
    before, systemProxyChanged: false, existingClashApiMutations: 0, newServicesPurchased: false };
  const receiptPath = path.join(parent, `route-${randomUUID()}.json`);
  let child, result, failure;
  try {
    const proxyPort = await freePort(), controllerPort = await freePort(), secret = randomUUID();
    await fs.copyFile(path.join(clashDataDirectory, 'Country.mmdb'), path.join(run, 'Country.mmdb'));
    await fs.writeFile(path.join(run, 'config.yaml'), yaml.dump({ 'mixed-port': proxyPort, 'allow-lan': false,
      'bind-address': '127.0.0.1', 'external-controller': `127.0.0.1:${controllerPort}`, secret,
      mode: 'rule', 'log-level': 'silent', ipv6: false, proxies: [{ ...nodes[0], name: 'UPLOAD_SELECTED' }], rules: ['MATCH,UPLOAD_SELECTED'] }), { flag: 'wx' });
    child = spawn(corePath, ['-d', run, '-f', path.join(run, 'config.yaml')], { windowsHide: true, stdio: 'ignore' });
    let ready = false;
    for (let attempt = 0; attempt < 25; attempt++) {
      check(child.exitCode === null && child.signalCode === null, 'ISOLATED_CORE_EXITED');
      try { await get(controllerPort, secret, '/version'); ready = true; break; } catch { await wait(200); }
    }
    check(ready, 'ISOLATED_CORE_NOT_READY');
    receipt.officialRoute = await new Promise((resolve, reject) => {
      const request = http.request({ host: '127.0.0.1', port: proxyPort, method: 'CONNECT', path: 'servicewechat.com:443', timeout: 12000 });
      request.on('connect', async (response, socket) => {
        try {
          check(response.statusCode === 200, 'OFFICIAL_CONNECT_FAILED'); let connection;
          for (let index = 0; index < 12 && !connection; index++) {
            const connections = await get(controllerPort, secret, '/connections');
            connection = connections.connections.find(item => item.metadata?.host === 'servicewechat.com');
            if (!connection) await wait(100);
          }
          check(connection && connection.chains.includes('UPLOAD_SELECTED') && !connection.chains.includes('DIRECT'), 'OFFICIAL_ROUTE_NOT_FORCED');
          resolve({ host: 'servicewechat.com', connectStatus: 200, chains: connection.chains, rule: connection.rule, rulePayload: connection.rulePayload });
        } catch (error) { reject(error); } finally { socket.destroy(); request.destroy(); }
      });
      request.on('timeout', () => request.destroy(Object.assign(new Error('OFFICIAL_CONNECT_TIMEOUT'), { code: 'OFFICIAL_CONNECT_TIMEOUT' })));
      request.on('error', reject); request.end();
    });
    const sdkRequest = sdkRequire('miniprogram-ci/dist/utils/request.js'), proxyUrl = `http://127.0.0.1:${proxyPort}`;
    sdkRequest.setCiProxy(proxyUrl); receipt.exitIps = [];
    for (let index = 0; index < 3; index++) {
      if (index) await wait(1000);
      const ip = await new Promise((resolve, reject) => sdkRequest.simpleRequest({ url: 'https://api.ipify.org?format=json',
        method: 'GET', timeout: 15000, followRedirect: false }, (error, response, body) => {
        if (error) return reject(Object.assign(new Error('IP_PROBE_FAILED'), { code: 'IP_PROBE_FAILED' }));
        try { const ip = JSON.parse(body).ip; check(response.statusCode === 200 && net.isIP(ip) === 4, 'IP_PROBE_INVALID'); resolve(ip); }
        catch { reject(Object.assign(new Error('IP_PROBE_INVALID'), { code: 'IP_PROBE_INVALID' })); }
      })); receipt.exitIps.push(ip); check(ip === expectedIp, 'ALLOWLISTED_EXIT_IP_CHANGED');
    }
    const preUpload = await snapshot(existingPort, original.secret, configFile, profileFile);
    check(JSON.stringify(before) === JSON.stringify(preUpload), 'GLOBAL_CONFIGURATION_CHANGED_BEFORE_TRANSFER');
    receipt.preUploadGlobalEvidence = 'GLOBAL_UNCHANGED';
    // Only this callback may perform the one explicitly authorized transfer.
    result = await visit({ proxyUrl, sdkRequest, routeReceiptPath: receiptPath });
    receipt.transfer = { status: result.status, version: result.version, candidateId: result.candidateId,
      directory: result.directory, packageInfo: result.packageInfo };
    receipt.status = 'ISOLATED_TRANSFER_COMPLETED';
  } catch (error) { failure = error; receipt.status = 'STOPPED_NO_AUTOMATIC_RETRY'; receipt.errorCode = code(error); receipt.transferReceiptDirectory = error.receiptDirectory; }
  finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve)); child.kill(); await exited;
    }
    check(path.dirname(path.resolve(run)) === parent && path.basename(run).startsWith('task-'), 'UNSAFE_CLEANUP_DIRECTORY');
    await fs.rm(run, { recursive: true, force: true });
    receipt.temporarySensitiveConfigDeleted = !sync.existsSync(run);
    receipt.isolatedCoreStopped = !child || child.exitCode !== null || child.signalCode !== null;
    try {
      receipt.after = await snapshot(existingPort, original.secret, configFile, profileFile);
      receipt.globalEvidence = JSON.stringify(before) === JSON.stringify(receipt.after) ? 'GLOBAL_UNCHANGED' : 'GLOBAL_CHANGED_EXTERNALLY';
    } catch { receipt.globalEvidence = 'GLOBAL_POSTCHECK_UNAVAILABLE'; }
    receipt.finishedAt = new Date().toISOString(); await fs.writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  }
  if (failure) throw Object.assign(new Error('ISOLATED_TRANSFER_NOT_CONFIRMED'), { code: code(failure),
    receiptDirectory: failure.receiptDirectory, routeReceiptPath: receiptPath });
  return { ...result, routeReceiptPath: receiptPath, globalEvidence: receipt.globalEvidence,
    temporarySensitiveConfigDeleted: receipt.temporarySensitiveConfigDeleted, isolatedCoreStopped: receipt.isolatedCoreStopped };
};
