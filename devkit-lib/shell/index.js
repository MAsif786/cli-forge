#!/usr/bin/env node
/**
 * devkit — Smart CLI Toolbox
 * Command-center with tool contexts & live suggestion box.
 * `/` always shows what's available — nothing to remember.
 */
import chalk from 'chalk';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import readline from 'readline';
import { _setOnPending, _setAppendOutput, _isPending, _resolve, _reset, _getType, _getOptions, _getDefault, _getSuggestions } from './inline.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOOLS_DIR = path.join(__dirname, 'tools');

let TOOLS = [];

const GLOBAL_CMDS = [
  { name: '/help',     desc: 'Show help' },
  { name: '/tools',    desc: 'List all tools' },
  { name: '/clear',    desc: 'Clear screen' },
];

// ─── Auto-discovery ───────────────────────────────────

/**
 * Scan the tools/ directory and import every .js file that exports commands.
 * Each discovered tool is cached in memory for the session.
 * Drop a .js file in tools/ and it's immediately available — no registry needed.
 */
async function discoverTools() {
  const tools = [];
  let files;
  try {
    files = fs.readdirSync(TOOLS_DIR).filter(f => f.endsWith('.js') && f !== 'tool-sdk.js');
  } catch {
    return tools;
  }
  for (const file of files) {
    try {
      const mod = await import(path.join(TOOLS_DIR, file));
      if (mod.commands && Array.isArray(mod.commands)) {
        const m = mod.manifest || {};
        tools.push({
          name: m.name || file.replace('.js', ''),
          label: m.label || file.replace('.js', ''),
          hint: m.hint || `${mod.commands.length} command(s)`,
          mod,
        });
      }
    } catch {
      // Silently skip tools that fail to load
    }
  }
  return tools;
}

// ─── Context system ────────────────────────────────────

let context = 'root';
let contextMod = null;
let contextCmdList = []; // [{name, desc}, ...]

function contextPrompt() {
  return context === 'root' ? chalk.cyan(' devkit> ') : chalk.yellow(` devkit[${context}]> `);
}

// ─── Terminal ──────────────────────────────────────────

const stdin = process.stdin;
const stdout = process.stdout;

function rawMode(on) {
  if (stdin.isTTY && stdin.isRaw !== on) stdin.setRawMode(on);
}

const KEY = {
  UP: '\x1b[A', DOWN: '\x1b[B', LEFT: '\x1b[C', RIGHT: '\x1b[D',
  HOME: '\x1b[H', END: '\x1b[F', DEL: '\x1b[3~',
  TAB: '\t', ENTER: '\r', BACKSPACE: '\x7f', ESC: '\x1b',
  CTRL_C: '\x03', CTRL_D: '\x04', CTRL_L: '\x0c', CTRL_U: '\x15',
};

// ─── Display buffer ────────────────────────────────────

const MAX_LINES = 1000;
const lines = [
  '',
  chalk.bold('  ⚡ devkit — Smart CLI Toolbox'),
  chalk.dim('  ─────────────────────────────────────────────'),
];

function emit(...args) {
  for (const l of args.join(' ').split('\n')) lines.push(l);
  if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
}
_setAppendOutput(emit);

function clearLines() {
  lines.length = 0;
  emit(chalk.bold('  ⚡ devkit — Smart CLI Toolbox'));
  emit(chalk.dim('  ─────────────────────────────────────────────'));
}

// ─── Working indicator ────────────────────────────────

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
let workingText = null;
let workingFrame = 0;
let workingTimer = null;

function startWorking(text) {
  workingText = text;
  workingFrame = 0;
  if (workingTimer) clearInterval(workingTimer);
  workingTimer = setInterval(() => {
    workingFrame = (workingFrame + 1) % SPINNER.length;
    render(false);
  }, 100);
}

function stopWorking() {
  workingText = null;
  workingFrame = 0;
  if (workingTimer) { clearInterval(workingTimer); workingTimer = null; }
}

// ─── Suggestions ───────────────────────────────────────

const suggest = { items: [], sel: 0, offset: 0, visible: false };

// Dynamic max: leave room for output lines + spinner + separator + prompt + hint + borders
function getMaxSuggest() {
  const overhead = 8; // top border + separator + prompt + hint + bottom border + padding
  const spinH = workingText ? 1 : 0;
  const outputLines = Math.min(lines.length, 4); // at most 4 output lines shown when menu is open
  return Math.max(6, Math.min(20, th - overhead - spinH - outputLines));
}

function suggestVisibleItems() {
  const max = getMaxSuggest();
  const start = suggest.offset;
  const end = Math.min(start + max, suggest.items.length);
  return suggest.items.slice(start, end);
}

function scrollToIndex(idx) {
  const max = getMaxSuggest();
  // Keep selected item in the visible window
  if (idx < suggest.offset) {
    suggest.offset = idx;
  } else if (idx >= suggest.offset + max) {
    suggest.offset = idx - max + 1;
  }
  // Clamp offset
  if (suggest.offset < 0) suggest.offset = 0;
  const maxOffset = Math.max(0, suggest.items.length - max);
  if (suggest.offset > maxOffset) suggest.offset = maxOffset;
}

function stripAnsi(s) { return s.replace(/\x1b\[[0-9;]*m/g, ''); }

function buildSuggestions(text) {
  if (!text) { suggest.visible = false; return; }

  let pool;
  if (context === 'root') {
    // Root: tools (+ global cmds when / is typed)
    const tools = TOOLS.map(t => ({ value: t.name, display: t.label, desc: t.hint }));
    if (text.startsWith('/')) {
      // Strip leading / to match tool names
      const query = text.slice(1);
      const cmds = GLOBAL_CMDS.filter(c => c.name.startsWith(text)).map(c => ({ value: c.name, display: `  ${c.name}`, desc: c.desc }));
      const matchedTools = query ? tools.filter(t => t.value.startsWith(query)) : tools;
      pool = [...cmds, ...matchedTools];
    } else {
      pool = tools.filter(t => t.value.startsWith(text));
    }
  } else {
    // Tool context: show tool commands (+ back / menu helpers)
    const cmds = contextCmdList.map(c => ({ value: c.name, display: `  ${c.name}`, desc: c.desc }));
    const helpers = [
      { value: 'menu', display: '  📋  Menu', desc: 'Open the full menu' },
      { value: 'back', display: '  ← Back', desc: 'Return to devkit' },
    ];
    if (text.startsWith('/') || text === '') {
      // Show all when / is typed or empty input
      pool = [...cmds, ...helpers];
    } else {
      pool = [...cmds, ...helpers].filter(c => c.value.startsWith(text));
    }
  }

  if (pool.length === 0) { suggest.visible = false; return; }
  suggest.items = pool.slice(0, 12);
  suggest.sel = 0; suggest.offset = 0;
  suggest.visible = true;
}

// ─── Render ────────────────────────────────────────────

let tw = process.stdout.columns || 80;
let th = process.stdout.rows || 24;
function onResize() { tw = process.stdout.columns || 80; th = process.stdout.rows || 24; }

function renderBox() {
  if (!suggest.visible || suggest.items.length === 0) return;
  const bw = Math.min(tw - 4, 64);
  const pad = 2;
  const total = suggest.items.length;
  const visible = suggestVisibleItems();
  const maxVis = getMaxSuggest();
  const moreAbove = suggest.offset > 0;
  const moreBelow = suggest.offset + maxVis < total;

  // Category header with count + scroll hint
  const scrollHint = total > maxVis ? ` ${suggest.offset + 1}-${suggest.offset + visible.length}/${total}` : '';
  const category = context === 'root'
    ? chalk.dim(` Tools${scrollHint} `)
    : chalk.dim(` Commands${scrollHint} `);

  stdout.write(' '.repeat(pad) + category + '┌' + '─'.repeat(bw - category.length + stripAnsi(category).length - 2) + '┐' + '\x1b[0K\n');

  // Scroll-up indicator
  if (moreAbove) {
    stdout.write(' '.repeat(pad) + `│ ${chalk.dim('▲  more...')}${' '.repeat(bw - 13)}│\x1b[0K\n`);
  }

  for (let vi = 0; vi < visible.length; vi++) {
    const item = visible[vi];
    const globalIdx = suggest.offset + vi;
    const is = globalIdx === suggest.sel;
    const arrow = is ? chalk.cyan('❯') : ' ';
    const name = is ? chalk.bold(item.display) : item.display;
    const nameLen = stripAnsi(item.display).length;
    const desc = item.desc || '';
    const descLen = stripAnsi(desc).length;
    const sp = Math.max(1, bw - 2 - nameLen - descLen - 4);

    if (is) {
      stdout.write(' '.repeat(pad) + `│${chalk.bgHex('#1a1a2e')(chalk.cyan(` ${arrow}${name}`))}${' '.repeat(sp + descLen + 2)}│\x1b[0K\n`);
    } else {
      stdout.write(' '.repeat(pad) + `│ ${arrow}${name}${' '.repeat(sp)}${chalk.dim(desc)} │\x1b[0K\n`);
    }
  }

  // Scroll-down indicator
  if (moreBelow) {
    stdout.write(' '.repeat(pad) + `│ ${chalk.dim('▼  more...')}${' '.repeat(bw - 13)}│\x1b[0K\n`);
  }

  stdout.write(' '.repeat(pad) + '└' + '─'.repeat(bw - 2) + '┘' + '\x1b[0K\n');
}

function render(clear = true) {
  if (!stdin.isTTY) return;
  if (clear) stdout.write('\x1b[0J');

  // Layout: topBorder(1) + output + spinner(1) + box + separator(1) + prompt(1) + hint(1) + bottomBorder(1)
  // Box height: visible items + header/footer lines + scroll indicators
  let boxH = 0;
  if (suggest.visible && suggest.items.length > 0) {
    const visible = suggestVisibleItems();
    boxH = visible.length + 2; // header + footer lines
    if (suggest.offset > 0) boxH++; // ▲ more...
    if (suggest.offset + getMaxSuggest() < suggest.items.length) boxH++; // ▼ more...
  }
  const spinH = workingText ? 1 : 0;
  const overhead = 5 + boxH + spinH; // top + sep + prompt + hint + bottom = 5
  const avail = Math.max(0, th - overhead);
  const show = lines.slice(-avail);

  stdout.write('\x1b[H');

  // 1. Top border with context label
  const topLabel = context !== 'root' ? ` ══ ${chalk.yellow(context)} ══` : '';
  stdout.write(chalk.cyan('  ═' + '═'.repeat(Math.min(tw - 6, 48)) + '═') + topLabel + '\x1b[0K\n');

  // 2. Output lines
  for (const line of show) {
    const d = line || ' ';
    stdout.write(d.length > tw ? d.slice(0, tw - 1) + '…' : d);
    stdout.write('\x1b[0K\n');
  }
  const fill = avail - show.length;
  for (let i = 0; i < fill; i++) stdout.write('\x1b[0K\n');

  // 2b. Working indicator (animated spinner)
  if (workingText) {
    stdout.write(`  ${chalk.cyan(SPINNER[workingFrame])} ${workingText}\x1b[0K\n`);
  }

  // 3. Suggestion box
  renderBox();

  // 4. Separator
  stdout.write(chalk.dim('  ─' + '─'.repeat(Math.min(tw - 6, 48)) + '─') + '\x1b[0K\n');

  // 5. Prompt line
  stdout.write('\x1b[0K');
  const dt = input.buf.slice(0, input.cursor);
  const dr = input.buf.slice(input.cursor);
  stdout.write(`${contextPrompt()}${dt}\x1b[?25h${dr}\x1b[?25l`);

  // 6. Hint line
  const hint = context === 'root'
    ? chalk.dim('  /<tool> launch  ·  /help  ·  /clear  ·  exit')
    : chalk.dim(`${chalk.cyan('/')} commands  ·  ${chalk.cyan('menu')} full UI  ·  ${chalk.cyan('Esc')} back  ·  ${chalk.cyan('back')} to root`);
  stdout.write('\x1b[0K\n');
  stdout.write(hint + '\x1b[0K');

  // 7. Bottom border (dim)
  stdout.write('\n');
  const bottomStyle = context === 'root' ? chalk.dim : chalk.cyan;
  stdout.write(bottomStyle('  ─' + '─'.repeat(Math.min(tw - 6, 48)) + '─') + '\x1b[0K');

  // Move cursor back up 3 lines (hint + bottom + blank) to prompt
  const cursorPos = stripAnsi(contextPrompt() + dt).length;
  stdout.write(`\x1b[3A\x1b[${cursorPos}G`);
}

// ─── Input state ───────────────────────────────────────

const input = { buf: '', cursor: 0, history: [], hIdx: -1 };

function setInput(v) { input.buf = v; input.cursor = v.length; }

// ─── Dispatch ──────────────────────────────────────────

async function dispatch(raw) {
  const cmd = raw.trim();
  if (!cmd) return;

  input.history.push(cmd);
  input.hIdx = -1;
  emit(`${contextPrompt()}${cmd}`);

  // Global exits work anywhere
  if (cmd === 'exit' || cmd === 'quit' || cmd === 'q') {
    emit(chalk.dim('  Goodbye!'));
    if (stdin.isTTY) { render(true); rawMode(false); stdout.write('\x1b[?25h\n'); }
    process.exit(0);
  }

  // / commands and clear work in both contexts
  if (cmd === '/clear' || cmd === 'clear') { clearLines(); buildSuggestions(input.buf); render(true); return; }

  if (cmd === '/help') {
    emit('');
    emit(chalk.bold('  Commands:'));
    if (context === 'root') {
      for (const c of GLOBAL_CMDS) emit(`    ${chalk.cyan(c.name.padEnd(10))}  ${c.desc}`);
      emit(`    ${chalk.cyan('<tool>'.padEnd(10))}    Launch a tool`);
    } else {
      emit(`    ${chalk.yellow('<cmd>'.padEnd(10))}    Run a tool command`);
      emit(`    ${chalk.yellow('menu'.padEnd(10))}    Open the full menu`);
      emit(`    ${chalk.yellow('back'.padEnd(10))}    Return to devkit`);
      emit(`    ${chalk.cyan('/clear'.padEnd(10))}   Clear screen`);
    }
    emit('');
    render(true); return;
  }

  // ── Tool context dispatch ──
  if (context !== 'root') {
    if (cmd === 'back' || cmd === '..') {
      contextMod?.onExit?.();
      context = 'root';
      contextMod = null;
      contextCmdList = [];
      emit(chalk.dim('  ── back to devkit ──'));
      buildSuggestions(input.buf);
      render(true);
      return;
    }

    if (cmd === 'menu') {
      // Launch full clack menu
      if (stdin.isTTY) { render(true); rawMode(false); stdout.write('\x1b[?25h\n'); }
      try {
        if (contextMod?.main) await contextMod.main();
      } catch (err) { console.error(chalk.red(`Error: ${err.message}`)); }
      if (stdin.isTTY) { stdout.write('\n'); rawMode(true); }
      // Stay in context after menu exits
      emit(chalk.dim(`  ── back to ${context} context ──`));
      buildSuggestions(input.buf);
      render(true);
      return;
    }

    // Execute tool command
    if (contextMod?.execute) {
      // Register inline callback so tools can show selections/text
      // within the devkit interface (no clack takeover).
      _setOnPending((type, prompt, options) => {
        stopWorking();
        if (type === 'select' && options) {
          emit(chalk.cyan(`  ${prompt}`));
          suggest.items = options.map(o => ({
            value: o.value, display: `  ${o.label || o.value}`, desc: o.hint || '',
          }));
          suggest.sel = 0; suggest.offset = 0;
          suggest.visible = true;
          render(true);
        } else if (type === 'text') {
          setInput(_getDefault());
          emit(chalk.cyan(`  ${prompt}`));
          render(true);
        }
      });

      // Remove main handler, add inline-aware handler
      stdin.removeListener('data', handleKey);

      const updateTextSuggestions = () => {
        const textSuggestions = _getSuggestions();
        if (textSuggestions.length > 0) {
          const words = input.buf.split(/\s+/);
          const lastWord = words[words.length - 1] || '';

          // SQL context: determine what type of suggestion to show based on previous word
          const prevWord = words.length >= 2 ? words[words.length - 2].toUpperCase() : '';
          const tableKeywords = ['FROM', 'JOIN', 'INTO', 'TABLE', 'UPDATE'];
          const columnKeywords = ['SELECT', 'WHERE', 'AND', 'OR', 'ON', 'SET', 'ORDER', 'GROUP', 'HAVING', 'BY', 'VALUES'];
          let typeFilter = null;
          if (tableKeywords.includes(prevWord)) typeFilter = 'table';
          else if (columnKeywords.includes(prevWord)) typeFilter = 'column';

          let filtered = textSuggestions;
          if (lastWord.length >= 1) {
            if (typeFilter) {
              filtered = textSuggestions.filter(s =>
                s.type === typeFilter && s.value.toLowerCase().startsWith(lastWord.toLowerCase())
              );
            } else {
              filtered = textSuggestions.filter(s =>
                s.value.toLowerCase().startsWith(lastWord.toLowerCase())
              );
            }
          }
          // Always show when there are suggestions (show all on empty input)
          if (filtered.length > 0) {
            suggest.items = filtered.slice(0, 12).map(s => ({
              value: s.value, display: `  ${s.label || s.value}`, desc: s.desc || '',
            }));
            suggest.sel = 0; suggest.offset = 0;
            suggest.visible = true;
            return;
          }
        }
        suggest.visible = false;
      };

      const inlineHandler = (buf) => {
        if (!_isPending()) return;
        const key = buf.toString();

        if (_getType() === 'select') {
          if (key === '\r' || key === '\n' || key === '\t') {
            const sel = suggest.items[suggest.sel];
            _resolve(sel ? sel.value : null);
            suggest.visible = false;
            render(true);
          } else if (key === '\x1b') {
            _resolve(null);
            suggest.visible = false;
            render(true);
          } else if (key === '\x1b[A' && suggest.sel > 0) {
            suggest.sel--;
            scrollToIndex(suggest.sel);
            render(false);
          } else if (key === '\x1b[B' && suggest.sel < suggest.items.length - 1) {
            suggest.sel++;
            scrollToIndex(suggest.sel);
            render(false);
          }
          return;
        }

        if (_getType() === 'text') {
          if (key === '\r' || key === '\n') {
            // If suggestion is visible and selected, submit that instead of typed text
            if (suggest.visible && suggest.items[suggest.sel]) {
              const val = suggest.items[suggest.sel].value;
              suggest.visible = false;
              setInput('');
              _resolve(val);
              render(true);
            } else {
              suggest.visible = false;
              const val = input.buf;
              setInput('');
              _resolve(val);
              render(true);
            }
          } else if (key === '\t' && suggest.visible) {
            // Tab auto-complete from suggestion
            const sel = suggest.items[suggest.sel];
            if (sel) {
              const word = sel.value;
              const parts = input.buf.split(/(\s+)/);
              // Replace last word with completion
              const lastWord = parts.pop() || '';
              const before = parts.join('');
              const prefix = input.buf.slice(0, input.buf.lastIndexOf(lastWord));
              input.buf = prefix + word;
              input.cursor = input.buf.length;
            }
            suggest.visible = false;
            render(true);
          } else if (key === '\x1b' || key === '\x03') {
            suggest.visible = false;
            setInput('');
            _resolve(null);
            render(true);
          } else if (key === '\x1b[A' && suggest.visible && suggest.sel > 0) {
            suggest.sel--;
            scrollToIndex(suggest.sel);
            render(false);
          } else if (key === '\x1b[B' && suggest.visible && suggest.sel < suggest.items.length - 1) {
            suggest.sel++;
            scrollToIndex(suggest.sel);
            render(false);
          } else if (key === '\x7f') {
            if (input.cursor > 0) {
              input.buf = input.buf.slice(0, input.cursor - 1) + input.buf.slice(input.cursor);
              input.cursor--;
            }
            updateTextSuggestions();
            render(true);
          } else if (key.length >= 1 && [...key].every(c => c.charCodeAt(0) >= 0x20)) {
            input.buf = input.buf.slice(0, input.cursor) + key + input.buf.slice(input.cursor);
            input.cursor += key.length;
            updateTextSuggestions();
            render(true);
          }
          return;
        }
      };

      stdin.on('data', inlineHandler);

      stopWorking(); // tools manage their own display
      try {
        const results = await contextMod.execute(cmd);
        if (results && results.length > 0) {
          if (results[0] === '__FOLLOW__' && contextMod?.followLogs) {
            await contextMod.followLogs(results[1], results[2]);
          } else {
            for (const line of results) emit(line);
          }
        }
      } catch (err) {
        stopWorking();
        emit(chalk.red(`  Error: ${err.message}`));
      } finally {
        stopWorking();
        stdin.removeListener('data', inlineHandler);
        if (stdin.isTTY) { rawMode(true); stdin.resume(); }
        stdin.on('data', handleKey);
        _setOnPending(null);
        _reset();
      }
      buildSuggestions(input.buf);
      render(true);
      return;
    }
  }

  // ── Root context dispatch ──

  if (cmd === '/tools') {
    emit('');
    emit(chalk.bold('  Available tools:'));
    for (const t of TOOLS) emit(`    ${chalk.green(t.name.padEnd(10))}  ${t.hint}`);
    emit('');
    render(true); return;
  }

  // Launch tool
  const toolName = cmd.startsWith('/') ? cmd.slice(1) : cmd;
  const tool = TOOLS.find(t => t.name === toolName);
  if (tool) {
    try {
      const mod = tool.mod;
      // If tool has commands, enter context mode
      if (mod.commands && Array.isArray(mod.commands) && mod.commands.length > 0) {
        context = tool.name;
        contextMod = mod;
        contextCmdList = mod.commands;
        mod.onEnter?.();
        emit(chalk.dim(`  ── ${tool.label} — type / to see commands, 'menu' for full UI ──`));
        // Show suggestions immediately
        buildSuggestions('/');
        render(true);
        return;
      }
      // Fallback: standalone launch
      if (stdin.isTTY) { render(true); rawMode(false); stdout.write('\x1b[?25h\n'); }
      if (mod.main) await mod.main();
      if (stdin.isTTY) { stdout.write('\n'); rawMode(true); emit(chalk.dim(`  ── back to devkit ──`)); }
    } catch (err) {
      emit(chalk.red(`  Error: ${err.message}`));
    }
    buildSuggestions(input.buf);
    render(true);
    return;
  }

  emit(chalk.red(`  Unknown: "${cmd}"`));
  emit(chalk.dim('  Type /help for commands'));
  render(true);
}

// ─── Key handler ───────────────────────────────────────

function handleKey(buf) {
  const key = buf.toString();
  const text = input.buf;
  const cursor = input.cursor;

  if (suggest.visible) {
    switch (key) {
      case KEY.ENTER:
      case KEY.TAB: {
        const sel = suggest.items[suggest.sel];
        if (sel) {
          suggest.visible = false;
          const cmd = sel.value;
          setInput('');
          buildSuggestions('');
          dispatch(cmd);
        } else { suggest.visible = false; render(true); }
        return;
      }
      case KEY.UP: if (suggest.sel > 0) { suggest.sel--; render(false); } return;
      case KEY.DOWN: if (suggest.sel < suggest.items.length - 1) { suggest.sel++; render(false); } return;
      case KEY.ESC:
        suggest.visible = false;
        if (context !== 'root') {
          render(true);
          // Second ESC will exit the tool context (fall through to default handler)
          return;
        }
        render(true);
        return;
    }
  }

  switch (key) {
    case KEY.ENTER: {
      const cmd = input.buf.trim();
      setInput(''); buildSuggestions('');
      dispatch(cmd);
      return;
    }
    case KEY.BACKSPACE:
      if (cursor > 0) { input.buf = text.slice(0, cursor - 1) + text.slice(cursor); input.cursor--; }
      buildSuggestions(input.buf); render(true); break;
    case KEY.DEL:
      if (cursor < text.length) { input.buf = text.slice(0, cursor) + text.slice(cursor + 1); }
      buildSuggestions(input.buf); render(true); break;
    case KEY.LEFT: if (cursor > 0) { input.cursor--; render(); } break;
    case KEY.RIGHT: if (cursor < text.length) { input.cursor++; render(); } break;
    case KEY.HOME: input.cursor = 0; render(); break;
    case KEY.END: input.cursor = text.length; render(); break;
    case KEY.UP:
      if (input.history.length > 0) {
        if (input.hIdx === -1) input.hIdx = input.history.length - 1;
        else if (input.hIdx > 0) input.hIdx--;
        setInput(input.history[input.hIdx]);
      }
      buildSuggestions(input.buf); render(true); break;
    case KEY.DOWN:
      if (input.hIdx >= 0) {
        input.hIdx++;
        if (input.hIdx >= input.history.length) { input.hIdx = -1; setInput(''); }
        else { setInput(input.history[input.hIdx]); }
      } else { setInput(''); }
      buildSuggestions(input.buf); render(true); break;
    case KEY.TAB: if (!suggest.visible) stdout.write('\x07'); break;
    case KEY.CTRL_C:
    case KEY.CTRL_D:
      emit(chalk.dim('  Goodbye!'));
      if (stdin.isTTY) { render(true); rawMode(false); stdout.write('\x1b[?25h\n'); }
      process.exit(0);
    case KEY.CTRL_L: clearLines(); buildSuggestions(input.buf); render(true); break;
    case KEY.CTRL_U: setInput(''); buildSuggestions(''); render(true); break;
    case KEY.ESC:
      if (suggest.visible) { suggest.visible = false; render(true); }
      else if (context !== 'root') {
        // Exit tool context on Escape
        contextMod?.onExit?.();
        context = 'root'; contextMod = null; contextCmdList = [];
        emit(chalk.dim('  ── back to devkit ──'));
        buildSuggestions(input.buf);
        render(true);
      }
      break;
    default:
      if (key.length === 1 && key.charCodeAt(0) >= 0x20) {
        input.buf = text.slice(0, cursor) + key + text.slice(cursor);
        input.cursor++;
        buildSuggestions(input.buf); render(true);
      } else if (key.length > 1 && key.startsWith('\x1bO')) {
        const s = key.slice(2);
        if (s === 'H') { input.cursor = 0; render(); }
        if (s === 'F') { input.cursor = input.buf.length; render(); }
      }
  }
}

// ─── Start ─────────────────────────────────────────────

async function start() {
  process.stdout.on('resize', onResize);
  onResize();

  if (!stdin.isTTY) {
    // Non-TTY: simple piped mode with context support
    TOOLS = await discoverTools();
    let ctx = 'root'; let ctxMod = null;
    const rl = readline.createInterface({ input: stdin });
    for await (const line of rl) {
      const cmd = line.trim();
      if (!cmd) continue;
      if (cmd === 'exit' || cmd === 'quit' || cmd === 'q') break;

      if (ctx !== 'root') {
        if (cmd === 'back') { ctxMod?.onExit?.(); ctx = 'root'; ctxMod = null; console.log(''); continue; }
        if (cmd === 'menu' && ctxMod?.main) { console.log('Menu not available in non-TTY mode'); continue; }
        if (ctxMod?.execute) {
          try { const r = await ctxMod.execute(cmd); if (r?.length) console.log(r.join('\n')); }
          catch (err) { console.error(`Error: ${err.message}`); }
        } else { console.log(`Unknown in ${ctx}: ${cmd}`); }
        continue;
      }

      if (cmd === '/tools') { console.log(''); console.log('Available tools:'); for (const t of TOOLS) console.log(`  ${t.name.padEnd(10)} ${t.hint}`); console.log(''); }
      else if (cmd === '/clear' || cmd === 'clear') { console.clear(); }
      else {
        const tn = cmd.startsWith('/') ? cmd.slice(1) : cmd;
        const tool = TOOLS.find(t => t.name === tn);
        if (!tool) { console.log(`Unknown: "${cmd}"`); continue; }
        try {
          const mod = tool.mod;
          if (mod.commands?.length) { ctxMod?.onExit?.(); ctx = tool.name; ctxMod = mod; console.log(`\n${tool.label} — type commands or "back" to exit`); }
          else if (mod.main) { console.log(`Launching ${tool.label}...`); await mod.main(); }
        } catch (err) { console.error(`Error: ${err.message}`); }
      }
    }
    return;
  }

  emit('');
  TOOLS = await discoverTools();
  emit(chalk.dim('  Type a tool name or / for all commands.  ↓ arrows to pick.'));
  render(true);

  stdin.on('data', handleKey);
  rawMode(true);
  stdin.resume();
}

start();
