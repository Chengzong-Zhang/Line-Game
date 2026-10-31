import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateHarmonySigningOverlay } from './harmony-release-signing.mjs';

export async function prepareHarmonyReleaseSigningOverlay(options = {}) {
  return generateHarmonySigningOverlay(options);
}

async function main() {
  const result = await prepareHarmonyReleaseSigningOverlay();
  if (!result.ok) {
    if (result.missing?.length) console.error(`Harmony signing BLOCKED: missing ${result.missing.join(', ')}.`);
    else console.error(`Harmony signing BLOCKED: invalid ${result.invalid?.join(', ') || 'configuration'}.`);
    process.exitCode = 1;
  } else {
    console.log('Harmony signing overlay generated under ignored mobile/local_artifacts; tracked build profiles were not modified.');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`Harmony signing BLOCKED: ${error.message}`);
    process.exitCode = 1;
  });
}