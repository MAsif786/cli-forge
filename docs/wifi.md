# WiFi Tool

Show connected WiFi network details, reveal saved passwords from Keychain, and scan nearby networks.

## Commands

| Command | Description |
|---------|-------------|
| `status` | Show current connection — SSID, IP, router, DNS, signal strength, channel |
| `password` | Reveal the WiFi password from macOS Keychain |
| `scan` | Scan for nearby WiFi networks with signal bars |
| `info` | Show all WiFi interface details from `airport -I` |

## Usage

```
devkit[wifi]> status                  # Connected network info
devkit[wifi]> password                # Reveal password for current SSID
devkit[wifi]> scan                    # Nearby networks with signal strength
devkit[wifi]> info                    # Raw airport -I output
```

## Status output

```
  WiFi Status: MyNetwork

  ● SSID               MyNetwork
  ● IP address         192.168.1.42
  ● Subnet mask        255.255.255.0
  ● Router             192.168.1.1
  ● MAC (Wi-Fi)        aa:bb:cc:dd:ee:ff
  ● Channel            36 (5 GHz)
  ● Max rate           866 Mbps
  ● Signal             -47 dBm  ▂▄▆█

  Use: wifi password  — to reveal the password
```

## Password

Retrieved from macOS Keychain via `security find-generic-password`. If you're not currently connected to WiFi, you can type any SSID manually to look up its saved password.

```
devkit[wifi]> password

  Password: MyNetwork

  🔑  hunter2

  (retrieved from macOS Keychain)
```

## Scan

Shows nearby networks with:
- Signal strength bars (▂▄▆█ green → yellow → red)
- SSID, channel, security type
- Current network marked with ●

Uses the `airport` utility at `/System/Library/PrivateFrameworks/Apple80211.framework/`.
