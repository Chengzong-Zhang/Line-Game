import { BASIC_CONTROLLERS, controllerChoices } from './controllers.js';
import { MODEL_CATALOG, MULTIPLAYER_AI_CATALOG } from './model-catalog.js';

// Analysis shows the whole catalog, including profiles outside this board's
// supported scope. Displaying a profile never silently substitutes another AI.
export function replayAnalysisChoices(settings) {
  const supported = new Set(controllerChoices(settings));
  return [...new Set([...BASIC_CONTROLLERS.filter(profile => profile !== 'human'),
    ...MULTIPLAYER_AI_CATALOG.map(model => model.profile), ...MODEL_CATALOG.map(model => model.profile)])]
    .map(profile => ({ profile, supported: supported.has(profile) }));
}
