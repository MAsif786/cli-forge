#!/usr/bin/env node
/**
 * devkit docker — Interactive Docker Manager
 * Full clack-powered UI. Also exports commands for direct use
 * from the devkit prompt after the menu closes.
 */
import { defineTool } from '../tool-sdk.js';
import { inlineSelect, inlineText } from '../inline.js';
import { cancel, confirm, isCancel, note, select, spinner, text } from '@clack/prompts';
import chalk from 'chalk';
import { execFileSync, execSync, spawn } from 'child_process';

// ─── Constants ────────────────────────────────────────────

const commands = [
  { name: 'list',    desc: 'List running containers' },
  { name: 'all',     desc: 'List all containers' },
  { name: 'start',   desc: 'Start a stopped container' },
  { name: 'stop',    desc: 'Stop a running container' },
  { name: 'restart', desc: 'Restart a container' },
  { name: 'rm',      desc: 'Remove a container' },
  { name: 'logs',    desc: 'View container logs' },
  { name: 'images',  desc: 'List images' },
  { name: 'rmi',     desc: 'Remove an image' },
  { name: 'prune',   desc: 'Prune dangling images' },
  { name: 'sysprune',desc: 'System prune' },
  { name: 'df',      desc: 'Disk usage' },
];

function docker(args, opts = {}) {
  try {
    return execFileSync('docker', args, { encoding: 'utf-8', timeout: opts.timeout || 15000, ...opts });
  } catch (e) {
    if (e.stdout) return e.stdout;
    throw e;
  }
}

function fmtTable(out) {
  if (!out || !out.trim()) return [];
  return out.trim().split('\n').filter(Boolean).map(l => `  ${l}`);
}

function isDockerReady() {
  try { execFileSync('docker', ['info'], { encoding: 'utf-8', timeout: 5000, stdio: 'ignore' }); return true; }
  catch { return false; }
}

function pickContainer(all = false, filter = '') {
  const args = all ? ['ps', '-a'] : ['ps'];
  if (filter) args.push('--filter', filter);
  args.push('--format', '{{.ID}}##{{.Names}}##{{.Image}}##{{.Status}}');
  const out = docker(args);
  if (!out || !out.trim()) return null;
  const containers = out.trim().split('\n').filter(Boolean).map(l => {
    const [id, name, image, status] = l.split('##');
    return { value: id, label: name, hint: `${image} — ${status}` };
  });
  return containers.length > 0 ? containers : null;
}

async function pickImage() {
  const out = docker(['images', '--format', '{{.Repository}}:{{.Tag}}##{{.ID}}##{{.Size}}']);
  if (!out || !out.trim()) return null;
  const imgs = out.trim().split('\n').filter(Boolean).map(l => {
    const [tag, id, size] = l.split('##');
    return { value: tag, label: tag, hint: `${id} (${size})` };
  });
  return imgs.length > 0 ? imgs : null;
}

async function execute(cmd) {
  if (!isDockerReady()) return [chalk.red('  Docker daemon not running')];

  switch (cmd) {
    case 'list': {
      const out = docker(['ps', '--format', 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}']);
      return [chalk.bold('  Running containers:')].concat(out ? fmtTable(out) : ['  None']);
    }
    case 'all': {
      const out = docker(['ps', '-a', '--format', 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}']);
      return [chalk.bold('  All containers:')].concat(out ? fmtTable(out) : ['  None']);
    }
    case 'images': {
      const out = docker(['images', '--format', 'table {{.Repository}}\t{{.Tag}}\t{{.ID}}\t{{.Size}}']);
      return [chalk.bold('  Images:')].concat(out ? fmtTable(out) : ['  None']);
    }
    case 'df': {
      const out = docker(['system', 'df']);
      return out ? [chalk.bold('  Docker disk usage:'), ...fmtTable(out)] : ['  Unable to get disk usage'];
    }
    case 'start': case 'stop': case 'restart': case 'rm': {
      const inf = { start: { all: true, filter: 'status=exited', verb: 'Starting', past: 'started' },
                    stop: { all: false, filter: '', verb: 'Stopping', past: 'stopped' },
                    restart: { all: false, filter: '', verb: 'Restarting', past: 'restarted' },
                    rm: { all: true, filter: '', verb: 'Removing', past: 'removed' } };
      const info = inf[cmd];
      const conts = pickContainer(info.all, info.filter);
      if (!conts) return ['  No containers found'];
      const sel = await inlineSelect('Select container:', conts);
      if (!sel) return ['  Cancelled'];
      try {
        const cArgs = cmd === 'rm' ? ['rm', '-f', sel] : [cmd, sel];
        docker(cArgs);
        return [chalk.green(`  Container ${info.past}: ${sel.slice(0, 12)}`)];
      } catch (e) { return [chalk.red(`  Failed: ${e.message}`)]; }
    }
    case 'logs': {
      const conts = pickContainer(false);
      if (!conts) return ['  No running containers'];
      const sel = await inlineSelect('Which container logs?', conts);
      if (!sel) return ['  Cancelled'];
      const tailStr = await inlineText('Tail lines:', '50');
      if (tailStr === null) return ['  Cancelled'];
      const tail = parseInt(tailStr, 10) || 50;

      let out;
      try {
        out = execFileSync('docker', ['logs', '--tail', String(tail), sel], { encoding: 'utf-8', timeout: 10000 });
      } catch (e) {
        out = e.stdout || '';
        if (!out && e.stderr) return [chalk.red(`  docker error: ${e.stderr.trim().split('\n').pop()}`)];
        if (!out) return [chalk.yellow('  No logs for this container')];
      }
      const allLines = out.trim().split('\n').filter(Boolean);
      if (allLines.length === 0) return [chalk.yellow('  No logs for this container')];

      const result = [chalk.bold(`  Logs (last ${tail}) for ${sel.slice(0, 12)}:`)];
      for (const l of allLines.slice(-30)) result.push(`  ${l}`);

      // Ask about follow mode
      const follow = await inlineSelect('Follow logs with -f?', [
        { value: 'yes', label: 'Yes, follow logs', hint: 'stream new output' },
        { value: 'no', label: 'No, just show logs', hint: '' },
      ]);
      if (follow === 'yes') {
        // We need caller's emit for streaming — return a special result that
        // signals the caller to run the follow loop.
        return ['__FOLLOW__', sel.slice(0, 12), String(tail)];
      }
      return result;
    }
    case 'rmi': {
      const imgs = await pickImage();
      if (!imgs) return ['  No images found'];
      const sel = await inlineSelect('Select image to remove:', imgs);
      if (!sel) return ['  Cancelled'];
      try { docker(['rmi', sel]); return [chalk.green(`  Removed: ${sel}`)]; }
      catch (e) { return [chalk.red(`  Failed: ${e.message}`)]; }
    }
    case 'prune': {
      const dangling = docker(['images', '-f', 'dangling=true', '--format', '{{.ID}} {{.Size}}']);
      if (!dangling || !dangling.trim()) return ['  No dangling images to prune'];
      const ok = await inlineSelect('Proceed with prune?', [
        { value: 'yes', label: 'Yes, prune' },
        { value: 'no', label: 'Cancel' },
      ]);
      if (ok !== 'yes') return ['  Cancelled'];
      try {
        const result = docker(['image', 'prune', '-f']);
        return [chalk.green(`  ${(result || '').trim().split('\n').filter(Boolean).pop() || 'Done'}`)];
      } catch (e) { return [chalk.red(`  Failed: ${e.message}`)]; }
    }
    case 'sysprune': {
      const ok = await inlineSelect('System prune -a --volumes?', [
        { value: 'yes', label: 'Yes, prune everything', hint: 'cannot be undone' },
        { value: 'no', label: 'Cancel' },
      ]);
      if (ok !== 'yes') return ['  Cancelled'];
      try {
        const result = docker(['system', 'prune', '-a', '--force', '--volumes'], { timeout: 120000 });
        const lines = (result || '').trim().split('\n').filter(Boolean);
        const sum = lines.find(l => l.includes('Total reclaimed') || l.includes('freed')) || 'System prune complete';
        return [chalk.green(`  ${sum}`)];
      } catch (e) { return [chalk.red(`  Failed: ${e.message}`)]; }
    }
    default:
      return [chalk.yellow(`  Unknown docker command: "${cmd}"`)];
  }
}

/**
 * Stream docker logs -f within the devkit interface.
 * Called by index.js when execute returns the __FOLLOW__ marker.
 */
async function followLogs(containerId, tail) {
  const child = spawn('docker', ['logs', '--tail', String(tail), '-f', containerId], { stdio: ['ignore', 'pipe', 'pipe'] });
  const isRaw = process.stdin.isRaw;
  if (!isRaw) { process.stdin.setRawMode(true); process.stdin.resume(); }
  process.stdout.write('\x1b[?25l');

  let running = true;
  const lines = [chalk.bold(`  Following logs for ${containerId} (press q to stop):`)];
  const lineBuffer = [];

  child.stdout.on('data', chunk => {
    for (const l of chunk.toString().split('\n').filter(Boolean)) {
      lineBuffer.push(l);
    }
  });
  child.stderr.on('data', chunk => {
    for (const l of chunk.toString().split('\n').filter(Boolean)) {
      lineBuffer.push(chalk.red(l));
    }
  });

  const stdinHandler = buf => {
    if (buf.toString() === 'q' || buf.toString() === '\x1b') running = false;
  };
  process.stdin.on('data', stdinHandler);

  while (running) {
    // Drain buffer
    while (lineBuffer.length > 0) {
      const l = lineBuffer.shift();
      lines.push(`  ${l}`);
    }
    if (lines.length > 200) lines.splice(0, lines.length - 150);

    // Render to terminal (write directly, not via devkit emit)
    process.stdout.write('\x1b[H\x1b[0J');
    const showLines = lines.slice(-(process.stdout.rows - 4));
    for (const l of showLines) {
      process.stdout.write(l.slice(0, process.stdout.columns - 1) + '\x1b[0K\n');
    }
    process.stdout.write(chalk.dim('  ── (q) quit ──') + '\x1b[0K');

    await new Promise(r => setTimeout(r, 100));
  }

  child.kill('SIGTERM');
  process.stdin.removeListener('data', stdinHandler);
  if (!isRaw) process.stdin.setRawMode(false);
  process.stdout.write('\x1b[?25h\n');
}

// ─── Container actions ──────────────────────────────────

async function listContainers(all = false) {
  const title = all ? 'All Containers' : 'Running Containers';
  const out = docker(all ? ['ps', '-a'] : ['ps', '--format', 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}']);
  if (!out || !out.trim()) { note('No containers found.', title); return; }
  note(out.trim(), title);
}

async function containerAction(action) {
  const actionInfo = {
    start: { all: true, filter: 'status=exited', verb: 'Starting', past: 'started' },
    stop: { all: false, filter: '', verb: 'Stopping', past: 'stopped' },
    restart: { all: false, filter: '', verb: 'Restarting', past: 'restarted' },
    rm: { all: true, filter: '', verb: 'Removing', past: 'removed' },
  };
  const info = actionInfo[action];
  const containers = pickContainer(info.all, info.filter);
  if (!containers) { note('No containers found.', 'Containers'); return; }

  containers.push({ value: '__back', label: '←  Back' });

  const selected = await select({
    message: 'Select a container:',
    options: containers,
  });
  if (isCancel(selected) || selected === '__back') return;

  const sp = spinner();
  sp.start(`${info.verb}...`);

  try {
    const cmdArgs = action === 'rm' ? ['rm', '-f', selected] : [action, selected];
    execFileSync('docker', cmdArgs, { stdio: 'pipe', timeout: 15000 });
    sp.stop(`${info.past.charAt(0).toUpperCase() + info.past.slice(1)}: ${selected.slice(0, 12)}`);
  } catch (e) {
    sp.stop('Failed');
    cancel(`Failed: ${e.message}`);
  }
}

async function viewLogs() {
  const containers = pickContainer(false);
  if (!containers) { note('No running containers.', 'Logs'); return; }

  containers.push({ value: '__back', label: '←  Back' });

  const selected = await select({ message: 'Which container logs?', options: containers });
  if (isCancel(selected) || selected === '__back') return;

  const tailStr = await text({ message: 'Tail lines:', initialValue: '50' });
  if (isCancel(tailStr)) return;
  const tail = parseInt(tailStr, 10) || 50;

  const out = docker(['logs', '--tail', String(tail), selected]);
  if (out) note(out.trim().split('\n').slice(-20).map(l => `  ${l}`).join('\n'), `Logs (last ${tail})`);

  const follow = await confirm({ message: 'Follow logs with -f?', initialValue: false });
  if (follow) {
    note('Tailing logs (Ctrl+C to stop)\n', 'Follow');
    try {
      const { execSync } = await import('child_process');
      execSync(`docker logs --tail ${tail} -f ${selected}`, { stdio: 'inherit' });
    } catch {}
  }
}

// ─── Image actions ──────────────────────────────────────

async function listImages() {
  const out = docker(['images', '--format', 'table {{.Repository}}\t{{.Tag}}\t{{.ID}}\t{{.Size}}\t{{.CreatedSince}}']);
  if (!out || !out.trim()) { note('No images found.', 'Images'); return; }
  note(out.trim(), 'Images');
}

async function removeImage() {
  const out = docker(['images', '--format', '{{.Repository}}:{{.Tag}}##{{.ID}}##{{.Size}}']);
  if (!out) { note('No images found.', 'Remove Image'); return; }

  const images = out.trim().split('\n').filter(Boolean).map(l => {
    const [tag, id, size] = l.split('##');
    return { value: tag, label: tag, hint: `${id} (${size})` };
  });
  if (images.length === 0) { note('No images found.', 'Remove Image'); return; }

  images.push({ value: '__back', label: '←  Back' });

  const selected = await select({ message: 'Select image to remove:', options: images });
  if (isCancel(selected) || selected === '__back') return;

  const sp = spinner();
  sp.start(`Removing ${selected}...`);
  try {
    execFileSync('docker', ['rmi', selected], { stdio: 'pipe' });
    sp.stop(`Removed: ${selected}`);
  } catch (e) {
    sp.stop('Failed');
    cancel(`Failed: ${e.message}`);
  }
}

async function pruneImages() {
  const dangling = docker(['images', '-f', 'dangling=true', '--format', '{{.Repository}}:{{.Tag}} {{.ID}} {{.Size}}']);
  if (!dangling || !dangling.trim()) { note('No dangling images to prune.', 'Prune'); return; }

  note(dangling.trim().split('\n').filter(Boolean).map(l => `  ${l}`).join('\n'), 'Dangling images');

  const proceed = await confirm({ message: 'Proceed with prune?', initialValue: false });
  if (!proceed) { note('Cancelled', 'Prune'); return; }

  const sp = spinner();
  sp.start('Pruning...');
  try {
    const result = docker(['image', 'prune', '-f']);
    sp.stop((result || '').trim().split('\n').filter(Boolean).pop() || 'Done');
  } catch (e) {
    sp.stop('Failed');
    cancel(`Failed: ${e.message}`);
  }
}

// ─── System actions ─────────────────────────────────────

async function systemPrune() {
  note(
    '• All stopped containers\n• All dangling images\n• All unused networks\n• All unused volumes\n• All build cache',
    'System Prune — cannot be undone'
  );

  const df = docker(['system', 'df']);
  if (df) note(df.trim(), 'Current disk usage');

  const proceed = await confirm({ message: 'Proceed with system prune -a --volumes?', initialValue: false });
  if (!proceed) { note('Cancelled', 'System Prune'); return; }

  const sp = spinner();
  sp.start('Pruning system...');
  try {
    const result = docker(['system', 'prune', '-a', '--force', '--volumes'], { timeout: 120000 });
    const lines = (result || '').trim().split('\n').filter(Boolean);
    const summary = lines.filter(l => l.includes('Total reclaimed') || l.includes('freed'));
    sp.stop(summary.length > 0 ? summary[0] : 'System prune complete');
  } catch (e) {
    sp.stop('Failed');
    cancel(`Prune failed: ${e.message}`);
  }
}

async function diskUsage() {
  const out = docker(['system', 'df']);
  if (!out) { note('Unable to get disk usage.', 'Disk Usage'); return; }
  note(out.trim(), 'Docker Disk Usage');
}

// ─── Main — Full clack menu ────────────────────────────

const tool = defineTool({
  manifest: { name: 'docker', label: '🐳  Docker', hint: 'container lifecycle, logs, images', keywords: ['container', 'compose', 'image', 'k8s', 'podman', 'prune', 'daemon', 'registry'] },
  commands,
  execute,
  followLogs,
});
export { commands, execute, followLogs };
export const manifest = tool.manifest;
