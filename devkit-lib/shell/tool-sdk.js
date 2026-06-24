#!/usr/bin/env node
/**
 * devkit Tool SDK
 *
 * Standardized hooks for building devkit tools.
 * Every tool should use defineTool() — the shell auto-discovers any .js file
 * in the tools/ directory that exports a valid tool definition.
 *
 * Usage:
 *
 *   import { defineTool } from '../tool-sdk.js';
 *
 *   const tool = defineTool({
 *     manifest: {
 *       name: 'mytool',              // unique lowercase ID
 *       label: '🛠  My Tool',         // display name with emoji
 *       hint: 'does awesome stuff',   // one-line description
 *     },
 *     commands: [
 *       { name: 'cmd1', desc: 'First command' },
 *     ],
 *     execute(cmd) { ... },           // required — called from devkit context
 *     main() { ... },                 // optional — full clack-powered menu
 *     followLogs(a, b) { ... },       // optional — interactive stream mode
 *     onEnter() { ... },              // optional — called when entering context
 *     onExit() { ... },               // optional — called when leaving context
 *   });
 *
 *   export const { manifest, commands, execute, main, followLogs, onEnter, onExit } = tool;
 */

export function defineTool(config) {
  if (!config || typeof config !== 'object') {
    throw new Error('defineTool() requires a config object');
  }
  if (!config.manifest || !config.manifest.name) {
    throw new Error('Tool must have a manifest with a name (e.g. { name: "mytool" })');
  }
  if (!config.commands || !Array.isArray(config.commands)) {
    throw new Error(`Tool "${config.manifest.name}" must export a commands array`);
  }
  if (typeof config.execute !== 'function') {
    throw new Error(`Tool "${config.manifest.name}" must export an execute() function`);
  }

  return {
    manifest: { ...config.manifest },
    commands: [...config.commands],
    execute: config.execute,
    main: typeof config.main === 'function' ? config.main : null,
    followLogs: typeof config.followLogs === 'function' ? config.followLogs : null,
    onEnter: typeof config.onEnter === 'function' ? config.onEnter : null,
    onExit: typeof config.onExit === 'function' ? config.onExit : null,
  };
}
