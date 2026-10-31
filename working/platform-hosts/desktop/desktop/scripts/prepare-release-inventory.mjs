import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { workspace, filesIn, fileHash } from "./release-lib.mjs";

const require = createRequire(import.meta.url);
const { ACHIEVEMENTS } = require("../src/achievement-store.cjs");
const imageRoot = "web/web前端/guide/guide-images";
const modelRoot = "web/web前端/assets/research-ai";
const evidence = path.join(workspace, "docs/verification/lifeline-steam-m3");
fs.mkdirSync(evidence, { recursive: true });
const sourceEntries = directory => filesIn(path.join(workspace, directory)).map(file => ({ ...file, path: `${directory}/${file.path}` }));
const inventory = {
  format: "lifeline-release-rights-inventory", schemaVersion: 1, preparedOn: "2026-10-18",
  status: "TECHNICAL_PROVENANCE_RECORDED_RIGHTS_CLEARANCE_PENDING",
  legalConclusion: "Not a license grant or a legal clearance. Existing project credits and source hashes do not establish each contributor's distribution permission.",
  originalArtwork: { source:"desktop/scripts/prepare-branding.cjs", sha256:fileHash(path.join(workspace,"desktop/scripts/prepare-branding.cjs")),
    origin:"Original geometric source created during this development task. No external image/font file consumed.",
    remaining:"Working title and branding still need name/trademark clearance before publication." },
  guideImages: sourceEntries(imageRoot).map(file => ({ ...file,
    provenance:"Existing project guide asset", author:"NOT_ESTABLISHED_BY_REPOSITORY_RECORD", redistribution:"NEEDS_OWNER_REVIEW" })),
  inferenceAssets: sourceEntries(modelRoot).map(file => ({ ...file,
    provenance:"Existing project inference export; manifests contain model/checkpoint/config hashes",
    redistribution:"NEEDS_OWNER_REVIEW", strengthClaim:"NOT_ESTABLISHED; pilot exports are not formal strength evidence" })),
  dependencies: { source:"desktop/legal/dependency-notice-index.json", sha256:fileHash(path.join(workspace,"desktop/legal/dependency-notice-index.json")),
    notes:"31 pinned production package declarations and retained notice texts; Electron/Chromium notices are included by the packager." },
  sound:{origin:"Runtime oscillator synthesis in project GameFeedback.js",externalSoundBank:false},
  fonts:{origin:"Installed system fonts; no custom font binaries redistributed"},
  code:{origin:"Existing project with multiple credited contributors",licenseGrant:"No new project-wide license granted by this preparation",review:"Review contributor permissions before public distribution"}
};
fs.writeFileSync(path.join(evidence,"asset-rights-inventory.json"),JSON.stringify(inventory,null,2)+"\n");
fs.writeFileSync(path.join(workspace,"desktop/steam/achievement-config.draft.json"),JSON.stringify({format:"lifeline-steam-achievement-draft",schemaVersion:1,status:"NOT_CONFIGURED_IN_STEAMWORKS",achievements:ACHIEVEMENTS.map(a=>({apiName:a.id,hidden:false,displayName:{schinese:a.titleZh,english:a.titleEn},description:{schinese:a.descriptionZh,english:a.descriptionEn}}))},null,2)+"\n");
console.log(JSON.stringify({status:inventory.status,guideImages:inventory.guideImages.length,modelFiles:inventory.inferenceAssets.filter(f=>f.path.endsWith(".f32")).length,evidence}));
