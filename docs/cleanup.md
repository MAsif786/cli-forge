# Cleanup Tool

Scan and free disk space — Docker, npm, pip, Homebrew, caches, Trash, old virtualenvs, and more.

## Commands

| Command | Description |
|---------|-------------|
| `scan` | Scan all categories and interactively choose what to clean |

## Usage

```
devkit[cleanup]> scan
```

The tool scans these categories and shows estimated space:

| Category | What it finds |
|----------|---------------|
| Docker | Unused images, containers, volumes, build cache |
| npm | `node_modules` in common project directories, npm cache |
| pip | pip cache |
| Homebrew | Old formula versions, downloads cache |
| System Caches | `~/Library/Caches` — Xcode, Chrome, Spotify, Slack, etc. |
| Trash | `~/.Trash` contents |
| Old venvs | Python virtualenvs with no `pyproject.toml`/`setup.py` parent |
| Downloads | Files older than 30 days |

After scanning, select which categories to clean with a multi-select menu. Each item shows estimated space to reclaim.
