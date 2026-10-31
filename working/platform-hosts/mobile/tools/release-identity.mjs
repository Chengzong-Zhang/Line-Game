import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateIdentity } from './release-identity-data.mjs';

const mobileRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(mobileRoot, '..');
const identityPath = path.join(mobileRoot, 'config/release-identity-candidate.json');
const identity = JSON.parse(await readFile(identityPath, 'utf8'));

async function transform(relativePath, transformText, checkOnly) {
  const absolutePath = path.join(repoRoot, relativePath);
  const original = await readFile(absolutePath, 'utf8');
  const updated = transformText(original);
  if (updated === original) return;
  if (checkOnly) throw new Error(`Release identity drift: ${relativePath}; run npm run sync:release-identity.`);
  await writeFile(absolutePath, updated, 'utf8');
}

function replaceOne(text, pattern, replacement, label) {
  let count = 0;
  const updated = text.replace(pattern, (...args) => { count += 1; return replacement(...args); });
  if (count !== 1) throw new Error(`Expected one ${label} entry, found ${count}.`);
  return updated;
}

function androidGradle(text) {
  text = replaceOne(text, /^\s*namespace\s*=\s*"[^"]+"\s*$/gm, () => `    namespace = "${identity.android.namespace}"`, 'Android namespace');
  text = replaceOne(text, /^\s*applicationId\s+"[^"]+"\s*$/gm, () => `        applicationId "${identity.android.applicationId}"`, 'Android applicationId');
  text = replaceOne(text, /^\s*versionCode\s+\d+\s*$/gm, () => `        versionCode ${identity.android.versionCode}`, 'Android versionCode');
  return replaceOne(text, /^\s*versionName\s+"[^"]*"\s*$/gm, () => `        versionName "${identity.android.versionName}"`, 'Android versionName');
}

function androidStrings(text) {
  text = replaceOne(text, /(<string\s+name="app_name">)[^<]*(<\/string>)/, (_m, before, after) => `${before}${identity.displayName}${after}`, 'Android app_name');
  return replaceOne(text, /(<string\s+name="title_activity_main">)[^<]*(<\/string>)/, (_m, before, after) => `${before}${identity.displayName}${after}`, 'Android activity title');
}

function capacitorConfig(text) {
  text = replaceOne(text, /(^\s*appId:\s*)'[^']*'/m, (_m, before) => `${before}'${identity.android.capacitorAppId}'`, 'Capacitor appId');
  return replaceOne(text, /(^\s*appName:\s*)'[^']*'/m, (_m, before) => `${before}'${identity.displayName}'`, 'Capacitor appName');
}

function androidPackageResources(text) {
  text = replaceOne(text, /(<string\s+name="package_name">)[^<]*(<\/string>)/, (_m, before, after) => `${before}${identity.android.applicationId}${after}`, 'Android package_name');
  return replaceOne(text, /(<string\s+name="custom_url_scheme">)[^<]*(<\/string>)/, (_m, before, after) => `${before}${identity.android.urlScheme}${after}`, 'Android custom_url_scheme');
}

function harmonyApp(text) {
  text = replaceOne(text, /("bundleName"\s*:\s*")[^"]+(")/, (_m, before, after) => `${before}${identity.harmony.bundleName}${after}`, 'Harmony bundleName');
  text = replaceOne(text, /("versionCode"\s*:\s*)\d+/, (_m, before) => `${before}${identity.harmony.versionCode}`, 'Harmony versionCode');
  return replaceOne(text, /("versionName"\s*:\s*")[^"]+(")/, (_m, before, after) => `${before}${identity.harmony.versionName}${after}`, 'Harmony versionName');
}

function harmonyStrings(text) {
  return replaceOne(text, /("name"\s*:\s*"app_name"\s*,\s*"value"\s*:\s*")[^"]+(")/, (_m, before, after) => `${before}${identity.displayName}${after}`, 'Harmony app_name');
}

validateIdentity(identity);
const checkOnly = process.argv.includes('--check');
await transform('mobile/android/app/build.gradle', androidGradle, checkOnly);
await transform('mobile/android/app/src/main/res/values/strings.xml', androidStrings, checkOnly);
await transform('mobile/android/app/src/main/res/values/strings.xml', androidPackageResources, checkOnly);
await transform('mobile/capacitor.config.ts', capacitorConfig, checkOnly);
await transform('mobile/harmony/AppScope/app.json5', harmonyApp, checkOnly);
await transform('mobile/harmony/AppScope/resources/base/element/string.json', harmonyStrings, checkOnly);
console.log(`Release identity ${checkOnly ? 'matches' : 'synced'} (${identity.status}; package IDs remain in sync).`);

export { identity };
