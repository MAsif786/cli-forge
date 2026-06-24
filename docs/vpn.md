# VPN Tool

OpenVPN connection manager — scan configs, connect, disconnect, check status.

## Commands

| Command | Description |
|---------|-------------|
| `connect` | Connect to a VPN config |
| `disconnect` | Disconnect the active VPN |
| `status` | Check connection status and public IP |
| `configs` | Manage VPN config files |

## Usage

```
devkit[vpn]> connect                  # Pick a .ovpn config and connect
devkit[vpn]> status                   # Show connection + public IP
devkit[vpn]> disconnect               # Kill the OpenVPN process
devkit[vpn]> configs                  # List/add/remove .ovpn configs
```

## Prerequisites

```bash
brew install openvpn
```

VPN configs (`.ovpn` files) are scanned from `~/vpn/` by default. Place your `.ovpn` files there.
