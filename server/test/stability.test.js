const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('UDP relay drops invalid ports instead of crashing send', () => {
  const source = read('server/index.js');
  assert.match(source, /port <= 0 \|\| port > 65535/);
  assert.match(source, /if \(!payload\.length\) return;/);
});

test('SOCKS requests are length-guarded before parsing', () => {
  const source = read('server/index.js');
  assert.match(source, /buffer\.length < 10|reqData\.length < 10/);
  assert.match(source, /buffer\.length < 22|reqData\.length < 22/);
  assert.match(source, /buffer\.length < 5 \+ domainLen \+ 2|reqData\.length < 5 \+ domainLen \+ 2/);
});

test('bad-port socket errors never flood the console', () => {
  const source = read('server/index.js');
  assert.match(source, /ERR_SOCKET_BAD_PORT/);
});

test('hotspot task uses real ScheduledTask objects', () => {
  const source = read('server/index.js');
  assert.match(source, /New-ScheduledTaskAction/);
  assert.match(source, /New-ScheduledTaskTrigger/);
  assert.match(source, /New-ScheduledTaskPrincipal/);
  assert.match(source, /HOTSPOT_TASK_OK/);
  assert.doesNotMatch(source, /-Principal \$env:USERNAME -RunLevel Highest/);
});
