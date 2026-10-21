'use strict';
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function configHasSecret(cfgText, secret) {
  return typeof cfgText === 'string' && cfgText.includes(secret);
}

function findSessionDir(home, id) {
  const root = path.join(home, '.harness2', 'sessions');
  if (!fs.existsSync(root)) return null;
  let groups = [];
  try {
    groups = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const g of groups) {
    if (!g.isDirectory()) continue;
    const p = path.join(root, g.name, id);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// Test 1: secret detection
assert.strictEqual(configHasSecret('{"providers":{"p":{"baseUrl":"http://x"}}}', 'sk-probe-secret-123'), false);
assert.strictEqual(configHasSecret('{"apiKey":"sk-probe-secret-123"}', 'sk-probe-secret-123'), true);

// Test 2: findSessionDir round-trip
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zs4-logic-'));
const sessRoot = path.join(tmp, '.harness2', 'sessions', 'group-a', 'session-123');
fs.mkdirSync(sessRoot, { recursive: true });
assert.strictEqual(findSessionDir(tmp, 'session-123'), sessRoot);
assert.strictEqual(findSessionDir(tmp, 'nope'), null);
fs.rmSync(tmp, { recursive: true, force: true });

console.log('round-logic: all assertions passed');
process.exit(0);
