#!/usr/bin/env node
/**
 * devkit vpn — Interactive VPN connection manager (clack-powered)
 */
import { defineTool } from '../tool-sdk.js';
import { inlineSelect, inlineText, _appendOutput, _startWorking, _stopWorking } from '../inline.js';
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
    _appendOutput(chalk.red('  OpenVPN not found. Install: brew install openvpn'));
    return;
  }

  const configs = findConfigs();
  if (configs.length === 0) {
    const manual = await inlineSelect('No .ovpn files found. Add one manually?', [
      { value: 'yes', label: 'Yes, browse for file' },
      { value: 'no', label: 'Cancel' },
    ]);
    if (manual !== 'yes') return;
    const fpath = await inlineText('Path to .ovpn file:');
    if (!fpath) return;
    if (!fs.existsSync(fpath)) { _appendOutput(chalk.red('  File not found')); return; }
    configs.push(fpath);
  }

  const options = configs.map(c => ({
    value: c,
    label: path.basename(c, '.ovpn'),
    hint: path.dirname(c).replace(os.homedir(), '~'),
  }));

  const selected = await inlineSelect('Select VPN config:', options);
  if (!selected) return;

  if (isConnected()) {
    const disc = await inlineSelect('Already connected. Disconnect first?', [
      { value: 'yes', label: 'Yes, disconnect and reconnect' },
      { value: 'no', label: 'Cancel' },
    ]);
    if (disc !== 'yes') { _appendOutput(chalk.dim('  ── cancelled ──')); return; }
    await disconnect();
    await new Promise(r => setTimeout(r, 1000));
  }

  // Check if config has auth-user-pass — prompt for creds before launching
  const configText = fs.readFileSync(selected, 'utf-8');
  // Match "auth-user-pass" with or without a file path
  const authMatch = configText.match(/^auth-user-pass\s*(.*)$/m);
  let authFile = null;
  if (authMatch) {
    const existingFile = authMatch[1]?.trim();
    // If config points to a file that doesn't exist, we need to create it
    if (existingFile && fs.existsSync(existingFile)) {
      authFile = existingFile; // use the existing file
    } else {
      const username = await inlineText('VPN Username:');
      if (!username) return;
      const password = await inlineText('VPN Password:');
      if (!password) return;
      const otp = await inlineText('OTP / 2FA code (leave empty if none):', '');
      if (otp === null) return;
      authFile = path.join(os.homedir(), '.devkit', 'vpn', '.auth-tmp');
      fs.mkdirSync(path.dirname(authFile), { recursive: true });
      const authPass = otp ? `${password}${otp}` : password;
      fs.writeFileSync(authFile, `${username}\n${authPass}\n`);
    }
  }

  // Warn about sudo prompt — it writes directly to the terminal
  _appendOutput(chalk.yellow('  🔐  macOS admin password required — type it in the terminal below:'));
  _startWorking('Waiting for sudo authentication...');

  try {
    fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });
    const args = [ovpn];
    if (authFile) args.push('--auth-user-pass', authFile);
    args.push('--config', selected, '--log', LOG_FILE, '--daemon', '--writepid', PID_FILE);
    // 120s to type sudo password + possible retries
    execFileSync('sudo', args, { timeout: 120000 });
    _stopWorking();
    _appendOutput(chalk.green(`  ✅  VPN Connected — ${path.basename(selected)}`));
  } catch (e) {
    _stopWorking();
    const msg = e.message || '';
    if (msg.includes('ETIMEDOUT')) {
      _appendOutput(chalk.yellow('  Timed out — sudo password took too long. Try again.'));
    } else {
      _appendOutput(chalk.red(`  Connection failed: ${msg}`));
    }
  } finally {
    if (authFile && authFile.includes('.auth-tmp')) {
      try { fs.unlinkSync(authFile); } catch {}
    }
  }
}

async function disconnect() {
  if (!fs.existsSync(PID_FILE)) {
    _appendOutput(chalk.dim('  No active connection'));
    return;
  }

  _startWorking('Disconnecting VPN...');

  try {
    const pid = fs.readFileSync(PID_FILE, 'utf-8').trim();
    try { process.kill(parseInt(pid, 10), 'SIGTERM'); } catch {}
    fs.unlinkSync(PID_FILE);
    try { execSync('sudo pkill openvpn 2>/dev/null', { stdio: 'ignore' }); } catch {}
    _stopWorking();
    _appendOutput(chalk.green('  ✅  Disconnected'));
  } catch (e) {
    _stopWorking();
    _appendOutput(chalk.red(`  Error: ${e.message}`));
  }
}

const tool = defineTool({
  manifest: { name: 'vpn', label: '🔒  VPN Manager', hint: 'connect, disconnect, manage configs', keywords: ['tunnel', 'wireguard', 'openvpn', 'tailscale', 'zerotier', 'cisco', 'anyconnect', 'proxy'] },
  commands,
  execute,
});
export { commands, execute };
export const manifest = tool.manifest;
