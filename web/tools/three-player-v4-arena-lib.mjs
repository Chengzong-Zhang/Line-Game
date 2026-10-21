import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { validateConfig as baseValidate } from "./three-player-arena-lib.mjs";
export * from "./three-player-arena-lib.mjs";

export function validateConfig(config) {
  if (config.stage === "DEVELOPMENT") baseValidate({ ...config, stage: "CALIBRATION" });
  else baseValidate(config);
  return config;
}

export async function loadRuntime(sourceDirectory) {
  const asModule = (source) => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
  const engineUrl = asModule(await readFile(resolve(sourceDirectory, "GameEngine.js"), "utf8"));
  const aiUrl = asModule((await readFile(resolve(sourceDirectory, "AIEngine.js"), "utf8"))
    .replace(/(["'])\.\/GameEngine\.js(?:\?[^"']*)?\1/g, JSON.stringify(engineUrl)));
  const policyUrl = asModule((await readFile(resolve(sourceDirectory, "ThreePlayerAI.js"), "utf8"))
    .replace(/(["'])\.\/AIEngine\.js(?:\?[^"']*)?\1/g, JSON.stringify(aiUrl))
    .replaceAll("import.meta.url", JSON.stringify("file:///frozen-three-player-v4/ThreePlayerAI.js")));
  const searchUrl = asModule((await readFile(resolve(sourceDirectory, "ThreePlayerSearchAI.js"), "utf8"))
    .replace(/(["'])\.\/GameEngine\.js(?:\?[^"']*)?\1/g, JSON.stringify(engineUrl))
    .replace(/(["'])\.\/AIEngine\.js(?:\?[^"']*)?\1/g, JSON.stringify(aiUrl))
    .replace(/(["'])\.\/ThreePlayerAI\.js(?:\?[^"']*)?\1/g, JSON.stringify(policyUrl)));
  return { ...(await import(engineUrl)), ...(await import(policyUrl)), ...(await import(searchUrl)) };
}
