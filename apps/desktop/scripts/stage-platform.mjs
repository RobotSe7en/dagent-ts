import { access, cp, mkdir, readdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const platform = process.argv[2] ?? process.platform;
const architecture = process.argv[3] ?? process.arch;
const supported = new Set([
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64',
  'linux-x64',
  'win32-arm64',
  'win32-x64',
]);
const target = `${platform}-${architecture}`;
if (!supported.has(target)) throw new Error(`Unsupported desktop target '${target}'.`);

const desktopRoot = resolve(import.meta.dirname, '..');
const workspaceRoot = resolve(desktopRoot, '../..');
const outputRoot = resolve(desktopRoot, 'out');
const candidates = (await readdir(outputRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory() && entry.name.endsWith(`-${platform}-${architecture}`))
  .map((entry) => resolve(outputRoot, entry.name));
const source = candidates[0];
if (source === undefined) throw new Error(`No Electron package was found for '${target}'.`);

const destination = resolve(workspaceRoot, `packages/desktop-${target}/dist`);
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
await cp(source, destination, { recursive: true, force: true });

const executable =
  platform === 'darwin'
    ? resolve(destination, 'DagentWork.app/Contents/MacOS/DagentWork')
    : resolve(destination, platform === 'win32' ? 'DagentWork.exe' : 'DagentWork');
await access(executable);
process.stdout.write(`Staged ${target} at ${destination}\n`);
