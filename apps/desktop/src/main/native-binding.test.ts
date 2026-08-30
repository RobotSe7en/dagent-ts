import { describe, expect, it } from 'vitest';

import {
  developmentSqliteNativeBinding,
  packagedSqliteNativeBinding,
  sqlitePrebuildFilename,
} from './native-binding.js';

describe('desktop SQLite native binding', () => {
  it.each([
    [{ platform: 'darwin', arch: 'arm64' }, 'darwin-arm64.node'],
    [{ platform: 'darwin', arch: 'x64' }, 'darwin-x64.node'],
    [{ platform: 'linux', arch: 'arm64', glibcVersionRuntime: '2.39' }, 'linux-arm64.node'],
    [{ platform: 'linux', arch: 'x64' }, 'linuxmusl-x64.node'],
    [{ platform: 'win32', arch: 'arm64' }, 'win32-arm64.node'],
    [{ platform: 'win32', arch: 'x64' }, 'win32-x64.node'],
  ] as const)('selects the packaged prebuild for %o', (target, expected) => {
    expect(sqlitePrebuildFilename(target)).toBe(expected);
  });

  it('resolves packaged and development paths without relying on cwd', () => {
    const target = { platform: 'linux', arch: 'x64', glibcVersionRuntime: '2.39' } as const;

    expect(packagedSqliteNativeBinding('/opt/DagentWork/resources', target)).toBe(
      '/opt/DagentWork/resources/prebuilds/linux-x64.node',
    );
    expect(
      developmentSqliteNativeBinding('/repo/node_modules/better-sqlite3/lib/index.js', target),
    ).toBe('/repo/node_modules/better-sqlite3/prebuilds/linux-x64.node');
  });

  it('rejects unsupported targets', () => {
    expect(() => sqlitePrebuildFilename({ platform: 'freebsd', arch: 'x64' })).toThrow(
      "does not support SQLite on 'freebsd'",
    );
    expect(() => sqlitePrebuildFilename({ platform: 'linux', arch: 'ia32' })).toThrow(
      "does not support SQLite on 'ia32'",
    );
  });
});
