import { chmod, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import { appConfigSchema, createApplicationRuntime, type ApplicationRuntime } from 'dagent-ai-app';
import { OpenAICompatibleProvider } from 'dagent-ai/providers/openai-compatible';
import { app, BrowserWindow, dialog } from 'electron';

import { registerDesktopIpc } from './ipc.js';
import {
  developmentSqliteNativeBinding,
  packagedSqliteNativeBinding,
  type SqliteNativeTarget,
} from './native-binding.js';
import { hardenDefaultSession, registerAppProtocol, registerPrivilegedScheme } from './security.js';
import { createMainWindow } from './window.js';

registerPrivilegedScheme();
app.enableSandbox();
app.setName('DagentWork');
app.setPath('userData', join(app.getPath('appData'), 'DagentWork Open Source'));

let runtime: ApplicationRuntime | undefined;
let removeIpc: (() => void) | undefined;
let quitting = false;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', focusMainWindow);
  void app.whenReady().then(start).catch(reportStartupFailure);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('before-quit', (event) => {
    if (runtime === undefined || quitting) return;
    event.preventDefault();
    quitting = true;
    removeIpc?.();
    removeIpc = undefined;
    void runtime.close().finally(() => {
      runtime = undefined;
      app.quit();
    });
  });
}

async function start(): Promise<void> {
  if (process.platform === 'win32') app.setAppUserModelId('ai.dagent.desktop');
  const userData = app.getPath('userData');
  await mkdir(userData, { recursive: true, mode: 0o700 });
  await chmod(userData, 0o700);
  const stateDirectory = join(userData, 'state');
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  await chmod(stateDirectory, 0o700);
  hardenDefaultSession();
  if (app.isPackaged) {
    registerAppProtocol(join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}`));
  }
  const config = appConfigSchema.parse({
    dataDirectory: stateDirectory,
    runtimeDirectory: '.runtime',
  });
  const provider = new OpenAICompatibleProvider({
    baseURL: config.provider.baseURL,
    model: config.provider.model,
    apiKeyEnv: config.provider.apiKeyEnv,
    timeoutMs: config.provider.timeoutMs,
    contextWindowTokens: config.provider.contextWindowTokens,
    outputReserveTokens: config.provider.outputReserveTokens,
    streamIncludeUsage: config.provider.streamIncludeUsage,
    extraRequestArgs: config.provider.extraRequestArgs,
    extraBody: config.provider.extraBody,
  });
  runtime = await createApplicationRuntime({
    config,
    provider,
    database: { nativeBinding: sqliteNativeBinding() },
  });
  removeIpc = registerDesktopIpc(runtime);
  const window = createMainWindow();
  if (app.isPackaged && process.argv.includes('--desktop-smoke-test')) {
    const timeout = setTimeout(() => app.exit(1), 20_000);
    window.webContents.once('did-finish-load', () => {
      clearTimeout(timeout);
      app.exit(0);
    });
    window.webContents.once('did-fail-load', () => {
      clearTimeout(timeout);
      app.exit(1);
    });
  }
}

function focusMainWindow(): void {
  const window = BrowserWindow.getAllWindows()[0];
  if (window === undefined) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

function reportStartupFailure(error: unknown): void {
  const message = error instanceof Error ? error.message : 'Unknown startup error.';
  dialog.showErrorBox(
    'DagentWork could not start',
    `${message}\n\nDesktop data: ${app.getPath('userData')}`,
  );
  app.exit(1);
}

function sqliteNativeBinding(): string {
  const glibcVersion = glibcVersionRuntime();
  const target: SqliteNativeTarget = {
    platform: process.platform,
    arch: process.arch,
    ...(glibcVersion === undefined ? {} : { glibcVersionRuntime: glibcVersion }),
  };
  if (app.isPackaged) return packagedSqliteNativeBinding(process.resourcesPath, target);
  const packageEntry = createRequire(__filename).resolve('better-sqlite3');
  return developmentSqliteNativeBinding(packageEntry, target);
}

function glibcVersionRuntime(): unknown {
  if (process.platform !== 'linux') return true;
  const report = process.report.getReport() as {
    readonly header?: { readonly glibcVersionRuntime?: unknown };
  };
  return report.header?.glibcVersionRuntime;
}
