// Opt-in dependency fallback for testing a source checkout against an installed DSH.
// Run: node --import ./scripts/test-runtime-loader.mjs <test-file>
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const root = process.env.DSH_TEST_RUNTIME;
if (!root) throw new Error('DSH_TEST_RUNTIME must point to the DSH installation directory');
const parentURL = pathToFileURL(resolve(root, 'package.json')).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); }
    catch (error) {
      if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
      if (!/^(@[^/]+\/)?[^./][^/]*/u.test(specifier)) throw error;
      return nextResolve(specifier, { ...context, parentURL });
    }
  }
});
