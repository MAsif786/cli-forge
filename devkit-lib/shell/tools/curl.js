#!/usr/bin/env node
/**
 * devkit curl — Interactive HTTP Client (clack-powered)
 */
import { defineTool } from '../tool-sdk.js';
import { inlineText } from '../inline.js';
import chalk from 'chalk';
import { execSync } from 'child_process';

// ─── Constants ────────────────────────────────────────────

const commands = [
  { name: 'request', desc: 'Make an HTTP request (interactive)' },
];

async function execute(cmd) {
  if (cmd === 'request') {
    // Re-use the full interactive flow from main()
    return await interactiveRequest();
  }
  return [chalk.yellow(`  Unknown curl command: "${cmd}"`)];
}

/** Run a single interactive request cycle, return results as lines. */
async function interactiveRequest() {
  const request = await collectRequestInput();
  if (!request) return ['  Cancelled'];
  return await executeRequest(request);
}

async function collectRequestInput() {
  const method = await inlineText('HTTP Method:', 'GET');
  if (!method) return null;
  const url = await inlineText('URL:');
  if (!url) return null;
  const headers = await collectItems('Header', 'e.g. Content-Type: application/json');
  if (headers === null) return null;
  const params = await collectItems('Query param', 'e.g. key=value');
  if (params === null) return null;
  let body = '';
  if (method.toUpperCase() !== 'GET' && method.toUpperCase() !== 'HEAD') {
    body = await inlineText('Request body (JSON or text, empty to skip):', '');
    if (body === null) return null;
  }
  return { method: method.toUpperCase(), url, headers, params, body };
}

async function executeRequest(req) {
  let finalUrl = req.url;
  if (req.params.length > 0) {
    const qs = req.params.join('&');
    finalUrl += req.url.includes('?') ? '&' + qs : '?' + qs;
  }

  const args = ['-s', '-S', '-i', '-X', req.method, finalUrl];
  for (const h of req.headers) args.push('-H', h);
  if (req.body) args.push('-d', req.body);

  let response;
  try {
    response = execSync(`curl ${args.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ')} 2>&1`, { encoding: 'utf-8', timeout: 30000 });
  } catch (e) {
    response = e.stdout || e.message || 'Unknown error';
  }

  const headerEnd = response.indexOf('\n\n');
  const respHeaders = headerEnd >= 0 ? response.slice(0, headerEnd) : response;
  let respBody = headerEnd >= 0 ? response.slice(headerEnd + 2) : '';
  const lines = [chalk.bold('  Response:')];
  for (const l of respHeaders.split('\n')) lines.push(`  ${l}`);
  if (respBody) {
    lines.push('');
    if (hasJq()) {
      try {
        const pretty = execSync(`echo ${JSON.stringify(respBody)} | jq .`, { encoding: 'utf-8' });
        for (const l of pretty.trim().split('\n')) lines.push(`  ${l}`);
      } catch { for (const l of respBody.split('\n')) lines.push(`  ${l}`); }
    } else { for (const l of respBody.split('\n')) lines.push(`  ${l}`); }
  }
  return lines;
}

function hasJq() {
  try { execSync('which jq', { stdio: 'ignore' }); return true; }
  catch { return false; }
}

function prettyJson(str) {
  try {
    return JSON.stringify(JSON.parse(str), null, 2);
  } catch {
    return str;
  }
}

async function collectItems(message, hint) {
  const items = [];
  while (true) {
    const label = hint ? `${message} (${hint})` : message;
    const val = await inlineText(label, '');
    if (val === null) return null;
    if (!val) break;
    items.push(val);
  }
  return items;
}

const tool = defineTool({
  manifest: { name: 'curl', label: '🌐  HTTP Client', hint: 'Postman-like requests', keywords: ['http', 'https', 'rest', 'api', 'post', 'get', 'request', 'web', 'endpoint', 'fetch', 'download'] },
  commands,
  execute,
});
export { commands, execute };
export const manifest = tool.manifest;
