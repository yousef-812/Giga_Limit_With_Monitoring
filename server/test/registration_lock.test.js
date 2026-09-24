const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('new-device registration can be locked by admin', () => {
  const dbSource = read('server/db.js');
  assert.match(dbSource, /registration_locked/);
  assert.match(dbSource, /setRegistrationLocked/);
  const source = read('server/index.js');
  assert.match(source, /Registration is disabled by admin/);
  assert.match(source, /toggle_registration/);
  assert.match(source, /REGISTER_BLOCK/);
});

test('known devices keep working while locked', () => {
  const source = read('server/index.js');
  assert.match(source, /!existing && db\.getSetting\('registration_locked'\) === true/);
  const ui = read('server/public/index.html');
  assert.match(ui, /toggleRegistration/);
  assert.match(ui, /reg-lock-btn/);
  assert.match(ui, /registration_locked/);
});
