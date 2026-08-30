import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { test } from 'node:test';

import { resolveLinuxSandbox } from '../lib/linux-sandbox.js';

test('launcher reports its package version without loading a platform binary', () => {
  const output = execFileSync(
    process.execPath,
    [resolve(import.meta.dirname, '../bin/dagent-desktop.js'), '--version'],
    {
      encoding: 'utf8',
    },
  );
  assert.equal(output, '0.9.5\n');
});

test('Linux sandbox selection never falls back to no-sandbox', () => {
  assert.deepEqual(
    resolveLinuxSandbox({
      helperPath: '/opt/dagent/chrome-sandbox',
      helperIsRootSetuid: true,
      userNamespacesRestricted: true,
    }),
    { ok: true, arguments: [] },
  );
  assert.deepEqual(
    resolveLinuxSandbox({
      helperPath: '/opt/dagent/chrome-sandbox',
      helperIsRootSetuid: false,
      userNamespacesRestricted: false,
    }),
    { ok: true, arguments: ['--disable-setuid-sandbox'] },
  );
  const blocked = resolveLinuxSandbox({
    helperPath: '/opt/dagent/chrome-sandbox',
    helperIsRootSetuid: false,
    userNamespacesRestricted: true,
  });
  assert.equal(blocked.ok, false);
  assert.match(blocked.message, /will not fall back to --no-sandbox/u);
});
