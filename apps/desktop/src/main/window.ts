import { join } from 'node:path';

import { app, BrowserWindow } from 'electron';

import { hardenWindow } from './security.js';

export function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1024,
    minHeight: 680,
    title: 'DagentWork',
    backgroundColor: '#f4f4f2',
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 14, y: 15 } }
      : {}),
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      spellcheck: true,
    },
  });
  hardenWindow(window);
  const target =
    !app.isPackaged && MAIN_WINDOW_VITE_DEV_SERVER_URL !== undefined
      ? MAIN_WINDOW_VITE_DEV_SERVER_URL
      : 'app://dagent/index.html';
  void window.loadURL(target);
  return window;
}
