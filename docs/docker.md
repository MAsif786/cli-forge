# Docker Tool

Container and image management via an interactive menu or quick commands.

## Commands

| Command | Description |
|---------|-------------|
| `list` | List running containers |
| `all` | List all containers (including stopped) |
| `start` | Start a stopped container |
| `stop` | Stop a running container |
| `restart` | Restart a container |
| `rm` | Remove a container |
| `logs` | View container logs (with follow option) |
| `images` | List images |
| `rmi` | Remove an image |
| `prune` | Prune dangling images |
| `sysprune` | Full system prune (containers, networks, images) |
| `df` | Show disk usage by Docker |

## Usage

```
devkit[docker]> list                  # Running containers
devkit[docker]> all                   # All containers
devkit[docker]> logs <container>      # Stream logs
devkit[docker]> images                # List images with sizes
devkit[docker]> prune                 # Clean up dangling images
devkit[docker]> df                    # Disk usage breakdown
```

## Prerequisites

Docker Desktop or Docker Engine must be installed and running:

```bash
brew install --cask docker
```
