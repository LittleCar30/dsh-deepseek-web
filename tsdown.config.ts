/**
 * Standalone client bundle build for the dsh-deepseek-web-littlecar30 plugin.
 * The client entry imports only React at runtime; dsh services are type-only
 * imports supplied by the desktop host. Keeping this config self-contained
 * lets the plugin rebuild after the upstream dsh source checkout is removed.
 */
import { fileURLToPath } from 'node:url'

const ID = 'dsh-deepseek-web-littlecar30'
const externals = new Set<string>(['react', 'react/jsx-runtime'])

export default {
  name: `${ID}/client`,
  entry: { client: fileURLToPath(new URL('./src/client/index.ts', import.meta.url)) },
  outDir: fileURLToPath(new URL('./lib/', import.meta.url)),
  format: 'cjs',
  platform: 'browser',
  dts: false,
  sourcemap: true,
  clean: false,
  deps: {
    neverBundle: (specifier: string): boolean => externals.has(specifier),
    alwaysBundle: (specifier: string): boolean => !externals.has(specifier),
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}
