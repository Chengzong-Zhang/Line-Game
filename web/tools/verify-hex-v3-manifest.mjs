import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readChecked, sha256, canonical } from "./three-player-arena-lib.mjs";
const root = process.cwd(), base = resolve(root, "local_artifacts/hex-player-distill-v3");
const records = [];
for (const stage of ["train", "final"]) {
  const directory = resolve(base, `${stage}-20261021-r1`), checkpoint = await readChecked(resolve(directory, "checkpoint.json"));
  assert.equal(checkpoint.phase, "complete"); assert.equal(sha256(canonical(checkpoint.identityData)), checkpoint.identity);
  const configBytes = await readFile(resolve(root, `web/tools/configs/hex-player-policy-v3-${stage}.json`));
  assert.equal(sha256(configBytes), checkpoint.identityData.config); assert.deepEqual(JSON.parse(configBytes), checkpoint.config);
  assert.equal(sha256(await readFile(checkpoint.parentPath)), checkpoint.identityData.parent);
  for (const [file, hash] of Object.entries(checkpoint.identityData.sources)) assert.equal(sha256(await readFile(resolve(root, file))), hash, file);
  const report = await readChecked(resolve(base, `${stage}-verification-20261021-r1/report.json`));
  assert.equal(report.status, "PASS"); assert.equal(report.sourceIdentity, checkpoint.identity);
  if (stage === "final") assert.equal(sha256(await readFile(checkpoint.candidatePath)), checkpoint.identityData.candidate);
  records.push({ stage, identity: checkpoint.identity, checkpointSha256: sha256(await readFile(resolve(directory, "checkpoint.json"))),
    configSha256: checkpoint.identityData.config, sources: checkpoint.identityData.sources, reportSha256: sha256(await readFile(resolve(base, `${stage}-verification-20261021-r1/report.json`))) });
}
const originalBytes = await readFile(resolve(base, "campaign.json")), original = JSON.parse(originalBytes);
const supplement = JSON.parse(await readFile(resolve(base, "campaign-budget-v2.json")));
assert.equal(supplement.originalCampaignSha256, sha256(originalBytes)); assert.equal(supplement.deadlineEpochMs, original.deadlineEpochMs + 900000);
assert.equal(supplement.startedEpochMs, original.startedEpochMs);
const firstFinal = JSON.parse(await readFile(resolve(base, "final-20261021-r1/worker-1.launch.json")));
assert.ok(Date.parse(supplement.authorizedAt) < firstFinal.started_epoch_ms, "Budget extension must precede FINAL opening");
const value = { status: "PASS", scope: "Scientific identity, exact config bodies and hashes, parent/candidate/sources, completed independent reports, pre-FINAL budget chronology",
  records, addedBudgetSeconds: 900, totalBudgetSeconds: 4500, originalCampaignSha256: sha256(originalBytes), command: "node web/tools/verify-hex-v3-manifest.mjs" };
await writeFile(resolve(root, "docs/verification/hex-ai-distill-v3/IDENTITY_AUDIT.json"), `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
console.log(JSON.stringify({ status: "PASS", identities: records.map((x) => x.identity), totalBudgetSeconds: 4500 }));
