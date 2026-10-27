import { ensureOnlineConsent } from './online-consent.js';

export const ACCOUNT_COPY = {
  zh: {
    disabled: '微信账号与好友对战正在接入正式服务器。当前可以直接玩本地对局。',
    linked: name => `微信账号已登录\n已关联网页版账号：${name}`,
    unlinked: '微信账号已登录\n尚未关联网页版账号。好友对战无需绑定，网页好友输入同一房间码即可加入。',
    link: '关联已有网页版账号', unlink: '解除网页版账号关联', refresh: '刷新账号信息',
    instructions: '先在网页版登录原账号，打开“对战舱 → 关联微信账号”，复制一次性绑定码。请粘贴到这里。',
    confirmLink: '将这个微信身份与绑定码对应的网页版账号关联？服务器会保存关联关系并显示网页账号名称，原网页账号及密码保留。绑定码 5 分钟有效；请先退出正在进行的好友房间。',
    confirmUnlink: '解除关联后，网页版原账号及密码仍保留，两端使用独立的联机身份。请先退出好友房间。是否继续？',
    success: '账号关联已更新。', retry: '暂时无法读取账号，请稍后重试。',
  },
  en: {
    disabled: 'WeChat accounts and friend rooms need the configured online service. Local games are ready to play.',
    linked: name => `WeChat signed in\nLinked Web account: ${name}`,
    unlinked: 'WeChat signed in\nNo linked Web account. Linking is optional for friend games: Web friends can enter the same room code.',
    link: 'Link existing Web account', unlink: 'Unlink Web account', refresh: 'Refresh account',
    instructions: 'Sign in on the website, open Match cabin → Link WeChat account, then paste the one-time code here.',
    confirmLink: 'Link this WeChat identity to the Web account that issued this code? The service stores the link and displays the Web account name. Your original Web account and password remain. Codes expire in 5 minutes. Leave any active friend room first.',
    confirmUnlink: 'Keep your Web account and password but separate the two game identities? Leave your friend room first.',
    success: 'Account link updated.', retry: 'Account unavailable. Please try again.',
  },
};
export const ACCOUNT_ERRORS = {
  LINK_CODE_INVALID: ['绑定码无效或已过期，请在网页版重新生成。', 'Invalid or expired code. Generate a new one on the website.'],
  ACCOUNT_LINK_CONFLICT: ['该微信或网页账号已经关联其他身份，无法覆盖。', 'This identity already has a different link. It cannot be overwritten.'],
  INVALID_LINK_CODE: ['绑定码无效或已过期，请在网页版重新生成。', 'Invalid or expired code. Generate a new one on the website.'],
  LINK_CODE_EXPIRED: ['绑定码已过期，请在网页版重新生成。', 'Code expired. Generate a new one on the website.'],
  ACTIVE_ROOM: ['请先在两端退出好友房间，再进行账号关联。', 'Leave friend rooms on both accounts before linking.'],
  ACCOUNT_IN_ROOM: ['请先在两端退出好友房间，再进行账号关联。', 'Leave friend rooms on both accounts before linking.'],
  ACCOUNT_ALREADY_LINKED: ['该账号已有其他关联，无法覆盖。', 'This account is already linked. Existing links cannot be overwritten.'],
  ONLINE_NOT_CONFIGURED: ['联机服务尚未配置，仍可继续本地游戏。', 'Online service is not configured. Local games remain available.'],
};

export async function showAccountMenu({ online, platform, language = 'zh', isCurrent = () => true }) {
  const en = language === 'en', t = ACCOUNT_COPY[en ? 'en' : 'zh'];
  if (!online.enabled) return platform.message(t.disabled);
  try {
    if (!await ensureOnlineConsent({ online, platform, language, isCurrent }) || !isCurrent()) return;
    const account = await online.loadAccount();
    if (!isCurrent()) return;
    await platform.message(account.linkedWeb ? t.linked(account.displayName || account.linkedWeb?.displayName || '') : t.unlinked);
    if (!isCurrent()) return;
    const selected = await platform.choose([account.linkedWeb ? t.unlink : t.link, t.refresh]);
    if (!isCurrent() || selected < 0) return;
    if (selected === 1) { await online.loadAccount(); return; }
    if (account.linkedWeb) {
      if (!await platform.confirm(t.confirmUnlink) || !isCurrent()) return;
      await online.unlinkWebAccount();
    } else {
      const code = await platform.input(t.instructions);
      if (!code || !isCurrent()) return;
      if (!await platform.confirm(t.confirmLink) || !isCurrent()) return;
      await online.linkWebAccount(code);
    }
    if (isCurrent()) await platform.message(t.success);
  } catch (error) {
    if (isCurrent()) await platform.message(ACCOUNT_ERRORS[error.message]?.[en ? 1 : 0] || `${t.retry}\n${String(error.message).slice(0, 100)}`);
  }
}
