/**
 * Dev server for the visual (mock-API) specs: `npx vite --config e2e/support/vite.visual.config.ts`.
 * Same app as production; the API is answered in the browser by e2e/support/mock-api.ts.
 * While src/app/lib/{gemini,audio,image}.ts are still stubs (they throw "not implemented"), imports
 * of them are redirected to e2e/support/standins/*. Once a real module lands it is used as is.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, mergeConfig, type Plugin } from 'vite';
import base from '../../vite.config';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const MODULES = ['gemini', 'audio', 'image'] as const;

function isStub(file: string): boolean {
  try {
    return /['"]not implemented['"]/.test(readFileSync(file, 'utf8'));
  } catch {
    return false;
  }
}

function standIns(): Plugin {
  const active = new Map<string, string>();
  for (const m of MODULES) {
    const real = resolve(root, 'src/app/lib', `${m}.ts`);
    if (isStub(real)) active.set(real, resolve(here, 'standins', `${m}.ts`));
  }
  return {
    name: 'tally-visual-standins',
    enforce: 'pre',
    configResolved() {
      if (active.size) console.log(`[visual] stand-ins for stub modules: ${[...active.keys()].map((f) => f.slice(root.length + 1)).join(', ')}`);
    },
    async resolveId(source, importer) {
      if (!importer || active.size === 0 || !/(gemini|audio|image)(\.ts)?$/.test(source)) return null;
      const resolved = await this.resolve(source, importer, { skipSelf: true });
      const id = resolved?.id.split('?')[0];
      return (id && active.get(id)) ?? null;
    },
  };
}

export default mergeConfig(
  base,
  defineConfig({
    plugins: [standIns()],
    server: { port: 5174, strictPort: true, host: '127.0.0.1' },
    optimizeDeps: { include: ['preact', 'preact/hooks', 'preact/jsx-runtime', '@preact/signals', 'zod'] },
  }),
);
