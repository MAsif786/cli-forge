#!/usr/bin/env node
/**
 * devkit aws — AWS Manager
 * Quick AWS operations: identity, S3, EC2, CloudWatch logs, profiles.
 */
import { defineTool } from '../tool-sdk.js';
import { inlineSelect, inlineText, _appendOutput } from '../inline.js';
import { intro, outro, select, spinner, text, isCancel, cancel, note } from '@clack/prompts';
import chalk from 'chalk';
import { execFileSync, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ─── Constants ────────────────────────────────────────────

const commands = [
  { name: 'whoami',  desc: 'Show current AWS identity (STS)' },
  { name: 's3',      desc: 'List S3 buckets and objects' },
  { name: 'ec2',     desc: 'List EC2 instances' },
  { name: 'logs',    desc: 'CloudWatch log groups and streams' },
  { name: 'secrets', desc: 'List and get Secrets Manager secrets' },
  { name: 'secret',  desc: 'Update a secret: secret update <name>' },
  { name: 'profile', desc: 'List / switch AWS profiles' },
  { name: 'login',   desc: 'SSO login via browser' },
  { name: 'help',    desc: 'Help with credentials / SSO setup' },
  { name: 'regions', desc: 'List enabled AWS regions' },
];

const AWS_CONFIG = path.join(os.homedir(), '.aws', 'config');
const AWS_CREDS = path.join(os.homedir(), '.aws', 'credentials');
const STATE_FILE = path.join(os.homedir(), '.devkit', 'aws', 'state.json');

// ─── State ────────────────────────────────────────────────

let activeProfile = process.env.AWS_PROFILE || 'default';
let activeRegion = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || '';

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
      if (state.profile && !process.env.AWS_PROFILE) activeProfile = state.profile;
      if (state.region && !process.env.AWS_REGION && !process.env.AWS_DEFAULT_REGION) activeRegion = state.region;
    }
  } catch {}
}

function saveState() {
  try {
    const dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({ profile: activeProfile, region: activeRegion }), 'utf-8');
  } catch {}
}

// Load persisted state
loadState();

// ─── Helpers ──────────────────────────────────────────────

function checkAws() {
  try {
    execFileSync('which', ['aws'], { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

function awsArgs() {
  const args = [];
  if (activeProfile !== 'default') args.push('--profile', activeProfile);
  if (activeRegion) args.push('--region', activeRegion);
  return args;
}

function runAws(command, opts = {}) {
  const args = command.split(/\s+/);
  const allArgs = [...args, ...awsArgs()];
  try {
    const out = execFileSync('aws', allArgs, {
      encoding: 'utf-8',
      timeout: opts.timeout || 15000,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...opts,
    });
    return { ok: true, data: out.trim(), error: null };
  } catch (e) {
    let msg = e.message;
    if (e.stderr) {
      const lines = e.stderr.trim().split('\n');
      msg = lines[lines.length - 1] || msg;
    }
    return { ok: false, data: '', error: msg };
  }
}

function runAwsJson(command, opts = {}) {
  const result = runAws(`${command} --output json`, opts);
  if (!result.ok) return result;
  try {
    return { ok: true, data: JSON.parse(result.data), error: null };
  } catch {
    return { ok: true, data: result.data, error: null };
  }
}

function fmtTable(rows, headers) {
  if (!rows || rows.length === 0) return ['  (none)'];
  const cols = headers.length;
  const widths = headers.map((h, i) => {
    let max = h.length;
    for (const row of rows) {
      const val = String(row[i] || '');
      if (val.length > max) max = Math.min(val.length, 40);
    }
    return max;
  });

  const line = '  ┌' + widths.map(w => '─'.repeat(w + 2)).join('┬') + '┐';
  const sep = '  ├' + widths.map(w => '─'.repeat(w + 2)).join('┼') + '┤';
  const bot = '  └' + widths.map(w => '─'.repeat(w + 2)).join('┴') + '┘';

  const result = [line];
  // Header
  result.push('  │' + headers.map((h, i) => ` ${h.padEnd(widths[i])} `).join('│') + '│');
  result.push(sep);
  // Rows
  for (const row of rows) {
    result.push('  │' + row.map((v, i) => {
      const s = String(v == null ? '-' : v);
      return ` ${s.length > widths[i] ? s.slice(0, widths[i] - 1) + '…' : s.padEnd(widths[i])} `;
    }).join('│') + '│');
  }
  result.push(bot);
  return result;
}

function readProfiles() {
  const profiles = [];
  // Read from config ([profile name] format)
  if (fs.existsSync(AWS_CONFIG)) {
    const content = fs.readFileSync(AWS_CONFIG, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      const m = trimmed.match(/^\[(?:profile\s+)?(.+?)\]$/);
      if (m) profiles.push(m[1]);
    }
  }
  // Read from credentials ([name] format)
  if (fs.existsSync(AWS_CREDS)) {
    const content = fs.readFileSync(AWS_CREDS, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      const m = trimmed.match(/^\[(.+?)\]$/);
      if (m) profiles.push(m[1]);
    }
  }
  return [...new Set(profiles)];
}

async function addProfileMenu() {
  const name = await text({ message: 'Profile name:', validate: v => v ? undefined : 'Required' });
  if (isCancel(name)) return;
  const profiles = readProfiles();
  if (profiles.includes(name)) { cancel(`Profile "${name}" already exists`); return; }
  const keyId = await text({ message: 'AWS Access Key ID:', validate: v => v ? undefined : 'Required' });
  if (isCancel(keyId)) return;
  const secretKey = await text({ message: 'AWS Secret Access Key:', validate: v => v ? undefined : 'Required' });
  if (isCancel(secretKey)) return;
  const region = await text({ message: 'Default region:', initialValue: 'us-east-1' });
  if (isCancel(region)) return;
  const configDir = path.dirname(AWS_CREDS);
  if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
  let creds = '';
  if (fs.existsSync(AWS_CREDS)) creds = fs.readFileSync(AWS_CREDS, 'utf-8').trimEnd();
  creds += '\n\n[' + name + ']\naws_access_key_id = ' + keyId + '\naws_secret_access_key = ' + secretKey + '\n';
  fs.writeFileSync(AWS_CREDS, creds, 'utf-8');
  if (!fs.existsSync(AWS_CONFIG)) fs.writeFileSync(AWS_CONFIG, '', 'utf-8');
  let config = fs.readFileSync(AWS_CONFIG, 'utf-8').trimEnd();
  config += '\n\n[profile ' + name + ']\nregion = ' + region + '\noutput = json\n';
  fs.writeFileSync(AWS_CONFIG, config, 'utf-8');
  activeProfile = name;
  activeRegion = region;
  saveState();
  note('', '✅  Profile "' + name + '" added (region: ' + region + ')');
}

function addProfile() {
  return new Promise(async (resolve) => {
    const name = await inlineText('Profile name:', '');
    if (!name) { resolve([chalk.dim('  ── cancelled ──')]); return; }

    const profiles = readProfiles();
    if (profiles.includes(name)) {
      resolve([chalk.yellow(`  Profile "${name}" already exists`)]);
      return;
    }

    const keyId = await inlineText('AWS Access Key ID:', '');
    if (!keyId) { resolve([chalk.dim('  ── cancelled ──')]); return; }

    const secretKey = await inlineText('AWS Secret Access Key:', '');
    if (!secretKey) { resolve([chalk.dim('  ── cancelled ──')]); return; }

    const region = await inlineText('Default region:', 'us-east-1');

    // Write to credentials
    const configDir = path.dirname(AWS_CREDS);
    if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
    let creds = '';
    if (fs.existsSync(AWS_CREDS)) creds = fs.readFileSync(AWS_CREDS, 'utf-8').trimEnd();
    creds += '\n\n[' + name + ']\naws_access_key_id = ' + keyId + '\naws_secret_access_key = ' + secretKey + '\n';
    fs.writeFileSync(AWS_CREDS, creds, 'utf-8');

    // Write to config with region
    if (!fs.existsSync(AWS_CONFIG)) fs.writeFileSync(AWS_CONFIG, '', 'utf-8');
    let config = fs.readFileSync(AWS_CONFIG, 'utf-8').trimEnd();
    config += '\n\n[profile ' + name + ']\nregion = ' + region + '\noutput = json\n';
    fs.writeFileSync(AWS_CONFIG, config, 'utf-8');

    // Auto-activate profile and region
    activeProfile = name;
    activeRegion = region;
    saveState();

    resolve([chalk.green('  ✅  Profile "' + name + '" added'), chalk.dim('  Region: ' + region), chalk.dim('  Switched to profile "' + name + '"')]);
  });
}

// ─── Secret value formatter ───────────────────────────────

function formatSecretLines(name, secretData) {
  const secretString = secretData.SecretString || '';
  const lines = [
    '',
    chalk.bold(`  🔐  ${name}`),
    chalk.dim('  ───────────────────────────────────────────────'),
  ];
  if (secretData.VersionId) lines.push(`  ${chalk.dim('Version:')} ${chalk.dim(secretData.VersionId)}`);
  if (secretData.ARN) lines.push(`  ${chalk.dim('ARN:    ')} ${chalk.dim(secretData.ARN)}`);
  lines.push('');

  try {
    const parsed = JSON.parse(secretString);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      lines.push(`  ${chalk.bold('Value')} ${chalk.dim('(JSON object):')}`);
      lines.push('');
      const entries = Object.entries(parsed);
      const keyWidth = Math.min(Math.max(...entries.map(([k]) => k.length), 4), 30);
      for (const [k, v] of entries) {
        lines.push(`  ${chalk.cyan('●')} ${chalk.bold(k.padEnd(keyWidth))}  ${chalk.yellow(String(v))}`);
      }
    } else {
      lines.push(`  ${chalk.bold('Value:')}`);
      lines.push(`  ${chalk.yellow(JSON.stringify(parsed, null, 2).replace(/\n/g, '\n  '))}`);
    }
  } catch {
    lines.push(`  ${chalk.bold('Value:')}`);
    lines.push(`  ${chalk.yellow(secretString)}`);
  }

  return lines;
}

// ─── Secret update helper ─────────────────────────────────

function updateSecret(name, key, value) {
  // Fetch current value
  const result = runAwsJson(`secretsmanager get-secret-value --secret-id ${name}`);
  if (!result.ok) return { ok: false, error: result.error };

  let data;
  try {
    data = JSON.parse(result.data.SecretString || '{}');
  } catch {
    data = {};
  }

  // Update the key
  if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
    data[key] = value;
  } else {
    // Wrap non-object values in an object
    data = { [key]: value };
  }

  // Write back
  const writeResult = runAws(`secretsmanager put-secret-value --secret-id ${name} --secret-string '${JSON.stringify(data)}'`);
  if (!writeResult.ok) return { ok: false, error: writeResult.error };

  return { ok: true, data };
}

async function secretUpdateFlow(name) {
  const lines = [];

  // Fetch current value
  const result = runAwsJson(`secretsmanager get-secret-value --secret-id ${name}`);
  if (!result.ok) return [chalk.red(`  ❌  ${result.error}`)];

  let currentData;
  try {
    currentData = JSON.parse(result.data.SecretString || '{}');
  } catch {
    currentData = {};
  }

  const isJsonObject = currentData !== null && typeof currentData === 'object' && !Array.isArray(currentData);
  const currentKeys = isJsonObject ? Object.keys(currentData) : [];

  // Show current value
  _appendOutput('');
  _appendOutput(chalk.bold(`  ✏️  Update Secret: ${name}`));
  _appendOutput(chalk.dim('  ───────────────────────────────────────────────'));
  if (isJsonObject && currentKeys.length > 0) {
    const keyWidth = Math.min(Math.max(...currentKeys.map(k => k.length), 4), 30);
    _appendOutput(`  ${chalk.bold('Current keys:')}`);
    for (const k of currentKeys) {
      _appendOutput(`  ${chalk.cyan('●')} ${chalk.bold(k.padEnd(keyWidth))}  ${chalk.yellow(String(currentData[k]))}`);
    }
  } else {
    _appendOutput(`  ${chalk.dim('(no JSON keys — will create new)')}`);
  }
  _appendOutput('');

  while (true) {
    // Ask what to do
    const action = await inlineSelect('Action:', [
      { value: 'add', label: '➕  Add new key', hint: '' },
      ...(currentKeys.length > 0 ? [
        { value: 'edit', label: '✏️  Edit existing key', hint: '' },
        { value: 'delete', label: '🗑️  Delete a key', hint: '' },
      ] : []),
      { value: 'done', label: '✅  Done — save changes', hint: '' },
      { value: 'cancel', label: 'Cancel', hint: '' },
    ]);
    if (!action || action === 'cancel') return [chalk.dim('  ── cancelled ──')];
    if (action === 'done') break;

    if (action === 'add') {
      const newKey = await inlineText('New key name:', '');
      if (!newKey) continue;
      const newVal = await inlineText(`Value for "${newKey}":`, '');
      if (!newVal) continue;

      const updateResult = updateSecret(name, newKey, newVal);
      if (!updateResult.ok) {
        _appendOutput(chalk.red(`  ❌  ${updateResult.error}`));
        continue;
      }
      currentKeys.push(newKey);
      currentData = updateResult.data;
      _appendOutput(chalk.green(`  ✅  Added ${chalk.bold(newKey)}`));
    }

    if (action === 'edit') {
      const editKey = await inlineSelect('Select key to edit:', currentKeys.map(k => ({
        value: k, label: k, hint: String(currentData[k]),
      })));
      if (!editKey) continue;

      const newVal = await inlineText(`New value for "${editKey}":`, String(currentData[editKey]));
      if (!newVal) continue;

      const updateResult = updateSecret(name, editKey, newVal);
      if (!updateResult.ok) {
        _appendOutput(chalk.red(`  ❌  ${updateResult.error}`));
        continue;
      }
      currentData = updateResult.data;
      _appendOutput(chalk.green(`  ✅  Updated ${chalk.bold(editKey)}`));
    }

    if (action === 'delete') {
      const delKey = await inlineSelect('Select key to delete:', currentKeys.map(k => ({
        value: k, label: k, hint: String(currentData[k]),
      })));
      if (!delKey) continue;

      // Remove the key
      const newData = { ...currentData };
      delete newData[delKey];
      const writeResult = runAws(`secretsmanager put-secret-value --secret-id ${name} --secret-string '${JSON.stringify(newData)}'`);
      if (!writeResult.ok) {
        _appendOutput(chalk.red(`  ❌  ${writeResult.error}`));
        continue;
      }
      currentKeys.splice(currentKeys.indexOf(delKey), 1);
      currentData = newData;
      _appendOutput(chalk.green(`  ✅  Deleted ${chalk.bold(delKey)}`));
    }
  }

  return [
    '',
    chalk.green(`  ✅  Secret "${name}" updated successfully`),
    chalk.dim(`  Final keys: ${currentKeys.join(', ') || '(empty)'}`),
  ];
}

// ─── Execute ──────────────────────────────────────────────

async function execute(cmd) {
  const parts = cmd.trim().split(/\s+/);
  const name = parts[0];
  const arg = parts.slice(1).join(' ');

  if (!checkAws()) return [chalk.red('  AWS CLI not found. Install: brew install awscli')];

  switch (name) {
    case 'whoami': {
      const result = runAwsJson('sts get-caller-identity');
      if (!result.ok) return [chalk.red(`  ❌  ${result.error}`)];
      const id = result.data;
      const lines = [
        chalk.bold(`  AWS Identity (${activeProfile})`),
        chalk.dim('  ───────────────────────────────────────────────'),
        `  ${chalk.green('●')} Account: ${chalk.bold(id.Account)}`,
        `  ${chalk.cyan('●')} User/Role: ${id.Arn.split('/').slice(1).join('/') || id.Arn}`,
        `  ${chalk.dim('●')} ARN: ${id.Arn}`,
      ];
      if (activeRegion) lines.push(`  ${chalk.yellow('●')} Region: ${activeRegion}`);
      return lines;
    }

    case 'profile': {
      if (arg === 'add') {
        return await addProfile();
      }

      const profiles = readProfiles();

      if (arg) {
        if (!profiles.includes(arg)) return [chalk.yellow(`  Profile "${arg}" not found`)];
        activeProfile = arg;
        saveState();
        return [chalk.green(`  ✅  Switched to profile: ${chalk.bold(arg)}`)];
      }

      if (profiles.length === 0) return [chalk.yellow('  No AWS profiles found. Use: profile add to create one')];

      // Show all profiles, current one marked
      const lines = [chalk.bold(`  AWS Profiles (${profiles.length}):`)];
      lines.push(chalk.dim('  ───────────────────────────────────────────────'));
      for (const p of profiles) {
        const active = p === activeProfile ? chalk.green(' ●') : '  ';
        lines.push(`  ${active} ${chalk.bold(p)}`);
      }
      lines.push('');
      lines.push(chalk.dim('  Use: profile <name> to switch'));
      lines.push(chalk.dim('  Use: profile add to create a new one'));
      return lines;
    }

    case 'help': {
      const helpOpt = await inlineSelect('What do you need help with?', [
        { value: 'sso', label: 'Get SSO Start URL', hint: 'where to find your company SSO URL' },
        { value: 'iam', label: 'Get IAM Access Keys', hint: 'create IAM user with programmatic access' },
        { value: 'open', label: 'Open AWS Console', hint: 'open AWS Management Console in browser' },
        { value: 'no', label: 'Cancel', hint: '' },
      ]);
      if (helpOpt === 'sso') {
        return ['  ' + chalk.bold('SSO Start URL'), '',
          chalk.dim('  Your company SSO URL is provided by your AWS organization admin.'),
          chalk.dim('  It typically looks like:'),
          chalk.cyan('    https://<company>.awsapps.com/start'),
          '',
          chalk.dim('  Where to find it:'),
          chalk.dim('    • Ask your cloud/IT team'),
          chalk.dim('    • Check your email for "AWS SSO" or "IAM Identity Center" invite'),
          chalk.dim('    • Check your company\'s Okta/Azure AD/SSO portal'),
          '',
          chalk.dim('  Once you have it, run:') + chalk.cyan(' profile add'),
          chalk.dim('  Or configure a new profile with SSO settings.'),
          '',
          chalk.cyan('  → Open AWS IAM Identity Center: ') + chalk.underline('https://console.aws.amazon.com/singlesignon/'),
        ];
      }
      if (helpOpt === 'iam') {
        return ['  ' + chalk.bold('IAM Access Keys'), '',
          chalk.dim('  IAM users with programmatic access have an Access Key ID and Secret Key.'),
          chalk.dim('  To create one:'),
          chalk.bold('  1.') + chalk.dim(' Open IAM Console → Users → your user → Security credentials'),
          chalk.bold('  2.') + chalk.dim(' Click "Create access key"'),
          chalk.bold('  3.') + chalk.dim(' Copy the Access Key ID and Secret Access Key'),
          chalk.bold('  4.') + chalk.dim(' Run:') + chalk.cyan(' profile add'),
          '',
          chalk.cyan('  → Open IAM Users: ') + chalk.underline('https://console.aws.amazon.com/iamv2/home#/users'),
        ];
      }
      if (helpOpt === 'open') {
        const url = 'https://' + (activeRegion || 'us-east-1') + '.console.aws.amazon.com/console/home?region=' + (activeRegion || 'us-east-1');
        try {
          execFileSync('open', [url]);
          return [chalk.green('  🌐  Opened AWS Console in browser')];
        } catch {
          return [chalk.dim('  ' + url)];
        }
      }
      return [chalk.dim('  ── cancelled ──')];
    }

    case 'login': {
      // Check if SSO profile
      let ssoUrl = '';
      if (fs.existsSync(AWS_CONFIG)) {
        const config = fs.readFileSync(AWS_CONFIG, 'utf-8');
        const profileSection = config.match(new RegExp(`\\[profile ${activeProfile}\\][^\\[]*`));
        if (profileSection) {
          const urlMatch = profileSection[0].match(/sso_start_url\s*=\s*(.+)/);
          if (urlMatch) ssoUrl = urlMatch[1].trim();
        }
      }

      if (ssoUrl) {
        const msg = `  Opening browser for SSO login...\n  ${chalk.dim('Profile:')} ${activeProfile}\n  ${chalk.dim('SSO URL:')} ${ssoUrl}`;
        const result = runAws(`sso login${activeProfile !== 'default' ? ` --profile ${activeProfile}` : ''}`, { timeout: 120000, stdio: 'inherit' });
        if (result.ok || result.error === null) {
          return [chalk.green('  ✅  SSO login successful'), chalk.dim(`  Profile: ${activeProfile}`)];
        }
        return [chalk.red('  ❌  Login failed'), chalk.dim(result.error || '')];
      }

      // Not SSO — offer Console sign-in or IAM setup
      const action = await inlineSelect('How to authenticate?', [
        { value: 'console', label: 'Open Console sign-in page', hint: 'browser-based login' },
        { value: 'iam', label: 'Add IAM access keys', hint: 'profile add (fully programmatic)' },
        { value: 'no', label: 'Cancel', hint: '' },
      ]);
      if (action === 'console') {
        try {
          execFileSync('open', ['https://console.aws.amazon.com/']);
          return [chalk.green('  🌐  Opened AWS Console in browser')];
        } catch {
          return [chalk.dim('  https://console.aws.amazon.com/')];
        }
      }
      if (action === 'iam') {
        return await addProfile();
      }
      return [chalk.dim('  ── cancelled ──')];
    }

    case 'regions': {
      // Use us-east-1 as default since this is a region-agnostic listing
      const savedRegion = activeRegion;
      if (!activeRegion) activeRegion = 'us-east-1';
      const result = runAwsJson('ec2 describe-regions --query Regions[].{Name:RegionName,Opt:OptInStatus}');
      if (!savedRegion) activeRegion = '';
      if (!result.ok) return [chalk.red(`  ❌  ${result.error}`)];
      const regions = (result.data || []).map(r => ({ value: r.Name || r.RegionName || '', label: r.Name || r.RegionName || '', hint: r.Opt || '' }));

      if (regions.length === 0) return [chalk.yellow('  No regions found')];

      const pick = await inlineSelect('Select region for profile "' + activeProfile + '":', regions);
      if (!pick) return [chalk.dim('  ── cancelled ──')];

      // Update in-memory state
      activeRegion = pick;
      saveState();
      return ['  ' + chalk.green('✅  Region set to ' + chalk.bold(pick) + ' for profile "' + activeProfile + '"')];
    }

    case 's3': {
      if (arg) {
        // List objects in a bucket
        const bucket = arg.replace(/^s3:\/\//, '').replace(/\/$/, '');
        const result = runAwsJson(`s3api list-objects-v2 --bucket "${bucket.split('/')[0]}" --prefix "${bucket.split('/').slice(1).join('/') || ''}" --delimiter "/"`);
        if (!result.ok) return [chalk.red(`  ❌  ${result.error}`)];

        const data = result.data;
        const folders = (data.CommonPrefixes || []).map(p => ({ name: p.Prefix, type: 'dir' }));
        const files = (data.Contents || []).filter(f => !f.Key.endsWith('/')).map(f => ({
          name: f.Key, size: f.Size, lastMod: f.LastModified, type: 'file',
        }));
        const all = [...folders, ...files];

        if (all.length === 0) return [chalk.yellow('  (empty)')];
        const rows = all.slice(0, 50).map(item => {
          if (item.type === 'dir') return [chalk.dim('📁'), item.name, '', ''];
          const size = item.size > 1024 * 1024 ? `${(item.size / 1024 / 1024).toFixed(1)}MB`
            : item.size > 1024 ? `${(item.size / 1024).toFixed(1)}KB`
            : `${item.size}B`;
          const date = item.lastMod ? item.lastMod.split('T')[0] : '';
          return [chalk.dim('📄'), item.name.split('/').pop(), size, date];
        });
        return [chalk.bold(`  s3://${bucket}/`), ...fmtTable(rows, ['', 'Name', 'Size', 'Modified'])];
      }

      // List buckets
      const result = runAwsJson('s3api list-buckets --query Buckets[].{Name:Name,Date:CreationDate}');
      if (!result.ok) return [chalk.red(`  ❌  ${result.error}`)];
      const buckets = (result.data || []).map(b => [b.Name || '', (b.Date || '').split('T')[0] || '']);
      const lines = [chalk.bold(`  S3 Buckets (${buckets.length}):`)];
      lines.push(chalk.dim('  ───────────────────────────────────────────────'));
      for (const b of buckets) {
        lines.push(`  ${chalk.yellow('●')} ${chalk.bold(b[0].padEnd(35))} ${chalk.dim(b[1])}`);
      }
      return lines;
    }

    case 'ec2': {
      const result = runAwsJson('ec2 describe-instances');
      if (!result.ok) return [chalk.red(`  ❌  ${result.error}`)];
      const reservations = result.data?.Reservations || [];
      const instances = [];
      for (const r of reservations) {
        for (const inst of r.Instances || []) {
          const state = inst.State?.Name || '';
          const nameTag = (inst.Tags || []).find(t => t.Key === 'Name')?.Value || '';
          instances.push({ id: inst.InstanceId, state, type: inst.InstanceType, launch: inst.LaunchTime?.split('T')[0] || '', name: nameTag, data: inst });
        }
      }
      if (instances.length === 0) return [chalk.yellow('  No EC2 instances found')];

      if (arg) {
        // Show instance details
        const inst = instances.find(i => i.id === arg || i.name === arg);
        if (!inst) return [chalk.yellow(`  Instance "${arg}" not found`)];
        const d = inst.data;
        const lines = [chalk.bold(`  ${inst.name || inst.id}`)];
        lines.push(chalk.dim('  ───────────────────────────────────────────────'));
        lines.push(`  ${chalk.bold('ID:')}       ${inst.id}`);
        lines.push(`  ${chalk.bold('State:')}    ${inst.state === 'running' ? chalk.green('▶ running') : inst.state === 'stopped' ? chalk.red('⏹ stopped') : inst.state}`);
        lines.push(`  ${chalk.bold('Type:')}     ${inst.type}`);
        lines.push(`  ${chalk.bold('AZ:')}       ${d.Placement?.AvailabilityZone || '-'}`);
        lines.push(`  ${chalk.bold('Launch:')}   ${inst.launch}`);
        lines.push(`  ${chalk.bold('VPC:')}      ${d.VpcId || '-'}`);
        lines.push(`  ${chalk.bold('Subnet:')}   ${d.SubnetId || '-'}`);
        if (d.PublicIpAddress) lines.push(`  ${chalk.bold('Public IP:')} ${d.PublicIpAddress}`);
        if (d.PrivateIpAddress) lines.push(`  ${chalk.bold('Private IP:')}${d.PrivateIpAddress}`);
        const sgs = (d.SecurityGroups || []).map(sg => sg.GroupName).join(', ');
        if (sgs) lines.push(`  ${chalk.bold('SG:')}       ${sgs}`);
        const tags = (d.Tags || []).filter(t => t.Key !== 'Name').map(t => `    ${t.Key}: ${t.Value}`).join('\n');
        if (tags) lines.push(`  ${chalk.bold('Tags:')}\n${tags}`);
        return lines;
      }

      // Offer interactive selection if no arg
      const pick = await inlineSelect('Select instance for details:', instances.map(i => ({
        value: i.id, label: i.name || i.id, hint: `${i.type}  ${i.state}  ${i.launch}`,
      })));
      if (pick) {
        const inst = instances.find(i => i.id === pick);
        if (inst) return await execute(`ec2 ${inst.id}`);
      }
      return [chalk.dim('  ── cancelled ──')];
    }

    case 'logs': {
      const result = runAwsJson('logs describe-log-groups');
      if (!result.ok) return [chalk.red(`  ❌  ${result.error}`)];
      const groups = result.data?.logGroups || [];
      if (groups.length === 0) return [chalk.yellow('  No log groups found')];

      if (arg) {
        // Show log streams for this group
        const streamResult = runAwsJson(`logs describe-log-streams --log-group-name ${arg} --order-by LastEventTime --descending --max-results 20`);
        if (!streamResult.ok) return [chalk.red(`  ❌  ${streamResult.error}`)];
        const streams = streamResult.data?.logStreams || [];
        if (streams.length === 0) return [chalk.yellow('  No streams in this log group')];
        const lines = [chalk.bold(`  Streams: ${arg}`)];
        lines.push(chalk.dim('  ───────────────────────────────────────────────'));
        for (const s of streams) {
          const name = s.logStreamName || '';
          const lastEvent = s.lastEventTimestamp ? new Date(s.lastEventTimestamp).toISOString().split('.')[0].replace('T', ' ') : '';
          lines.push(`  ${chalk.dim('●')} ${name.length > 60 ? name.slice(0, 58) + '..' : name}`);
          if (lastEvent) lines.push(`    ${chalk.dim('last event:')} ${lastEvent}`);
        }
        return lines;
      }

      // Offer interactive selection
      const pick = await inlineSelect('Select log group for streams:', groups.slice(0, 30).map(g => ({
        value: g.logGroupName, label: g.logGroupName.length > 55 ? g.logGroupName.slice(0, 53) + '..' : g.logGroupName,
        hint: g.storedBytes ? `${(g.storedBytes / 1024 / 1024).toFixed(1)}MB` : '',
      })));
      if (pick) return await execute(`logs ${pick}`);
      return [chalk.dim('  ── cancelled ──')];
    }

    case 'secrets': {
      if (arg) {
        // Direct invocation: secrets <name> — return lines
        const result = runAwsJson(`secretsmanager get-secret-value --secret-id ${arg}`);
        if (!result.ok) return [chalk.red(`  ❌  ${result.error}`)];
        return formatSecretLines(arg, result.data);
      }

      // Interactive: inlineSelect with scroll-window (handles any number of secrets)
      const result = runAwsJson('secretsmanager list-secrets');
      if (!result.ok) return [chalk.red(`  ❌  ${result.error}`)];
      const secretList = result.data?.SecretList;
      if (!secretList || !Array.isArray(secretList)) {
        return [chalk.yellow('  No secrets found'), chalk.dim(`  Raw: ${JSON.stringify(result.data).slice(0, 200)}`)];
      }
      if (secretList.length === 0) return [chalk.yellow('  No secrets found')];

      // Use inlineSelect instead of dumping all names — scroll-window handles overflow
      const pick = await inlineSelect(`Secrets (${secretList.length}):`, [
        ...secretList.map(s => ({
          value: s.Name,
          label: s.Name,
          hint: s.LastChangedDate ? s.LastChangedDate.split('T')[0] : '',
        })),
      ]);
      if (!pick) return [];

      // Show value and ask if they want another
      const valResult = runAwsJson(`secretsmanager get-secret-value --secret-id ${pick}`);
      if (!valResult.ok) {
        return [chalk.red(`  ❌  ${valResult.error}`), '', chalk.dim('  Type secrets to try again')];
      }

      const secretLines = formatSecretLines(pick, valResult.data);
      for (const line of secretLines) _appendOutput(line);

      const again = await inlineText('View another? (y/N)  Edit? (e):', '', ['y', 'n', 'yes', 'no', 'e', 'edit']);
      if (again === 'y' || again === 'yes') {
        return await execute('secrets');
      }
      if (again === 'e' || again === 'edit') {
        return await secretUpdateFlow(pick);
      }
      return [];
    }

    case 'secret': {
      if (arg.startsWith('update ')) {
        const target = arg.slice(7).trim();
        if (!target) return [chalk.yellow('  Usage: secret update <name>')];
        return await secretUpdateFlow(target);
      }
      return [chalk.yellow('  Unknown secret subcommand. Try: secrets, secret update <name>')];
    }

    default:
      return [chalk.yellow(`  Unknown AWS command: "${name}"`)];
  }
}

// ─── Main menu ────────────────────────────────────────────

async function main() {
  if (!checkAws()) {
    cancel('AWS CLI not found. Install: brew install awscli');
    return;
  }

  intro(chalk.bold('devkit aws — AWS Manager'));

  while (true) {
    const profileTag = activeProfile !== 'default' ? ` (${activeProfile})` : '';
    const regionTag = activeRegion ? ` @${activeRegion}` : '';

    const action = await select({
      message: `Choose an action${profileTag}${regionTag}:`,
      options: [
        { value: 'whoami',  label: '👤  Who am I',              hint: 'STS caller identity' },
        { value: 's3',      label: '📦  S3 Buckets',            hint: 'list buckets & objects' },
        { value: 'ec2',     label: '🖥️  EC2 Instances',        hint: 'list all instances' },
        { value: 'logs',    label: '📝  CloudWatch Logs',       hint: 'log groups & streams' },
        { value: 'secrets', label: '🔐  Secrets Manager',       hint: 'list and view secrets' },
        { value: '__sep1',  label: '──  Config  ──',            hint: '' },
        { value: 'profile', label: '🔑  AWS Profile',           hint: activeProfile !== 'default' ? activeProfile : 'default' },
        { value: 'login',   label: '🌐  SSO Login',             hint: 'browser-based auth' },
        { value: 'help',    label: '❓  Help & Setup',          hint: 'credentials, SSO, URLs' },
        { value: 'regions', label: '🌍  Regions',               hint: activeRegion || 'not set' },
        { value: '__back',  label: '←  Back to devkit',         hint: '' },
      ],
    });

    if (isCancel(action) || action === '__back') break;

    switch (action) {
      case 'whoami': {
        const sp = spinner();
        sp.start('Calling STS...');
        const result = runAwsJson('sts get-caller-identity');
        sp.stop(result.ok ? 'Done' : 'Failed');
        if (!result.ok) { cancel(result.error); break; }
        note(
          `Account: ${chalk.bold(result.data.Account)}\n` +
          `ARN: ${result.data.Arn}\n` +
          `Profile: ${chalk.cyan(activeProfile)}${activeRegion ? `\nRegion: ${activeRegion}` : ''}`,
          '👤  AWS Identity'
        );
        break;
      }

      case 's3': {
        const sp = spinner();
        sp.start('Listing buckets...');
        const result = runAwsJson('s3api list-buckets --query Buckets[].{Name:Name,Date:CreationDate}');
        sp.stop(result.ok ? 'Done' : 'Failed');
        if (!result.ok) { cancel(result.error); break; }
        const buckets = (result.data || []).map(b => ({ value: b.Name, label: b.Name, hint: (b.Date || '').split('T')[0] }));
        if (buckets.length === 0) { note('No buckets found', 'S3'); break; }

        buckets.push({ value: '__back', label: '← Back' });
        const sel = await select({ message: 'Select bucket:', options: buckets });
        if (isCancel(sel) || sel === '__back') break;

        // List objects
        sp.start(`Listing s3://${sel}...`);
        const objResult = runAwsJson(`s3api list-objects-v2 --bucket "${sel}" --delimiter "/" --max-items 50`);
        sp.stop('Done');
        if (!objResult.ok) { cancel(objResult.error); break; }

        const data = objResult.data;
        const folders = (data.CommonPrefixes || []).map(p => ({ value: p.Prefix, label: `📁  ${p.Prefix}` }));
        const files = (data.Contents || []).filter(f => !f.Key.endsWith('/')).slice(0, 50).map(f => {
          const size = f.Size > 1024 * 1024 ? `${(f.Size / 1024 / 1024).toFixed(1)}MB` : `${(f.Size / 1024).toFixed(1)}KB`;
          return { value: f.Key, label: `📄  ${f.Key.split('/').pop()}`, hint: size };
        });
        const items = [...folders, ...files];
        if (items.length === 0) { note('(empty)', 'S3'); break; }
        note(items.slice(0, 30).map(i => `  ${i.label}${i.hint ? `  ${chalk.dim(i.hint)}` : ''}`).join('\n'), `s3://${sel}`);
        break;
      }

      case 'ec2': {
        const sp = spinner();
        sp.start('Describing instances...');
        const result = runAwsJson('ec2 describe-instances');
        sp.stop(result.ok ? 'Done' : 'Failed');
        if (!result.ok) { cancel(result.error); break; }
        const reservations = result.data?.Reservations || [];
        const instances = [];
        for (const r of reservations) {
          for (const inst of r.Instances || []) {
            const nameTag = (inst.Tags || []).find(t => t.Key === 'Name')?.Value || '';
            instances.push({ value: inst.InstanceId, label: nameTag || inst.InstanceId, hint: `${inst.InstanceType}  ${inst.State?.Name || ''}  ${(inst.LaunchTime || '').split('T')[0]}` });
          }
        }
        if (instances.length === 0) { note('No instances found', 'EC2'); break; }
        instances.push({ value: '__back', label: '← Back' });
        const sel = await select({ message: 'Select instance for details:', options: instances });
        if (isCancel(sel) || sel === '__back') break;

        // Show details
        const detailResult = runAwsJson(`ec2 describe-instances --instance-ids ${sel}`);
        if (!detailResult.ok) { cancel(detailResult.error); break; }
        const inst = detailResult.data?.Reservations?.[0]?.Instances?.[0];
        if (!inst) { cancel('Instance not found'); break; }
        const nameTag = (inst.Tags || []).find(t => t.Key === 'Name')?.Value || '';
        const sgs = (inst.SecurityGroups || []).map(sg => sg.GroupName).join(', ');
        note(
          `ID:       ${inst.InstanceId}\n` +
          `State:    ${inst.State?.Name || ''}\n` +
          `Type:     ${inst.InstanceType}\n` +
          `AZ:       ${inst.Placement?.AvailabilityZone || '-'}\n` +
          `VPC:      ${inst.VpcId || '-'}\n` +
          `Subnet:   ${inst.SubnetId || '-'}\n` +
          `${inst.PublicIpAddress ? `Public IP: ${inst.PublicIpAddress}\n` : ''}` +
          `${inst.PrivateIpAddress ? `Private IP: ${inst.PrivateIpAddress}\n` : ''}` +
          `SG:       ${sgs}`,
          `🖥️  ${nameTag || inst.InstanceId}`
        );
        break;
      }

      case 'logs': {
        const sp = spinner();
        sp.start('Fetching log groups...');
        const result = runAwsJson('logs describe-log-groups');
        sp.stop(result.ok ? 'Done' : 'Failed');
        if (!result.ok) { cancel(result.error); break; }
        const groups = (result.data?.logGroups || []).map(g => ({
          value: g.logGroupName,
          label: g.logGroupName.length > 60 ? g.logGroupName.slice(0, 58) + '..' : g.logGroupName,
          hint: g.storedBytes ? `${(g.storedBytes / 1024 / 1024).toFixed(1)}MB` : '',
        }));
        if (groups.length === 0) { note('No log groups found', 'Logs'); break; }
        groups.push({ value: '__back', label: '← Back' });
        const sel = await select({ message: 'Select log group for streams:', options: groups });
        if (isCancel(sel) || sel === '__back') break;

        sp.start('Fetching streams...');
        const streamResult = runAwsJson(`logs describe-log-streams --log-group-name ${sel} --order-by LastEventTime --descending --max-results 20`);
        sp.stop(streamResult.ok ? 'Done' : 'Failed');
        if (!streamResult.ok) { cancel(streamResult.error); break; }
        const streams = (streamResult.data?.logStreams || []).map(s => {
          const lastEvent = s.lastEventTimestamp ? new Date(s.lastEventTimestamp).toISOString().split('.')[0].replace('T', ' ') : '';
          return `${s.logStreamName}${lastEvent ? `  ${chalk.dim(lastEvent)}` : ''}`;
        });
        if (streams.length === 0) { note('No streams found', 'Logs'); break; }
        note(streams.join('\n'), `📝  ${sel}`);
        break;
      }

      case 'secrets': {
        const sp = spinner();
        sp.start('Listing secrets...');
        const result = runAwsJson('secretsmanager list-secrets');
        sp.stop(result.ok ? 'Done' : 'Failed');
        if (!result.ok) { cancel(result.error); break; }
        const secretList = result.data?.SecretList;
        if (!secretList || !Array.isArray(secretList) || secretList.length === 0) { note('No secrets found', 'Secrets'); break; }

        while (true) {
          const sel = await select({
            message: 'Select secret to view:',
            options: [
              ...secretList.map(s => ({
                value: s.Name,
                label: s.Name,
                hint: s.LastChangedDate ? s.LastChangedDate.split('T')[0] : '',
              })),
              { value: '__back', label: '← Back' },
            ],
          });
          if (isCancel(sel) || sel === '__back') break;

          sp.start('Getting secret value...');
          const valResult = runAwsJson(`secretsmanager get-secret-value --secret-id ${sel}`);
          sp.stop(valResult.ok ? 'Done' : 'Failed');
          if (!valResult.ok) { cancel(valResult.error); break; }

          const lines = formatSecretLines(sel, valResult.data);
          // Build a display string for note() — strip chalk codes for length check
          const display = lines.join('\n');
          note(display.length > 3000 ? display.slice(0, 3000) + '\n...(truncated)' : display, `🔐  ${sel}`);
        }
        break;
      }

      case 'profile': {
        const profiles = readProfiles();
        const opts = [
          ...(profiles.length > 0 ? profiles.map(p => ({
            value: p,
            label: p === activeProfile ? `${p}  ${chalk.green('(active)')}` : p,
          })) : []),
          { value: '__add', label: '➕  Add profile', hint: 'create new AWS profile' },
          { value: '__back', label: '← Back' },
        ];
        const sel = await select({ message: 'Switch profile:', options: opts });
        if (isCancel(sel) || sel === '__back') break;
        if (sel === '__add') {
          const result = await addProfile();
          note(result.filter(l => !l.includes('──')).join('\n'), 'Profile');
          break;
        }
        activeProfile = sel;
        saveState();
        note('', `🔑  Switched to "${sel}"`);
        break;
      }

      case 'login': {
        let ssoUrl = '';
        if (fs.existsSync(AWS_CONFIG)) {
          const config = fs.readFileSync(AWS_CONFIG, 'utf-8');
          const profileSection = config.match(new RegExp('\\[profile ' + activeProfile + '\\][^\\[]*'));
          if (profileSection) {
            const urlMatch = profileSection[0].match(/sso_start_url\s*=\s*(.+)/);
            if (urlMatch) ssoUrl = urlMatch[1].trim();
          }
        }
        if (ssoUrl) {
          const sp = spinner();
          sp.start('Opening browser for SSO login...');
          const result = runAws('sso login' + (activeProfile !== 'default' ? ' --profile ' + activeProfile : ''), { timeout: 120000, stdio: 'inherit' });
          sp.stop(result.ok || result.error === null ? 'Done' : 'Failed');
          if (result.ok || result.error === null) { note('Profile: ' + activeProfile, '✅  SSO login successful'); break; }
          cancel('Login failed: ' + (result.error || ''));
          break;
        }
        const action = await select({
          message: 'How to authenticate?',
          options: [
            { value: 'console', label: '🌐  Open Console sign-in', hint: 'browser' },
            { value: 'iam', label: '🔑  Add IAM access keys', hint: 'add profile' },
            { value: '__back', label: '← Back' },
          ],
        });
        if (isCancel(action) || action === '__back') break;
        if (action === 'console') {
          try {
            execFileSync('open', ['https://console.aws.amazon.com/']);
            note('', '🌐  Opened AWS Console in browser');
          } catch {
            note('https://console.aws.amazon.com/', 'AWS Console');
          }
        } else if (action === 'iam') {
          await addProfileMenu();
        }
        break;
      }

      case 'help': {
        const helpOpt = await select({
          message: 'What do you need help with?',
          options: [
            { value: 'sso', label: 'Get SSO Start URL', hint: 'company SSO portal' },
            { value: 'iam', label: 'Get IAM Access Keys', hint: 'create programmatic user' },
            { value: 'open', label: 'Open AWS Console', hint: 'in browser' },
            { value: '__back', label: '← Back' },
          ],
        });
        if (isCancel(helpOpt) || helpOpt === '__back') break;
        if (helpOpt === 'sso') {
          note(
            'Your company SSO URL looks like:\n' +
            chalk.cyan('https://<company>.awsapps.com/start') + '\n\n' +
            'Ask your cloud team or check email for "AWS SSO" invite.',
            'SSO Start URL'
          );
        } else if (helpOpt === 'iam') {
          note(
            '1. Open IAM Console → Users → your user\n' +
            '2. Click "Create access key"\n' +
            '3. Copy the Key ID and Secret Key\n' +
            '4. Run: profile add',
            'Create IAM Access Keys'
          );
        } else if (helpOpt === 'open') {
          const url = 'https://' + (activeRegion || 'us-east-1') + '.console.aws.amazon.com/console/home?region=' + (activeRegion || 'us-east-1');
          try {
            execFileSync('open', [url]);
            note('', '🌐  AWS Console opened in browser');
          } catch {
            note(url, 'AWS Console URL');
          }
        }
        break;
      }

      case 'regions': {
        const sp = spinner();
        sp.start('Fetching regions...');
        const savedRegion = activeRegion;
        if (!activeRegion) activeRegion = 'us-east-1';
        const result = runAwsJson('ec2 describe-regions --query Regions[].{Name:RegionName,Opt:OptInStatus}');
        if (!savedRegion) activeRegion = '';
        sp.stop(result.ok ? 'Done' : 'Failed');
        if (!result.ok) { cancel(result.error); break; }
        const regions = (result.data || []).map(r => ({
          value: r.Name || r.RegionName,
          label: `${r.Name || r.RegionName}  ${chalk.dim(r.Opt || '')}`,
          hint: r.Name === activeRegion ? 'current' : '',
        }));
        regions.push({ value: '__back', label: '← Back' });
        regions.push({ value: '__clear', label: 'Clear region setting' });
        const sel = await select({ message: 'Select region:', options: regions });
        if (isCancel(sel) || sel === '__back') break;
        if (sel === '__clear') { activeRegion = ''; saveState(); note('', '🌍  Region cleared'); break; }
        activeRegion = sel;
        saveState();
        note('', `🌍  Region set to ${sel}`);
        break;
      }
    }
  }

  outro('AWS done');
}

// ─── Tool definition ──────────────────────────────────────

const tool = defineTool({
  manifest: { name: 'aws', label: '☁️  AWS Manager', hint: 'S3, EC2, CloudWatch, profiles' },
  commands,
  execute,
  main,
});
export { commands, execute, main };
export const manifest = tool.manifest;
