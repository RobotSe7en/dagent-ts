#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveLinuxSandbox } from '../lib/linux-sandbox.js';

const require = createRequire(import.meta.url);
const ownManifest = JSON.parse(
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../package.json'), 'utf8'),
);

if (process.argv.includes('--version') || process.argv.includes('-v')) {
  process.stdout.write(`${ownManifest.version}\n`);
  process.exit(0);
}

const packageName = platformPackage(process.platform, process.arch);
if (packageName === undefined) {
  fail(`DagentWork does not support ${process.platform}/${process.arch}.`);
}

let manifestPath;
try {
  manifestPath = require.resolve(`${packageName}/package.json`);
} catch {
  fail(
    `The optional prebuilt package ${packageName} is missing. Reinstall dagent-ai-desktop with optional dependencies enabled.`,
  );
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const executable = join(dirname(manifestPath), manifest.dagentExecutable);
const childArguments = process.argv.slice(2);
if (process.platform === 'linux') childArguments.unshift(...linuxSandboxArguments(executable));
const child = spawnSync(executable, childArguments, {
  stdio: 'inherit',
  windowsHide: false,
});
if (child.error !== undefined) fail(`Could not launch DagentWork: ${child.error.message}`);
process.exit(child.status ?? 1);

function platformPackage(platform, architecture) {
  const suffix = `${platform}-${architecture}`;
  const supported = new Set([
    'darwin-arm64',
    'darwin-x64',
    'linux-arm64',
    'linux-x64',
    'win32-arm64',
    'win32-x64',
  ]);
  return supported.has(suffix) ? `@dagent-ai/desktop-${suffix}` : undefined;
}

function linuxSandboxArguments(executable) {
  const helper = join(dirname(executable), 'chrome-sandbox');
  let helperIsRootSetuid = false;
  try {
    const metadata = statSync(helper);
    helperIsRootSetuid = metadata.uid === 0 && (metadata.mode & 0o4000) !== 0;
  } catch {
    // A missing helper can still use the kernel user-namespace sandbox.
  }
  const resolution = resolveLinuxSandbox({
    helperPath: helper,
    helperIsRootSetuid,
    userNamespacesRestricted: unprivilegedUserNamespacesAreRestricted(),
  });
  if (!resolution.ok) fail(resolution.message);
  return resolution.arguments;
}

function unprivilegedUserNamespacesAreRestricted() {
  try {
    return (
      readFileSync('/proc/sys/kernel/apparmor_restrict_unprivileged_userns', 'utf8').trim() === '1'
    );
  } catch {
    return false;
  }
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
