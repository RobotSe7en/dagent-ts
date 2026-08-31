import type { ForgeConfig } from '@electron-forge/shared-types';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';

const config: ForgeConfig = {
  packagerConfig: {
    asar: { unpack: '**/*.node' },
    extraResource: [
      '../../node_modules/better-sqlite3/prebuilds',
      '../../packages/sdk/resources/profiles',
    ],
    executableName: 'DagentWork',
    appBundleId: 'ai.dagent.desktop',
    appCategoryType: 'public.app-category.developer-tools',
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      platforms: ['win32'],
      config: { name: 'dagent_work', setupExe: 'DagentWork-Setup.exe' },
    },
    {
      name: '@electron-forge/maker-dmg',
      platforms: ['darwin'],
      config: { name: 'DagentWork' },
    },
    {
      name: '@electron-forge/maker-deb',
      platforms: ['linux'],
      config: {
        options: {
          name: 'dagent-desktop',
          bin: 'DagentWork',
          productName: 'DagentWork',
          categories: ['Utility', 'Development'],
        },
      },
    },
    {
      name: '@reforged/maker-appimage',
      platforms: ['linux'],
      config: { options: { bin: 'DagentWork', categories: ['Utility', 'Development'] } },
    },
  ],
  plugins: [
    {
      name: '@electron-forge/plugin-vite',
      config: {
        build: [
          { entry: 'src/main/index.ts', config: 'vite.main.config.ts', target: 'main' },
          { entry: 'src/preload/index.ts', config: 'vite.preload.config.ts', target: 'preload' },
        ],
        renderer: [{ name: 'main_window', config: 'vite.renderer.config.ts' }],
      },
    },
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
