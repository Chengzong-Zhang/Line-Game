const API_TIMEOUT_MS = 10000;
const ANONYMOUS_NAMES = new Set(['微信用户', '微信使用者', '匿名用户', '匿名使用者', '匿名', 'wechat user', 'weixin user', 'anonymous']);

function profileFrom(result) {
  try {
    const source = result?.userInfo;
    if (!source || source.is_demote === true || source.is_demote === 1
      || typeof source.nickName !== 'string' || typeof source.avatarUrl !== 'string') return null;
    const displayName = Array.from(source.nickName.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '').trim()).slice(0, 24).join('');
    const avatarUrl = source.avatarUrl.trim();
    // These are WeChat's avatar hosts, not arbitrary image or login URLs.
    if (!displayName || ANONYMOUS_NAMES.has(displayName.toLowerCase())
      || !/^https:\/\/(?:thirdwx\.qlogo\.cn|wx\.qlogo\.cn)(?::443)?\/[^\s\\#]+$/i.test(avatarUrl)) return null;
    return { displayName, avatarUrl };
  } catch (_) { return null; }
}

function callOptional(api, name, options = {}) {
  return new Promise(resolve => {
    let method;
    try { method = api?.[name]; } catch (_) { return resolve(null); }
    if (typeof method !== 'function') return resolve(null);
    let settled = false;
    const finish = result => { if (settled) return; settled = true; clearTimeout(timer); resolve(result); };
    const timer = setTimeout(() => finish(null), API_TIMEOUT_MS);
    try { method.call(api, { ...options, success: finish, fail: () => finish(null) }); }
    catch (_) { finish(null); }
  });
}

function profileError(result) {
  try {
    const code = result?.errCode ?? result?.errno;
    if ([112, 1025, 1026].includes(Number(code))) return new Error('WECHAT_PRIVACY_UNCONFIGURED');
    if (Number(code) === 104) return new Error('WECHAT_PROFILE_DENIED');
    return new Error(/deny|denied|cancel|refuse|disagree/i.test(result?.errMsg || '')
      ? 'WECHAT_PROFILE_DENIED' : 'WECHAT_PROFILE_UNAVAILABLE');
  } catch (_) { return new Error('WECHAT_PROFILE_UNAVAILABLE'); }
}

function english(language) {
  try { return (typeof language === 'function' ? language() : language) === 'en'; }
  catch (_) { return false; }
}

function buttonStyle(bounds) {
  try {
    const left = bounds?.left ?? bounds?.x, top = bounds?.top ?? bounds?.y;
    const width = bounds?.width ?? bounds?.w, height = bounds?.height ?? bounds?.h;
    if (![left, top, width, height].every(Number.isFinite) || left < 0 || top < 0 || width <= 0 || height <= 0) return null;
    return { left, top, width, height, lineHeight: height, backgroundColor: '#f2e8d5', color: '#22474b',
      textAlign: 'center', fontSize: Math.min(14, Math.max(11, height * 0.36)), borderRadius: 10 };
  } catch (_) { return null; }
}

export function userInfoPlatform(api) {
  return {
    async getAuthorizedUserInfo() {
      // Never open an authorization prompt during startup or silently replace a
      // saved player profile with the anonymous fallback returned by older APIs.
      try {
        const setting = await callOptional(api, 'getSetting');
        if (setting?.authSetting?.['scope.userInfo'] !== true) return null;
        return profileFrom(await callOptional(api, 'getUserInfo', { withCredentials: false }));
      } catch (_) { return null; }
    },

    createUserInfoControl({ bounds, language = 'zh', onResult } = {}) {
      let style = buttonStyle(bounds), button, live = true, visible = true, validBounds = Boolean(style);
      const notify = (profile, error) => { if (live && visible) { try { onResult?.(profile, error); } catch (_) {} } };
      const fail = result => notify(null, profileError(result));
      if (!style) { fail(); return null; }
      const text = () => english(language) ? 'Use WeChat profile' : '导入微信昵称头像';
      const tap = result => {
        if (!live || !visible) return;
        try {
          const code = result?.errCode ?? result?.errno;
          if ((code !== undefined && Number(code) !== 0)
            || (typeof result?.errMsg === 'string' && result.errMsg && !/:ok$/i.test(result.errMsg))) { fail(result); return; }
        } catch (_) { fail(); return; }
        const profile = profileFrom(result);
        profile ? notify(profile) : fail(result);
      };
      try {
        if (typeof api?.createUserInfoButton !== 'function') throw new Error('WECHAT_PROFILE_UNAVAILABLE');
        button = api.createUserInfoButton({ type: 'text', text: text(), style, withCredentials: false,
          lang: english(language) ? 'en' : 'zh_CN' });
        if (typeof button?.onTap !== 'function') throw new Error('WECHAT_PROFILE_UNAVAILABLE');
        button.onTap(tap);
      } catch (error) {
        try { button?.destroy?.(); } catch (_) {}
        fail(error); live = false; return null;
      }
      const hide = () => {
        if (!live) return;
        visible = false;
        try { button.hide?.(); } catch (_) {}
      };
      return {
        update(options = {}) {
          if (!live) return false;
          if (options.bounds !== undefined) {
            const next = buttonStyle(options.bounds);
            if (!next) { validBounds = false; hide(); return false; }
            style = next; validBounds = true;
          }
          if (options.language !== undefined) language = options.language;
          try { button.style = style; button.text = text(); return true; }
          catch (error) { fail(error); hide(); return false; }
        },
        show() {
          if (!live || !validBounds) return false;
          try { button.show?.(); visible = true; return true; }
          catch (error) { fail(error); hide(); return false; }
        },
        hide,
        destroy() {
          if (!live) return;
          live = false; visible = false;
          try { button.offTap?.(tap); } catch (_) {}
          try { button.hide?.(); } catch (_) {}
          try { button.destroy?.(); } catch (_) {}
        },
      };
    },

    installPrivacyAuthorization({ language = 'zh' } = {}) {
      let active = true, prompting = false, promptSequence = 0;
      const pending = new Set();
      const finish = (entry, agree) => {
        if (entry.settled) return;
        entry.settled = true; pending.delete(entry);
        try { entry.resolve({ event: agree ? 'agree' : 'disagree' }); } catch (_) {}
      };
      const settle = agree => {
        prompting = false;
        for (const entry of [...pending]) finish(entry, active && agree);
      };
      const showPrompt = () => {
        if (!active || !pending.size) return;
        let showActionSheet, openPrivacyContract;
        try { showActionSheet = api?.showActionSheet; openPrivacyContract = api?.openPrivacyContract; } catch (_) {}
        if (typeof showActionSheet !== 'function' || typeof openPrivacyContract !== 'function') { settle(false); return; }
        prompting = true;
        const sequence = ++promptSequence;
        let answered = false;
        const current = () => active && sequence === promptSequence && pending.size > 0;
        const answer = index => {
          if (answered || !current()) return;
          answered = true;
          if (index === 0) {
            // Reading the official guide never grants consent. Present the
            // choices again after the native guide call completes.
            callOptional(api, 'openPrivacyContract').then(result => {
              if (!current()) return;
              if (result === null) settle(false);
              else showPrompt();
            });
          } else settle(index === 1);
        };
        const en = english(language);
        try {
          // alertText is available in Mini Game base library 2.14.0 and later.
          showActionSheet.call(api, {
            alertText: en ? 'Import your WeChat name and avatar for your game profile. Only your chosen photo is processed when selecting an avatar. Read the privacy guide, then choose whether to agree.'
              : '导入微信昵称和头像，用于完善游戏资料；相册头像仅处理你选中的照片。请阅读隐私指引，并选择是否同意。',
            itemList: en ? ['Read privacy guide', 'Agree and continue', 'Decline'] : ['阅读隐私指引', '同意并继续', '拒绝'],
            success: result => { let index = -1; try { index = result?.tapIndex; } catch (_) {} answer(index); },
            fail: () => answer(-1),
          });
        } catch (_) { answer(-1); }
      };
      const handler = resolve => {
        if (typeof resolve !== 'function') return;
        const entry = { resolve, settled: false };
        if (!active) { finish(entry, false); return; }
        pending.add(entry);
        try { resolve({ event: 'exposureAuthorization' }); }
        catch (_) { finish(entry, false); return; }
        if (!active || entry.settled) return;
        if (prompting) return;
        showPrompt();
      };
      try { api?.onNeedPrivacyAuthorization?.(handler); } catch (_) { active = false; }
      return () => {
        if (!active) return;
        active = false; ++promptSequence; settle(false);
        try { api?.offNeedPrivacyAuthorization?.(handler); } catch (_) {}
      };
    },

    async openPrivacyContract() {
      return (await callOptional(api, 'openPrivacyContract')) !== null;
    },
  };
}
