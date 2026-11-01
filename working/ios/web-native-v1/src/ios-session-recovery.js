import { registerPlugin } from '@capacitor/core';
import { claimIOSDocument } from './ios-document-lease.js';

const native = registerPlugin('LifelineStorage');
const KEYS = Object.freeze({
  ordinary: 'lifeline-local-game-session-v1',
  topology: 'lifeline-topology-local-game-session-v1',
});
const marker = key => `lifeline-ios-recovery-pending:${key}`;
const backup = key => `lifeline-ios-recovery-backup:${key}`;
const CLEARED = JSON.stringify({format:'lifeline-local-session-envelope',version:1,revision:1,state:'cleared'});

// A surviving marker means a previous confirmed clear may have stopped between
// either write. Never enter the game until the player explicitly resumes it.
export function assertNoRecoveryPending(storage = globalThis.localStorage) {
  for (const key of Object.values(KEYS)) if (storage.getItem(marker(key)) !== null) throw new Error('Session recovery is pending.');
}

export function createIOSSessionRecovery({ storage, plugin, documentLease }) {
  async function status() {
    const result = await plugin.getSessionRecoveryStatus({documentLease});
    if (!result || !['ready','blocked'].includes(result.ordinary) || !['ready','blocked'].includes(result.topology)) throw new Error('Invalid recovery status.');
    return Object.fromEntries(Object.entries(KEYS).map(([type,key]) => [type, result[type] === 'blocked' || storage.getItem(marker(key)) !== null ? 'blocked' : 'ready']));
  }
  async function clear(type, confirmed) {
    if (!Object.hasOwn(KEYS, type) || confirmed !== true) throw new Error('Explicit confirmation required.');
    const key=KEYS[type];
    storage.setItem(marker(key),'1');
    if (storage.getItem(marker(key)) !== '1') throw new Error('Recovery marker was not saved.');
    const old = storage.getItem(key);
    if (old !== null && old !== CLEARED && storage.getItem(backup(key)) === null) {
      storage.setItem(backup(key),old);
      if (storage.getItem(backup(key)) !== old) throw new Error('Recovery backup was not saved.');
    }
    storage.setItem(key,CLEARED);
    if (storage.getItem(key) !== CLEARED) throw new Error('Local clear was not saved.');
    const response=await plugin.resolveSessionRecovery({key,value:CLEARED,confirm:true,documentLease});
    if (response?.durable !== true) throw new Error('Native clear was not confirmed.');
    storage.removeItem(marker(key));
    if (storage.getItem(marker(key)) !== null) throw new Error('Recovery marker was not removed.');
  }
  return Object.freeze({status,clear});
}

// Returns false if the failure was unrelated to this recoverable barrier.
export async function showIOSSessionRecovery({ document = globalThis.document, storage = globalThis.localStorage, plugin = native, location = globalThis.location, confirm = globalThis.confirm } = {}) {
  let controller, states;
  try {
    const documentLease=await claimIOSDocument(plugin);
    controller=createIOSSessionRecovery({storage,plugin,documentLease});
    states=await controller.status();
  } catch (_error) { return false; }
  if (Object.values(states).every(value=>value==='ready')) return false;
  const english=/^en/i.test(globalThis.navigator?.language ?? '');
  const panel=document.createElement('main'); panel.setAttribute('role','alert');
  panel.style.cssText='padding:24px;display:grid;gap:16px;background:#101713;color:#f5f1e7;min-height:100vh;font:16px/1.6 system-ui';
  const title=document.createElement('h1'); title.textContent=english?'Saved game needs attention':'存档需要处理'; panel.append(title);
  const description=document.createElement('p');
  description.textContent=english?'A storage operation was interrupted. Retry first. Clearing permanently discards the selected game; the other game is not changed.':'存档写入曾中断。请先重试。清除会永久丢弃所选存档，不影响另一种存档。'; panel.append(description);
  const retry=document.createElement('button'); retry.textContent=english?'Retry':'重试'; retry.onclick=()=>location.reload(); panel.append(retry);
  const feedback=document.createElement('p'); panel.append(feedback);
  for(const [type,state] of Object.entries(states)) {
    if(state!=='blocked') continue;
    const button=document.createElement('button');
    const label=type==='ordinary'?(english?'ordinary game':'普通对局'):(english?'topology game':'拓扑对局');
    button.textContent=english?`Clear ${label} and retry`:`清除${label}存档并重试`;
    button.onclick=async()=>{
      if (!confirm(english?`Permanently clear ${label}? This cannot be undone.`:`确认永久清除${label}存档？此操作无法撤销。`)) return;
      button.disabled=true;
      try { await controller.clear(type,true); location.reload(); }
      catch (_error) { feedback.textContent=english?'Clear was not completed. The game remains blocked; retry the same operation.':'清除未完成，游戏仍被阻止。请重试同一操作。'; button.disabled=false; }
    };
    panel.append(button);
  }
  document.body.replaceChildren(panel); return true;
}
