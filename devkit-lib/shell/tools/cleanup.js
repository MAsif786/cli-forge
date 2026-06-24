#!/usr/bin/env node
/**
 * devkit cleanup — Mac Storage Cleanup (clack-powered)
 */
import { defineTool } from '../tool-sdk.js';
import { intro, outro, select, spinner, multiselect, confirm, isCancel, note } from '@clack/prompts';
import chalk from 'chalk';
import { execFileSync, execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

// ─── Constants ────────────────────────────────────────────

const commands = [
  { name: 'scan', desc: 'Scan and clean up disk space' },
];

async function execute(cmd) {
  if (cmd === 'scan') {
    const items = [];
    await scanDocker(items);
    await scanNpm(items);
    await scanPip(items);
    await scanHomebrew(items);
    await scanCaches(items);
    await scanTrash(items);
    await scanOldVenvs(items);
    await scanNodeModules(items);
    await scanDeveloper(items);
    await scanDownloads(items);

    if (items.length === 0) return ['  Nothing to clean — system is tidy!'];

    const out = [chalk.bold(`  Found ${items.length} items to clean:`), chalk.dim('  ────────')];
    for (const item of items) out.push(`  ${chalk.yellow('•')} ${item.label}: ${item.size}`);
    return out;
  }
  return [chalk.yellow(`  Unknown cleanup command: "${cmd}"`)];
}

const HOME = os.homedir();

function duSize(dir) {
  try {
    const out = execFileSync('du', ['-sh', dir], { encoding: 'utf-8', timeout: 10000 });
    return out.trim().split('\t')[0] || '0B';
  } catch { return '0B'; }
}

async function ensureCmd(cmd) {
  try { execFileSync('which', [cmd], { stdio: 'ignore' }); return true; }
  catch { return false; }
}

// ─── Scan helpers ──────────────────────────────────────

async function scanDocker(items) {
  if (!await ensureCmd('docker')) return;
  try {
    execFileSync('docker', ['info'], { encoding: 'utf-8', timeout: 5000, stdio: 'ignore' });
  } catch { return; }

  const df = execFileSync('docker', ['system', 'df'], { encoding: 'utf-8', timeout: 30000 });
  const lines = df.trim().split('\n');

  let reclaim = 0;
  for (const line of lines) {
    if (line.includes('Images') || line.includes('Build Cache')) {
      const parts = line.trim().split(/\s+/);
      const val = parseFloat(parts[parts.length - 1]);
      if (!isNaN(val)) reclaim += val;
    }
  }

  if (reclaim > 0) {
    items.push({ key: 'docker', label: `Docker (images + build cache)`, size: `~${reclaim.toFixed(1)}GB` });
    const dfLines = lines.map(l => `  ${l}`).join('\n');
    return dfLines;
  }
}

async function scanNpm(items) {
  const npmDir = path.join(HOME, '.npm');
  const pnpmDir = path.join(HOME, 'Library', 'Caches', 'pnpm');

  for (const [key, dir] of [['npm', npmDir], ['pnpm', pnpmDir]]) {
    if (fs.existsSync(dir)) {
      const size = duSize(dir);
      if (size !== '0B') items.push({ key, label: `${key} cache`, size });
    }
  }
}

async function scanPip(items) {
  const dirs = [
    path.join(HOME, 'Library', 'Caches', 'pip'),
    path.join(HOME, '.cache', 'uv'),
    path.join(HOME, '.cache', 'pre-commit'),
    path.join(HOME, '.cache', 'pipenv'),
    path.join(HOME, '.cache', 'poetry'),
  ];
  for (const dir of dirs) {
    if (fs.existsSync(dir)) {
      const size = duSize(dir);
      const name = path.basename(dir);
      if (size !== '0B') items.push({ key: name, label: `${name} cache`, size });
    }
  }
}

async function scanHomebrew(items) {
  if (!await ensureCmd('brew')) return;
  const dir = path.join(HOME, 'Library', 'Caches', 'Homebrew');
  if (fs.existsSync(dir)) {
    const size = duSize(dir);
    if (size !== '0B') items.push({ key: 'homebrew', label: 'Homebrew cache', size });
  }
}

async function scanCaches(items) {
  const cacheDirs = [
    { key: 'google', dir: path.join(HOME, 'Library', 'Caches', 'Google') },
    { key: 'steam', dir: path.join(HOME, 'Library', 'Caches', 'Steam') },
    { key: 'siri', dir: path.join(HOME, 'Library', 'Caches', 'SiriTTS') },
    { key: 'vscode', dir: path.join(HOME, 'Library', 'Caches', 'vscode-cpptools') },
    { key: 'msedge', dir: path.join(HOME, 'Library', 'Caches', 'Microsoft Edge') },
    { key: 'geoservices', dir: path.join(HOME, 'Library', 'Caches', 'GeoServices') },
    { key: 'puppeteer', dir: path.join(HOME, 'Library', 'Caches', 'puppeteer') },
  ];
  for (const { key, dir } of cacheDirs) {
    if (fs.existsSync(dir)) {
      const size = duSize(dir);
      if (size !== '0B') items.push({ key: `cache_${key}`, label: `${key} cache`, size });
    }
  }
}

async function scanTrash(items) {
  const dir = path.join(HOME, '.Trash');
  if (fs.existsSync(dir)) {
    const size = duSize(dir);
    if (size !== '0B') items.push({ key: 'trash', label: 'Trash', size });
  }
}

async function scanOldVenvs(items) {
  const venvDirs = [
    path.join(HOME, '.venv2'), path.join(HOME, '.venv3'),
    path.join(HOME, 'venv'), path.join(HOME, 'env'),
  ];
  for (const dir of venvDirs) {
    if (fs.existsSync(dir)) {
      const size = duSize(dir);
      if (size !== '0B') items.push({ key: `venv_${path.basename(dir)}`, label: `Old venv (${path.basename(dir)})`, size });
    }
  }
}

async function scanNodeModules(items) {
  const desktop = path.join(HOME, 'Desktop');
  if (!fs.existsSync(desktop)) return;
  try {
    const out = execFileSync('find', [desktop, '-maxdepth', '3', '-name', 'node_modules', '-type', 'd', '-size', '+100M', '-not', '-path', '*/\.*'], { encoding: 'utf-8', timeout: 15000 });
    const dirs = out.trim().split('\n').filter(Boolean);
    for (const dir of dirs.slice(0, 10)) {
      const size = duSize(dir);
      const parent = path.basename(path.dirname(dir));
      items.push({ key: `nm_${parent}`, label: `node_modules (${parent})`, size });
    }
  } catch { /* timeout or no find */ }
}

async function scanDeveloper(items) {
  const dir = path.join(HOME, 'Library', 'Developer');
  if (fs.existsSync(dir)) {
    const size = duSize(dir);
    if (size !== '0B') items.push({ key: 'xcode', label: 'Xcode/Developer data', size });
  }
}

async function scanDownloads(items) {
  const dir = path.join(HOME, 'Downloads');
  if (!fs.existsSync(dir)) return;
  const size = duSize(dir);
  try {
    const dmgCount = execSync(`find "${dir}" -maxdepth 1 -name "*.dmg" -type f 2>/dev/null | wc -l`, { encoding: 'utf-8' }).trim();
    const bigCount = execSync(`find "${dir}" -maxdepth 1 -type f -size +100M 2>/dev/null | wc -l`, { encoding: 'utf-8' }).trim();
    items.push({ key: 'downloads', label: 'Downloads', size: `${size} (${dmgCount} DMGs, ${bigCount} large files)` });
  } catch {
    items.push({ key: 'downloads', label: 'Downloads', size });
  }
}

// ─── Clean helpers ──────────────────────────────────────

async function cleanItems(selectedKeys) {
  const results = [];

  for (const key of selectedKeys) {
    const s = spinner();
    s.start(`Cleaning ${key}...`);

    try {
      switch (true) {
        case key === 'docker':
          execFileSync('docker', ['system', 'prune', '-a', '--force', '--volumes'], { stdio: 'pipe', timeout: 120000 });
          s.stop('Docker cleaned');
          results.push('Docker system pruned');
          break;

        case key === 'npm':
          execFileSync('npm', ['cache', 'clean', '--force'], { stdio: 'pipe', timeout: 30000 });
          s.stop('npm cache cleaned');
          results.push('npm cache cleaned');
          break;

        case key === 'pnpm':
          fs.rmSync(path.join(HOME, 'Library', 'Caches', 'pnpm'), { recursive: true, force: true });
          s.stop('pnpm cache cleaned');
          results.push('pnpm cache cleaned');
          break;

        case key === 'pip' || key === 'uv' || key === 'pre-commit' || key === 'pipenv' || key === 'poetry':
          fs.rmSync(path.join(HOME, key === 'pip' ? 'Library/Caches/pip' : `.cache/${key}`), { recursive: true, force: true });
          s.stop(`${key} cache cleaned`);
          results.push(`${key} cache cleaned`);
          break;

        case key === 'homebrew':
          execFileSync('brew', ['cleanup', '--prune=all'], { stdio: 'pipe', timeout: 60000 });
          fs.rmSync(path.join(HOME, 'Library', 'Caches', 'Homebrew', 'downloads'), { recursive: true, force: true });
          s.stop('Homebrew cleaned');
          results.push('Homebrew cleaned');
          break;

        case key.startsWith('cache_'):
          // Map cache keys to paths
          const caches = {
            cache_google: 'Library/Caches/Google',
            cache_steam: 'Library/Caches/Steam',
            cache_siri: 'Library/Caches/SiriTTS',
            cache_vscode: 'Library/Caches/vscode-cpptools',
            cache_msedge: 'Library/Caches/Microsoft Edge',
            cache_geoservices: 'Library/Caches/GeoServices',
            cache_puppeteer: 'Library/Caches/puppeteer',
          };
          const relPath = caches[key];
          if (relPath) {
            fs.rmSync(path.join(HOME, relPath), { recursive: true, force: true });
            s.stop(`${key.replace('cache_', '')} cache cleaned`);
            results.push(`${key.replace('cache_', '')} cache cleaned`);
          }
          break;

        case key === 'trash':
          execSync(`rm -rf "${HOME}/.Trash/"* 2>/dev/null`, { stdio: 'ignore' });
          s.stop('Trash emptied');
          results.push('Trash emptied');
          break;

        case key.startsWith('venv_'):
          const venvName = key.replace('venv_', '');
          fs.rmSync(path.join(HOME, venvName), { recursive: true, force: true });
          s.stop(`venv (${venvName}) removed`);
          results.push(`venv (${venvName}) removed`);
          break;

        case key.startsWith('nm_'):
          // Find and remove the specific node_modules
          const nmParent = key.replace('nm_', '');
          try {
            const out = execFileSync('find', [path.join(HOME, 'Desktop'), '-maxdepth', '3', '-name', 'node_modules', '-path', `*/${nmParent}/node_modules`, '-type', 'd'], { encoding: 'utf-8', timeout: 10000 });
            const dir = out.trim();
            if (dir) { fs.rmSync(dir, { recursive: true, force: true }); s.stop(`node_modules (${nmParent}) removed`); results.push(`node_modules (${nmParent}) removed`); }
            else { s.stop('Not found'); }
          } catch { s.stop('Not found'); }
          break;

        case key === 'xcode':
          const xcodeDirs = ['Library/Developer/Xcode/DerivedData', 'Library/Developer/Xcode/Archives', 'Library/Developer/CoreSimulator/Caches'];
          for (const d of xcodeDirs) {
            fs.rmSync(path.join(HOME, d), { recursive: true, force: true });
          }
          s.stop('Xcode data cleaned');
          results.push('Xcode derived data & archives removed');
          break;

        case key === 'downloads':
          execSync(`rm -f "${HOME}/Downloads/"*.dmg "${HOME}/Downloads/"*.crdownload "${HOME}/Downloads/"*.part 2>/dev/null`, { stdio: 'ignore' });
          s.stop('Downloads cleaned');
          results.push('DMGs & partial downloads removed');
          break;
      }
    } catch (e) {
      s.stop('Failed');
      results.push(`${key}: failed - ${e.message}`);
    }
  }

  return results;
}

// ─── Main ───────────────────────────────────────────────

async function main() {
  intro(chalk.bold('devkit cleanup — Mac Storage Cleanup'));

  const sp = spinner();
  sp.start('Scanning system...');

  const items = [];

  const dockerInfo = await scanDocker(items);
  await scanNpm(items);
  await scanPip(items);
  await scanHomebrew(items);
  await scanCaches(items);
  await scanTrash(items);
  await scanOldVenvs(items);
  await scanNodeModules(items);
  await scanDeveloper(items);
  await scanDownloads(items);

  sp.stop('Scan complete');

  // Show disk before
  const dfBefore = execFileSync('df', ['-h', '/'], { encoding: 'utf-8' });
  const availBefore = dfBefore.trim().split('\n')[1].split(/\s+/)[3];
  note(`Available: ${availBefore}`, 'Disk');

  if (items.length === 0) {
    note('Nothing to clean — system is tidy!', 'Cleanup');
    outro('Done');
    return;
  }

  // Show summary
  const summaryLines = items.map(i => chalk.yellow(`  • ${i.label}: ${i.size}`)).join('\n');
  note(summaryLines, 'Items found');

  // Multi-select
  const selected = await multiselect({
    message: 'Select items to clean (Space to toggle, Enter to confirm):',
    options: [
      ...items.map(item => ({ value: item.key, label: `${item.label} (${item.size})` })),
    ],
    required: false,
  });

  if (isCancel(selected) || !selected || selected.length === 0) {
    note('Cancelled — nothing cleaned', 'Cleanup');
    outro('Done');
    return;
  }

  // Clean selected items
  const results = await cleanItems(selected);

  // Show results
  if (results.length > 0) {
    note(results.map(r => `  ${chalk.green('✓')} ${r}`).join('\n'), 'Cleaned');
  }

  // Show disk after
  const dfAfter = execFileSync('df', ['-h', '/'], { encoding: 'utf-8' });
  const availAfter = dfAfter.trim().split('\n')[1].split(/\s+/)[3];
  note(`${chalk.cyan(availBefore)} → ${chalk.green(availAfter)}`, 'Disk available');

  outro('Cleanup complete');
}

const tool = defineTool({
  manifest: { name: 'cleanup', label: '🧹  Disk Cleanup', hint: 'scan and free up space' },
  commands,
  execute,
  main,
});
export { commands, execute, main };
export const manifest = tool.manifest;
