const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('social monitoring covers requested apps and browsers', () => {
  const source = read('mobile_app/android/app/src/main/kotlin/com/example/mobile_app/ScreenMonitorService.kt');
  for (const pkg of [
    'com.instagram.android',
    'com.facebook.katana',
    'com.zhiliaoapp.musically',
    'com.snapchat.android',
    'com.instagram.barcelona',
  ]) {
    assert.match(source, new RegExp(pkg.replace(/\./g, '\\.'), 'g'));
  }
  for (const browser of ['com.android.chrome', 'org.mozilla.firefox', 'com.microsoft.emmx']) {
    assert.match(source, new RegExp(browser.replace(/\./g, '\\.'), 'g'));
  }
  for (const domain of ['facebook.com', 'instagram.com', 'tiktok.com', 'snapchat.com', 'threads.net']) {
    assert.ok(source.includes(`"${domain}"`));
  }
  assert.match(source, /POLLING_INTERVAL = 20000L/);
  assert.match(source, /monitoring_status/);
  assert.match(source, /upload_screenshot/);
});

test('monitoring captures only on screen-on social context', () => {
  const source = read('mobile_app/android/app/src/main/kotlin/com/example/mobile_app/ScreenMonitorService.kt');
  assert.match(source, /isInteractive/);
  assert.match(source, /isKeyguardLocked/);
  assert.match(source, /inSocialApp|isSocialApp/);
  assert.match(source, /isSocialUrl|inSocialSite/);
});

test('server exposes authenticated monitoring endpoints', () => {
  const source = read('server/index.js');
  assert.match(source, /app\.get\('\/api\/monitoring_status\/:device_id'/);
  assert.match(source, /app\.post\('\/api\/upload_screenshot'/);
  assert.match(source, /app\.post\('\/api\/admin\/toggle_monitoring', adminAuth/);
  assert.match(source, /requireDevice\(req, res, deviceId\)/);
  // Screenshots stay inside the app directory, never a hardcoded drive.
  assert.doesNotMatch(source, /D:\\Alaa/);
  assert.match(source, /screenshots/);
});

test('monitoring defaults on and can be toggled per user', () => {
  const dbSource = read('server/db.js');
  assert.match(dbSource, /setMonitoring/);
  assert.match(dbSource, /monitoring_enabled/);
  const ui = read('server/public/index.html');
  assert.match(ui, /toggleMonitoring/);
  assert.match(ui, /toggle_monitoring/);
});

test('diagnostic heartbeat and activity log are wired', () => {
  const source = read('server/index.js');
  assert.match(source, /monitor_heartbeat/);
  assert.match(source, /MONITOR_BEAT/);
  assert.match(source, /giga_activity\.log/);
  assert.match(source, /\/api\/admin\/activity/);
  assert.match(source, /AUTH_FAIL/);
  const kotlin = read('mobile_app/android/app/src/main/kotlin/com/example/mobile_app/ScreenMonitorService.kt');
  assert.match(kotlin, /monitor_heartbeat/);
  assert.match(kotlin, /sendHeartbeat/);
  const ui = read('server/public/index.html');
  assert.match(ui, /loadActivity/);
  assert.match(ui, /downloadActivity/);
});
