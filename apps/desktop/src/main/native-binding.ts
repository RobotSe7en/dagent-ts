import { join } from 'node:path';

export type SqliteNativeTarget = {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly glibcVersionRuntime?: unknown;
};

export function sqlitePrebuildFilename(target: SqliteNativeTarget): string {
  if (!['darwin', 'linux', 'win32'].includes(target.platform)) {
    throw new Error(`DagentWork does not support SQLite on '${target.platform}'.`);
  }
  if (target.arch !== 'x64' && target.arch !== 'arm64') {
    throw new Error(`DagentWork does not support SQLite on '${target.arch}'.`);
  }
  const platform =
    target.platform === 'linux' && target.glibcVersionRuntime === undefined
      ? 'linuxmusl'
      : target.platform;
  return `${platform}-${target.arch}.node`;
}

export function packagedSqliteNativeBinding(
  resourcesPath: string,
  target: SqliteNativeTarget,
): string {
  return join(resourcesPath, 'prebuilds', sqlitePrebuildFilename(target));
}

export function developmentSqliteNativeBinding(
  packageEntry: string,
  target: SqliteNativeTarget,
): string {
  return join(packageEntry, '..', '..', 'prebuilds', sqlitePrebuildFilename(target));
}
