# cli-forge

**Smart CLI toolbox** — interactive terminal tools for everyday devops tasks. Built with a modular plugin architecture: drop a `.js` file in `tools/` and it's live in the shell, no registry changes needed.

## Quick start

### Prerequisites

- **Node.js** ≥18 (required for the interactive shell)
- **Python 3** (TOTP code generation, Google Auth migration import)
- **AWS CLI** (`brew install awscli`) — only if you use the AWS tool

### Install

```bash
# Clone the repo
git clone git@asif:MAsif786/cli-forge.git ~/cli-forge

# Install Node.js dependencies
cd ~/cli-forge/devkit-lib/shell
npm install

# Add to PATH (add this line to ~/.zshrc or ~/.bashrc)
export PATH="$HOME/cli-forge:$PATH"
```

Or symlink the entry point:

```bash
ln -s ~/cli-forge/devkit /usr/local/bin/devkit
```

### Run

```bash
devkit            # Launch the interactive shell
devkit help       # Quick overview
```

## Using the shell

The shell is a TUI application. Type your way around — no menus to memorize.

### Navigation

| Key | Action |
|-----|--------|
| Type a tool name | Enter that tool's context (e.g. `aws`, `port`, `docker`) |
| `/` | Show available commands within the current tool |
| `menu` | Open the full clack menu for the current tool |
| `back` | Return to root / exit tool context |
| `↑` / `↓` | Navigate the suggestion box |
| `Enter` | Select highlighted suggestion or submit typed text |
| `Tab` | Auto-complete from suggestion |
| `Esc` | Cancel the current prompt / exit selection |

### Tools

Each tool has its own docs page with commands, usage examples, and prerequisites.

| Tool | Description | Docs |
|------|-------------|------|
| `aws` | AWS identity, S3, EC2, CloudWatch, Secrets Manager, profiles | [docs/aws.md](docs/aws.md) |
| `port` | Port scanning, process kill, firewall rules, network checks | [docs/port.md](docs/port.md) |
| `docker` | Container and image management | [docs/docker.md](docs/docker.md) |
| `curl` | Interactive HTTP request builder | [docs/curl.md](docs/curl.md) |
| `vpn` | OpenVPN connection manager | [docs/vpn.md](docs/vpn.md) |
| `totp` | TOTP 2FA codes with live countdown timer | [docs/totp.md](docs/totp.md) |
| `cleanup` | Disk space scanner — Docker, npm, pip, caches, Trash | [docs/cleanup.md](docs/cleanup.md) |
| `db` | PostgreSQL, SQLite, MySQL client with schema autocomplete | [docs/db.md](docs/db.md) |
| `ssh` | SSH config parser, host manager, key viewer | [docs/ssh.md](docs/ssh.md) |
| `wifi` | WiFi details, password from Keychain, network scan | [docs/wifi.md](docs/wifi.md) |

## Plugin system

Create a file in `devkit-lib/shell/tools/`. It's discovered and loaded automatically at shell startup — zero registry changes.

### Minimal tool

```js
// devkit-lib/shell/tools/hello.js
import { defineTool } from '../tool-sdk.js';

const commands = [
  { name: 'greet', desc: 'Say hello' },
];

async function execute(cmd) {
  if (cmd === 'greet') return ['  Hello, world!'];
  return ['  Unknown command'];
}

const tool = defineTool({
  manifest: { name: 'hello', label: '👋  Hello', hint: 'example tool' },
  commands,
  execute,
});
export { commands, execute };
export const manifest = tool.manifest;
```

### Tool API

| Export | Required | Purpose |
|--------|----------|---------|
| `commands` | Yes | Array of `{name, desc}` — shown in the suggest box |
| `execute(cmd)` | Yes | Called when user types a command; returns `string[]` |
| `manifest` | Yes | `{name, label, hint}` — tool identity and display |
| `main()` | No | Clack-powered full menu (called when user types `menu`) |
| `onEnter()` | No | Called when user enters the tool context |
| `onExit()` | No | Called when user leaves the tool context |

### Inline input

Tools can prompt users without leaving the shell:

```js
import { inlineSelect, inlineText, _appendOutput } from '../inline.js';

// Show a selection list in the suggestion box
const pick = await inlineSelect('Choose:', [
  { value: 'a', label: 'Option A', hint: 'description' },
  { value: 'b', label: 'Option B' },
]);

// Get text input with autocomplete suggestions
const name = await inlineText('Enter name:', 'default', ['alice', 'bob']);

// Append output that persists through render cycles
_appendOutput('This stays visible during the prompt');
```

## Configuration

| Path | Purpose |
|------|---------|
| `~/.devkit/aws/state.json` | Active AWS profile and region |
| `~/.devkit/totp.ini` | TOTP secrets (`name=base32key`) |
| `~/.aws/config` | AWS profiles with region |
| `~/.aws/credentials` | AWS access keys |

## Dependencies

- `@clack/prompts` — interactive menus (main menu path)
- `chalk` — terminal styling
- `python3` — TOTP code generation (HMAC-SHA1)
- `pbcopy` / `pbpaste` — clipboard integration (macOS built-in)

## License

MIT
