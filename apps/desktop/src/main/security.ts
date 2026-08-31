import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';

import { app, protocol, session, type BrowserWindow } from 'electron';

export function registerPrivilegedScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'app',
      privileges: { standard: true, secure: true, supportFetchAPI: false, corsEnabled: false },
    },
  ]);
}

export function registerAppProtocol(rendererRoot: string): void {
  const root = resolve(rendererRoot);
  protocol.handle('app', async (request) => {
    const url = new URL(request.url);
    if (url.hostname !== 'dagent') return new Response('Not found.', { status: 404 });
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    const target = resolve(root, relative);
    if (target !== root && !target.startsWith(`${root}${sep}`)) {
      return new Response('Not found.', { status: 404 });
    }
    try {
      return new Response(await readFile(target), {
        headers: {
          'content-type': contentType(target),
          'cache-control': app.isPackaged ? 'public, max-age=31536000, immutable' : 'no-store',
          'x-content-type-options': 'nosniff',
        },
      });
    } catch {
      return new Response('Not found.', { status: 404 });
    }
  });
}

export function trustedRendererUrl(value: string): boolean {
  if (app.isPackaged) {
    const url = new URL(value);
    return url.protocol === 'app:' && url.hostname === 'dagent';
  }
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL === undefined) return false;
  return new URL(value).origin === new URL(MAIN_WINDOW_VITE_DEV_SERVER_URL).origin;
}

export function hardenWindow(window: BrowserWindow): void {
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (!trustedRendererUrl(url)) event.preventDefault();
  });
  window.webContents.on('will-frame-navigate', (event) => {
    if (
      !event.isMainFrame &&
      event.url !== 'about:blank' &&
      event.url !== 'about:srcdoc' &&
      !event.url.startsWith('blob:')
    ) {
      event.preventDefault();
    }
  });
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
}

export function hardenDefaultSession(): void {
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  );
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const allowed =
      trustedRendererUrl(details.url) ||
      details.url.startsWith('data:') ||
      details.url.startsWith('blob:') ||
      details.url === 'about:blank' ||
      details.url === 'about:srcdoc' ||
      (!app.isPackaged &&
        MAIN_WINDOW_VITE_DEV_SERVER_URL !== undefined &&
        details.url.startsWith(MAIN_WINDOW_VITE_DEV_SERVER_URL.replace(/^http/u, 'ws')));
    callback({ cancel: !allowed });
  });
}

function contentType(path: string): string {
  switch (extname(path)) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
      return 'text/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    case '.png':
      return 'image/png';
    case '.woff2':
      return 'font/woff2';
    default:
      return 'application/octet-stream';
  }
}
