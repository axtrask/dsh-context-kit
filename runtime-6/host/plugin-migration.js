/** Read-only migration planning. Session logs, editor records and indexes are never opened. */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import YAML from 'yaml';
import { readConfigFiles } from './dcp-config.js';
import { readJsonc } from './common.js';
import { Config as DcpConfig } from './dcp-plugin.js';
import { Config as ContextConfig } from './context-mode-plugin.js';
import { Config as EditorConfig } from './editor-plugin.js';

function merge(base, override) {
  const result = { ...base };
  for (const [key, value] of Object.entries(override ?? {})) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('Invalid configuration key');
    result[key] = value && typeof value === 'object' && !Array.isArray(value)
      ? merge(result[key], value) : value;
  }
  return result;
}

export function planMigration({ home, kitRoot }) {
  home = resolve(home); kitRoot = resolve(kitRoot);
  const homePath = realpathSync(home);
  const changes = [], documents = new Map(), legacy = new Map();
  const entry = file => join(kitRoot, 'lib', file).replace(/\\/g, '/');
  const owns = (name, file) => typeof name === 'string' && name.replace(/\\/g, '/') === entry(file);
  const open = (path, empty) => {
    const physical = existsSync(path) ? realpathSync(path) : join(realpathSync(dirname(path)), path.slice(dirname(path).length + 1));
    const inside = relative(homePath, physical);
    if (isAbsolute(inside) || inside === '..' || inside.startsWith('..\\') || inside.startsWith('../')) {
      throw new Error('Migration target is outside DSH_HOME: ' + path);
    }
    const before = existsSync(path) ? readFileSync(path, 'utf8') : null;
    const doc = before === null ? new YAML.Document(empty) : YAML.parseDocument(before);
    if (doc.errors.length) throw new Error('Invalid YAML: ' + path);
    documents.set(path, { before, doc, original: doc.toJS() });
    return doc;
  };
  const remember = (key, value = {}) => {
    if (legacy.has(key) && !isDeepStrictEqual(legacy.get(key), value)) {
      throw new Error('Legacy presets have different ' + key + ' settings; reconcile them before migration');
    }
    legacy.set(key, value);
  };
  for (const dir of [join(home, '.agent-presets', 'context-kit'), join(home, 'plugins', 'presets', 'context-kit')]) {
    const path = join(dir, 'agent.cordis.yml');
    if (!existsSync(path)) continue;
    const doc = open(path);
    if (!YAML.isSeq(doc.contents)) throw new Error('Expected preset rows: ' + path);
    for (const row of doc.contents.items) {
      if (owns(row.get('name'), 'context-mode.js')) remember('context-mode', row.get('config')?.toJSON());
      const children = row.get('config');
      if (!YAML.isSeq(children)) continue;
      for (let i = 0; i < children.items.length; i++) {
        const child = children.items[i];
        if (!owns(child.get('name'), 'dcp.js')) continue;
        remember('dcp', child.get('config')?.toJSON());
        if (children.items.some(sibling => sibling !== child && sibling.get('id') === 'compaction-basic')) {
          throw new Error('Ambiguous compaction providers: ' + path);
        }
        children.items[i] = doc.createNode({ id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic' });
      }
    }
    doc.contents.items = doc.contents.items.filter(row => !owns(row.get('name'), 'context-mode.js'));
  }

  const patchPath = join(home, 'profiles', 'web', 'cordis.patch.yml');
  const patch = open(patchPath, []);
  if (!YAML.isSeq(patch.contents)) throw new Error('Expected profile patch entries');
  for (const row of patch.contents.items) {
    const inserts = row.get('insert');
    if (YAML.isSeq(inserts)) inserts.items = inserts.items.filter(item => !owns(item.get('name'), 'edit-host.js'));
  }
  patch.contents.items = patch.contents.items.filter(row => !YAML.isSeq(row.get('insert')) || row.get('insert').items.length || row.has('id'));
  const additions = [];
  for (const [id, file] of [['context-kit-dcp', 'dcp-plugin.js'], ['context-kit-context-mode', 'context-mode-plugin.js'], ['context-kit-history-editor', 'editor-plugin.js']]) {
    const existing = patch.contents.items.flatMap(row => row.get('insert')?.items ?? []).find(row => row.get('id') === id);
    if (existing && !owns(existing.get('name'), file)) throw new Error('Profile entry belongs to another plugin: ' + id);
    if (!existing) additions.push({ id, name: entry(file) });
  }
  if (additions.length) {
    const row = patch.createNode({ insert: additions });
    row.commentBefore = ' Independent context plugins; configuration lives in Settings > Plugins.';
    patch.contents.add(row);
  }

  const settings = open(join(home, 'settings.yaml'), {});
  if (!YAML.isMap(settings.contents)) throw new Error('Expected settings namespaces');
  const strict = { warn: message => {
    if (!message.includes('unknown key "$schema"')) throw new Error('Cannot migrate legacy configuration: ' + message);
  } };
  const files = readConfigFiles(undefined, home, strict);
  const oldDcp = merge(legacy.get('dcp'), files.merged);
  const editor = oldDcp.editor ?? {};
  delete oldDcp.editor;
  const oldContext = merge(legacy.get('context-mode'), readJsonc(join(home, 'context-mode.jsonc')));
  for (const [namespace, schema, old] of [['dcp', DcpConfig, oldDcp], ['context-mode', ContextConfig, oldContext], ['history-editor', EditorConfig, editor]]) {
    const native = settings.get(namespace)?.toJSON() ?? {};
    const value = schema(merge(old, native));
    if (!isDeepStrictEqual(value, native)) settings.set(namespace, value);
  }
  for (const [path, { before, doc, original }] of documents) {
    if (!isDeepStrictEqual(original, doc.toJS())) changes.push({ path, before, after: doc.toString() });
  }
  return { home, changes, imported: files.sources };
}
