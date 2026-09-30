/** Host entry for a link-installed migration package under a symlink-preserving Loader. */
import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectedDirectory = dirname(fileURLToPath(import.meta.url));
const sourceDirectory = realpathSync(projectedDirectory);
const implementationUrl = pathToFileURL(resolve(sourceDirectory, '../lib/plugin.js')).href;
const plugin = await import(implementationUrl);

export const name = plugin.name;
export const inject = plugin.inject;
export const Config = plugin.Config;
export const apply = plugin.apply;
