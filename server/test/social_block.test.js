const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('social block covers requested apps and sites', () => {
  const source = read('server/index.js');
  for (const domain of [
    'facebook.com',
    'instagram.com',
    'tiktok.com',
    'snapchat.com',
    'threads.net',
  ]) {
    assert.ok(source.includes(`'${domain}'`));
  }
  assert.match(source, /isSocialHost/);
  assert.match(source, /isSocialBlockedForIp/);
});

test('social block enforced on HTTP, CONNECT, SOCKS TCP and UDP DNS', () => {
  const source = read('server/index.js');
  assert.match(source, /Forbidden: Social media blocked for this device/);
  assert.match(source, /parseDnsQueryName/);
  assert.match(source, /toggle_social/);
  assert.match(source, /setSocialBlocked/);
});

test('social block is per device with safe defaults', () => {
  const dbSource = read('server/db.js');
  assert.match(dbSource, /social_blocked/);
  assert.match(dbSource, /setSocialBlocked/);
  const ui = read('server/public/index.html');
  assert.match(ui, /toggleSocial/);
  assert.match(ui, /toggle_social/);
});
