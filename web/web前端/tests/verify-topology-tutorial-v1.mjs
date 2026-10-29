import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  TOPOLOGY_TUTORIAL_STEPS,
  TOPOLOGY_TUTORIAL_VERSION,
  getTopologyTutorialStep,
  topologyTutorialText,
} from "../TopologyTutorial.js";

assert.equal(TOPOLOGY_TUTORIAL_VERSION, "topology-onboarding-v1");
assert.equal(TOPOLOGY_TUTORIAL_STEPS.length, 5);

for (const step of TOPOLOGY_TUTORIAL_STEPS) {
  assert.equal(typeof step.id, "string");
  assert.equal(typeof step.action?.type, "string");
  assert.ok(step.titleZh.length > 4 && step.titleEn.length > 4, step.id);
  assert.ok(step.instructionZh.length > 12 && step.instructionEn.length > 12, step.id);
  assert.deepEqual(topologyTutorialText(step, "zh"), {
    title: step.titleZh,
    instruction: step.instructionZh,
  });
  assert.deepEqual(topologyTutorialText(step, "en"), {
    title: step.titleEn,
    instruction: step.instructionEn,
  });
  assert.equal(getTopologyTutorialStep(step.id), step);
}

assert.equal(getTopologyTutorialStep("not-a-step"), null);
assert.equal(topologyTutorialText(null, "en"), null);

const appPath = fileURLToPath(new URL("../OnlineApp.js", import.meta.url));
const appSource = fs.readFileSync(appPath, "utf8");
assert.match(appSource, /TopologyTutorial\.js/);
assert.match(appSource, /topologyTutorialSteps/);
assert.match(appSource, /topology-tutorial/);

console.log("verify-topology-tutorial-v1: PASS (five bilingual setup lessons, seam/copy/boundary/Mobius coverage)");
