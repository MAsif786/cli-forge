#!/usr/bin/env node
/**
 * devkit wifi — WiFi Network Manager
 * Show connected network details, password, and available networks.
 */
import { defineTool } from '../tool-sdk.js';
import { inlineSelect, inlineText } from '../inline.js';
import { intro, outro, select, spinner, note, isCancel } from '@clack/prompts';
import chalk from 'chalk';
import { execFileSync } from 'child_process';

// ─── Constants ────────────────────────────────────────────

const commands = [
  { name: 'status',   desc: 'Show current WiFi connection details' },
  { name: 'password', desc: 'Reveal WiFi password from Keychain' },
  { name: 'scan',     desc: 'Scan available WiFi networks' },
  { name: 'info',     desc: 'Show all WiFi interface details' },
];

const AIRPORT = '/System/Library/PrivateFrameworks/Apple80211.framework/Versions/Current/Resources/airport';

// ─── Helpers ──────────────────────────────────────────────

function getWiFiDevice() {
  try {
    const out = execFileSync('networksetup', ['-listallhardwareports'], { encoding: 'utf-8' });
    const lines = out.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('Wi-Fi')) {
        const deviceMatch = lines[i + 1]?.match(/Device:\s*(.+)/);
        if (deviceMatch) return deviceMatch[1].trim();
      }
    }
  } catch {}
  return 'en0'; // fallback
}

function getCurrentSSID() {
  try {
    const device = getWiFiDevice();
    const out = execFileSync('networksetup', ['-getairportnetwork', device], { encoding: 'utf-8' });
    const match = out.match(/Current Wi-Fi Network:\s*(.+)/);
    return match ? match[1].trim() : null;
  } catch { return null; }
}

function getAirportInfo() {
  try {
    if (require('fs').existsSync(AIRPORT)) {
      return execFileSync(AIRPORT, ['-I'], { encoding: 'utf-8', timeout: 5000 });
    }
  } catch {}
  return null;
}

function parseAirport(raw) {
  const info = {};
  if (!raw) return info;
  for (const line of raw.split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    if (val) info[key] = val;
  }
  return info;
}

function getWiFiInfo() {
  try {
    const out = execFileSync('networksetup', ['-getinfo', 'Wi-Fi'], { encoding: 'utf-8' });
    const info = {};
    for (const line of out.split('\n')) {
      const idx = line.indexOf(':');
      if (idx === -1) continue;
      const key = line.slice(0, idx).trim();
      const val = line.slice(idx + 1).trim();
      if (val && key !== 'Wi-Fi ID') info[key] = val;
    }
    return info;
  } catch { return {}; }
}

function getPassword(ssid) {
  try {
    return execFileSync('security', ['find-generic-password', '-wa', ssid], {
      encoding: 'utf-8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch { return null; }
}

function scanNetworks() {
  try {
    if (require('fs').existsSync(AIRPORT)) {
      const raw = execFileSync(AIRPORT, ['-s'], { encoding: 'utf-8', timeout: 8000 });
      const lines = raw.trim().split('\n').slice(1); // skip header
      return lines.map(line => {
        const parts = line.trim().split(/\s{2,}/);
        return {
          ssid: parts[0] || '',
          bssid: parts[1] || '',
          rssi: parts[2] || '',
          channel: parts[3] || '',
          security: parts.slice(5).join(' ') || '',
        };
      }).filter(n => n.ssid);
    }
  } catch {}
  return [];
}

// ─── Formatting ──────────────────────────────────────────

function fmtKv(key, value, color = chalk.yellow) {
  return `  ${chalk.cyan('●')} ${chalk.bold(key.padEnd(18))} ${color(value)}`;
}

function fmtSection(title) {
  return ['', chalk.bold(`  ${title}`), chalk.dim('  ───────────────────────────────────────────────')];
}

// ─── Execute ──────────────────────────────────────────────

async function execute(cmd) {
  const device = getWiFiDevice();
  const ssid = getCurrentSSID();

  switch (cmd) {
    case 'status': {
      if (!ssid) return [chalk.yellow(`  Not connected to any WiFi network (device: ${device})`)];
      const info = getWiFiInfo();
      const lines = [
        ...fmtSection(`WiFi Status: ${ssid}`),
        fmtKv('SSID', ssid, chalk.green),
      ];
      if (info['IP address']) lines.push(fmtKv('IP address', info['IP address'], chalk.yellow));
      if (info['Subnet mask']) lines.push(fmtKv('Subnet mask', info['Subnet mask']));
      if (info['Router']) lines.push(fmtKv('Router', info['Router'], chalk.yellow));
      if (info['IPv6 IP address']) lines.push(fmtKv('IPv6', info['IPv6 IP address'], chalk.dim));
      if (info['DNS']) lines.push(fmtKv('DNS', info['DNS'], chalk.dim));
      if (info['Wi-Fi ID']) lines.push(fmtKv('MAC (Wi-Fi)', info['Wi-Fi ID'], chalk.dim));

      const raw = getAirportInfo();
      if (raw) {
        const ai = parseAirport(raw);
        if (ai.channel) lines.push(fmtKv('Channel', ai.channel));
        if (ai.maxRate) lines.push(fmtKv('Max rate', `${ai.maxRate} Mbps`));
        if (ai.RSSI) {
          const rssi = parseInt(ai.RSSI);
          const bars = rssi > -50 ? '▂▄▆█' : rssi > -60 ? '▂▄▆_' : rssi > -70 ? '▂▄__' : '▂___';
          lines.push(fmtKv('Signal', `${ai.RSSI} dBm  ${bars}`));
        }
        if (ai.noise) lines.push(fmtKv('Noise', `${ai.noise} dBm`, chalk.dim));
      }
      lines.push('', chalk.dim('  Use: wifi password  — to reveal the password'));
      return lines;
    }

    case 'password': {
      if (!ssid) return [chalk.yellow(`  Not connected to any WiFi network (device: ${device})`)];
      const pwd = getPassword(ssid);
      if (pwd) {
        return [
          ...fmtSection(`Password: ${ssid}`),
          `  ${chalk.cyan('🔑')}  ${chalk.bold.yellow(pwd)}`,
          '',
          chalk.dim('  (retrieved from macOS Keychain)'),
        ];
      }
      // Try to prompt for manual SSID
      const manualSSID = await inlineText('SSID (press enter for current):', ssid, [ssid]);
      if (!manualSSID) return [chalk.dim('  ── cancelled ──')];
      const manualPwd = getPassword(manualSSID);
      if (manualPwd) {
        return [
          ...fmtSection(`Password: ${manualSSID}`),
          `  ${chalk.cyan('🔑')}  ${chalk.bold.yellow(manualPwd)}`,
        ];
      }
      return [chalk.yellow(`  No password found in Keychain for "${manualSSID}"`)];
    }

    case 'scan': {
      const scanStart = Date.now();
      const networks = scanNetworks();
      const elapsed = ((Date.now() - scanStart) / 1000).toFixed(1);

      if (networks.length === 0) return [chalk.yellow('  No networks found. Ensure Wi-Fi is on.')];

      const lines = [
        ...fmtSection(`WiFi Networks (${networks.length}, scanned in ${elapsed}s)`),
      ];
      for (const n of networks.slice(0, 20)) {
        const signal = parseInt(n.rssi);
        const bar = signal > -50 ? chalk.green('▂▄▆█') : signal > -60 ? chalk.green('▂▄▆ ') : signal > -70 ? chalk.yellow('▂▄  ') : chalk.red('▂   ');
        const current = n.ssid === ssid ? chalk.cyan(' ●') : '  ';
        lines.push(`${current} ${bar} ${chalk.bold(n.ssid.padEnd(25))} ${chalk.dim(n.channel.padEnd(5))} ${n.security}`);
      }
      return lines;
    }

    case 'info': {
      const lines = [...fmtSection('WiFi Interface Details')];
      lines.push(fmtKv('Device', device));
      if (ssid) lines.push(fmtKv('Connected to', ssid, chalk.green));

      const raw = getAirportInfo();
      if (raw) {
        const ai = parseAirport(raw);
        for (const [k, v] of Object.entries(ai)) {
          lines.push(fmtKv(k, v, chalk.yellow));
        }
      } else {
        lines.push('', chalk.yellow('  airport utility not found — limited info'));
        const info = getWiFiInfo();
        for (const [k, v] of Object.entries(info)) {
          lines.push(fmtKv(k, v));
        }
      }
      return lines;
    }

    default:
      return [chalk.yellow(`  Unknown wifi command: "${cmd}"`)];
  }
}

// ─── Main menu ────────────────────────────────────────────

async function main() {
  intro(chalk.bold('devkit wifi — WiFi Network Manager'));

  while (true) {
    const ssid = getCurrentSSID();
    const statusTag = ssid ? `connected to ${ssid}` : 'not connected';

    const action = await select({
      message: `Choose an action (${statusTag}):`,
      options: [
        { value: 'status',   label: '📶  Current status',       hint: ssid || 'not connected' },
        { value: 'password', label: '🔑  Show password',        hint: ssid ? `reveal password for ${ssid}` : 'enter SSID manually' },
        { value: 'scan',     label: '📡  Scan networks',        hint: 'list nearby WiFi networks' },
        { value: 'info',     label: '📋  Full interface info',  hint: 'all details from airport -I' },
        { value: '__back',   label: '←  Back to devkit',        hint: '' },
      ],
    });

    if (isCancel(action) || action === '__back') break;

    const lines = await execute(action);
    if (lines && lines.length > 0) {
      note(lines.join('\n'), 'WiFi');
    }
  }

  outro('WiFi done');
}

// ─── Tool definition ──────────────────────────────────────

const tool = defineTool({
  manifest: { name: 'wifi', label: '📶  WiFi', hint: 'show network details & passwords' },
  commands,
  execute,
  main,
});
export { commands, execute, main };
export const manifest = tool.manifest;
