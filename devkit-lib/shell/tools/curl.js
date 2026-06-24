#!/usr/bin/env node
/**
 * devkit curl — Interactive HTTP Client (clack-powered)
 */
import { defineTool } from '../tool-sdk.js';
import { inlineText } from '../inline.js';
import { intro, outro, select, spinner, text, isCancel, note } from '@clack/prompts';
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

async function main() {
  intro(chalk.bold('devkit curl — Interactive HTTP Client'));

  let repeatRequest = null;

  while (true) {
    let method, url, headers, params, body;

    if (repeatRequest) {
      method = repeatRequest.method;
      url = repeatRequest.url;
      headers = repeatRequest.headers;
      params = repeatRequest.params;
      body = repeatRequest.body;
      repeatRequest = null;
      note(`Repeating: ${method} ${url}`, 'Repeat');
    } else {
      // Method
      method = await text({
        message: 'HTTP Method:',
        initialValue: 'GET',
        validate: v => v ? undefined : 'Required',
      });
      if (isCancel(method)) break;
      method = method.toUpperCase();

      // URL
      url = await text({
        message: 'URL:',
        validate: v => v ? undefined : 'Required',
      });
      if (isCancel(url)) break;

      // Headers
      headers = await collectItems('Header', 'e.g. Content-Type: application/json');
      if (headers === null) break;

      // Query params
      params = await collectItems('Query param', 'e.g. key=value');
      if (params === null) break;

      // Body (skip for GET, HEAD)
      body = '';
      if (method !== 'GET' && method !== 'HEAD') {
        body = await text({
          message: 'Request body (JSON or text, empty to skip):',
        });
        if (isCancel(body)) break;
      }
    }

    // Build final URL
    let finalUrl = url;
    if (params.length > 0) {
      const qs = params.join('&');
      finalUrl += url.includes('?') ? '&' + qs : '?' + qs;
    }

    // Build curl args
    const curlArgs = ['-s', '-S', '-i', '-X', method, finalUrl];
    for (const h of headers) curlArgs.push('-H', h);
    if (body) curlArgs.push('-d', body);

    // Show request
    let reqDisplay = `curl -X ${method} \\\n  ${finalUrl}`;
    for (const h of headers) reqDisplay += ` \\\n  -H "${h}"`;
    if (body) reqDisplay += ` \\\n  -d '${body}'`;
    note(reqDisplay, 'Request');

    // Execute
    const sp = spinner();
    sp.start('Sending request...');

    let response;
    try {
      response = execSync(`curl ${curlArgs.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ')} 2>&1`, { encoding: 'utf-8', timeout: 30000 });
      sp.stop('Response received');
    } catch (e) {
      sp.stop('Failed');
      response = e.stdout || e.message || 'Unknown error';
    }

    // Split headers from body
    const headerEnd = response.indexOf('\n\n');
    const respHeaders = headerEnd >= 0 ? response.slice(0, headerEnd) : response;
    let respBody = headerEnd >= 0 ? response.slice(headerEnd + 2) : '';

    // Show response
    let display = respHeaders.split('\n').map(l => `  ${l}`).join('\n');
    if (respBody) {
      display += '\n\n';
      if (hasJq()) {
        try {
          const pretty = execSync(`echo ${JSON.stringify(respBody)} | jq .`, { encoding: 'utf-8' });
          display += pretty.split('\n').map(l => `  ${l}`).join('\n');
        } catch {
          display += respBody.split('\n').map(l => `  ${l}`).join('\n');
        }
      } else {
        display += respBody.split('\n').map(l => `  ${l}`).join('\n');
      }
    }
    note(display, 'Response');

    // Next action
    const next = await select({
      message: 'What next?',
      options: [
        { value: 'new', label: '🔁  New request' },
        { value: 'repeat', label: '🔂  Repeat this request' },
        { value: '__back', label: '←  Back to devkit' },
      ],
    });

    if (isCancel(next) || next === '__back') break;

    if (next === 'repeat') {
      repeatRequest = { method, url, headers, params, body };
    }
  }

  outro('Curl done');
}

const tool = defineTool({
  manifest: { name: 'curl', label: '🌐  HTTP Client', hint: 'Postman-like requests' },
  commands,
  execute,
  main,
});
export { commands, execute, main };
export const manifest = tool.manifest;
