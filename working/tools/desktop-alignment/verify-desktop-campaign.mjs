import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const frontend = path.resolve(process.argv[2] ?? '');
assert.ok(process.argv[2], 'Pass the adapted frontend directory.');
const moduleAt = name => import(pathToFileURL(path.join(frontend, name)).href);
const { DesktopChallenge, createDesktopProfileController } = await moduleAt('DesktopModes.js');
const { CHALLENGE_LEVELS } = await moduleAt('ChallengeCampaign.js');
const { createDefaultPlayerProfile } = await moduleAt('LocalProfile.js');
const { default: GameEngine } = await moduleAt('GameEngine.js');
let saves = 0;
let storedProfile;
globalThis.lifelineDesktop = { isDesktop: true,
  readProfileSync: () => ({ ok: true, status: 'saved', value: JSON.stringify(storedProfile) }),
  writeProfileSync: value => { storedProfile = JSON.parse(value); saves += 1; return { ok: true, status: 'saved' }; } };
const untouched = new GameEngine();
const before = JSON.stringify(untouched.getSnapshot());
for (const level of CHALLENGE_LEVELS) {
  const profile = createDefaultPlayerProfile();
  storedProfile = profile;
  const challenge = new DesktopChallenge(level, profile);
  storedProfile = { ...storedProfile, preferences: { ...storedProfile.preferences, audioVolume: 25 } };
  for (const action of level.referenceSolution) {
    if (challenge.status === 'won') break;
    assert.ok(challenge.step(action.type === 'skip' ? null : action.point, action.player), `${level.id}: valid authored move`);
  }
  assert.equal(challenge.status, 'won', `${level.id}: goal reached`);
  assert.ok(storedProfile.progress.completedChallenges.includes(level.id), `${level.id}: completion persisted`);
  assert.equal(storedProfile.preferences.audioVolume, 25, `${level.id}: fresh preferences preserved`);
  assert.equal(challenge.saveResult.ok, true, `${level.id}: host confirmed save`);
}
assert.equal(saves, CHALLENGE_LEVELS.length);
assert.equal(JSON.stringify(untouched.getSnapshot()), before, 'challenge engines do not mutate an unrelated match');
let profile = createDefaultPlayerProfile();
globalThis.lifelineDesktop = {
  isDesktop: true,
  readProfileSync: () => ({ ok: true, status: 'saved', value: JSON.stringify(profile) }),
  writeProfileSync: value => { profile = JSON.parse(value); return { ok: true }; },
};
const desktopProfile = createDesktopProfileController();
assert.equal(desktopProfile.setPreferences({ audioEnabled: false, audioVolume: 25, reducedMotion: true, uiScale: 1.1, language: 'en' }).ok, true);
assert.equal(desktopProfile.finishTutorial().ok, true);
assert.deepEqual({ audioEnabled: profile.preferences.audioEnabled, audioVolume: profile.preferences.audioVolume,
  reducedMotion: profile.preferences.reducedMotion, uiScale: profile.preferences.uiScale, language: profile.preferences.language,
  tutorialComplete: profile.progress.tutorialComplete },
{ audioEnabled: false, audioVolume: 25, reducedMotion: true, uiScale: 1.1, language: 'en', tutorialComplete: true });
console.log(JSON.stringify({ status: 'PASS_DESKTOP_CAMPAIGN_ENGINE', levels: CHALLENGE_LEVELS.length, saves, profilePreferences: true, tutorialProgress: true }));
