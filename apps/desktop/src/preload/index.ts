import { contextBridge, ipcRenderer } from 'electron';

import {
  desktopInvokeChannel,
  desktopRunEventChannel,
  type DesktopBridge,
  type DesktopRequest,
  type DesktopResult,
  type DesktopRunEvent,
} from '../shared/contracts.js';

const bridge: DesktopBridge = Object.freeze({
  invoke(request: DesktopRequest): Promise<DesktopResult> {
    return ipcRenderer.invoke(desktopInvokeChannel, request) as Promise<DesktopResult>;
  },
  onRunEvent(listener: (event: DesktopRunEvent) => void): () => void {
    const handler = (_event: Electron.IpcRendererEvent, value: DesktopRunEvent): void =>
      listener(value);
    ipcRenderer.on(desktopRunEventChannel, handler);
    return () => ipcRenderer.removeListener(desktopRunEventChannel, handler);
  },
});

contextBridge.exposeInMainWorld('dagentDesktop', bridge);
