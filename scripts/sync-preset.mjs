/** The old generator would reinstall preset-coupled plugins and overwrite customizations. */
console.error('Preset regeneration is retired. Existing presets and their MCP configuration are preserved.');
console.error('Use node scripts/migrate-independent-plugins.mjs --check to inspect the independent-plugin migration.');
process.exitCode = 1;
