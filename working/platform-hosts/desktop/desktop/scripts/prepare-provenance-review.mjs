import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { workspace, filesIn, fileHash, json } from "./release-lib.mjs";

const git=args=>execFileSync("git",args,{cwd:workspace,encoding:"utf8",windowsHide:true}).trim();
const source=relative=>({path:relative,sha256:fileHash(path.join(workspace,relative))});
const guide="web/web前端/guide/guide-images", models="web/web前端/assets/research-ai";
const previous=json(path.join(workspace,"docs/verification/lifeline-steam-m3/asset-rights-inventory.json"));
const images=filesIn(path.join(workspace,guide)),inference=filesIn(path.join(workspace,models));
const priorHashes=new Map([...previous.guideImages,...previous.inferenceAssets].map(f=>[f.path,f.sha256]));
for(const [prefix,entries] of [[guide,images],[models,inference]])for(const f of entries){
  if(priorHashes.get(`${prefix}/${f.path}`)!==f.sha256)throw new Error(`Changed provenance scope: ${prefix}/${f.path}`);
}
const receipt={format:"lifeline-release-provenance-review",schemaVersion:1,preparedOn:"2026-10-19",
  status:"EVIDENCE_GROUPED_OWNER_FACTS_PENDING",headReviewed:git(["rev-parse","HEAD"]),
  boundary:"Source history and hashes narrow the questions; they do not prove ownership, contributor permission, trademark clearance or scientific model strength.",
  code:{authorSummaryCommand:"git shortlog -sn HEAD -- desktop web/web前端",authorSummary:git(["shortlog","-sn","HEAD","--","desktop","web/web前端"]),
    credits:source("web/web前端/guide/Thanks.md"),humanProgramContributorsExplicitlyCredited:["zcz","Harmony","LeoYan"],
    note:"Other design/test acknowledgements are retained, not automatically treated as code rightsholders. AI tool credits are also retained.",
    rootLicenseFiles:git(["ls-files"]).split(/\r?\n/).filter(p=>/^(LICENSE|LICENCE|COPYING|AUTHORS)(\.[^/]*)?$/i.test(p)),ownerConfirmation:"Commercial distribution rights for project and substantive contributions"},
  guideImages:{files:images.map(f=>({...f,path:`${guide}/${f.path}`})),historyCommand:"git log --format='%h %ad %s' --date=short -- web/web前端/guide/guide-images",
    history:git(["log","--format=%h %ad %s","--date=short","--",guide]).split(/\r?\n/),sameAsFrozenM3:true,ownerConfirmation:"Original or permitted redistribution of six existing guide illustrations"},
  models:{weightFileCount:inference.filter(f=>f.path.endsWith(".f32")).length,sameAsFrozenM3:true,
    manifests:[source(`${models}/manifest.json`),source(`${models}/transfer-v1/manifest.json`),source(`${models}/transfer-v1/export-receipt.json`)],
    evidence:"Existing manifests/receipt retain project source, config and checkpoint hashes. No training or new datasets were created.",ownerConfirmation:"Commercial redistribution rights for project training inputs and exported models"},
  preparedAssets:{branding:source("desktop/scripts/prepare-branding.cjs"),sound:source("web/web前端/GameFeedback.js"),
    notes:"Geometric branding source, programmatic sound and system fonts; no added external asset pack or downloaded font. Working name still pending clearance."},
  dependencies:{index:source("desktop/legal/dependency-notice-index.json"),notices:source("desktop/legal/DEPENDENCY_LICENSES.txt"),
    notes:"31 production license texts retained; packaged Electron/Chromium notices kept. No broad new project license granted."},
  aiDisclosure:{status:"DRAFT_NOT_SUBMITTED",draft:"docs/steam/LAUNCH_FIELDS_20261019.md",notes:"Includes AI-assisted player-facing text/localization; no blanket no-AI declaration or platform classification approval."},
  sourceCommands:["git shortlog -sn HEAD -- desktop web/web前端","git log --format='%h %ad %s' --date=short -- web/web前端/guide/guide-images","git ls-files","node desktop/scripts/prepare-provenance-review.mjs"]};
const directory=path.join(workspace,"docs/verification/lifeline-steam-m4");fs.mkdirSync(directory,{recursive:true});
const output=path.join(directory,"provenance-review.json");
fs.writeFileSync(output,JSON.stringify(receipt,null,2)+"\n",{flag:"wx"});
console.log(JSON.stringify({status:receipt.status,output,guideImages:images.length,models:receipt.models.weightFileCount}));
