import type { DesktopBridge } from '../shared/contracts.js';

declare global {
  interface Window {
    readonly dagentDesktop: DesktopBridge;
  }
}

export {};
