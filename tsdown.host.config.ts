/**
 * Host bundle for the dsh-deepseek-web plugin: compiles src/index.ts into a
 * plain Node ESM file (lib/index.js) so an installed package needs no TS
 * runtime. Mirrors the workspace host build contract (tsdown, ESM, node,
 * es2024); everything the running dsh host provides (@deepseek-ai/*, which
 * must resolve to the host's own module instances) plus playwright-core
 * (declared as a real dependency) stays external.
 */
import { fileURLToPath } from 'node:url'

const EXTERNAL = (specifier: string): boolean =>
  specifier.startsWith('@deepseek-ai/') || specifier === 'playwright-core'

export default {
  name: 'dsh-deepseek-web/host',
  entry: { index: fileURLToPath(new URL('./src/index.ts', import.meta.url)) },
  outDir: fileURLToPath(new URL('./lib/', import.meta.url)),
  format: 'esm',
  platform: 'node',
  target: 'es2024',
  dts: false,
  sourcemap: true,
  clean: false,
  deps: {
    neverBundle: EXTERNAL,
    alwaysBundle: (specifier: string): boolean => !EXTERNAL(specifier),
  },
  outputOptions: {
    entryFileNames: 'index.js',
  },
}
