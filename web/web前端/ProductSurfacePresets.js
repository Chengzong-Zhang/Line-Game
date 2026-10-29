import { createSurfacePreset } from './BoardPresets.js?v=20261030-topology-fix';
import { createDoubleSphereBoardDefinition, createDoubleTorusBoardDefinition } from './RandomSurfaceBoard.js?v=20261030-topology-fix';

export const PRODUCT_SURFACE_PRESETS = Object.freeze([
  'cylinder', 'mobius', 'torus', 'klein-bottle', 'tetrahedron', 'cone', 'sphere', 'double-sphere', 'double-torus',
]);

// These two-chart surfaces use the same proven constructors as random v4.
// Keep the older sphere factory for old presets and saved-board inference.
export function createProductSurfacePreset(name, options = {}) {
  if (name === 'double-torus') return createDoubleTorusBoardDefinition(options);
  if (name === 'double-sphere') return createDoubleSphereBoardDefinition(options);
  return createSurfacePreset(name, options);
}
