import assert from 'node:assert/strict';
import { PRODUCT_SURFACE_PRESETS, createProductSurfacePreset } from '../ProductSurfacePresets.js';
import { compileBoard } from '../BoardCompiler.js';
import { topologyDefaultDefinition } from '../TopologyStartingPointSetup.js';

for (const [name, chi] of [['double-torus', -2], ['double-sphere', 2]]) {
  assert.ok(PRODUCT_SURFACE_PRESETS.includes(name));
  for (const gridSize of [5, 9, 15]) {
    const definition = createProductSurfacePreset(name, { gridSize });
    const compiled = compileBoard(definition);
    assert.equal(compiled.ok, true, JSON.stringify(compiled.errors));
    assert.equal(compiled.value.eulerCharacteristic, chi);
    assert.equal(compiled.value.boundaryComponents.length, 0);
    assert.equal(compiled.value.orientable, true);
    assert.ok(compiled.value.vertexLinks.every(link => link.manifold));
    const defaults = topologyDefaultDefinition(definition, gridSize);
    assert.deepEqual(defaults, definition);
  }
}
console.log('Product presets: double torus and two-chart sphere, N=5/9/15, geometry and default-root restoration passed.');
