// Lease-bound snapshots avoid queued Capacitor listeners crossing a page reload.
// The host tracks inactive transitions, so a short suspension between polls is
// delivered as background then foreground on the next successful snapshot.
export async function startIOSLifecyclePolling({read, publish, eventTarget, pageTarget, timers=globalThis, intervalMs=1000}) {
  let last=null, observedRevision=-1, serial=0, stopped=false, timer=null, suspended=false;
  async function refresh() {
    const request=++serial;
    const result=await read();
    if (stopped || suspended || request!==serial) return;
    if (typeof result?.isActive !== 'boolean' || !Number.isSafeInteger(result.transitionRevision)
        || !Number.isSafeInteger(result.lastInactiveRevision) || result.lastInactiveRevision < 0
        || result.transitionRevision < result.lastInactiveRevision || result.transitionRevision < observedRevision) throw new Error('Invalid app state.');
    if (last===true && result.isActive && result.lastInactiveRevision>observedRevision) {publish(false);publish(true);}
    else if (last!==result.isActive) publish(result.isActive);
    last=result.isActive; observedRevision=result.transitionRevision;
  }
  await refresh();
  const safeRefresh=()=>{void refresh().catch(()=>{});};
  const start=()=>{if(timer===null && !stopped && !suspended) timer=timers.setInterval(safeRefresh,intervalMs);};
  const stopTimer=()=>{if(timer!==null){timers.clearInterval(timer);timer=null;}};
  const hide=()=>{suspended=true;serial++;stopTimer();};
  const show=()=>{if(stopped) return;suspended=false;start();safeRefresh();};
  start();
  eventTarget?.addEventListener?.('visibilitychange',safeRefresh);
  pageTarget?.addEventListener?.('pagehide',hide);
  pageTarget?.addEventListener?.('pageshow',show);
  return () => {stopped=true;serial++;stopTimer();eventTarget?.removeEventListener?.('visibilitychange',safeRefresh);pageTarget?.removeEventListener?.('pagehide',hide);pageTarget?.removeEventListener?.('pageshow',show);};
}

export function createIOSNetworkPolling({read, timers=globalThis, intervalMs=1000}) {
  return async function listen(notify) {
    let stopped=false, sequence=0;
    const tick=()=>{
      const request=++sequence;
      void Promise.resolve().then(read).then(status=>{if(!stopped && request===sequence) notify(status);}).catch(()=>{});
    };
    const timer=timers.setInterval(tick,intervalMs);
    return {remove:async()=>{stopped=true;sequence++;timers.clearInterval(timer);}};
  };
}
