/**
 * devkit Inline Input — Keep tool interactions inside the devkit shell.
 *
 * Tools call inlineSelect() / inlineText() instead of clack prompts.
 * The shell's dispatch handles them inline using the suggest box + prompt line.
 * No terminal takeover, no raw mode toggling.
 *
 * Usage in a tool's execute():
 *
 *   import { inlineSelect, inlineText } from '../inline.js';
 *
 *   const chosen = await inlineSelect('Pick one:', [
 *     { value: 'a', label: 'Option A', hint: 'desc' },
 *   ]);
 *   const name = await inlineText('Enter name:');
 */

// ─── Module-level state ───────────────────────────────
// Set by the tool (inlineSelect/inlineText), read by the shell's inlineHandler.

let _pendingResolve = null;
let _pendingType = 'select'; // 'select' | 'text'
let _pendingOptions = [];
let _pendingDefault = '';
let _pendingSuggestions = []; // [{value, label, desc}] for text completion

// Callback registered by the shell to set up suggest box / prompt on pending.
let _onPendingCallback = null;

// Callback registered by the shell to append output lines (persist through renders).
let _appendOutputCallback = null;

// ─── Shell hooks ──────────────────────────────────────

/** Called by the shell to register its setup callback. */
export function _setOnPending(fn) {
  _onPendingCallback = fn;
}

/** Called by the shell to register its output appender. */
export function _setAppendOutput(fn) {
  _appendOutputCallback = fn;
}

let _workingCallback = null;
let _stopWorkingCallback = null;

/** Called by the shell to register its start/stop working callbacks. */
export function _setWorkingCallbacks(start, stop) {
  _workingCallback = start;
  _stopWorkingCallback = stop;
}

/** Tool calls this before a long async operation. Starts the spinner. */
export function _startWorking(text) {
  if (_workingCallback) _workingCallback(text);
}

/** Tool calls this after a long async operation. Stops the spinner. */
export function _stopWorking() {
  if (_stopWorkingCallback) _stopWorkingCallback();
}

/** Called by the shell's inlineHandler when a keypress resolves a pending request. */
export function _isPending() {
  return _pendingResolve !== null;
}

export function _resolve(value) {
  const r = _pendingResolve;
  _pendingResolve = null;
  _pendingOptions = [];
  _pendingDefault = '';
  _pendingSuggestions = [];
  if (r) r(value);
}

export function _reset() {
  _pendingResolve = null;
  _pendingOptions = [];
  _pendingDefault = '';
  _pendingSuggestions = [];
}

/**
 * Append output lines that persist across render cycles.
 * Tools call this before inlineText/inlineSelect to show context that
 * won't be cleared on the next redraw.
 */
export function _appendOutput(...args) {
  if (_appendOutputCallback) {
    for (const a of args) _appendOutputCallback(a);
  }
}

// ─── Tool API ─────────────────────────────────────────

/**
 * Show a selection list in the suggestion box, resolve with the picked value.
 * @param {string} prompt  - Label shown in the output area.
 * @param {Array<{value, label, hint}>} options
 * @returns {Promise<string|null>}  selected value, or null on cancel.
 */
export async function inlineSelect(prompt, options) {
  _pendingType = 'select';
  _pendingOptions = (options || []).map(o =>
    typeof o === 'string' ? { value: o, label: o } : o
  );

  if (_onPendingCallback) {
    _onPendingCallback('select', prompt, _pendingOptions);
  }

  return new Promise(resolve => {
    _pendingResolve = resolve;
  });
}

/**
 * Get a line of text input from the devkit prompt.
 * @param {string} prompt  - Label shown in the output area.
 * @param {string} defaultValue
 * @param {Array<{value, label, desc}>} suggestions  - completion items shown in suggest box
 * @returns {Promise<string|null>}  entered text, or null on cancel.
 */
export async function inlineText(prompt, defaultValue = '', suggestions = []) {
  _pendingType = 'text';
  _pendingDefault = defaultValue;
  _pendingSuggestions = suggestions.map(s =>
    typeof s === 'string' ? { value: s, label: s } : s
  );

  if (_onPendingCallback) {
    _onPendingCallback('text', prompt, null);
  }

  return new Promise(resolve => {
    _pendingResolve = resolve;
  });
}

/** Accessors for the shell's inlineHandler. */
export function _getType() { return _pendingType; }
export function _getOptions() { return _pendingOptions; }
export function _getDefault() { return _pendingDefault; }
export function _getSuggestions() { return _pendingSuggestions; }
