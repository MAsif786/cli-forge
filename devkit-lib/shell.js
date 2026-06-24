#!/usr/bin/env node
/**
 * devkit interactive shell — Node.js
 * Real-time suggestion popup on "/" like Claude Code.
 * Uses raw stdin for full control.
 */
const { execFileSync } = require('child_process');
const path = require('path');

const DEVKIT_DIR = path.resolve(__dirname, '..');
const DEVKIT_BIN = path.join(DEVKIT_DIR, 'devkit');

const TOOLS = [
  { name: 'totp',    desc: 'TOTP 2FA code manager' },
  { name: 'curl',    desc: 'HTTP client (Postman-like)' },
  { name: 'docker',  desc: 'Docker container manager' },
  { name: 'cleanup', desc: 'Disk space cleanup' },
  { name: 'vpn',     desc: 'VPN connection manager' },
];

const CYAN = '\x1b[36m', BOLD = '\x1b[1m', NC = '\x1b[0m';
const HIDE = '\x1b[?25l', SHOW = '\x1b[?25h', CLR = '\x1b[J';


/** Read N bytes from stdin with timeout (ms). Throws on timeout. */
function readBytes(n, timeoutMs = 100) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
    function attempt() {
      const data = process.stdin.read(n);
      if (data && data.length >= n) {
        clearTimeout(timer);
        resolve(data.slice(0, n));
        if (data.length > n) process.stdin.unshift(data.slice(n));
      } else {
        process.stdin.once('readable', attempt);
      }
    }
    process.stdin.once('readable', attempt);
  });
}

/** Read one keypress. Returns 'a', '\r', '\x1b[A', '\x1bOA', '\x1b' etc. */
async function readKey(timeoutMs = 5000) {
  const first = await readBytes(1, timeoutMs);
  const b = first[0];

  if (b === 0x1b) {
    try {
      const second = await readBytes(1, 30);
      if (second[0] === 0x5b || second[0] === 0x4f) {
        const third = await readBytes(1, 30);
        return `\x1b${String.fromCharCode(second[0])}${String.fromCharCode(third[0])}`;
      }
      return '\x1b' + String.fromCharCode(second[0]);
    } catch {
      return '\x1b'; // Just Escape key
    }
  }

  if (b === 0x7f) return '\x7f';
  return String.fromCharCode(b);
}


/** Show interactive suggestion popup. Returns tool name or null. */
async function suggestPopup(filterText) {
  let items = TOOLS.filter(t => t.name.includes(filterText));
  if (items.length === 0) return null;

  let selected = 0;
  let count = items.length;
  let lines = count + 2;

  process.stderr.write(HIDE);

  while (true) {
    for (let i = 0; i < count; i++) {
      const p = i === selected ? ' >' : '  ';
      process.stderr.write(`\r  ${p}  ${CYAN}${items[i].name.padEnd(10)}${NC}  ${items[i].desc.padEnd(28)}${CLR}\n`);
    }
    process.stderr.write(`\r  ${BOLD}↑↓${NC} nav  ${BOLD}Enter${NC} select  ${BOLD}Esc${NC} cancel${CLR}\n`);
    process.stderr.write(`\x1b[${lines}A`);
    process.stderr.flush?.();

    const key = await readKey(5000);

    if (key === '\x1b[A' || key === '\x1bOA') {
      selected = (selected - 1 + count) % count;
    } else if (key === '\x1b[B' || key === '\x1bOB') {
      selected = (selected + 1) % count;
    } else if (key === '\r' || key === '\n') {
      process.stderr.write(`\x1b[${lines}B${CLR}${SHOW}`);
      return items[selected].name;
    } else if (key === '\x1b') {
      process.stderr.write(`\x1b[${lines}B${CLR}${SHOW}`);
      return null;
    } else if (key.length === 1 && key >= ' ') {
      filterText += key;
      items = TOOLS.filter(t => t.name.includes(filterText));
      if (items.length === 0) {
        process.stderr.write(`\x1b[${lines}B${CLR}${SHOW}`);
        return key; // pass char back
      }
      count = items.length;
      lines = count + 2;
      selected = 0;
    }
  }
}


function runTool(name) {
  console.log();
  try { execFileSync(DEVKIT_BIN, [name], { stdio: 'inherit' }); } catch {}
  console.log();
}


async function main() {
  if (!process.stdin.isTTY) {
    process.stderr.write('devkit interactive shell requires a TTY\n');
    process.exit(1);
  }

  process.stdin.setRawMode(true);
  process.stdin.resume();

  console.log();
  console.log(`  ${BOLD}╭────────────────────────────────╮${NC}`);
  console.log(`  ${BOLD}│${NC}          ${BOLD}devkit${NC} v1.0            ${BOLD}│${NC}`);
  console.log(`  ${BOLD}│${NC}     Smart CLI Toolbox           ${BOLD}│${NC}`);
  console.log(`  ${BOLD}╰────────────────────────────────╯${NC}`);
  console.log();

  let line = '';
  process.stdout.write('  devkit> ');

  while (true) {
    const key = await readKey(5000);

    // Ctrl+C
    if (key === '\x03') {
      console.log(`\n  ${CYAN}Goodbye!${NC}`);
      break;
    }

    // Enter
    if (key === '\r' || key === '\n') {
      const cmd = line.trim();
      line = '';
      process.stdout.write('\n');

      if (!cmd) {
        console.log(`\n  ${BOLD}Available tools:${NC}`);
        for (const t of TOOLS) console.log(`  ${CYAN}/${t.name.padEnd(10)}${NC}  ${t.desc}`);
        console.log(`  Type ${BOLD}/<tool>${NC} or a name. ${BOLD}q${NC} to quit.\n`);
        process.stdout.write('  devkit> ');
        continue;
      }

      if (['q', 'quit', 'exit', '0'].includes(cmd)) {
        console.log(`  ${CYAN}Goodbye!${NC}`);
        break;
      }

      if (cmd === '/') {
        const result = await suggestPopup('');
        if (result && typeof result === 'string') runTool(result);
      } else if (cmd.startsWith('/')) {
        const filter = cmd.slice(1).trim();
        const match = TOOLS.find(t => t.name.startsWith(filter) && filter.length > 0);
        match ? runTool(match.name) : (await suggestPopup(filter));
      } else {
        const d = {
          '1': 'totp', '2': 'curl', '3': 'docker', '4': 'cleanup', '5': 'vpn',
          totp: 'totp', curl: 'curl', docker: 'docker', cleanup: 'cleanup', vpn: 'vpn',
        };
        if (d[cmd]) { runTool(d[cmd]); }
        else { console.log(`  \x1b[31m[ERR]${NC}  Unknown: ${cmd}\n`); }
      }

      process.stdout.write('  devkit> ');
      continue;
    }

    // Backspace
    if (key === '\x7f' || key === '\b') {
      if (line.length > 0) { line = line.slice(0, -1); process.stdout.write('\b \b'); }
      continue;
    }

    // Printable char
    if (key.length === 1 && key >= ' ') {
      line += key;
      process.stdout.write(key);

      // Immediate popup on standalone "/"
      if (line === '/') {
        process.stdout.write('\n');
        const result = await suggestPopup('');
        if (result && typeof result === 'string') runTool(result);
        line = '';
        process.stdout.write('  devkit> ');
      }
    }
  }

  process.stdin.setRawMode(false);
}

main().catch(() => process.exit(1));
