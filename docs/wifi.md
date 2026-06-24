# WiFi Tool

Show connected WiFi network details, reveal saved passwords from Keychain, and scan nearby networks. Works on both Intel and Apple Silicon Macs.

## Commands

| Command | Description |
|---------|-------------|
| `status` | Show connection details — IP, router, DNS, signal, channel, PHY mode |
| `password` | Reveal WiFi password from macOS Keychain (pick from known networks) |
| `scan` | Scan nearby WiFi networks with signal bars |
| `info` | Show WiFi interface — card type, firmware, MAC, power state |

## Usage

```
devkit[wifi]> status                  # Connection details
devkit[wifi]> password                # Pick network → reveal password
devkit[wifi]> scan                    # Nearby networks with signal bars
devkit[wifi]> info                    # Interface hardware details
```

## macOS compatibility

| macOS version | SSID detection | Scan engine |
|---------------|---------------|-------------|
| Intel / older macOS | `networksetup -getairportnetwork` | `airport -s` |
| Apple Silicon / macOS 26+ | Hidden by OS (shows all details except SSID) | `system_profiler SPAirPortDataType` |

On newer macOS, the SSID is redacted by the system — status shows all wireless details (channel, signal, PHY, security) and the password command lets you pick from your known networks list.

## Status output

```
  WiFi Status: Connected

  ● SSID               MyNetwork
  ● IP address         192.168.18.4
  ● Subnet mask        255.255.255.0
  ● Router             192.168.18.1
  ● PHY Mode          802.11ax
  ● Channel           149 (5GHz, 80MHz)
  ● Security          WPA2 Personal
  ● Signal / Noise    -55 dBm / -93 dBm
  ● TX Rate           720 Mbps

  Use: wifi password  — to reveal the password
```

## Password

Retrieved from macOS Keychain via `security find-generic-password`. On newer macOS where the SSID is hidden, the tool shows your list of known/preferred networks to pick from.

```
devkit[wifi]> password
  → pick "MyNetwork" from the list of known networks
  🔑  hunter2
  (retrieved from macOS Keychain)
```

## Scan

Uses `system_profiler SPAirPortDataType` (all macOS versions) with `airport -s` fallback. Shows nearby networks with signal bars (▂▄▆█).
