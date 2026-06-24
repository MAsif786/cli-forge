# SSH Tool

SSH connection manager — parse `~/.ssh/config`, connect to hosts, manage config entries, and copy keys.

## Commands

| Command | Description |
|---------|-------------|
| `list` | List all hosts from `~/.ssh/config` |
| `connect` | Pick a host and open an SSH session |
| `add` | Add a new host entry to SSH config (inline or menu) |
| `remove` | Remove a host from SSH config |
| `key` | Show SSH key fingerprint and details |
| `copy` | Copy SSH public key to clipboard |

## Usage

```
devkit[ssh]> list                    # All configured hosts
devkit[ssh]> connect                 # Pick a host → opens SSH session
devkit[ssh]> add                     # Walk through host alias, hostname, user, port, identity
devkit[ssh]> remove                  # Pick and confirm removal from config
devkit[ssh]> key                     # Choose a key, show fingerprints
devkit[ssh]> copy                    # Copy public key to clipboard
```

## Connect flow

1. Lists all hosts from `~/.ssh/config`
2. Select a host → launches `ssh <host>` in your terminal
3. Session runs interactively — type `exit` or Ctrl+D to return

## Add flow

Prompts for:
- **Host alias** — short name (e.g. `myserver`)
- **Hostname** — IP or FQDN
- **User** — SSH username (defaults to current user)
- **Port** — SSH port (defaults to 22)
- **Identity file** — optional path to private key

Writes the entry to `~/.ssh/config`.
