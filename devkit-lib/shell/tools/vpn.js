#!/usr/bin/env node
/**
 * devkit vpn — Interactive VPN connection manager (clack-powered)
 */
import { defineTool } from '../tool-sdk.js';
import { intro, outro, select, spinner, text, confirm, isCancel, cancel, note } from '@clack/prompts';
import chalk from 'chalk';
import { execFileSync, execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';

// ─── Constants ────────────────────────────────────────────

const commands = [
  { name: 'connect',    desc: 'Connect VPN' },
  { name: 'disconnect', desc: 'Disconnect VPN' },
  { name: 'status',     desc: 'Check connection status' },
  { name: 'configs',    desc: 'Manage VPN configs' },
];

async function execute(cmd) {
  switch (cmd) {
    case 'connect': {
      await connect();
      return [chalk.dim('  ── done ──')];
    }
    case 'disconnect': {
      await disconnect();
      return [chalk.dim('  ── done ──')];
    }
    case 'status': {
      if (isConnected()) {
        const pid = fs.readFileSync(PID_FILE, 'utf-8').trim();
        const out = [chalk.green(`  ✅  Connected (PID: ${pid})`)];
        if (fs.existsSync(LOG_FILE)) {
          const logs = fs.readFileSync(LOG_FILE, 'utf-8').trim().split('\n').slice(-3).join('\n');
          if (logs) out.push(chalk.dim(`  Recent log:`), ...logs.split('\n').map(l => `  ${l}`));
        }
        try {
          const ip = execSync('curl -s --max-time 3 ifconfig.me 2>/dev/null', { encoding: 'utf-8' }).trim();
          if (ip) out.push(chalk.dim(`  Public IP: ${ip}`));
        } catch {}
        return out;
      }
      return [chalk.yellow('  ⛔  Not connected')];
    }
    case 'configs': {
      fs.mkdirSync(CFG_DIR, { recursive: true });
      const files = fs.existsSync(CFG_DIR) ? fs.readdirSync(CFG_DIR).filter(f => f.endsWith('.ovpn')) : [];
      if (files.length === 0) return ['  No configs in ~/.devkit/vpn/configs/'];
      const lines = files.map((f, i) => `  ${i + 1}. ${f}`);
      return [chalk.bold('  VPN configs:'), chalk.dim(`  Directory: ${CFG_DIR}`), '', ...lines];
    }
    default:
      return [chalk.yellow(`  Unknown VPN command: "${cmd}"`)];
  }
}

const PID_FILE = path.join(os.homedir(), '.devkit', 'vpn', 'active.pid');
const LOG_FILE = path.join(os.homedir(), '.devkit', 'vpn', 'openvpn.log');
const CFG_DIR = path.join(os.homedir(), '.devkit', 'vpn', 'configs');

function findOpenvpn() {
  const paths = ['openvpn', '/usr/local/sbin/openvpn', '/opt/homebrew/sbin/openvpn'];
  for (const p of paths) {
    try { execFileSync('which', [p], { encoding: 'utf-8' }); return p; }
    catch { continue; }
  }
  return null;
}

function findConfigs() {
  const configs = [];
  // Check devkit config dir
  if (fs.existsSync(CFG_DIR)) {
    for (const f of fs.readdirSync(CFG_DIR)) {
      if (f.endsWith('.ovpn')) configs.push(path.join(CFG_DIR, f));
    }
  }
  // Scan home directory
  try {
    const result = execSync(`find "${os.homedir()}" -maxdepth 4 -name "*.ovpn" -not -path "*/.*" 2>/dev/null`, { encoding: 'utf-8' });
    for (const f of result.trim().split('\n').filter(Boolean)) {
      if (!configs.includes(f)) configs.push(f);
    }
  } catch {}
  return configs;
}

function isConnected() {
  if (!fs.existsSync(PID_FILE)) return false;
  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10);
    process.kill(pid, 0);
    return true;
  } catch { return false; }
}

async function connect() {
  const ovpn = findOpenvpn();
  if (!ovpn) {
    cancel('OpenVPN not found. Install: brew install openvpn');
    return;
  }

  const configs = findConfigs();
  if (configs.length === 0) {
    const manual = await confirm({ message: 'No .ovpn files found. Add one manually?', initialValue: false });
    if (isCancel(manual) || !manual) return;
    const fpath = await text({ message: 'Path to .ovpn file:', validate: v => v ? undefined : 'Required' });
    if (isCancel(fpath)) return;
    if (!fs.existsSync(fpath)) { cancel('File not found'); return; }
    configs.push(fpath);
  }

  const options = configs.map(c => ({
    value: c,
    label: path.basename(c, '.ovpn'),
    hint: path.dirname(c).replace(os.homedir(), '~'),
  }));
  options.push({ value: '__back', label: '←  Back' });

  const selected = await select({ message: 'Select VPN config:', options });
  if (isCancel(selected) || selected === '__back') return;

  if (isConnected()) {
    const disc = await confirm({ message: 'Already connected. Disconnect first?', initialValue: true });
    if (isCancel(disc) || !disc) { cancel('Cancelled'); return; }
    await disconnect();
    await new Promise(r => setTimeout(r, 1000));
  }

  const sp = spinner();
  sp.start('Connecting...');

  try {
    fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });
    execFileSync('sudo', [ovpn, '--config', selected, '--log', LOG_FILE, '--daemon', '--writepid', PID_FILE], { timeout: 10000 });
    sp.stop('Connected!');
    note(`Config: ${path.basename(selected)}`, '✅  VPN Connected');
  } catch (e) {
    sp.stop('Failed');
    cancel(`Connection failed: ${e.message}`);
  }
}

async function disconnect() {
  if (!fs.existsSync(PID_FILE)) {
    note('No active connection.', 'Disconnect');
    return;
  }

  const sp = spinner();
  sp.start('Disconnecting...');

  try {
    const pid = fs.readFileSync(PID_FILE, 'utf-8').trim();
    try { process.kill(parseInt(pid, 10), 'SIGTERM'); } catch {}
    fs.unlinkSync(PID_FILE);
    try { execSync('sudo pkill openvpn 2>/dev/null', { stdio: 'ignore' }); } catch {}
    sp.stop('Disconnected');
  } catch (e) {
    sp.stop('Error');
    cancel(`Error: ${e.message}`);
  }
}

async function status() {
  if (isConnected()) {
    const pid = fs.readFileSync(PID_FILE, 'utf-8').trim();
    note(`PID: ${pid}`, '✅  Connected');

    if (fs.existsSync(LOG_FILE)) {
      const logs = fs.readFileSync(LOG_FILE, 'utf-8').trim().split('\n').slice(-3).join('\n');
      if (logs) note(logs, 'Recent log');
    }

    try {
      const ip = execSync('curl -s --max-time 3 ifconfig.me 2>/dev/null', { encoding: 'utf-8' }).trim();
      if (ip) note(ip, 'Public IP');
    } catch {}
  } else {
    note('Use option 1 to connect.', '⛔  Not connected');
  }
}

async function manageConfigs() {
  fs.mkdirSync(CFG_DIR, { recursive: true });

  const action = await select({
    message: 'Config management:',
    options: [
      { value: 'list', label: '📋  List configs' },
      { value: 'import', label: '📥  Import .ovpn file' },
      { value: 'remove', label: '🗑️  Remove config' },
      { value: '__back', label: '←  Back' },
    ],
  });

  if (isCancel(action) || action === '__back') return;

  if (action === 'list') {
    const files = fs.existsSync(CFG_DIR) ? fs.readdirSync(CFG_DIR).filter(f => f.endsWith('.ovpn')) : [];
    if (files.length === 0) note('No configs in ~/.devkit/vpn/configs/', 'Configs');
    else note(files.join('\n'), `📋  ${files.length} config(s)`);
  }

  if (action === 'import') {
    const fpath = await text({ message: 'Path to .ovpn file:', validate: v => v ? undefined : 'Required' });
    if (isCancel(fpath)) return;
    if (!fs.existsSync(fpath)) { cancel('File not found'); return; }
    fs.mkdirSync(CFG_DIR, { recursive: true });
    fs.copyFileSync(fpath, path.join(CFG_DIR, path.basename(fpath)));
    note('', `✅  Imported ${path.basename(fpath)}`);
  }

  if (action === 'remove') {
    const files = fs.existsSync(CFG_DIR) ? fs.readdirSync(CFG_DIR).filter(f => f.endsWith('.ovpn')) : [];
    if (files.length === 0) { note('No configs to remove.', 'Remove'); return; }
    const target = await select({
      message: 'Select config to remove:',
      options: [
        ...files.map(f => ({ value: f, label: f })),
        { value: '__back', label: '←  Back' },
      ],
    });
    if (isCancel(target) || target === '__back') return;
    fs.unlinkSync(path.join(CFG_DIR, target));
    note('', `🗑️  Removed ${target}`);
  }
}

async function main() {
  intro(chalk.bold('devkit vpn — VPN Connection Manager'));

  while (true) {
    const action = await select({
      message: 'Choose an action:',
      options: [
        { value: 'connect',    label: '🔗  Connect VPN',      hint: 'scan & connect' },
        { value: 'disconnect', label: '🔌  Disconnect',       hint: isConnected() ? 'active' : 'inactive' },
        { value: 'status',     label: '📊  Connection status', hint: '' },
        { value: 'configs',    label: '⚙️  Manage configs',   hint: 'import/remove .ovpn' },
        { value: '__back',     label: '←  Back to devkit',    hint: '' },
      ],
    });

    if (isCancel(action) || action === '__back') break;

    switch (action) {
      case 'connect': await connect(); break;
      case 'disconnect': await disconnect(); break;
      case 'status': await status(); break;
      case 'configs': await manageConfigs(); break;
    }
  }

  outro('VPN done');
}

const tool = defineTool({
  manifest: { name: 'vpn', label: '🔒  VPN Manager', hint: 'connect, disconnect, manage configs' },
  commands,
  execute,
  main,
});
export { commands, execute, main };
export const manifest = tool.manifest;
