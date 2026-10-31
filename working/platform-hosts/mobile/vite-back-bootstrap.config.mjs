import { defineConfig } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { patchCapacitorCore } from './tools/patch-capacitor-core.mjs';

const mobileRoot = path.dirname(fileURLToPath(import.meta.url));
let capacitorPatchApplied = false;

export default defineConfig({
  root: mobileRoot,
  configFile: false,
  plugins: [{
    name: 'lifeline-capacitor-listener-rejection',
    enforce: 'pre',
    buildStart() { capacitorPatchApplied = false; },
    async transform(source, id) {
      const patched = await patchCapacitorCore(source, id);
      if (patched === null) return null;
      capacitorPatchApplied = true;
      return { code: patched, map: null };
    },
    buildEnd() {
      if (!capacitorPatchApplied) throw new Error('The locked @capacitor/core listener module was not transformed.');
    },
  }],
  build: {
    emptyOutDir: false,
    outDir: path.join(mobileRoot, 'dist'),
    lib: {
      entry: path.join(mobileRoot, 'src/native-back-bootstrap.js'),
      formats: ['es'],
      fileName: () => 'platform/native-back-bootstrap.js',
    },
    rollupOptions: { output: { inlineDynamicImports: true } },
    target: 'es2022',
    minify: true,
  },
});
