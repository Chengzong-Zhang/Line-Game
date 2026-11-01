// The warning only appears while secure credential storage is unavailable.
// Local game sessions are not touched by these actions.
export function createIOSCredentialRecovery({ document, confirm, getAuthority, language = '' }) {
  let panel = null, busy = false;
  const english = /^en/i.test(language);
  function update(status) {
    if (!['error','unknown','unavailable'].includes(status?.state)) {
      panel?.remove(); panel = null; return;
    }
    if (panel) return;
    panel=document.createElement('aside'); panel.setAttribute('role','alert');
    panel.style.cssText='position:fixed;z-index:2147483647;inset:auto 12px 12px;padding:16px;background:#fff4d5;color:#201b10;border:1px solid #735b29;border-radius:12px;font:15px/1.5 system-ui';
    const text=document.createElement('p'); text.textContent=english?'Saved sign-in needs attention. You can retry, or clear the saved sign-in and sign in again. Your games are unaffected.':'保存的登录信息需要处理。可以重试，或清除登录信息后重新登录；对局存档不受影响。'; panel.append(text);
    const message=document.createElement('p'); panel.append(message);
    const retry=document.createElement('button'); retry.textContent=english?'Retry':'重试'; panel.append(retry);
    const clear=document.createElement('button'); clear.textContent=english?'Clear saved sign-in':'清除登录信息'; panel.append(clear);
    const act=async (operation)=>{
      if (busy) return; busy=true; retry.disabled=true; clear.disabled=true;
      try { const ok=await operation(); if(!ok && panel) message.textContent=english?'The operation could not be confirmed. Please retry.':'操作未能确认，请重试。'; }
      catch (_error) { if(panel) message.textContent=english?'The operation could not be confirmed. Please retry.':'操作未能确认，请重试。'; }
      finally {busy=false;retry.disabled=false;clear.disabled=false;}
    };
    retry.onclick=()=>act(async()=> (await getAuthority().retry())?.state==='ready');
    clear.onclick=()=>{
      if (!confirm(english?'Clear saved sign-in? You will need to sign in again.':'确认清除已保存的登录信息？之后需要重新登录。')) return;
      return act(async()=>{const authority=getAuthority(); if(!await authority.clear()) return false; return (await authority.retry())?.state==='ready';});
    };
    document.body.append(panel);
  }
  return Object.freeze({update});
}
