#!/usr/bin/env node
/**
 * devkit port — Port & Process Manager
 * List, find, kill port services, and manage firewall rules.
 */
import { defineTool } from '../tool-sdk.js';
import { inlineSelect, inlineText } from '../inline.js';
import { isCancel } from '@clack/prompts';
import chalk from 'chalk';
import { execFileSync } from 'child_process';
import fs from 'fs';

// ─── Constants ────────────────────────────────────────────

const commands = [
  { name: 'list',  desc: 'List all listening ports with processes' },
  { name: 'find',  desc: 'Find what is running on a specific port' },
  { name: 'kill',  desc: 'Kill process running on a port' },
  { name: 'open',  desc: 'Open/expose a port through the firewall' },
  { name: 'close', desc: 'Close/block a port through the firewall' },
  { name: 'check', desc: 'Check TCP connectivity to a host:port' },
  { name: 'myip',  desc: 'Show local and public IP addresses' },
];

function parseArgs(cmd) {
  const parts = cmd.trim().split(/\s+/);
  return { name: parts[0], arg: parts.slice(1).join(' ') };
}

function hasSudo() {
  try {
    execFileSync('sudo', ['-n', 'true'], { stdio: 'ignore', timeout: 3000 });
    return true;
  } catch { return false; }
}

function getListening() {
  // TCP listening
  let tcp = '';
  try {
    tcp = execFileSync('lsof', [
      '-nP', '-iTCP', '-sTCP:LISTEN',
      '-F', 'pcn', // pid, command, name
    ], { encoding: 'utf-8', timeout: 10000 });
  } catch {}
  // UDP listening (try with -sUDP:LISTEN first, fallback to broad UDP)
  let udp = '';
  try {
    udp = execFileSync('lsof', [
      '-nP', '-iUDP', '-sUDP:LISTEN',
      '-F', 'pcn',
    ], { encoding: 'utf-8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    try {
      // Older lsof may not support -sUDP:LISTEN; fallback to listing UDP and
      // filter for "listen" in the address
      udp = execFileSync('lsof', [
        '-nP', '-iUDP',
        '-F', 'pcn',
      ], { encoding: 'utf-8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {}
  }

  return { tcp, udp };
}

function parseLsof(raw, protocol) {
  // lsof -F outputs lines prefixed with p (pid), c (command), n (name/address)
  const entries = [];
  let current = {};
  for (const line of raw.split('\n').filter(Boolean)) {
    const tag = line[0];
    const val = line.slice(1);
    if (tag === 'p') {
      if (current.pid && current.cmd) {
        entries.push(current);
      }
      current = { pid: val, cmd: '', addr: '', protocol };
    } else if (tag === 'c') {
      current.cmd = val;
    } else if (tag === 'n') {
      current.addr = val;
    }
  }
  if (current.pid && current.cmd) entries.push(current);
  return entries;
}

function formatEntries(entries, protocol) {
  // Group by pid+cmd, show all ports
  const groups = {};
  for (const e of entries) {
    const key = `${e.pid}|${e.cmd}`;
    if (!groups[key]) groups[key] = { pid: e.pid, cmd: e.cmd, addrs: [] };
    groups[key].addrs.push(e.addr);
  }

  const lines = [];
  for (const key of Object.keys(groups).sort()) {
    const g = groups[key];
    const ports = g.addrs
      .map(a => {
        const m = a.match(/\*:(\d+)/) || a.match(/(?:127\.0\.0\.1|localhost):(\d+)/) || a.match(/:(\d+)/);
        return m ? m[1] : a;
      })
      .filter((v, i, a) => a.indexOf(v) === i);
    const label = ports.length > 3
      ? `${ports.slice(0, 3).join(', ')}...+${ports.length - 3}`
      : ports.join(', ');
    lines.push(`  ${chalk.cyan(g.pid.padEnd(7))} ${chalk.green(g.cmd.padEnd(18))} ${chalk.yellow(label.padEnd(12))} ${chalk.dim(protocol)}`);
  }
  return lines;
}

// ─── Execute (used from devkit context) ─────────────────

async function execute(cmd) {
  const { name, arg } = parseArgs(cmd);

  switch (name) {
    case 'list': {
      const raw = getListening();
      const lines = [chalk.bold('  Listening ports:')];
      lines.push(chalk.dim('  PID     Command           Ports        Type'));
      lines.push(chalk.dim('  ─────────────────────────────────────────────'));

      if (raw.tcp) {
        const tcpEntries = parseLsof(raw.tcp, 'TCP');
        const tcpLines = formatEntries(tcpEntries, 'TCP');
        if (tcpLines.length > 0) lines.push(...tcpLines);
      }
      if (raw.udp) {
        const udpEntries = parseLsof(raw.udp, 'UDP');
        const udpLines = formatEntries(udpEntries, 'UDP');
        if (udpLines.length > 0) lines.push(...udpLines);
      }

      if (lines.length <= 2) lines.push('  Nothing listening');
      return lines;
    }

    case 'find': {
      const port = arg || await inlineText('Port number:');
      if (isCancel(port) || !port) return ['  Cancelled'];
      let out;
      try {
        out = execFileSync('lsof', ['-nP', '-i', `:${port}`], { encoding: 'utf-8', timeout: 8000 });
      } catch {
        return [chalk.yellow(`  Nothing found on port ${port}`)];
      }
      const rows = out.trim().split('\n').filter(Boolean);
      const lines = [chalk.bold(`  Port ${port}:`)];
      for (const row of rows) {
        lines.push(`  ${row}`);
      }
      return lines;
    }

    case 'kill': {
      const port = arg || await inlineText('Port number:');
      if (isCancel(port) || !port) return ['  Cancelled'];

      // Find process on this port
      let out;
      try {
        out = execFileSync('lsof', ['-nP', '-t', '-i', `:${port}`], { encoding: 'utf-8', timeout: 8000 });
      } catch {
        return [chalk.yellow(`  Nothing running on port ${port}`)];
      }

      const pids = out.trim().split('\n').filter(Boolean);
      if (pids.length === 0) return [chalk.yellow(`  Nothing running on port ${port}`)];

      // Get process info for display
      const procs = pids.map(pid => {
        try {
          const name = execFileSync('ps', ['-p', pid, '-o', 'comm='], { encoding: 'utf-8', timeout: 3000 }).trim();
          return { pid, name: name || 'unknown' };
        } catch { return { pid, name: 'unknown' }; }
      });

      if (pids.length === 1) {
        const p = procs[0];
        const ok = await inlineSelect(`Kill ${p.name} (PID ${p.pid}) on port ${port}?`, [
          { value: 'yes', label: 'Yes, kill it' },
          { value: 'no', label: 'Cancel' },
        ]);
        if (ok !== 'yes') return ['  Cancelled'];
        try {
          process.kill(parseInt(p.pid, 10), 'SIGTERM');
          return [chalk.green(`  Killed ${p.name} (PID ${p.pid}) on port ${port}`)];
        } catch (e) {
          try {
            execFileSync('kill', ['-9', p.pid], { stdio: 'pipe' });
            return [chalk.green(`  Force killed ${p.name} (PID ${p.pid})`), chalk.dim('  Used SIGKILL — process may not have been clean')];
          } catch (e2) {
            return [chalk.red(`  Could not kill PID ${p.pid}: ${e2.message}`)];
          }
        }
      }

      // Multiple PIDs
      const options = procs.map(p => ({ value: p.pid, label: `${p.name} (PID ${p.pid})` }));
      options.push({ value: 'all', label: `⚡  Kill ALL ${procs.length}` });

      const sel = await inlineSelect(`Processes on port ${port}:`, options);
      if (!sel) return ['  Cancelled'];

      const killed = [];
      for (const pid of sel === 'all' ? pids : [sel]) {
        try {
          process.kill(parseInt(pid, 10), 'SIGTERM');
          killed.push(pid);
        } catch {
          try { execFileSync('kill', ['-9', pid], { stdio: 'pipe' }); killed.push(pid); }
          catch {}
        }
      }
      return [chalk.green(`  Killed ${killed.length} process(es) on port ${port}`)];
    }

    case 'open': {
      const port = arg || await inlineText('Port number:');
      if (isCancel(port) || !port) return ['  Cancelled'];

      // Check if anything is listening on this port
      let listening = false;
      let procInfo = '';
      try {
        const l = execFileSync('lsof', ['-nP', '-i', `:${port}`], { encoding: 'utf-8', timeout: 5000 });
        listening = l.trim().length > 0;
        if (listening) {
          const pid = execFileSync('lsof', ['-nP', '-t', '-i', `:${port}`], { encoding: 'utf-8', timeout: 5000 }).trim().split('\n')[0];
          const pname = execFileSync('ps', ['-p', pid, '-o', 'comm='], { encoding: 'utf-8', timeout: 3000 }).trim();
          procInfo = `${pname} (PID ${pid})`;
        }
      } catch {}

      const lines = [];

      if (listening) {
        lines.push(chalk.green(`  ✅  ${procInfo} is listening on port ${port}`));
      } else {
        lines.push(chalk.yellow(`  ⚠  Nothing listening on port ${port}`));
      }

      // Check firewall status
      let pfEnabled = false;
      try {
        const pfInfo = execFileSync('pfctl', ['-s', 'info'], { encoding: 'utf-8', timeout: 5000 });
        pfEnabled = pfInfo.includes('Status: Enabled');
      } catch {}

      let alfEnabled = false;
      try {
        const alf = execFileSync('/usr/libexec/ApplicationFirewall/socketfilterfw', ['--getglobalstate'], { encoding: 'utf-8', timeout: 5000 });
        alfEnabled = alf.includes('enabled');
      } catch {}

      if (pfEnabled || alfEnabled) {
        const ok = await inlineSelect(
          pfEnabled
            ? `Add pf firewall rule to allow TCP port ${port}?`
            : `Add ${procInfo || `port ${port}`} to ALF allowed apps?`,
          [
            { value: 'yes', label: 'Yes, configure firewall', hint: 'macOS admin auth will pop up' },
            { value: 'no', label: 'Skip' },
          ]
        );
        if (ok !== 'yes') return [chalk.dim('  ── no changes ──')];
      } else {
        // Neither firewall is active — just tell the user
        lines.push(chalk.green('  ✅  No firewall blocking — port should be reachable'));
        lines.push(chalk.dim('  Test from another machine:'));
        const myIp = execFileSync('ipconfig', ['getifaddr', 'en0'], { encoding: 'utf-8', timeout: 5000 }).trim() || '<your-ip>';
        lines.push(chalk.cyan(`  nc -zv ${myIp} ${port}`));
        return lines;
      }

      // ── Apply firewall rules via osascript (GUI admin auth) ──
      if (pfEnabled) {
        try {
          const script = `do shell script "echo \\"pass in proto tcp from any to any port ${port}\\" | /sbin/pfctl -a \\"devkit/${port}\\" -f -" with administrator privileges`;
          execFileSync('osascript', ['-e', script], { timeout: 60000, stdio: 'pipe' });
          lines.push(chalk.green(`  ✅  pf rule added: TCP port ${port} is now open`));
          lines.push(chalk.dim('  Rule added to "devkit" anchor — persists until reboot'));
        } catch (e) {
          lines.push(chalk.red(`  ❌  Failed to add pf rule: ${e.message.split('\n')[0] || 'Unknown error'}`));
          return lines;
        }
      }

      if (alfEnabled && listening && procInfo) {
        // Find the executable path of the listening process
        try {
          const pid = execFileSync('lsof', ['-nP', '-t', '-i', `:${port}`], { encoding: 'utf-8', timeout: 5000 }).trim().split('\n')[0];
          const procPath = execFileSync('lsof', ['-nP', '-p', pid, '-Fn'], { encoding: 'utf-8', timeout: 5000 })
            .split('\n').filter(l => l.startsWith('n')).map(l => l.slice(1))[0];
          if (procPath && fs.existsSync(procPath)) {
            const script = `do shell script "/usr/libexec/ApplicationFirewall/socketfilterfw --add \\"${procPath}\\"" with administrator privileges`;
            execFileSync('osascript', ['-e', script], { timeout: 30000, stdio: 'pipe' });
            lines.push(chalk.green(`  ✅  ${procInfo} added to ALF allowed apps`));
          }
        } catch {}
      }

      // Show connectivity test
      lines.push('');
      lines.push(chalk.dim('  Test from another machine:'));
      try {
        const myIp = execFileSync('ipconfig', ['getifaddr', 'en0'], { encoding: 'utf-8', timeout: 5000 }).trim();
        lines.push(chalk.cyan(`  nc -zv ${myIp || '<your-ip>'} ${port}`));
      } catch {
        lines.push(chalk.cyan(`  nc -zv <your-ip> ${port}`));
      }

      return lines;
    }

    case 'close': {
      const port = arg || await inlineText('Port number:');
      if (isCancel(port) || !port) return ['  Cancelled'];

      const lines = [];

      // Check for pf anchor rule to remove
      let hasPfRule = false;
      try {
        const rules = execFileSync('pfctl', ['-a', `devkit/${port}`, '-s', 'rules'], { encoding: 'utf-8', timeout: 5000 });
        hasPfRule = rules.trim().length > 0;
      } catch {}

      // Find running process on port
      let listeningProc = '';
      try {
        const l = execFileSync('lsof', ['-nP', '-i', `:${port}`], { encoding: 'utf-8', timeout: 5000 });
        if (l.trim().length > 0) {
          const pid = execFileSync('lsof', ['-nP', '-t', '-i', `:${port}`], { encoding: 'utf-8', timeout: 5000 }).trim().split('\n')[0];
          const pname = execFileSync('ps', ['-p', pid, '-o', 'comm='], { encoding: 'utf-8', timeout: 3000 }).trim();
          listeningProc = `${pname} (PID ${pid})`;
        }
      } catch {}

      if (!hasPfRule && !listeningProc) {
        return [chalk.yellow(`  Nothing to close on port ${port} — no pf rule and no process found`)];
      }

      if (listeningProc) {
        const killToo = await inlineSelect(`Kill ${listeningProc} on port ${port}?`, [
          { value: 'yes', label: 'Yes, kill process' },
          { value: 'no', label: 'No, skip' },
        ]);
        if (killToo === 'yes') {
          try {
            const pids = execFileSync('lsof', ['-nP', '-t', '-i', `:${port}`], { encoding: 'utf-8', timeout: 5000 }).trim().split('\n').filter(Boolean);
            let killed = 0;
            for (const pid of pids) {
              try { process.kill(parseInt(pid, 10), 'SIGTERM'); killed++; }
              catch { try { execFileSync('kill', ['-9', pid], { stdio: 'pipe' }); killed++; } catch {} }
            }
            lines.push(chalk.green(`  ✅  Killed ${killed} process(es) on port ${port}`));
          } catch { lines.push(chalk.yellow('  Could not kill process')); }
        }
      }

      if (hasPfRule) {
        const removeRule = await inlineSelect('Remove pf firewall rule for this port?', [
          { value: 'yes', label: 'Yes, remove rule', hint: 'macOS admin auth will pop up' },
          { value: 'no', label: 'Keep rule' },
        ]);
        if (removeRule === 'yes') {
          try {
            const script = `do shell script "/sbin/pfctl -a \\"devkit/${port}\\" -F all" with administrator privileges`;
            execFileSync('osascript', ['-e', script], { timeout: 30000, stdio: 'pipe' });
            lines.push(chalk.green(`  ✅  pf rule removed for port ${port}`));
          } catch (e) {
            lines.push(chalk.red(`  ❌  Failed to remove pf rule: ${e.message.split('\n')[0] || 'Unknown error'}`));
          }
        }
      }

      if (lines.length === 0) lines.push(chalk.dim('  ── no changes ──'));
      return lines;
    }

    case 'check': {
      let host, port;
      if (arg) {
        const parts = arg.split(':');
        host = parts.length >= 2 ? parts.slice(0, -1).join(':') : 'localhost';
        port = parts.length >= 2 ? parts[parts.length - 1] : arg;
      } else {
        host = await inlineText('Host:', 'localhost');
        if (!host) return ['  Cancelled'];
        port = await inlineText('Port:');
        if (!port || !/^\d+$/.test(port)) return ['  Cancelled'];
      }

      let result;
      try {
        result = execFileSync('nc', ['-z', '-w', '3', host, port], { encoding: 'utf-8', timeout: 10000 });
        return [chalk.green(`  ✅  Port ${port} is open on ${host}`)];
      } catch (e) {
        // nc returns non-zero when port is closed
        if (e.stderr && e.stderr.includes('succeeded')) {
          return [chalk.green(`  ✅  Port ${port} is open on ${host}`)];
        }
        return [chalk.red(`  ❌  Port ${port} is not reachable on ${host} (or host is down)`)];
      }
    }

    case 'myip': {
      const lines = [chalk.bold('  IP Addresses:')];
      lines.push(chalk.dim('  ───────────────────────────'));

      // Local interfaces
      const interfaces = ['en0', 'en1', 'en2', 'en3', 'en4', 'en5'];
      for (const iface of interfaces) {
        try {
          const ip = execFileSync('ipconfig', ['getifaddr', iface], { encoding: 'utf-8', timeout: 5000 }).trim();
          if (ip) {
            const name = iface === 'en0' ? 'Wi-Fi' : iface === 'en1' ? 'Ethernet' : iface;
            lines.push(`  ${chalk.green('●')} ${chalk.bold(name.padEnd(12))} ${ip}`);
          }
        } catch {}
      }

      // VPN/tunnel interfaces
      for (const iface of ['utun0', 'utun1', 'utun2', 'utun3']) {
        try {
          const raw = execFileSync('ifconfig', [iface], { encoding: 'utf-8', timeout: 5000 });
          const m = raw.match(/inet\s+(\d+\.\d+\.\d+\.\d+)/);
          if (m) lines.push(`  ${chalk.yellow('●')} ${chalk.bold('VPN'.padEnd(12))} ${m[1]} (${iface})`);
        } catch {}
      }

      // Localhost
      lines.push(`  ${chalk.dim('●')} ${chalk.bold('localhost'.padEnd(12))} 127.0.0.1`);

      // Public IP
      lines.push('');
      lines.push(chalk.bold('  Public IP:'));
      try {
        const publicIp = execFileSync('curl', ['-s', '--max-time', '5', 'ifconfig.me'], { encoding: 'utf-8', timeout: 8000 }).trim();
        if (publicIp) lines.push(`  ${chalk.cyan('●')} ${publicIp}`);
        else lines.push(chalk.yellow('  Could not determine'));
      } catch {
        lines.push(chalk.yellow('  Could not determine (check internet connection)'));
      }

      return lines;
    }

    default:
      return [chalk.yellow(`  Unknown port command: "${name}"`)];
  }
}

const tool = defineTool({
  manifest: { name: 'port', label: '📡  Port Manager', hint: 'list, find, kill ports, firewall', keywords: ['lsof', 'process', 'pid', 'kill', 'firewall', 'listen', 'tcp', 'udp', 'network', 'socket', 'pf', 'alf'] },
  commands,
  execute,
});

// Re-export module bindings (export {} reuses existing declarations, no redeclaration)
export { commands, execute };
export const manifest = tool.manifest;
