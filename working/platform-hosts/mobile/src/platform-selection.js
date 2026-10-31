export function selectMobilePlatform(bridge = globalThis.LifelineBridge) {
  return bridge && typeof bridge.loadRecord === 'function' ? 'harmony' : 'capacitor';
}
