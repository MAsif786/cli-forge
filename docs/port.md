# Port Tool

Port scanning, process identification, kill, firewall rules, and network checks.

## Commands

| Command | Description |
|---------|-------------|
| `list` | List all listening ports with owning process |
| `find` | Find what is running on a specific port |
| `kill` | Kill the process running on a port |
| `open` | Open/expose a port through the firewall (pfctl) |
| `close` | Close/block a port through the firewall |
| `check` | Check TCP connectivity to host:port |
| `myip` | Show local and public IP addresses |

## Usage

```
devkit[port]> list                     # All listening ports
devkit[port]> find 3000               # What's on port 3000?
devkit[port]> kill 3000               # Kill the process on 3000
devkit[port]> check google.com:443    # Can I reach this?
devkit[port]> myip                    # Your local + public IP
```

## Firewall

Uses `pfctl` on macOS. `open` and `close` modify the packet filter to allow or block a port.
