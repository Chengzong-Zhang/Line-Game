export function createSerializedSessionMirror({ write, remove }) {
  let tail = Promise.resolve();
  let latest = tail;
  let revision = 0;
  const enqueue = (operation) => {
    const ownRevision = ++revision;
    const next = tail.catch(() => {}).then(operation);
    tail = next.catch(() => {});
    latest = next;
    Object.defineProperties(next, {
      revision: { value: ownRevision },
      isCurrent: { value: () => revision === ownRevision },
    });
    return next;
  };
  return Object.freeze({
    save(value) { return enqueue(() => write(value)); },
    clear() { return enqueue(() => remove()); },
    settled() { return latest; },
  });
}
