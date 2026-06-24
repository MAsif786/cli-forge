#!/usr/bin/env node
/**
 * devkit db — Interactive Database Client
 * Query PostgreSQL, SQLite, and MySQL databases.
 */
import { defineTool } from '../tool-sdk.js';
import { inlineText } from '../inline.js';
import { intro, outro, select, spinner, text, confirm, isCancel, cancel, note } from '@clack/prompts';
import chalk from 'chalk';
import { execFileSync, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ─── Constants ────────────────────────────────────────────

const CONFIG_DIR = path.join(os.homedir(), '.devkit', 'db');
const CONFIG_FILE = path.join(CONFIG_DIR, 'connections.json');
const DB_TYPES = ['postgres', 'sqlite', 'mysql', 'mariadb'];

const commands = [
  { name: 'saved',      desc: 'List saved database connections' },
  { name: 'connect',    desc: 'Connect to a database (set as active)' },
  { name: 'tables',     desc: 'List tables on the active connection' },
  { name: 'query',      desc: 'Run a SQL query on the active connection' },
  { name: 'save',       desc: 'Save a new database connection' },
  { name: 'remove',     desc: 'Remove a saved connection' },
  { name: 'disconnect', desc: 'Clear the active connection' },
];

// ─── State ────────────────────────────────────────────────

let activeConnection = null; // { name, type, host, port, user, password, database, path }

// ─── Helpers ──────────────────────────────────────────────

function ensureDir(dir) { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); }

function readConnections() {
  try {
    if (fs.existsSync(CONFIG_FILE)) return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
  } catch {}
  return [];
}

function writeConnections(conns) {
  ensureDir(CONFIG_DIR);
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(conns, null, 2) + '\n');
}

function checkBin(name) {
  try { execFileSync('which', [name], { stdio: 'ignore' }); return true; }
  catch { return false; }
}

function formatRow(values, widths) {
  return '│ ' + values.map((v, i) => {
    const s = String(v == null ? 'NULL' : v);
    return s.length > widths[i] ? s.slice(0, widths[i] - 1) + '…' : s.padEnd(widths[i]);
  }).join(' │ ') + ' │';
}

function formatQueryResult(raw, separator = '\t') {
  if (!raw || !raw.trim()) return ['  (empty result)'];

  const lines = raw.trim().split('\n').filter(Boolean);
  if (lines.length <= 1) return [`  ${lines[0] || '(empty)'}`];

  // Parse rows as tab-separated
  const rows = lines.map(l => l.split(separator));
  if (rows.length === 0) return ['  (empty)'];

  // Compute column widths
  const cols = rows[0].length;
  const widths = [];
  for (let c = 0; c < cols; c++) {
    let maxW = 0;
    for (const row of rows) {
      const val = String(row[c] == null ? 'NULL' : row[c]);
      if (val.length > maxW) maxW = val.length;
    }
    widths.push(Math.min(maxW, 40));
  }

  const totalW = widths.reduce((s, w) => s + w + 3, 0) + 1;
  const sep = '├' + widths.map(w => '─'.repeat(w + 2)).join('┼') + '┤';
  const top = '┌' + widths.map(w => '─'.repeat(w + 2)).join('┬') + '┐';

  const result = [];
  result.push(`  ${top}`);
  // Header row
  result.push(`  ${formatRow(rows[0], widths)}`);
  result.push(`  ${sep}`);
  // Data rows
  for (let r = 1; r < rows.length; r++) {
    result.push(`  ${formatRow(rows[r], widths)}`);
  }
  result.push(`  └${widths.map(w => '─'.repeat(w + 2)).join('┴')}┘`);
  result.push(chalk.dim(`  ${rows.length - 1} row(s)`));

  return result;
}

function buildConnString(conn) {
  switch (conn.type) {
    case 'postgres': {
      const env = { ...process.env };
      if (conn.password) env.PGPASSWORD = conn.password;
      return {
        bin: 'psql',
        args: ['-h', conn.host, '-p', String(conn.port || 5432), '-U', conn.user, '-d', conn.database],
        env,
      };
    }
    case 'mysql':
    case 'mariadb': {
      const env = { ...process.env };
      if (conn.password) env.MYSQL_PWD = conn.password;
      return {
        bin: conn.type === 'mariadb' ? 'mariadb' : 'mysql',
        args: ['-h', conn.host, '-P', String(conn.port || 3306), '-u', conn.user, conn.database],
        env,
      };
    }
    case 'sqlite': {
      return { bin: 'sqlite3', args: [conn.path], env: process.env };
    }
    default:
      return null;
  }
}

function testConnection(conn) {
  const info = buildConnString(conn);
  if (!info) return { ok: false, error: `Unknown type: ${conn.type}` };

  if (!checkBin(info.bin)) return { ok: false, error: `${info.bin} not found` };
  if (conn.type === 'sqlite' && !fs.existsSync(conn.path)) return { ok: false, error: `Database file not found: ${conn.path}` };

  try {
    switch (conn.type) {
      case 'postgres':
        execFileSync(info.bin, [...info.args, '-c', 'SELECT 1'], { encoding: 'utf-8', timeout: 8000, env: info.env, stdio: ['ignore', 'pipe', 'pipe'] });
        break;
      case 'mysql':
      case 'mariadb':
        execFileSync(info.bin, [...info.args, '-e', 'SELECT 1'], { encoding: 'utf-8', timeout: 8000, env: info.env, stdio: ['ignore', 'pipe', 'pipe'] });
        break;
      case 'sqlite':
        execFileSync(info.bin, [conn.path, 'SELECT 1'], { encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] });
        break;
    }
    return { ok: true, error: null };
  } catch (e) {
    // Extract meaningful error
    let msg = e.message;
    if (e.stderr) {
      const lines = e.stderr.trim().split('\n');
      msg = lines[lines.length - 1] || msg;
    }
    return { ok: false, error: msg };
  }
}

function runQuery(conn, sql) {
  const info = buildConnString(conn);
  if (!info) return { ok: false, error: `Unknown type: ${conn.type}`, raw: '' };

  try {
    switch (conn.type) {
      case 'postgres': {
        const out = execFileSync(info.bin, [...info.args, '--no-align', '--field-separator', '\t', '-c', sql], { encoding: 'utf-8', timeout: 30000, env: info.env });
        // Strip notice/INFO lines
        const clean = out.split('\n').filter(l => !l.startsWith('NOTICE:') && !l.startsWith('INFO:') && !l.startsWith('WARNING:')).join('\n');
        return { ok: true, raw: clean, error: null };
      }
      case 'mysql':
      case 'mariadb': {
        const out = execFileSync(info.bin, [...info.args, '--batch', '--silent', '-e', sql], { encoding: 'utf-8', timeout: 30000, env: info.env });
        return { ok: true, raw: out, error: null };
      }
      case 'sqlite': {
        const out = execFileSync(info.bin, [conn.path, '-header', '-separator', '\t', sql], { encoding: 'utf-8', timeout: 10000 });
        return { ok: true, raw: out, error: null };
      }
      default:
        return { ok: false, error: `Unknown type: ${conn.type}`, raw: '' };
    }
  } catch (e) {
    let msg = e.message;
    if (e.stderr) {
      const lines = e.stderr.trim().split('\n');
      msg = lines[lines.length - 1] || msg;
    }
    return { ok: false, error: msg, raw: e.stdout || '' };
  }
}

function getTables(conn) {
  switch (conn.type) {
    case 'postgres':
      return runQuery(conn, "SELECT table_schema || '.' || table_name FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog', 'information_schema') ORDER BY table_schema, table_name");
    case 'mysql':
    case 'mariadb':
      return runQuery(conn, 'SHOW TABLES');
    case 'sqlite':
      return runQuery(conn, "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
    default:
      return { ok: false, error: `Unknown type: ${conn.type}`, raw: '' };
  }
}

// ─── SQL Suggestions ────────────────────────────────────

const SQL_KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'IN', 'LIKE', 'BETWEEN',
  'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE', 'CREATE', 'TABLE',
  'ALTER', 'ADD', 'COLUMN', 'DROP', 'INDEX', 'VIEW', 'AS', 'ON', 'JOIN',
  'LEFT', 'RIGHT', 'INNER', 'OUTER', 'CROSS', 'FULL', 'GROUP', 'BY',
  'ORDER', 'ASC', 'DESC', 'HAVING', 'LIMIT', 'OFFSET', 'UNION', 'ALL',
  'DISTINCT', 'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'EXISTS', 'CASE',
  'WHEN', 'THEN', 'ELSE', 'END', 'NULL', 'IS', 'NOT', 'TRUE', 'FALSE',
  'PRIMARY', 'KEY', 'FOREIGN', 'REFERENCES', 'CONSTRAINT', 'DEFAULT',
  'CHECK', 'UNIQUE', 'CASCADE', 'RESTRICT', 'BEGIN', 'COMMIT', 'ROLLBACK',
  'TRANSACTION', 'GRANT', 'REVOKE', 'EXPLAIN', 'ANALYZE', 'VACUUM',
];

function getSchemaSuggestions() {
  if (!activeConnection) return SQL_KEYWORDS.map(k => ({ value: k, label: k, desc: 'SQL keyword', type: 'keyword' }));

  const suggestions = SQL_KEYWORDS.map(k => ({ value: k, label: k, desc: 'SQL keyword', type: 'keyword' }));

  try {
    const tables = getTables(activeConnection);
    if (tables.ok && tables.raw.trim()) {
      const tableRows = tables.raw.trim().split('\n').filter(Boolean);
      // Skip header row (first line is the column name from the query result)
      for (let i = 1; i < tableRows.length; i++) {
        const name = tableRows[i].split('\t')[0];
        if (name) {
          suggestions.push({ value: name, label: name, desc: 'table', type: 'table' });
        }
      }

      // Fetch column names for each table (PostgreSQL only for now)
      if (activeConnection.type === 'postgres') {
        try {
          const colResult = runQuery(activeConnection,
            "SELECT column_name, table_name FROM information_schema.columns " +
            "WHERE table_schema NOT IN ('pg_catalog', 'information_schema') " +
            "ORDER BY table_name, ordinal_position"
          );
          if (colResult.ok && colResult.raw.trim()) {
            const colRows = colResult.raw.trim().split('\n').filter(Boolean);
            for (let i = 1; i < colRows.length; i++) {
              const parts = colRows[i].split('\t');
              if (parts.length >= 2) {
                const col = parts[0];
                const tbl = parts[1];
                suggestions.push({ value: col, label: col, desc: `${tbl}.column`, type: 'column' });
              }
            }
          }
        } catch {}
      }

      // SQLite column info
      if (activeConnection.type === 'sqlite') {
        for (const row of tableRows.slice(1)) {
          const tbl = row.split('\t')[0];
          if (!tbl) continue;
          try {
            const info = runQuery(activeConnection, `PRAGMA table_info('${tbl}')`);
            if (info.ok && info.raw.trim()) {
              const pRows = info.raw.trim().split('\n').filter(Boolean);
              for (let i = 1; i < pRows.length; i++) {
                const col = pRows[i].split('\t')[1];
                if (col) suggestions.push({ value: col, label: col, desc: `${tbl}.column`, type: 'column' });
              }
            }
          } catch {}
        }
      }

      // MySQL column info
      if (activeConnection.type === 'mysql' || activeConnection.type === 'mariadb') {
        try {
          const colResult = runQuery(activeConnection,
            "SELECT COLUMN_NAME, TABLE_NAME FROM information_schema.COLUMNS " +
            "WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME, ORDINAL_POSITION"
          );
          if (colResult.ok && colResult.raw.trim()) {
            const colRows = colResult.raw.trim().split('\n').filter(Boolean);
            for (let i = 1; i < colRows.length; i++) {
              const parts = colRows[i].split('\t');
              if (parts.length >= 2) {
                suggestions.push({ value: parts[0], label: parts[0], desc: `${parts[1]}.column` });
              }
            }
          }
        } catch {}
      }
    }
  } catch {}

  return suggestions;
}

// ─── Execute ──────────────────────────────────────────────

async function execute(cmd) {
  const parts = cmd.trim().split(/\s+/);
  const name = parts[0];
  const arg = parts.slice(1).join(' ');

  switch (name) {
    case 'saved': {
      const conns = readConnections();
      if (conns.length === 0) return [chalk.yellow('  No saved connections. Use "save" to add one.')];
      const lines = [chalk.bold(`  ${conns.length} saved connection(s):`)];
      lines.push(chalk.dim('  ───────────────────────────────────────────────'));
      for (const c of conns) {
        const active = activeConnection?.name === c.name ? chalk.green(' ●') : '  ';
        const typeIcon = { postgres: '🐘', sqlite: '🗄️', mysql: '🐬', mariadb: '🐬' }[c.type] || '📦';
        const detail = c.type === 'sqlite' ? c.path : `${c.host}:${c.port || 5432}/${c.database}`;
        lines.push(`  ${typeIcon}${active} ${chalk.bold(c.name.padEnd(18))} ${chalk.dim(detail)}`);
      }
      return lines;
    }

    case 'connect': {
      const conns = readConnections();
      if (conns.length === 0) return [chalk.yellow('  No saved connections. Use "save" to add one first.')];

      let conn;
      if (arg) {
        conn = conns.find(c => c.name === arg);
        if (!conn) return [chalk.yellow(`  Connection "${arg}" not found`)];
      } else {
        // Show connection prompt — need to test and select
        const opts = conns.map(c => {
          const hint = c.type === 'sqlite' ? c.path : `${c.user}@${c.host}:${c.port || 5432}/${c.database}`;
          return { value: c.name, label: `${c.name}  (${c.type})`, hint };
        });
        const sel = await inlineSelect('Select database:', opts);
        if (!sel) return ['  Cancelled'];
        conn = conns.find(c => c.name === sel);
      }

      // Test connection
      const result = testConnection(conn);
      if (!result.ok) {
        activeConnection = null;
        return [chalk.red(`  ❌  Connection failed: ${result.error}`)];
      }

      activeConnection = conn;
      const lines = [chalk.green(`  ✅  Connected to ${conn.name} (${conn.type})`)];
      lines.push(chalk.dim(`  ── ${conn.type === 'sqlite' ? conn.path : `${conn.host}:${conn.port || 5432}/${conn.database}`} ──`));

      // Show tables
      const tables = getTables(conn);
      if (tables.ok && tables.raw.trim()) {
        const tableLines = tables.raw.trim().split('\n').filter(Boolean);
        if (tableLines.length > 1) {
          const tableCount = tableLines.length - 1; // minus header
          lines.push(chalk.dim(`  Tables: ${tableCount}`));
          const showTables = tableLines.slice(1, Math.min(11, tableLines.length));
          for (const t of showTables) lines.push(`    ${t.split('\t')[0] || t}`);
          if (tableLines.length > 11) lines.push(chalk.dim(`    ... and ${tableLines.length - 11} more`));
        }
      }

      return lines;
    }

    case 'disconnect': {
      activeConnection = null;
      return [chalk.dim('  ── disconnected ──')];
    }

    case 'tables': {
      if (!activeConnection) return [chalk.yellow('  No active connection. Use "connect" first.')];
      const result = getTables(activeConnection);
      if (!result.ok) return [chalk.red(`  Query failed: ${result.error}`)];
      return formatQueryResult(result.raw);
    }

    case 'query': {
      if (!activeConnection) return [chalk.yellow('  No active connection. Use "connect" first.')];
      let sql = arg;
      if (!sql) {
        const suggestions = getSchemaSuggestions();
        sql = await inlineText('SQL query:', '', suggestions);
        if (!sql) return ['  Cancelled'];
      }
      const result = runQuery(activeConnection, sql);
      if (!result.ok) return [chalk.red(`  ❌  Query failed: ${result.error}`)];
      const lines = [chalk.bold(`  SQL: ${sql}`)];
      lines.push(...formatQueryResult(result.raw));
      return lines;
    }

    case 'save': {
      const name = await inlineText('Connection name:');
      if (!name) return ['  Cancelled'];

      const dbType = await inlineSelect('Database type:', [
        { value: 'postgres', label: 'PostgreSQL' },
        { value: 'sqlite',   label: 'SQLite' },
        { value: 'mysql',    label: 'MySQL' },
        { value: 'mariadb',  label: 'MariaDB' },
      ]);
      if (!dbType) return ['  Cancelled'];

      let conn;
      if (dbType === 'sqlite') {
        const dbPath = await inlineText('Path to SQLite database:');
        if (!dbPath) return ['  Cancelled'];
        conn = { name, type: dbType, path: dbPath };
      } else {
        const host = await inlineText('Host:', 'localhost');
        if (!host) return ['  Cancelled'];
        const port = await inlineText('Port:', dbType === 'postgres' ? '5432' : '3306');
        if (!port) return ['  Cancelled'];
        const user = await inlineText('User:', 'root');
        if (!user) return ['  Cancelled'];
        const password = await inlineText('Password (leave empty if none):', '');
        if (password === null) return ['  Cancelled'];
        const database = await inlineText('Database name:');
        if (!database) return ['  Cancelled'];
        conn = { name, type: dbType, host, port: parseInt(port, 10) || 5432, user, password, database };
      }

      const conns = readConnections();
      const existing = conns.findIndex(c => c.name === name);
      if (existing >= 0) {
        const overwrite = await inlineSelect(`"${name}" already exists. Overwrite?`, [
          { value: 'yes', label: 'Yes, overwrite' },
          { value: 'no', label: 'Cancel' },
        ]);
        if (overwrite !== 'yes') return ['  Cancelled'];
        conns[existing] = conn;
      } else {
        conns.push(conn);
      }
      writeConnections(conns);
      return [chalk.green(`  ✅  Connection "${name}" saved`)];
    }

    case 'remove': {
      const conns = readConnections();
      if (conns.length === 0) return [chalk.yellow('  No saved connections')];

      let target;
      if (arg) {
        target = conns.find(c => c.name === arg);
        if (!target) return [chalk.yellow(`  Connection "${arg}" not found`)];
      } else {
        const opts = conns.map(c => ({ value: c.name, label: `${c.name} (${c.type})` }));
        const sel = await inlineSelect('Select connection to remove:', opts);
        if (!sel) return ['  Cancelled'];
        target = conns.find(c => c.name === sel);
      }

      const ok = await inlineSelect(`Remove "${target.name}"?`, [
        { value: 'yes', label: 'Yes, remove' },
        { value: 'no', label: 'Cancel' },
      ]);
      if (ok !== 'yes') return ['  Cancelled'];

      const remaining = conns.filter(c => c.name !== target.name);
      writeConnections(remaining);
      if (activeConnection?.name === target.name) activeConnection = null;
      return [chalk.green(`  🗑  Removed "${target.name}"`)];
    }

    default:
      return [chalk.yellow(`  Unknown db command: "${name}"`)];
  }
}

// ─── Main menu ────────────────────────────────────────────

async function main() {
  intro(chalk.bold('devkit db — Database Client'));

  while (true) {
    const action = await select({
      message: 'Choose an action:',
      options: [
        { value: 'saved',     label: '📋  Saved connections',        hint: activeConnection ? chalk.green(`active: ${activeConnection.name}`) : '' },
        { value: 'connect',   label: '🔗  Connect to database',      hint: 'select saved connection' },
        { value: 'disconnect', label: '🔌  Disconnect',              hint: activeConnection ? 'active' : 'inactive' },
        { value: 'tables',    label: '📊  List tables',               hint: activeConnection ? 'on active connection' : 'connect first' },
        { value: 'query',     label: '🔍  Run SQL query',             hint: activeConnection ? '' : 'connect first' },
        { value: '__sep',     label: '──  Config  ──',               hint: '' },
        { value: 'save',      label: '➕  Save connection',           hint: 'add new database config' },
        { value: 'remove',    label: '🗑  Remove connection',         hint: 'delete saved config' },
        { value: '__back',    label: '←  Back to devkit',            hint: '' },
      ],
    });

    if (isCancel(action) || action === '__back') break;

    switch (action) {
      case 'saved': {
        const conns = readConnections();
        if (conns.length === 0) { note('No saved connections. Use "Save connection" to add one.', 'DB'); break; }
        const lines = conns.map(c => {
          const active = activeConnection?.name === c.name ? chalk.green(' ● ACTIVE') : '';
          const typeIcon = { postgres: '🐘', sqlite: '🗄️', mysql: '🐬', mariadb: '🐬' }[c.type] || '📦';
          const detail = c.type === 'sqlite' ? c.path : `${c.host}:${c.port || 5432}/${c.database}`;
          return `${typeIcon} ${chalk.bold(c.name)} ${chalk.dim(detail)}${active}`;
        }).join('\n');
        note(lines, `📋  ${conns.length} connection(s)`);
        break;
      }

      case 'connect': {
        const conns = readConnections();
        if (conns.length === 0) { note('No connections saved.', 'Connect'); break; }
        const opts = conns.map(c => ({ value: c.name, label: c.name, hint: `${c.type} — ${c.type === 'sqlite' ? c.path : `${c.host}:${c.port}/${c.database}`}` }));
        opts.push({ value: '__back', label: '← Back' });
        const sel = await select({ message: 'Select database:', options: opts });
        if (isCancel(sel) || sel === '__back') break;
        const conn = conns.find(c => c.name === sel);

        const sp = spinner();
        sp.start(`Connecting to ${conn.name}...`);
        const result = testConnection(conn);
        if (!result.ok) {
          sp.stop('Failed');
          cancel(`Connection failed: ${result.error}`);
          break;
        }
        sp.stop('Connected');
        activeConnection = conn;
        note(`Type: ${chalk.bold(conn.type)}\n${conn.type === 'sqlite' ? `Path: ${conn.path}` : `Host: ${conn.host}:${conn.port}\nDB: ${conn.database}`}`, `✅  ${conn.name}`);

        // Show tables
        const tables = getTables(conn);
        if (tables.ok && tables.raw.trim()) {
          const tlines = tables.raw.trim().split('\n').filter(Boolean);
          if (tlines.length > 1) {
            const tableNames = tlines.slice(1, Math.min(16, tlines.length)).map(l => `  ${l.split('\t')[0] || l}`).join('\n');
            note(tableNames, `Tables (${tlines.length - 1})`);
          }
        }
        break;
      }

      case 'disconnect': {
        if (!activeConnection) { note('No active connection', 'Disconnect'); break; }
        note('', `🔌  Disconnected from ${activeConnection.name}`);
        activeConnection = null;
        break;
      }

      case 'tables': {
        if (!activeConnection) { note('Connect to a database first', 'Tables'); break; }
        const sp = spinner();
        sp.start('Fetching tables...');
        const result = getTables(activeConnection);
        if (!result.ok) { sp.stop('Failed'); cancel(result.error); break; }
        sp.stop('Done');
        if (result.raw.trim()) {
          const tbls = result.raw.trim().split('\n').filter(Boolean);
          note(tbls.slice(1).map(l => `  ${l.split('\t')[0] || l}`).join('\n'), `Tables (${tbls.length - 1})`);
        } else {
          note('No tables found', 'Tables');
        }
        break;
      }

      case 'query': {
        if (!activeConnection) { note('Connect to a database first', 'Query'); break; }
        const sql = await text({ message: 'SQL query:', validate: v => v ? undefined : 'Required' });
        if (isCancel(sql)) break;

        const sp = spinner();
        sp.start('Running query...');
        const result = runQuery(activeConnection, sql);
        if (!result.ok) { sp.stop('Failed'); cancel(result.error); break; }
        sp.stop('Done');

        if (result.raw.trim()) {
          const formatted = formatQueryResult(result.raw);
          note(formatted.map(l => l.replace(/^  /, '')).join('\n'), `SQL: ${sql}`);
        } else {
          note('Query executed (no results)', 'Done');
        }
        break;
      }

      case 'save': {
        const name = await text({ message: 'Connection name:', validate: v => v ? undefined : 'Required' });
        if (isCancel(name)) break;
        const dbType = await select({
          message: 'Database type:',
          options: [
            { value: 'postgres', label: '🐘  PostgreSQL' },
            { value: 'sqlite',   label: '🗄️  SQLite' },
            { value: 'mysql',    label: '🐬  MySQL' },
            { value: 'mariadb',  label: '🐬  MariaDB' },
          ],
        });
        if (isCancel(dbType)) break;

        let conn;
        if (dbType === 'sqlite') {
          const dbPath = await text({ message: 'Path to SQLite database:', validate: v => v ? undefined : 'Required' });
          if (isCancel(dbPath)) break;
          conn = { name, type: dbType, path: dbPath };
        } else {
          const host = await text({ message: 'Host:', initialValue: 'localhost' });
          if (isCancel(host)) break;
          const port = await text({ message: 'Port:', initialValue: dbType === 'postgres' ? '5432' : '3306' });
          if (isCancel(port)) break;
          const user = await text({ message: 'User:', initialValue: 'root' });
          if (isCancel(user)) break;
          const password = await text({ message: 'Password (leave empty if none):', placeholder: 'optional' });
          if (isCancel(password)) break;
          const database = await text({ message: 'Database name:', validate: v => v ? undefined : 'Required' });
          if (isCancel(database)) break;
          conn = { name, type: dbType, host, port: parseInt(port, 10) || 5432, user, password, database };
        }

        const conns = readConnections();
        const existing = conns.findIndex(c => c.name === name);
        if (existing >= 0) {
          const overwrite = await confirm({ message: `"${name}" already exists. Overwrite?`, initialValue: false });
          if (!overwrite) break;
          conns[existing] = conn;
        } else {
          conns.push(conn);
        }
        writeConnections(conns);
        note('', `✅  "${name}" saved`);
        break;
      }

      case 'remove': {
        const conns = readConnections();
        if (conns.length === 0) { note('No connections to remove.', 'Remove'); break; }
        const opts = conns.map(c => ({ value: c.name, label: c.name }));
        opts.push({ value: '__back', label: '← Back' });
        const sel = await select({ message: 'Select connection to remove:', options: opts });
        if (isCancel(sel) || sel === '__back') break;
        const ok = await confirm({ message: `Remove "${sel}"?`, initialValue: false });
        if (!ok) break;
        const remaining = conns.filter(c => c.name !== sel);
        writeConnections(remaining);
        if (activeConnection?.name === sel) activeConnection = null;
        note('', `🗑  Removed "${sel}"`);
        break;
      }
    }
  }

  outro('DB done');
}

// ─── Tool definition ──────────────────────────────────────

const tool = defineTool({
  manifest: { name: 'db', label: '🗄️  Database Client', hint: 'query PostgreSQL, SQLite, MySQL' },
  commands,
  execute,
  main,
});
export { commands, execute, main };
export const manifest = tool.manifest;
