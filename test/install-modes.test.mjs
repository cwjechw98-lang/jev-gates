import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPatch } from '../scripts/jev-install.mjs';
import { ADAPTER_MODES } from '../adapters/dsh/plugin.mjs';
import { CAPABILITY_MODES } from '../lib/capability.mjs';

test('installer selects supported initial modes for both plugins', () => {
  const rows = Object.fromEntries([...buildPatch(process.cwd()).matchAll(/- id: ([^\r\n]+)[\s\S]*?mode: ([^\r\n]+)/g)].map(m => [m[1], m[2]]));
  assert.ok(CAPABILITY_MODES.includes(rows['jev-tools']));
  assert.ok(ADAPTER_MODES.includes(rows['jev-adapter']));
  assert.equal(rows['jev-tools'], 'advisory');
  assert.equal(rows['jev-adapter'], 'shadow');
});
