export function selectSessionRecovery({ wasCleared, localValue, nativeValue, parse }) {
  if (wasCleared) return Object.freeze({ action: 'clear', value: null });
  const localValid = typeof localValue === 'string' && Boolean(parse(localValue));
  if (localValid) return Object.freeze({ action: 'save-local-to-native', value: localValue });
  const nativeValid = typeof nativeValue === 'string' && Boolean(parse(nativeValue));
  if (nativeValid) return Object.freeze({ action: 'restore-native-to-local', value: nativeValue });
  return Object.freeze({ action: localValue ? 'corrupt-local-and-no-valid-backup' : 'ready', value: null });
}
