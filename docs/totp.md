# TOTP Tool

TOTP 2FA code manager — store accounts, view live codes with countdown timer, copy to clipboard.

## Commands

| Command | Description |
|---------|-------------|
| `live` | View all codes with real-time countdown timer |
| `copy` | Copy a TOTP code to clipboard |
| `list` | List all saved accounts |
| `add` | Add an account manually (name + base32 secret) |
| `import` | Import from `otpauth://` URI, clipboard, file, or Google Auth migration |
| `remove` | Remove a saved account |

## Usage

```
devkit[totp]> live                    # Full-screen live codes with timer
devkit[totp]> copy                    # Pick account → copy code to clipboard
devkit[totp]> add                     # Enter name and base32 secret
devkit[totp]> import                  # Paste otpauth:// URI or Google Auth export
devkit[totp]> remove                  # Delete an account
```

## Live codes view

```
  Account               Code      Countdown
  ──────────────────────────────────────────────────────
❯ 123 456  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░  25s  github
  789 012  ▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░  10s  aws
  ──────────────────────────────────────────────────────
  ↑↓ select  ·  (c) copy  ·  (q) quit
```

- `↑` / `↓` — select account
- `c` or `Enter` — copy selected code to clipboard
- `q` or `Esc` — exit

## Import formats

- `otpauth://totp/...?secret=...&issuer=...` — standard TOTP URI
- `otpauth-migration://...?data=...` — Google Authenticator export
- `c` — read URI from clipboard
- `f <path>` — read URI from a file

## Storage

Secrets stored in `~/.devkit/totp.ini` as `name=base32key` lines.

## Prerequisites

```bash
python3           # Built into macOS — used for TOTP code generation
```
