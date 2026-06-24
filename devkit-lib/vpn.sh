# devkit vpn — VPN Connection Manager
# Sourced by devkit — provides run_vpn()

run_vpn() {
  local config_dir="$HOME/.devkit/vpn"
  mkdir -p "$config_dir"

  local ovpn_bin=""
  command -v openvpn &>/dev/null && ovpn_bin="openvpn"
  command -v /usr/local/sbin/openvpn &>/dev/null && ovpn_bin="/usr/local/sbin/openvpn"
  command -v /opt/homebrew/sbin/openvpn &>/dev/null && ovpn_bin="/opt/homebrew/sbin/openvpn"

  local choice
  while true; do
    echo ""
    echo "========================================"
    echo "  devkit vpn — VPN Connection Manager"
    echo "========================================"
    echo ""
    echo "  1)  Scan and connect to VPN"
    echo "  2)  Disconnect current VPN"
    echo "  3)  Show connection status"
    echo "  4)  Manage config files"
    echo ""
    echo "  0)  Back to devkit"
    echo ""

    read -r -p "  Choice: " choice
    echo ""

    case "$choice" in
      1) vpn_connect "$ovpn_bin" ;;
      2) vpn_disconnect ;;
      3) vpn_status ;;
      4) vpn_manage_configs "$ovpn_bin" ;;
      0) info "Back to devkit"; break ;;
      *) err "Invalid choice" ;;
    esac

    if [ "$choice" != "0" ] && [ "$choice" != "1" ] && [ "$choice" != "3" ]; then
      echo ""
      read -r -p "  Press Enter to continue... "
    fi
  done
}


vpn_connect() {
  local ovpn_bin="$1"

  # Find .ovpn files
  local configs=()
  while IFS= read -r -d '' f; do
    configs+=("$f")
  done < <(find "$HOME" -maxdepth 4 -name "*.ovpn" -not -path "*/.*" -print0 2>/dev/null)

  if [ ${#configs[@]} -eq 0 ]; then
    warn "No .ovpn files found"
    echo ""
    info "  Place .ovpn configs in ~/.devkit/vpn/ or anywhere under ~/"
    echo ""
    read -r -p "  Add a config file path manually? (y/N): " add_manual
    if [ "$add_manual" = "y" ] || [ "$add_manual" = "Y" ]; then
      read -r -p "  Path to .ovpn file: " fpath
      if [ -f "$fpath" ]; then
        configs+=("$fpath")
      else
        err "File not found"
        return
      fi
    else
      return
    fi
  fi

  # Show configs with index
  local i=1
  echo "  Available VPN configs:"
  echo ""
  for cfg in "${configs[@]}"; do
    local name
    name=$(basename "$cfg" .ovpn)
    local dir
    dir=$(dirname "$cfg")
    printf "  %2d)  %-25s  (%s)\n" "$i" "$name" "${dir#$HOME/}"
    i=$((i + 1))
  done
  echo ""
  read -r -p "  Select config [1-$(($i-1))]: " selection

  if ! [[ "$selection" =~ ^[0-9]+$ ]] || [ "$selection" -lt 1 ] || [ "$selection" -ge "$i" ]; then
    err "Invalid selection"
    return
  fi

  local selected="${configs[$((selection-1))]}"

  # Check if already connected
  if [ -f "$HOME/.devkit/vpn/active.pid" ]; then
    warn "A VPN connection is already active"
    read -r -p "  Disconnect first? (Y/n): " disconnect_first
    if [ "$disconnect_first" != "n" ] && [ "$disconnect_first" != "N" ]; then
      vpn_disconnect
      sleep 1
    else
      err "Cancelled"
      return
    fi
  fi

  if [ -z "$ovpn_bin" ]; then
    err "OpenVPN not found"
    echo ""
    info "  Install with: brew install openvpn"
    return
  fi

  echo ""
  info "Connecting to $(basename "$selected" .ovpn)..."

  # Check if sudo is needed (openvpn usually needs root)
  local log_file="$HOME/.devkit/vpn/openvpn.log"
  sudo "$ovpn_bin" --config "$selected" --log "$log_file" --daemon --writepid "$HOME/.devkit/vpn/active.pid" 2>/dev/null
  local exit_code=$?

  if [ $exit_code -eq 0 ]; then
    ok "VPN connected!"
    echo ""
    info "  Config: $(basename "$selected")"
    info "  Log:    $log_file"
    echo ""
    info "  Use option 3 to check status, option 2 to disconnect"
  else
    err "Failed to connect (exit code: $exit_code)"
    info "  Check log: $log_file"
  fi
}


vpn_disconnect() {
  local pid_file="$HOME/.devkit/vpn/active.pid"

  if [ ! -f "$pid_file" ]; then
    warn "No active VPN connection found"
    return
  fi

  local pid
  pid=$(cat "$pid_file" 2>/dev/null)
  if [ -n "$pid" ] && kill "$pid" 2>/dev/null; then
    ok "VPN disconnected"
  else
    warn "Could not kill process $pid (may already be disconnected)"
  fi

  rm -f "$pid_file"

  # Also try to kill any openvpn processes that might be orphaned
  local remaining
  remaining=$(pgrep openvpn 2>/dev/null || true)
  if [ -n "$remaining" ]; then
    info "Cleaning up remaining OpenVPN processes..."
    sudo pkill openvpn 2>/dev/null || true
  fi
}


vpn_status() {
  local pid_file="$HOME/.devkit/vpn/active.pid"
  local log_file="$HOME/.devkit/vpn/openvpn.log"

  echo ""
  echo "  VPN Connection Status"
  echo "  ─────────────────────"
  echo ""

  if [ -f "$pid_file" ]; then
    local pid
    pid=$(cat "$pid_file" 2>/dev/null)
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      ok "Connected (PID: $pid)"
      echo ""

      # Show uptime
      local start_time
      start_time=$(ps -o lstart= -p "$pid" 2>/dev/null)
      if [ -n "$start_time" ]; then
        echo "  Started: $start_time"
      fi

      # Show last log lines
      if [ -s "$log_file" ]; then
        echo ""
        echo "  Recent log entries:"
        tail -3 "$log_file" 2>/dev/null | while IFS= read -r line; do
          echo "    $line"
        done
      fi

      # Show IP (optional, if curl is available)
      if command -v curl &>/dev/null; then
        echo ""
        local pub_ip
        pub_ip=$(curl -s --max-time 3 ifconfig.me 2>/dev/null || echo "unavailable")
        echo "  Public IP: $pub_ip"
      fi
    else
      warn "PID file exists but process is not running"
      rm -f "$pid_file"
    fi
  else
    warn "Not connected"
    echo ""
    info "  Use option 1 to connect to a VPN"
  fi
}


vpn_manage_configs() {
  local ovpn_bin="$1"

  local vpn_dir="$HOME/.devkit/vpn/configs"
  mkdir -p "$vpn_dir"

  echo ""
  echo "  VPN Config Files"
  echo "  ────────────────"
  echo ""
  echo "  1)  List configs in ~/.devkit/vpn/configs/"
  echo "  2)  Import a .ovpn file"
  echo "  3)  Remove a config"
  echo ""

  read -r -p "  Choice: " cfg_choice
  echo ""

  case "$cfg_choice" in
    1)
      local configs=("$vpn_dir"/*.ovpn)
      if [ -f "${configs[0]}" ]; then
        echo "  Configs in $vpn_dir:"
        for cfg in "${configs[@]}"; do
          echo "    • $(basename "$cfg")"
        done
      else
        warn "No configs in $vpn_dir"
      fi
      ;;
    2)
      read -r -p "  Path to .ovpn file: " fpath
      if [ -f "$fpath" ]; then
        cp "$fpath" "$vpn_dir/"
        ok "Imported $(basename "$fpath")"
      else
        err "File not found"
      fi
      ;;
    3)
      local configs=("$vpn_dir"/*.ovpn)
      if [ -f "${configs[0]}" ]; then
        local i=1
        for cfg in "${configs[@]}"; do
          printf "  %2d)  %s\n" "$i" "$(basename "$cfg")"
          i=$((i + 1))
        done
        echo ""
        read -r -p "  Remove config #: " rm_idx
        if [[ "$rm_idx" =~ ^[0-9]+$ ]] && [ "$rm_idx" -ge 1 ] && [ "$rm_idx" -lt "$i" ]; then
          rm -f "${configs[$((rm_idx-1))]}"
          ok "Removed"
        fi
      else
        warn "No configs to remove"
      fi
      ;;
    *)
      err "Invalid choice"
      ;;
  esac
}
