#!/usr/bin/env node
/**
 * devkit totp — Interactive TOTP 2FA manager (clack-powered)
 */
import { defineTool } from '../tool-sdk.js';
import { inlineSelect, inlineText } from '../inline.js';
import { select, spinner, text, confirm, isCancel, cancel, note } from '@clack/prompts';
import chalk from 'chalk';
import { execFileSync, execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';

// ─── Constants ────────────────────────────────────────────

const commands = [
  { name: 'list',   desc: 'List all accounts' },
  { name: 'live',   desc: 'View live codes with timer' },
  { name: 'copy',   desc: '📋  Copy code to clipboard' },
  { name: 'add',    desc: 'Add account manually' },
  { name: 'import', desc: 'Import from otpauth:// URI' },
  { name: 'remove', desc: 'Remove an account' },
];

async function execute(cmd) {
  switch (cmd) {
    case 'list': {
      const accounts = readSecrets();
      if (accounts.length === 0) return ['  No accounts saved'];
      const lines = accounts.map(a => {
        const s = a.secret;
        const masked = s.length > 8 ? `${s.slice(0, 4)}...${s.slice(-4)}` : '****';
        return `  ${a.name.padEnd(25)} ${masked}`;
      });
      return [chalk.bold(`  ${accounts.length} account(s):`), chalk.dim('  ────────'), ...lines];
    }
    case 'live': {
      await liveCodes();
      return [chalk.dim('  ── done ──')];
    }
    case 'add': {
      await addAccount();
      return [chalk.dim('  ── done ──')];
    }
    case 'import': {
      await importUri();
      return [chalk.dim('  ── done ──')];
    }
    case 'copy': {
      const accounts = readSecrets();
      if (accounts.length === 0) return ['  No accounts saved'];
      const account = await inlineSelect('Select account to copy:', accounts.map(a => ({ value: a.name, label: a.name })));
      if (!account) return ['  Cancelled'];
      const code = generateCode(account);
      if (!code) return [chalk.red('  Failed to generate code')];
      try {
        execSync('pbcopy', { input: code, stdio: ['pipe', 'ignore', 'ignore'] });
        return [chalk.green(`  📋  ${code} — copied for ${account}`)];
      } catch {
        return [chalk.green(`  ${code} — for ${account} (pbcopy not available)`), chalk.dim('  Copy manually')];
      }
    }
    case 'remove': {
      await removeAccount();
      return [chalk.dim('  ── done ──')];
    }
    default:
      return [chalk.yellow(`  Unknown TOTP command: "${cmd}"`)];
  }
}

const CFG = path.join(os.homedir(), '.devkit', 'totp.ini');

function readSecrets() {
  try {
    const data = fs.readFileSync(CFG, 'utf-8').trim();
    if (!data) return [];
    return data.split('\n').filter(Boolean).map(line => {
      const idx = line.indexOf('=');
      if (idx === -1) return null;
      return { name: line.slice(0, idx), secret: line.slice(idx + 1) };
    }).filter(Boolean);
  } catch { return []; }
}

function writeSecrets(accounts) {
  const dir = path.dirname(CFG);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const data = accounts.map(a => `${a.name}=${a.secret}`).join('\n');
  fs.writeFileSync(CFG, data + '\n');
}

/** Generate TOTP code using Python (built into macOS). */
function generateCode(secret) {
  try {
    const out = execFileSync('python3', ['-c', `
import base64, hmac, struct, hashlib, time
secret = '''${secret}'''
key = base64.b32decode(secret.upper().replace(' ', ''))
counter = int(time.time()) // 30
msg = struct.pack('>Q', counter)
digest = hmac.new(key, msg, hashlib.sha1).digest()
offset = digest[-1] & 0xf
truncated = struct.unpack('>I', digest[offset:offset+4])[0] & 0x7fffffff
code = truncated % 1000000
print(f'{code:06d}')
    `], { encoding: 'utf-8', timeout: 5000 });
    return (out || '').toString().trim() || null;
  } catch { return null; }
}

function totpRemaining() {
  return 30 - (Math.floor(Date.now() / 1000) % 30);
}

async function liveCodes() {
  const accounts = readSecrets();
  if (accounts.length === 0) {
    note('No accounts saved. Add one first.', 'TOTP Live Codes');
    return;
  }

  // Switch to raw mode for real-time refresh
  const wasRaw = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdout.write('\x1b[?25l'); // hide cursor

  const count = accounts.length;
  const lines = count + 3; // header + N codes + stop hint
  let prevWindow = -1;
  let codes = accounts.map(() => '??????');
  let running = true;
  let selIdx = 0;

  // Read keypress to quit
  const stdinHandler = buf => {
    const key = buf.toString();
    if (key === 'q' || key === '\x1b') running = false;
    if (key === '\x1b[A' && selIdx > 0) selIdx--;
    if (key === '\x1b[B' && selIdx < count - 1) selIdx++;
    if (key === 'c' || key === '\r') {
      const idx = selIdx;
      const code = codes[idx];
      if (code && code !== '??????') {
        try {
          execSync('pbcopy', { input: code, stdio: ['pipe', 'ignore', 'ignore'] });
          running = false; // exit the loop
          process.stdout.write('\x1b[?25h\n');
          console.log(chalk.green(`  📋  ${code.slice(0,3)} ${code.slice(3)} copied for ${accounts[idx].name}`));
          return;
        } catch {}
      }
    }
  };
  process.stdin.on('data', stdinHandler);

  try {
    while (running) {
      const now = Math.floor(Date.now() / 1000);
      const window = Math.floor(now / 30);
      const rem = 30 - (now % 30);

      // Only recompute codes when 30s window changes
      if (window !== prevWindow) {
        for (let i = 0; i < count; i++) {
          codes[i] = generateCode(accounts[i].secret) || '??????';
        }
        prevWindow = window;
      }

      // Redraw
      process.stdout.write('\x1b[?25l');
      if (codes.length > 0) {
        process.stdout.write(`\r  ${chalk.bold('     Account               Code      Countdown')}\x1b[J\n`);
        process.stdout.write(`  \x1b[2m──────────────────────────────────────────────────────\x1b[0m\n`);

        for (let i = 0; i < count; i++) {
          const code = codes[i];
          const display = `${code.slice(0, 3)} ${code.slice(3)}`;
          const bar = '▓'.repeat(Math.ceil(rem / 3)) + '░'.repeat(10 - Math.ceil(rem / 3));
          const name = accounts[i].name.length > 20 ? accounts[i].name.slice(0, 18) + '..' : accounts[i].name;
          let color = chalk.green;
          if (rem <= 5) color = chalk.red;
          else if (rem <= 15) color = chalk.yellow;
          const selected = i === selIdx ? chalk.cyan('❯') : ' ';
          process.stdout.write(`  ${selected} ${color(`${display}  ${bar}  ${rem}s  ${name}`)}\x1b[J\n`);
        }
        process.stdout.write(`  \x1b[2m──────────────────────────────────────────────────────\x1b[0m\n`);
        process.stdout.write(chalk.dim('  ↑↓ select  ·  (c) copy  ·  (q) quit\x1b[J'));
      }

      // Sleep 1 second (check every 100ms if user pressed q)
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 100));
        if (!running) break;
      }

      // Move cursor back up for next redraw
      if (running) process.stdout.write(`\x1b[${lines}A`);
    }
  } finally {
    process.stdin.removeListener('data', stdinHandler);
    if (!wasRaw) process.stdin.setRawMode(false);
    process.stdout.write('\x1b[?25h\n'); // show cursor
  }
}

async function addAccount() {
  const name = await text({ message: 'Account name (e.g. github):', validate: v => v ? undefined : 'Required' });
  if (isCancel(name)) return;

  const secret = await text({
    message: 'Secret key (base32):',
    validate: v => v ? undefined : 'Required',
  });
  if (isCancel(secret)) return;

  const cleanSecret = secret.replace(/ /g, '');
  const testCode = generateCode(cleanSecret);
  if (!testCode) {
    cancel('Invalid secret — could not generate code');
    return;
  }

  const accounts = readSecrets();
  const existing = accounts.findIndex(a => a.name === name);
  if (existing >= 0) {
    const overwrite = await confirm({ message: `"${name}" already exists. Overwrite?`, initialValue: false });
    if (isCancel(overwrite) || !overwrite) { cancel('Cancelled'); return; }
    accounts[existing].secret = cleanSecret;
  } else {
    accounts.push({ name, secret: cleanSecret });
  }

  writeSecrets(accounts);
  note(`Test code: ${testCode}`, `✅  "${name}" added`);
}

async function removeAccount() {
  const accounts = readSecrets();
  if (accounts.length === 0) { note('No accounts saved.', 'Remove'); return; }

  const target = await select({
    message: 'Select account to remove:',
    options: [
      ...accounts.map(a => ({ value: a.name, label: a.name })),
      { value: '__back', label: '←  Back' },
    ],
  });

  if (isCancel(target) || target === '__back') return;

  const confirmRemove = await confirm({ message: `Remove "${target}"?`, initialValue: false });
  if (isCancel(confirmRemove) || !confirmRemove) { cancel('Cancelled'); return; }

  const remaining = accounts.filter(a => a.name !== target);
  writeSecrets(remaining);
  note('', `🗑️  "${target}" removed`);
}

async function importUri() {
  const uri = await text({
    message: 'Paste otpauth:// URI (or "c" for clipboard, "f <path>" for file):',
  });
  if (isCancel(uri) || !uri) return;

  let resolvedUri = uri;

  if (uri === 'c') {
    try {
      resolvedUri = execFileSync('pbpaste', [], { encoding: 'utf-8' }).trim();
    } catch { cancel('pbpaste failed'); return; }
  } else if (uri.startsWith('f ')) {
    const fpath = uri.slice(2).trim();
    try { resolvedUri = fs.readFileSync(fpath, 'utf-8').trim().split('\n')[0]; }
    catch { cancel(`Cannot read: ${fpath}`); return; }
  }

  if (resolvedUri.toLowerCase().startsWith('otpauth-migration://')) {
    await importMigration(resolvedUri);
    return;
  }

  // Parse standard otpauth://totp/...
  let account = resolvedUri.match(/otpauth:\/\/[tT][oO][tT][pP]\/([^?]+)/)?.[1];
  if (account) account = decodeURIComponent(account);
  const secret = resolvedUri.match(/[?&]secret=([^&]+)/)?.[1];

  if (!secret) { cancel('No secret found in URI'); return; }

  const cleanSecret = secret.replace(/ /g, '');
  const testCode = generateCode(cleanSecret);
  if (!testCode) { cancel('Invalid secret'); return; }

  if (!account) {
    const issuer = resolvedUri.match(/[?&]issuer=([^&]+)/)?.[1];
    account = issuer ? decodeURIComponent(issuer) : 'unknown';
  }

  const accounts = readSecrets();
  accounts.push({ name: account, secret: cleanSecret });
  writeSecrets(accounts);
  note(`Test code: ${testCode}`, `✅  "${account}" imported`);
}

async function importMigration(uri) {
  const data = uri.match(/[?&]data=([^&]+)/)?.[1];
  if (!data) { cancel('No data in migration URI'); return; }

  const sp = spinner();
  sp.start('Parsing Google Auth export...');

  try {
    const result = execFileSync('python3', ['-c', `
import base64, os, sys
from urllib.parse import unquote

b64 = unquote('''${data}''').replace('-','+').replace('_','/')
pad = len(b64) % 4
if pad: b64 += '=' * (4 - pad)
raw = base64.b64decode(b64)

def dv(data, off):
    v = s = 0
    while True:
        b = data[off]; v |= (b & 0x7f) << s; s += 7; off += 1
        if not (b & 0x80): break
    return v, off

def dl(data, off):
    l, off = dv(data, off)
    return data[off:off+l], off+l

def pf(data):
    f = {}; off = 0
    while off < len(data):
        tag, off = dv(data, off); fn = tag>>3; wt = tag&7
        if wt == 0: v, off = dv(data, off); f[fn] = v
        elif wt == 2: v, off = dl(data, off); f[fn] = v
        else: break
    return f

accts = []; off = 0
while off < len(raw):
    tag, off = dv(raw, off); fn = tag>>3; wt = tag&7
    if fn == 1 and wt == 2: v, off = dl(raw, off); accts.append(pf(v))
    else:
        if wt == 0: _, off = dv(raw, off)
        elif wt == 2: _, off = dl(raw, off)
        else: break

cfg = os.environ['HOME'] + '/.devkit/totp.ini'
existing = set()
try:
    for line in open(cfg):
        if '=' in line: existing.add(line.split('=')[0].strip())
except: pass

imported = 0
for i, a in enumerate(accts):
    rs = a.get(1, b''); nm = a.get(2, b'').decode('utf-8','replace'); isr = a.get(3, b'').decode('utf-8','replace'); ot = a.get(6, 0)
    if ot == 1 or not rs: continue
    b32 = base64.b32encode(rs).decode('utf-8').rstrip('=')
    disp = f'{isr}:{nm}' if isr and nm else isr or nm or f'unknown_{i}'
    if disp in existing: continue
    with open(cfg, 'a') as f: f.write(f'{disp}={b32}\\n')
    imported += 1
    print(f'OK:{disp}')

print(f'DONE:{imported}')
    `], { encoding: 'utf-8', timeout: 10000 });
    sp.stop('Done!');
    for (const line of (result.stdout || '').trim().split('\n')) {
      if (line.startsWith('OK:')) note('', `✅  ${line.slice(3)}`);
      if (line.startsWith('DONE:')) note('', `📦  ${line.slice(5)} account(s) imported`);
    }
  } catch (e) {
    sp.stop('Failed');
    cancel(`Import error: ${e.message}`);
  }
}

async function listAccounts() {
  const accounts = readSecrets();
  if (accounts.length === 0) { note('No accounts saved.', 'Accounts'); return; }
  const lines = accounts.map(a => {
    const s = a.secret;
    const masked = s.length > 8 ? `${s.slice(0, 4)}...${s.slice(-4)}` : '****';
    return `${a.name} → ${masked}`;
  }).join('\n');
  note(lines, `📋  ${accounts.length} account(s)`);
}

const tool = defineTool({
  manifest: { name: 'totp', label: '🔑  TOTP 2FA', hint: 'manage accounts & live codes', keywords: ['2fa', 'mfa', 'otp', 'authenticator', 'auth', 'codes', 'two-factor', 'one-time', 'token'] },
  commands,
  execute,
});
export { commands, execute };
export const manifest = tool.manifest;
