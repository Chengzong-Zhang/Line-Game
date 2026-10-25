export const ONLINE_CONSENT_KEY = 'lifeline-wx-online-consent-v2';
export const LEGACY_ONLINE_CONSENT_KEY = 'lifeline-wx-online-consent-v1';
export const ONLINE_CONSENT_VERSION = '2026-10-22.1';

// Production builds already validate a public HTTPS origin. Keep this small
// runtime check independent of URL/DOM globals unavailable in Mini Games.
function serviceOrigin(online) {
  const raw = online.config?.apiBase;
  if (typeof raw !== 'string' || raw.length > 270) return null;
  const match = /^https:\/\/([a-z0-9.-]+)(?::443)?\/?$/i.exec(raw);
  if (!match || !match[1].includes('.') || match[1].length > 253
    || !match[1].split('.').every(label => label.length <= 63
      && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label))) return null;
  return `https://${match[1].toLowerCase()}`;
}

function accepted(storage, origin) {
  try {
    const raw = storage.get(ONLINE_CONSENT_KEY);
    if (typeof raw !== 'string' || raw.length > 1024) return false;
    const record = JSON.parse(raw);
    return record?.schema === 1 && record.version === ONLINE_CONSENT_VERSION && record.origin === origin
      && Number.isSafeInteger(record.acceptedAt) && record.acceptedAt > 0 && record.acceptedAt <= Date.now();
  } catch (_) { return false; }
}

function notice(origin, language) {
  return language === 'en'
    ? `Online service: ${origin}\nWeChat sign-in creates a game identity. The service stores rooms and online moves for reconnection. Linking a Web account is optional; the service stores the link and displays the account name. You can choose a nickname and avatar; these are saved for display to other players. The game does not automatically read your WeChat avatar or nickname and never reads your friend list or contacts. Signing in does not upload local replays. Anonymous replay contributions require a separate, optional opt-in. Continue?`
    : `联机服务：${origin}\n微信登录会建立游戏身份，服务器保存房间与联机动作以便重连。你可选择关联网页账号，关联后保存对应关系并显示账号名称；也可主动设置昵称和头像，保存后用于向其他玩家展示。不自动读取微信头像、昵称，不读取好友或通讯录。联机登录本身不会上传本地棋谱；匿名棋谱贡献需要另外主动开启。是否继续？`;
}

export async function ensureOnlineConsent({ online, platform, language = 'zh', isCurrent = () => true }) {
  if (!online.enabled || !isCurrent()) return false;
  const origin = serviceOrigin(online);
  if (!origin) throw new Error('ONLINE_NOT_CONFIGURED');
  const current = () => online.enabled && isCurrent() && serviceOrigin(online) === origin;
  if (accepted(platform.storage, origin)) return current();
  if (!current() || !await platform.confirm(notice(origin, language)) || !current()) return false;
  // A write failure does not undo this explicit confirmation. The next entry
  // will ask again; the old unscoped "yes" is never upgraded automatically.
  try {
    platform.storage.set(ONLINE_CONSENT_KEY, JSON.stringify({
      schema: 1, version: ONLINE_CONSENT_VERSION, origin, acceptedAt: Date.now(),
    }));
  } catch (_) {}
  return current();
}
