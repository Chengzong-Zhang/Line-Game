import test from 'node:test';
import assert from 'node:assert/strict';
import { TEXT, errorText } from '../src/i18n.js';

for (const language of ['zh', 'en']) {
  test(`${language}: joining rejects an occupied target separately from an account in another room`, () => {
    const t = TEXT[language];
    const full = errorText('ROOM_FULL', t);
    const occupied = errorText('ALREADY_IN_ROOM', t);
    assert.notEqual(full, occupied);
    assert.ok(t.alreadyInRoom);
    assert.equal(full, t.roomFull);
    assert.equal(occupied, t.alreadyInRoom);
    assert.equal(errorText('ROOM_CLOSED', t), t.roomMissing);
  });
}
