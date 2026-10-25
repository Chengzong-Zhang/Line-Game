import { MODEL_CATALOG, MODEL_PACKAGES } from '../src/model-catalog.js';
import { GUIDE_ASSETS } from '../src/guide-assets.js';
export { MODEL_CATALOG, MODEL_PACKAGES };
export { GUIDE_ASSETS };
export const BASE_RUNTIME_FILES = ['THIRD_PARTY_NOTICES.txt', 'game.js', 'game.json', 'workers/index.js'];
export const GUIDE_RUNTIME_FILES = GUIDE_ASSETS.map(asset => asset.path);
export const MODEL_RUNTIME_FILES = [...MODEL_PACKAGES.map(pack => `${pack.root}/game.js`), ...MODEL_CATALOG.map(model => model.assetPath)];
export const LEGACY_MODEL_PACKAGE_FILES = [...BASE_RUNTIME_FILES, ...MODEL_RUNTIME_FILES, 'build-manifest.json'].sort();
export const LEGACY_MODEL_PACKAGE_DIRECTORIES = ['workers', 'models', ...MODEL_PACKAGES.map(pack => pack.root)];
export const RUNTIME_FILES = [...BASE_RUNTIME_FILES, ...GUIDE_RUNTIME_FILES, ...MODEL_RUNTIME_FILES];
export const PACKAGE_FILES = [...RUNTIME_FILES, 'build-manifest.json'].sort();
export const PACKAGE_DIRECTORIES = ['workers', 'guide', 'models', ...MODEL_PACKAGES.map(pack => pack.root)];
export const SUBPACKAGE_ENTRY = '// Optional model data only. Loaded explicitly by the main package.\n';
export const MAIN_BUDGET = 3 * 1024 * 1024;
// Conservative local budgets: each ordinary model pack stays below 4 MiB,
// and the whole candidate below 20 MiB, even where the platform allows more.
export const SUBPACKAGE_BUDGET = 4 * 1024 * 1024;
export const TOTAL_BUDGET = 20 * 1024 * 1024;
