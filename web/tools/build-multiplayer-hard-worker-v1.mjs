// Reproducible application build, not an experiment or a latency measurement.
// Tool installation remains local. Every build creates a new immutable receipt
// directory; replacing an existing application bundle requires its exact hash.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const SELF=fileURLToPath(import.meta.url),FRONTEND=resolve(dirname(SELF),'../web前端');
const [toolName,outName,replaceHash]=process.argv.slice(2);assert(toolName&&outName,'Expected tool-root and new evidence directory');
const toolRoot=resolve(toolName),root=resolve(outName),sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const ref=async path=>({path,sha256:sha(await readFile(path))});
const configPath=resolve(dirname(SELF),'configs/hard-worker-bundle-v1.json'),configBytes=await readFile(configPath),config=JSON.parse(configBytes);
assert.equal(config.schema,'lifeline-hard-worker-build-v1');assert.equal(config.version,'0.25.12');
const compilerPackage=resolve(toolRoot,'node_modules/esbuild/package.json');
assert.equal(JSON.parse(await readFile(compilerPackage)).version,config.version);
const esbuild=await import(pathToFileURL(resolve(toolRoot,'node_modules/esbuild/lib/main.js')));assert.equal(esbuild.version,config.version);
const outputPath=resolve(FRONTEND,config.output),manifestPath=resolve(FRONTEND,'MultiplayerHardAIWorker.bundle.manifest.json');
let previous=null;
try{previous=await ref(outputPath);}catch(error){if(error.code!=='ENOENT')throw error;}
if(previous)assert.equal(replaceHash,previous.sha256,'Existing bundle replacement requires its current SHA256');
else assert.equal(replaceHash,undefined,'Replacement hash supplied without a previous bundle');
await mkdir(root);
const inputs=new Map(),resolutions=[],transforms=[];
const sourcePath=name=>{const path=resolve(FRONTEND,name),rel=relative(FRONTEND,path);assert(rel&&!rel.startsWith('..')&&!isAbsolute(rel));return path;};
const evidence=[];for(const name of config.evidenceFiles)evidence.push({name,...await ref(sourcePath(name))});
const plugin={name:'canonical-local-hard-worker',setup(build){
  build.onResolve({filter:/.*/},args=>{
    if(args.kind==='entry-point')return{path:config.entry,namespace:'application-hard'};
    const from=sourcePath(args.importer),url=new URL(args.path,pathToFileURL(from));assert.equal(url.protocol,'file:');
    let name=relative(FRONTEND,fileURLToPath(url)).replaceAll('\\','/');sourcePath(name);
    const runtime=name==='MultiplayerRuntime.js';
    const external=runtime&&args.importer===config.runtimeAdapter
      ||args.importer==='AIWorker.js'&&config.workerExternals.includes(name);
    if(external){assert.equal(args.kind,'dynamic-import');resolutions.push({importer:args.importer,requested:args.path,resolved:name,external:true});
      return{path:'./'+name+url.search,external:true};}
    if(runtime){assert(config.runtimeImporters.includes(args.importer),'Unexpected general-runtime importer');name=config.runtimeAdapter;}
    resolutions.push({importer:args.importer,requested:args.path,resolved:name,external:false});
    return{path:name,namespace:'application-hard'};
  });
  build.onLoad({filter:/.*/,namespace:'application-hard'},async args=>{
    const path=sourcePath(args.path),bytes=await readFile(path),original=bytes.toString('utf8');
    const contents=original.replaceAll('import.meta.url',`new URL(${JSON.stringify('./'+args.path)}, self.location.href).href`);
    inputs.set(args.path,{name:args.path,path,sha256:sha(bytes),transformedSha256:sha(contents)});
    const occurrences=original.split('import.meta.url').length-1;
    if(occurrences)transforms.push({name:args.path,occurrences,kind:'retain-original-module-relative-asset-base'});
    return{contents,loader:'js'};
  });
}};
const built=await esbuild.build({...config.options,entryPoints:[config.entry],outfile:outputPath,
  plugins:[plugin],metafile:true,write:false,logLevel:'silent'});
assert.equal(built.errors.length,0);assert.equal(built.warnings.length,0);
for(const row of inputs.values())assert.equal(sha(await readFile(row.path)),row.sha256,'Source changed during bundle build');
for(const row of evidence)assert.equal(sha(await readFile(row.path)),row.sha256,'Application dependency changed during bundle build');
assert.equal(sha(await readFile(configPath)),sha(configBytes));
assert(inputs.has('AIWorker.js')&&inputs.has(config.runtimeAdapter)&&inputs.has('MultiplayerHardResources.js'));
for(const forbidden of['MultiplayerRuntime.js','MultiplayerModel.js','ResearchAI.js','ModelFreeAI.js'])assert(!inputs.has(forbidden));
const output=built.outputFiles.find(row=>row.path===outputPath),map=built.outputFiles.find(row=>row.path===outputPath+'.map');assert(output&&map);
assert(!output.text.includes('/isolated/'),'Application bundle cannot depend on isolated experiment routes');
const sourceMap=JSON.parse(map.text);assert.equal(sourceMap.sourcesContent.length,inputs.size);
assert.deepEqual(sourceMap.sourcesContent.map(sha).sort(),[...inputs.values()].map(row=>row.transformedSha256).sort());
const compiler={version:esbuild.version,package:await ref(compilerPackage),lock:await ref(resolve(toolRoot,'package-lock.json')),
  binary:await ref(resolve(toolRoot,'node_modules/@esbuild/win32-x64/esbuild.exe'))};
const sourceRows=[...inputs.values()].sort((a,b)=>a.name.localeCompare(b.name));
const manifest={schema:'lifeline-application-hard-worker-bundle-v1',publicModelId:'multiplayer-hard-v1',
  implementationId:'multiplayer-hard-cut-resilience-v1',bundleSha256:sha(output.contents),bundleBytes:output.contents.length,
  sourceMapSha256:sha(map.contents),compiler:config.version,configSha256:sha(configBytes),
  sourceHashes:Object.fromEntries(sourceRows.map(row=>[row.name,row.sha256])),verified:false};
await writeFile(resolve(root,config.output),output.contents,{flag:'wx'});
await writeFile(resolve(root,config.output+'.map'),map.contents,{flag:'wx'});
await writeFile(resolve(root,'metafile.json'),JSON.stringify(built.metafile,null,2)+'\n',{flag:'wx'});
await writeFile(resolve(root,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
// The generated app file is replaceable build output; the receipt copies above
// remain append-only. No source, model, old snapshot or run directory is edited.
await writeFile(outputPath,output.contents,{flag:previous?'w':'wx'});
await writeFile(manifestPath,JSON.stringify(manifest,null,2)+'\n');
const body={schema:'lifeline-hard-worker-build-receipt-v1',status:'BUILT_NOT_VERIFIED',manifest,compiler,
  output:await ref(outputPath),manifestFile:await ref(manifestPath),config:await ref(configPath),builder:await ref(SELF),
  inputs:sourceRows,evidence,resolutions,transforms,previous,command:process.argv,
  limits:['Compilation and source-map identity only; no model execution, browser, strength or latency acceptance.']};
await writeFile(resolve(root,'build-receipt.json'),JSON.stringify({...body,integrity:sha(JSON.stringify(body))},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({status:body.status,bundleBytes:manifest.bundleBytes,inputModules:inputs.size,bundleSha256:manifest.bundleSha256,root}));
