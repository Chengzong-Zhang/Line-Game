// Standard performance.now() and Date.now() both use milliseconds. Do not use
// wx.getPerformance() here: its native clock can have a different unit.
// Keep the fallback nondecreasing when the wall clock is adjusted backwards.
const nativeClock = globalThis.performance;
let lastWallTime = 0;
export const multiplayerClock = {
  now: typeof nativeClock?.now === "function" ? () => nativeClock.now() : () => {
    lastWallTime = Math.max(lastWallTime, Date.now());
    return lastWallTime;
  },
};
