#!/usr/bin/env node
/**
 * devkit wifi — WiFi Network Manager
 * Show connected network details, password, and available networks.
 * Handles both old macOS (airport) and new macOS 26+ (system_profiler).
 */
import { defineTool } from '../tool-sdk.js';
import { inlineSelect, inlineText } from '../inline.js';
import { intro, outro, select, note, isCancel } from '@clack/prompts';
import chalk from 'chalk';
import { execFileSync } from 'child_process';
import fs from 'fs';

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
        const m = lines[i + 1]?.match(/Device:\s*(.+)/);
        if (m) return m[1].trim();
      }
    }
  } catch {}
  return 'en0';
}

function wifiIsOn() {
  try {
    const device = getWiFiDevice();
    const out = execFileSync('networksetup', ['-getairportpower', device], { encoding: 'utf-8' });
    return out.toLowerCase().includes('on');
  } catch { return false; }
}

/** Check if en0 has an IPv4 address (reliable connection check on all macOS) */
function hasIP() {
  try {
    const out = execFileSync('ifconfig', [getWiFiDevice()], { encoding: 'utf-8' });
    return /\binet\s+\d+\.\d+\.\d+\.\d+/.test(out);
  } catch { return false; }
}

/** Try the old airport-network command (works on Intel Macs / older macOS) */
function getSSIDLegacy() {
  try {
    const device = getWiFiDevice();
    const out = execFileSync('networksetup', ['-getairportnetwork', device], { encoding: 'utf-8' });
    const m = out.match(/Current Wi-Fi Network:\s*(.+)/);
    return m ? m[1].trim() : null;
  } catch { return null; }
}

/** Get known/preferred networks for password lookup */
function getKnownNetworks() {
  try {
    const device = getWiFiDevice();
    const out = execFileSync('networksetup', ['-listpreferredwirelessnetworks', device], { encoding: 'utf-8' });
    // Lines are tab-indented, skip header line
    return out.split('\n').slice(1).map(s => s.replace(/^\t+/, '').trim()).filter(Boolean);
  } catch { return []; }
}

function getPassword(ssid) {
  try {
    // Try generic keychain item first
    return execFileSync('security', ['find-generic-password', '-wa', ssid], {
      encoding: 'utf-8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    // Try with the AirPort network password label
    try {
      return execFileSync('security', ['find-generic-password', '-D', 'AirPort network password', '-wa', ssid], {
        encoding: 'utf-8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    } catch { return null; }
  }
}

/** Parse system_profiler XML for current network + nearby BSSIDs */
function getSystemProfilerWiFi() {
  try {
    const out = execFileSync('system_profiler', ['-xml', 'SPAirPortDataType'], { encoding: 'utf-8', timeout: 5000 });
    // Plist XML → basic parse with regex (avoids pyobjc dependency)
    return out;
  } catch { return null; }
}

/** Extract current network info from system_profiler text output */
function getCurrentNetworkInfo() {
  try {
    const out = execFileSync('system_profiler', ['SPAirPortDataType'], { encoding: 'utf-8', timeout: 5000 });
    const info = {};
    // Parse the current network section
    const lines = out.split('\n');
    let inCurrent = false;
    let inOther = false;
    for (const line of lines) {
      if (line.includes('Current Network Information:')) { inCurrent = true; inOther = false; continue; }
      if (line.includes('Other Local Wi-Fi Networks:')) { inCurrent = false; inOther = true; continue; }
      if (inCurrent) {
        const colon = line.indexOf(':');
        if (colon === -1) continue;
        const key = line.slice(0, colon).trim();
        const val = line.slice(colon + 1).trim();
        if (key && val) info[key] = val;
      }
    }
    return info;
  } catch { return {}; }
}

/** Scan nearby networks from system_profiler text output */
function scanNetworksSP() {
  try {
    const out = execFileSync('system_profiler', ['SPAirPortDataType'], { encoding: 'utf-8', timeout: 5000 });
    const networks = [];
    const lines = out.split('\n');
    let inOther = false;
    let current = null;
    for (const line of lines) {
      if (line.includes('Other Local Wi-Fi Networks:')) { inOther = true; continue; }
      if (!inOther) continue;
      const trimmed = line.trim();
      // New network entry starts with unindented SSID followed by colon
      if (/^[A-Za-z0-9]/.test(trimmed) && trimmed.endsWith(':')) {
        if (current) networks.push(current);
        current = { ssid: trimmed.slice(0, -1) };
      } else if (current) {
        const colon = line.indexOf(':');
        if (colon === -1) continue;
        const key = line.slice(0, colon).trim();
        const val = line.slice(colon + 1).trim();
        if (key === 'PHY Mode') current.phy = val;
        if (key === 'Channel') current.channel = val;
        if (key === 'Security') current.security = val;
        if (key === 'Signal / Noise') {
          const parts = val.split('/').map(s => s.trim().replace('dBm', '').trim());
          current.rssi = parts[0];
          current.noise = parts[1];
        }
      }
    }
    if (current) networks.push(current);
    return networks;
  } catch { return []; }
}

// ─── Formatting ──────────────────────────────────────────

function fmtKv(key, value, color = chalk.yellow) {
  return `  ${chalk.cyan('●')} ${chalk.bold(key.padEnd(18))} ${color(value)}`;
}

function fmtSection(title) {
  return ['', chalk.bold(`  ${title}`), chalk.dim('  ───────────────────────────────────────────────')];
}

function signalBars(rssi) {
  const s = parseInt(rssi) || -100;
  if (s > -50) return chalk.green('▂▄▆█');
  if (s > -60) return chalk.green('▂▄▆ ');
  if (s > -70) return chalk.yellow('▂▄  ');
  return chalk.red('▂   ');
}

// ─── Execute ──────────────────────────────────────────────

async function execute(cmd) {
  const device = getWiFiDevice();
  const connected = hasIP();
  const wifiOn = wifiIsOn();
  // Legacy SSID works on Intel/older macOS, returns null on Apple Silicon/macOS 26+
  const ssid = getSSIDLegacy();
  const knownNetworks = getKnownNetworks();

  switch (cmd) {
    case 'status': {
      if (!wifiOn) return [chalk.yellow(`  Wi-Fi is OFF (${device}). Turn it on in the menu bar.`)];
      if (!connected) return [chalk.yellow(`  Wi-Fi is ON but not connected to any network (${device})`)];

      const info = getCurrentNetworkInfo();
      const netInfo = {};
      try {
        const out = execFileSync('networksetup', ['-getinfo', 'Wi-Fi'], { encoding: 'utf-8' });
        for (const line of out.split('\n')) {
          const idx = line.indexOf(':');
          if (idx === -1) continue;
          netInfo[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
        }
      } catch {}

      const lines = [
        ...fmtSection(ssid ? `WiFi Status: ${ssid}` : 'WiFi Status: Connected'),
      ];
      if (ssid) lines.push(fmtKv('SSID', ssid, chalk.green));
      else lines.push(`  ${chalk.dim('  (SSID hidden by macOS — type wifi password to pick from known networks)')}`);
      if (netInfo['IP address']) lines.push(fmtKv('IP address', netInfo['IP address'], chalk.yellow));
      if (netInfo['Subnet mask']) lines.push(fmtKv('Subnet mask', netInfo['Subnet mask']));
      if (netInfo['Router']) lines.push(fmtKv('Router', netInfo['Router'], chalk.yellow));
      if (netInfo['DNS']) lines.push(fmtKv('DNS', netInfo['DNS'], chalk.dim));

      // Wireless details from system_profiler (always works, even on macOS 26)
      if (info['PHY Mode']) lines.push(fmtKv('PHY Mode', info['PHY Mode'], chalk.dim));
      if (info['Channel']) lines.push(fmtKv('Channel', info['Channel']));
      if (info['Security']) lines.push(fmtKv('Security', info['Security']));
      if (info['Signal / Noise']) lines.push(fmtKv('Signal / Noise', info['Signal / Noise'], chalk.dim));
      if (info['Transmit Rate']) lines.push(fmtKv('TX Rate', `${info['Transmit Rate']} Mbps`));
      if (info['MCS Index']) lines.push(fmtKv('MCS Index', info['MCS Index'], chalk.dim));

      lines.push('', chalk.dim('  Use: wifi password  — to reveal the password'));
      return lines;
    }

    case 'password': {
      if (!wifiOn) return [chalk.yellow('  Wi-Fi is OFF')];

      if (ssid) {
        const pwd = getPassword(ssid);
        if (pwd) {
          return [...fmtSection(`Password: ${ssid}`), `  ${chalk.cyan('🔑')}  ${chalk.bold.yellow(pwd)}`, '', chalk.dim('  (retrieved from macOS Keychain)')];
        }
        return [chalk.yellow(`  No password found in Keychain for "${ssid}"`)];
      }

      // SSID unknown — show known networks to pick from
      if (knownNetworks.length === 0) {
        const manual = await inlineText('Enter SSID:', '');
        if (!manual) return [chalk.dim('  ── cancelled ──')];
        const pwd = getPassword(manual);
        if (pwd) return [...fmtSection(`Password: ${manual}`), `  ${chalk.cyan('🔑')}  ${chalk.bold.yellow(pwd)}`];
        return [chalk.yellow(`  No password found in Keychain for "${manual}"`)];
      }

      const pick = await inlineSelect('Pick a network to reveal password:', [
        ...knownNetworks.map(n => ({ value: n, label: n })),
        { value: '__manual', label: 'Type an SSID manually' },
      ]);
      if (!pick || pick === '__cancel') return [chalk.dim('  ── cancelled ──')];
      if (pick === '__manual') {
        const manual = await inlineText('Enter SSID:', '');
        if (!manual) return [chalk.dim('  ── cancelled ──')];
        const pwd2 = getPassword(manual);
        if (pwd2) return [...fmtSection(`Password: ${manual}`), `  ${chalk.cyan('🔑')}  ${chalk.bold.yellow(pwd2)}`];
        return [chalk.yellow(`  No password found in Keychain for "${manual}"`)];
      }

      const pwd = getPassword(pick);
      if (pwd) return [...fmtSection(`Password: ${pick}`), `  ${chalk.cyan('🔑')}  ${chalk.bold.yellow(pwd)}`, '', chalk.dim('  (retrieved from macOS Keychain)')];
      return [chalk.yellow(`  No password found in Keychain for "${pick}"`)];
    }

    case 'scan': {
      if (!wifiOn) return [chalk.yellow('  Wi-Fi is OFF. Turn it on to scan.')];

      const networks = scanNetworksSP();
      if (networks.length === 0) {
        // Fallback: try the old airport command
        if (fs.existsSync(AIRPORT)) {
          try {
            const raw = execFileSync(AIRPORT, ['-s'], { encoding: 'utf-8', timeout: 8000 });
            const fallback = raw.trim().split('\n').slice(1).map(line => {
              const parts = line.trim().split(/\s{2,}/);
              return { ssid: parts[0] || '', rssi: parts[2] || '', channel: parts[3] || '', security: parts.slice(5).join(' ') || '' };
            }).filter(n => n.ssid);
            if (fallback.length > 0) {
              const lines2 = [...fmtSection(`WiFi Networks (${fallback.length})`)];
              for (const n of fallback.slice(0, 20)) {
                lines2.push(`  ${signalBars(n.rssi)} ${chalk.bold(n.ssid.padEnd(25))} ${chalk.dim((n.channel || '').padEnd(5))} ${n.security}`);
              }
              return lines2;
            }
          } catch {}
        }
        return [chalk.yellow('  No networks found. Ensure Wi-Fi is on.')];
      }

      const lines = [...fmtSection(`WiFi Networks (${networks.length})`)];
      for (const n of networks.slice(0, 20)) {
        lines.push(`  ${signalBars(n.rssi)} ${chalk.bold(n.ssid.padEnd(25))} ${chalk.dim((n.channel || '').padEnd(8))} ${n.security || ''}`);
      }
      return lines;
    }

    case 'info': {
      const lines = [...fmtSection('WiFi Interface Details')];
      lines.push(fmtKv('Device', device));
      lines.push(fmtKv('Power', wifiOn ? chalk.green('On') : chalk.red('Off')));
      lines.push(fmtKv('Connected', connected ? chalk.green('Yes') + (ssid ? ` (${ssid})` : '') : chalk.yellow('No')));

      // Hardware details from system_profiler
      try {
        const spOut = execFileSync('system_profiler', ['SPAirPortDataType'], { encoding: 'utf-8', timeout: 5000 });
        let inIface = false;
        for (const line of spOut.split('\n')) {
          if (line.includes(`Interfaces:`) || line.includes(`${device}:`)) { inIface = true; continue; }
          if (inIface && /^\s{4,}\w+:/.test(line)) {
            // End of en0 block when we hit another interface like awdl0:
            if (/^\s{4}\w+:$/.test(line) && !line.includes(device)) break;
          }
          if (inIface) {
            const colon = line.indexOf(':');
            if (colon === -1) continue;
            const key = line.slice(0, colon).trim();
            const val = line.slice(colon + 1).trim();
            if (key && val && !['Supported PHY Modes', 'Supported Channels', 'Wake On Wireless', 'AirDrop', 'Auto Unlock', 'Status'].includes(key)) {
              if (key === 'MAC Address') lines.push(fmtKv(key, val));
              else if (key === 'Firmware Version') lines.push(fmtKv(key, val, chalk.dim));
              else if (key === 'Card Type') lines.push(fmtKv(key, val, chalk.dim));
            }
          }
        }
      } catch {}

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
    const connected = hasIP();
    const wifiOn = wifiIsOn();
    const ssid = getSSIDLegacy();
    let statusTag;
    if (!wifiOn) statusTag = 'Wi-Fi OFF';
    else if (!connected) statusTag = 'not connected';
    else statusTag = ssid ? `connected to ${ssid}` : 'connected (SSID hidden)';

    const action = await select({
      message: `Choose an action (${statusTag}):`,
      options: [
        { value: 'status',   label: '📶  Current status',       hint: connected ? 'show details' : 'view state' },
        { value: 'password', label: '🔑  Show password',        hint: ssid ? `reveal password for ${ssid}` : 'pick from known networks' },
        { value: 'scan',     label: '📡  Scan networks',        hint: 'list nearby WiFi networks' },
        { value: 'info',     label: '📋  Full interface info',  hint: 'card type, firmware, MAC' },
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
