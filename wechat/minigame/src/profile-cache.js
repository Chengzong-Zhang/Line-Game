const PREFIX = 'lifeline-wx-profile-v1:';
// Use code points instead of Unicode-property regexes: some WeChat Android
// JavaScript runtimes fail while parsing property escapes, before the game can start.
const INVALID_NAME_RANGES = [
  [0x0000, 0x001f], [0x007f, 0x009f], [0x00ad, 0x00ad],
  [0x0600, 0x0605], [0x061c, 0x061c], [0x06dd, 0x06dd],
  [0x070f, 0x070f], [0x0890, 0x0891], [0x08e2, 0x08e2],
  [0x180e, 0x180e], [0x200b, 0x200f], [0x2028, 0x202e],
  [0x2060, 0x2064], [0x2066, 0x206f], [0xd800, 0xdfff],
  [0xfeff, 0xfeff], [0xfff9, 0xfffb], [0x110bd, 0x110bd],
  [0x110cd, 0x110cd], [0x13430, 0x1343f], [0x1bca0, 0x1bca3],
  [0x1d173, 0x1d17a], [0xe0001, 0xe0001], [0xe0020, 0xe007f],
];

function invalidNameCharacter(value) {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (INVALID_NAME_RANGES.some(([start, end]) => codePoint >= start && codePoint <= end)) return true;
  }
  return false;
}

export function validateProfile(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.keys(value).length
    || Object.keys(value).some(key => !['displayName', 'avatarDataUrl'].includes(key))) throw new Error('INVALID_PROFILE');
  const data = { ...value };
  if (data.displayName !== undefined) {
    if (typeof data.displayName !== 'string' || invalidNameCharacter(data.displayName)) throw new Error('INVALID_DISPLAY_NAME');
    data.displayName = data.displayName.trim();
    if (![...data.displayName].length || [...data.displayName].length > 24) throw new Error('INVALID_DISPLAY_NAME');
  }
  if (data.avatarDataUrl !== undefined && data.avatarDataUrl !== null && (typeof data.avatarDataUrl !== 'string'
    || data.avatarDataUrl.length > 350000 || !/^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(data.avatarDataUrl))) throw new Error('INVALID_AVATAR');
  return data;
}

export function profileCache(platform, apiBase) {
  const key = uid => /^[0-9a-f]{32}$/.test(uid || '') ? `${PREFIX}${encodeURIComponent(String(apiBase).replace(/\/$/, ''))}:${uid}` : null;
  return {
    read(uid) {
      try {
        const name = key(uid), raw = name && platform.storage.get(name);
        if (!raw) return null;
        const record = JSON.parse(raw);
        if (record.version !== 1 || record.uid !== uid || record.pending !== true) return null;
        return { ...record, fields: validateProfile(record.fields) };
      } catch (_) { return null; }
    },
    write(uid, fields) {
      const name = key(uid);
      if (!name) throw new Error('INVALID_PROFILE');
      const record = { version: 1, uid, pending: true, fields: validateProfile(fields) };
      const raw = JSON.stringify(record);
      try {
        platform.storage.set(name, raw);
        if (platform.storage.get(name) !== raw) throw new Error('PROFILE_LOCAL_SAVE_FAILED');
      } catch (_) { throw new Error('PROFILE_LOCAL_SAVE_FAILED'); }
      return record;
    },
    clear(uid) {
      const name = key(uid);
      if (!name) return;
      try {
        platform.storage.set(name, '');
        if (platform.storage.get(name)) throw new Error('PROFILE_LOCAL_SAVE_FAILED');
      } catch (_) { throw new Error('PROFILE_LOCAL_SAVE_FAILED'); }
    },
  };
}
