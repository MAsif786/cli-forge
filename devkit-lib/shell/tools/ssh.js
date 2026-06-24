#!/usr/bin/env node
/**
 * devkit ssh — SSH Connection Manager
 * Parse ~/.ssh/config, connect to hosts, manage config entries.
 */
import { defineTool } from '../tool-sdk.js';
import { inlineSelect, inlineText } from '../inline.js';
import { intro, outro, select, spinner, text, confirm, isCancel, note } from '@clack/prompts';
import chalk from 'chalk';
import { execFileSync, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ─── Constants ────────────────────────────────────────────

const SSH_CONFIG = path.join(os.homedir(), '.ssh', 'config');
const SSH_DIR = path.dirname(SSH_CONFIG);
const DEVKIT_SSH_DIR = path.join(os.homedir(), '.devkit', 'ssh');
const BOOKMARKS_FILE = path.join(DEVKIT_SSH_DIR, 'bookmarks.json');

const commands = [
  { name: 'list',    desc: 'List all hosts from SSH config' },
  { name: 'connect', desc: 'Connect to a host via SSH' },
  { name: 'add',     desc: 'Add a new SSH config entry' },
  { name: 'remove',  desc: 'Remove an SSH config entry' },
  { name: 'key',     desc: 'Show SSH key info' },
  { name: 'copy',    desc: 'Copy SSH public key to clipboard' },
];

// ─── Helpers ──────────────────────────────────────────────

function ensureDir(dir) { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); }

function parseSSHConfig() {
  if (!fs.existsSync(SSH_CONFIG)) return [];
  const content = fs.readFileSync(SSH_CONFIG, 'utf-8');
  const blocks = [];
  let current = null;

  for (const line of content.split('\n')) {
    // Skip comments and empty
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const parts = trimmed.split(/\s+/);
    const key = parts[0].toLowerCase();
    const val = parts.slice(1).join(' ');

    if (key === 'host' || key === 'match') {
      if (current) blocks.push(current);
      current = { directive: key, pattern: val, hostName: '', user: '', port: 22, identityFile: '', opts: [] };
    } else if (current) {
      if (key === 'hostname') current.hostName = val;
      else if (key === 'user') current.user = val;
      else if (key === 'port') current.port = parseInt(val, 10) || 22;
      else if (key === 'identityfile') current.identityFile = val.replace(/~/, os.homedir());
      else current.opts.push(trimmed);
    }
  }
  if (current) blocks.push(current);

  // Resolve user
  const currentUser = os.userInfo().username;
  for (const b of blocks) { if (!b.user) b.user = currentUser; }

  return blocks;
}

function getHostList() {
  const blocks = parseSSHConfig();
  // Return only Host entries (not Match), filter wildcards
  return blocks.filter(b => b.directive === 'host' && !b.pattern.includes('*') && !b.pattern.includes('?'));
}

function readBookmarks() {
  try {
    if (fs.existsSync(BOOKMARKS_FILE)) {
      return JSON.parse(fs.readFileSync(BOOKMARKS_FILE, 'utf-8'));
    }
  } catch {}
  return [];
}

function writeBookmarks(bookmarks) {
  ensureDir(DEVKIT_SSH_DIR);
  fs.writeFileSync(BOOKMARKS_FILE, JSON.stringify(bookmarks, null, 2) + '\n');
}

function getSSHKeyFingerprint(keyPath) {
  try {
    const out = execFileSync('ssh-keygen', ['-lf', keyPath], { encoding: 'utf-8', timeout: 5000 });
    return out.trim();
  } catch { return null; }
}

function getDefaultKeys() {
  const keys = [
    path.join(SSH_DIR, 'id_ed25519.pub'),
    path.join(SSH_DIR, 'id_rsa.pub'),
    path.join(SSH_DIR, 'id_ecdsa.pub'),
  ];
  return keys.filter(k => fs.existsSync(k));
}

function sshEscapeArg(str) {
  // Simple shell escaping for SSH arguments
  return `'${str.replace(/'/g, "'\\''")}'`;
}

// ─── Execute ──────────────────────────────────────────────

async function execute(cmd) {
  const parts = cmd.trim().split(/\s+/);
  const name = parts[0];
  const arg = parts.slice(1).join(' ');

  switch (name) {
    case 'list': {
      const hosts = getHostList();
      if (hosts.length === 0) return [chalk.yellow('  No hosts found in ~/.ssh/config')];
      const lines = [chalk.bold(`  ${hosts.length} host(s) in SSH config:`)];
      lines.push(chalk.dim('  ───────────────────────────────────────────────'));
      for (const h of hosts) {
        const dest = h.hostName || h.pattern;
        const portStr = h.port !== 22 ? `:${h.port}` : '';
        const userStr = h.user ? `${h.user}@` : '';
        lines.push(`  ${chalk.green(h.pattern.padEnd(22))} ${chalk.dim(`${userStr}${dest}${portStr}`)}`);
      }
      return lines;
    }

    case 'connect': {
      const hosts = getHostList();
      if (hosts.length === 0) return [chalk.yellow('  No hosts configured. Use "add" to create one.')];

      let host;
      if (arg) {
        host = hosts.find(h => h.pattern === arg);
        if (!host) return [chalk.yellow(`  Host "${arg}" not found in SSH config`)];
      } else {
        const options = hosts.map(h => ({
          value: h.pattern,
          label: h.pattern,
          hint: h.hostName ? `${h.user}@${h.hostName}${h.port !== 22 ? `:${h.port}` : ''}` : '',
        }));
        options.push({ value: '__cancel', label: 'Cancel' });
        const sel = await inlineSelect('Select host to connect:', options);
        if (!sel) return ['  Cancelled'];
        host = hosts.find(h => h.pattern === sel);
      }

      const connStr = host.hostName
        ? `${host.user}@${host.hostName}${host.port !== 22 ? ` -p ${host.port}` : ''}`
        : host.pattern;

      const identity = host.identityFile ? ` -i ${sshEscapeArg(host.identityFile)}` : '';

      // Exit raw mode so SSH gets a proper TTY
      const wasRaw = process.stdin.isRaw;
      if (wasRaw) { process.stdin.setRawMode(false); process.stdout.write('\x1b[?25h\n'); }

      try {
        execSync(`ssh ${identity} ${sshEscapeArg(host.pattern)}`, { stdio: 'inherit' });
      } catch {
        // SSH returns non-zero on normal exit too
      }

      // Re-enter raw mode
      if (wasRaw) { process.stdin.setRawMode(true); process.stdout.write('\x1b[?25l'); }

      return [chalk.dim(`  ── SSH session ended for ${host.pattern} ──`)];
    }

    case 'add': {
      const hostname = await inlineText('Host alias (e.g. myserver):');
      if (!hostname) return ['  Cancelled'];

      const hostName = await inlineText('Hostname / IP:');
      if (!hostName) return ['  Cancelled'];

      const user = await inlineText('User:', os.userInfo().username);
      if (!user) return ['  Cancelled'];

      const port = await inlineText('Port:', '22');
      if (!port) return ['  Cancelled'];

      const identityFile = await inlineText('Identity file path (optional):', '');
      if (identityFile === null) return ['  Cancelled'];

      // Build the config entry
      let entry = `\nHost ${hostname}\n  HostName ${hostName}\n  User ${user}\n  Port ${port}\n`;
      if (identityFile) entry += `  IdentityFile ${identityFile}\n`;

      // Append to SSH config
      ensureDir(SSH_DIR);
      fs.appendFileSync(SSH_CONFIG, entry);

      return [
        chalk.green(`  ✅  Host "${hostname}" added to ~/.ssh/config`),
        chalk.dim(`  ── connect with: ssh ${hostname} ──`),
      ];
    }

    case 'remove': {
      const hosts = getHostList();
      if (hosts.length === 0) return [chalk.yellow('  No hosts configured')];

      let target;
      if (arg) {
        target = hosts.find(h => h.pattern === arg);
        if (!target) return [chalk.yellow(`  Host "${arg}" not found`)];
      } else {
        const options = hosts.map(h => ({ value: h.pattern, label: h.pattern }));
        const sel = await inlineSelect('Select host to remove:', options);
        if (!sel) return ['  Cancelled'];
        target = hosts.find(h => h.pattern === sel);
      }

      if (!fs.existsSync(SSH_CONFIG)) return [chalk.yellow('  SSH config not found')];
      const ok = await inlineSelect(`Remove host "${target.pattern}" from SSH config?`, [
        { value: 'yes', label: 'Yes, remove' },
        { value: 'no', label: 'Cancel' },
      ]);
      if (ok !== 'yes') return ['  Cancelled'];

      // Read config, remove the matching block
      const content = fs.readFileSync(SSH_CONFIG, 'utf-8');
      const lines = content.split('\n');
      const result = [];
      let skip = false;
      let found = false;

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.toLowerCase().startsWith('host ') && trimmed.split(/\s+/).slice(1).join(' ') === target.pattern) {
          skip = true;
          found = true;
          continue;
        }
        if (skip && (trimmed.toLowerCase().startsWith('host ') || trimmed.toLowerCase().startsWith('match '))) {
          skip = false;
        } else if (skip) {
          continue;
        }
        if (!skip) result.push(line);
      }

      fs.writeFileSync(SSH_CONFIG, result.join('\n') + '\n');
      return [found
        ? chalk.green(`  ✅  Host "${target.pattern}" removed from SSH config`)
        : chalk.yellow(`  Host "${target.pattern}" not found`)];
    }

    case 'key': {
      const keys = getDefaultKeys();
      if (keys.length === 0) return [chalk.yellow('  No SSH keys found in ~/.ssh/')];

      const lines = [chalk.bold('  SSH Keys:')];
      lines.push(chalk.dim('  ───────────────────────────────────────────────'));
      for (const k of keys) {
        const fp = getSSHKeyFingerprint(k);
        const privPath = k.replace(/\.pub$/, '');
        const exists = fs.existsSync(privPath);
        lines.push(`  ${exists ? chalk.green('●') : chalk.dim('○')} ${chalk.bold(path.basename(k))}:`);
        if (fp) lines.push(`     ${fp}`);
        if (!exists) lines.push(chalk.yellow('     (private key missing)'));
      }
      return lines;
    }

    case 'copy': {
      const keys = getDefaultKeys();
      if (keys.length === 0) return [chalk.yellow('  No SSH public keys found in ~/.ssh/')];

      let targetKey;
      if (keys.length === 1) {
        targetKey = keys[0];
      } else {
        const options = keys.map(k => ({ value: k, label: path.basename(k) }));
        const sel = await inlineSelect('Select key to copy:', options);
        if (!sel) return ['  Cancelled'];
        targetKey = sel;
      }

      const pubkey = fs.readFileSync(targetKey, 'utf-8').trim();
      try {
        execSync('pbcopy', { input: pubkey, stdio: ['pipe', 'ignore', 'ignore'] });
        return [chalk.green(`  ✅  ${path.basename(targetKey)} copied to clipboard`)];
      } catch {
        return [chalk.yellow('  Failed to copy — pbcopy not available')];
      }
    }

    default:
      return [chalk.yellow(`  Unknown SSH command: "${name}"`)];
  }
}

// ─── Main menu ────────────────────────────────────────────

async function main() {
  intro(chalk.bold('devkit ssh — SSH Connection Manager'));

  while (true) {
    const action = await select({
      message: 'Choose an action:',
      options: [
        { value: 'list',    label: '📋  List hosts',              hint: 'from ~/.ssh/config' },
        { value: 'connect', label: '🔗  Connect to host',         hint: 'start an SSH session' },
        { value: 'add',     label: '➕  Add SSH config entry',     hint: 'new host to ~/.ssh/config' },
        { value: 'remove',  label: '🗑  Remove SSH config entry',  hint: 'delete from config' },
        { value: '__sep',   label: '──  Keys  ──' },
        { value: 'key',     label: '🔑  Show SSH keys',           hint: 'fingerprints & status' },
        { value: 'copy',    label: '📋  Copy public key',         hint: 'to clipboard' },
        { value: '__back',  label: '←  Back to devkit',           hint: '' },
      ],
    });

    if (isCancel(action) || action === '__back') break;

    switch (action) {
      case 'list': {
        const hosts = getHostList();
        if (hosts.length === 0) { note('No hosts in ~/.ssh/config', 'SSH Config'); break; }
        const lines = hosts.map(h => {
          const dest = h.hostName || h.pattern;
          const portStr = h.port !== 22 ? `:${h.port}` : '';
          const userStr = h.user ? `${h.user}@` : '';
          return `${h.pattern.padEnd(22)} ${chalk.dim(`${userStr}${dest}${portStr}`)}`;
        }).join('\n');
        note(lines, `📋  ${hosts.length} host(s)`);
        break;
      }

      case 'connect': {
        const hosts = getHostList();
        if (hosts.length === 0) { note('No hosts configured.', 'SSH'); break; }
        const options = hosts.map(h => ({ value: h.pattern, label: h.pattern }));
        options.push({ value: '__back', label: '← Back' });
        const sel = await select({ message: 'Select host:', options });
        if (isCancel(sel) || sel === '__back') break;

        note(`Connecting to ${sel}...\n(Press Ctrl+D or type "exit" to end session)`, 'SSH');

        const wasRaw = process.stdin.isRaw;
        if (wasRaw) process.stdin.setRawMode(false);
        console.log(); // blank line before SSH takes over

        try {
          execSync(`ssh ${sshEscapeArg(sel)}`, { stdio: 'inherit' });
        } catch {}

        if (wasRaw) process.stdin.setRawMode(true);
        break;
      }

      case 'add': {
        const hostname = await text({ message: 'Host alias:', validate: v => v ? undefined : 'Required' });
        if (isCancel(hostname)) break;
        const hostName = await text({ message: 'Hostname / IP:', validate: v => v ? undefined : 'Required' });
        if (isCancel(hostName)) break;
        const user = await text({ message: 'User:', initialValue: os.userInfo().username });
        if (isCancel(user)) break;
        const port = await text({ message: 'Port:', initialValue: '22' });
        if (isCancel(port)) break;
        const idFile = await text({ message: 'Identity file (optional):', placeholder: 'skip' });
        if (isCancel(idFile)) break;

        const sp = spinner();
        sp.start('Adding to ~/.ssh/config...');
        let entry = `\nHost ${hostname}\n  HostName ${hostName}\n  User ${user}\n  Port ${port}\n`;
        if (idFile) entry += `  IdentityFile ${idFile}\n`;
        ensureDir(SSH_DIR);
        fs.appendFileSync(SSH_CONFIG, entry);
        sp.stop(`Added ${hostname}`);
        break;
      }

      case 'remove': {
        const hosts = getHostList();
        if (hosts.length === 0) { note('No hosts to remove.', 'Remove'); break; }
        const options = hosts.map(h => ({ value: h.pattern, label: h.pattern }));
        options.push({ value: '__back', label: '← Back' });
        const sel = await select({ message: 'Select host to remove:', options });
        if (isCancel(sel) || sel === '__back') break;

        const ok = await confirm({ message: `Remove "${sel}" from config?`, initialValue: false });
        if (!ok) { note('Cancelled', 'Remove'); break; }

        const content = fs.readFileSync(SSH_CONFIG, 'utf-8');
        const lines = content.split('\n');
        const result = [];
        let skip = false;
        for (const line of lines) {
          const t = line.trim();
          if (t.toLowerCase().startsWith('host ') && t.split(/\s+/).slice(1).join(' ') === sel) { skip = true; continue; }
          if (skip && (t.toLowerCase().startsWith('host ') || t.toLowerCase().startsWith('match '))) skip = false;
          if (!skip) result.push(line);
        }
        fs.writeFileSync(SSH_CONFIG, result.join('\n') + '\n');
        note('', `🗑  Removed "${sel}"`);
        break;
      }

      case 'key': {
        const keys = getDefaultKeys();
        if (keys.length === 0) { note('No SSH keys found in ~/.ssh/', 'SSH Keys'); break; }
        const lines = keys.map(k => {
          const fp = getSSHKeyFingerprint(k);
          const privPath = k.replace(/\.pub$/, '');
          const exists = fs.existsSync(privPath);
          const status = exists ? chalk.green('✓') : chalk.yellow('✗ (private missing)');
          return `${status} ${chalk.bold(path.basename(k))}\n   ${fp || 'unknown'}`;
        }).join('\n');
        note(lines, '🔑  SSH Keys');
        break;
      }

      case 'copy': {
        const keys = getDefaultKeys();
        if (keys.length === 0) { note('No public keys found', 'Copy Key'); break; }
        const target = keys.length === 1 ? keys[0] : await select({
          message: 'Select key:',
          options: keys.map(k => ({ value: k, label: path.basename(k) })),
        });
        if (isCancel(target)) break;
        const pubkey = fs.readFileSync(target, 'utf-8').trim();
        execSync('pbcopy', { input: pubkey, stdio: ['pipe', 'ignore', 'ignore'] });
        note('', `✅  ${path.basename(target)} copied`);
        break;
      }
    }
  }

  outro('SSH done');
}

// ─── Tool definition ──────────────────────────────────────

const tool = defineTool({
  manifest: { name: 'ssh', label: '🔗  SSH Manager', hint: 'connect, manage config & keys' },
  commands,
  execute,
  main,
});
export { commands, execute, main };
export const manifest = tool.manifest;
