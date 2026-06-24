# devkit totp — TOTP 2FA Code Manager
# Sourced by devkit — provides run_totp()
# No dependencies — only macOS built-ins (python3 + date)

run_totp() {
  local config_dir="$HOME/.devkit"
  local config_file="$config_dir/totp.ini"

  # Ensure config dir exists
  mkdir -p "$config_dir"
  touch "$config_file"

  # Check python3 (used for TOTP computation)
  if ! command -v python3 &>/dev/null; then
    err "python3 not found — install Xcode Command Line Tools: xcode-select --install"
    read -p "  Press Enter to return... "
    return 1
  fi

  local choice
  while true; do
    echo ""
    echo "========================================"
    echo "  devkit totp — TOTP 2FA Manager"
    echo "========================================"
    echo ""
    echo "  1)  Show all codes (live countdown)"
    echo "  2)  Add a new account (manual)"
    echo "  3)  Import from otpauth:// URI"
    echo "  4)  Scan QR from image file"
    echo "  5)  Remove an account"
    echo "  6)  List saved accounts"
    echo ""
    echo "  0)  Back to devkit"
    echo ""
    read -p "  Choice: " choice
    echo ""

    case "$choice" in
      1) totp_live "$config_file" ;;
      2) totp_add "$config_file" ;;
      3) totp_import_uri "$config_file" ;;
      4) totp_scan_qr "$config_file" ;;
      5) totp_remove "$config_file" ;;
      6) totp_list_accounts "$config_file" ;;
      0) info "Back to devkit"; break ;;
      *) err "Invalid choice" ;;
    esac

    if [ "$choice" != "0" ] && [ "$choice" != "1" ] && [ "$choice" != "3" ] && [ "$choice" != "4" ]; then
      echo ""
      read -p "  Press Enter to continue... "
    fi
  done
}


# ─── Helpers ───────────────────────────────────────────────

totp_read_secrets() {
  local file="$1"
  if [ ! -s "$file" ]; then
    return 0
  fi
  # Returns lines: account=secret
  cat "$file"
}

totp_generate_code() {
  local secret="$1"
  python3 -c "
import base64, hmac, struct, hashlib, time
secret = '''$secret'''
key = base64.b32decode(secret.upper().replace(' ', ''))
counter = int(time.time()) // 30
msg = struct.pack('>Q', counter)
digest = hmac.new(key, msg, hashlib.sha1).digest()
offset = digest[-1] & 0xf
truncated = struct.unpack('>I', digest[offset:offset+4])[0] & 0x7fffffff
code = truncated % 1000000
print(f'{code:06d}')
" 2>/dev/null
}

totp_remaining() {
  local period=30
  local now
  now=$(date +%s)
  echo $((period - (now % period)))
}


# ─── Add ───────────────────────────────────────────────────

totp_add() {
  local file="$1"

  echo ""
  echo "  Add a new 2FA account"
  echo "  ─────────────────────"
  echo ""

  read -p "  Account name (e.g. github): " account
  if [ -z "$account" ]; then
    err "Account name is required"
    return
  fi

  read -p "  Secret key (base32): " secret
  if [ -z "$secret" ]; then
    err "Secret key is required"
    return
  fi

  # Remove spaces from secret
  secret=$(echo "$secret" | tr -d ' ')

  # Validate by generating a test code
  local test_code
  test_code=$(totp_generate_code "$secret")
  if [ -z "$test_code" ]; then
    err "Invalid secret — could not generate code. Check the key is valid base32."
    return
  fi

  # Check if account already exists
  if grep -q "^${account}=" "$file" 2>/dev/null; then
    warn "Account '$account' already exists. Overwrite? (y/N): "
    read -p "  " overwrite
    if [ "$overwrite" != "y" ] && [ "$overwrite" != "Y" ]; then
      info "Cancelled"
      return
    fi
    # Remove old entry
    grep -v "^${account}=" "$file" > "${file}.tmp" && mv "${file}.tmp" "$file"
  fi

  echo "${account}=${secret}" >> "$file"
  ok "Account '$account' added (test code: $test_code)"
  warn "Your secrets are stored in plain text at: $file"
}


# ─── Import from URI ───────────────────────────────────────

totp_import_uri() {
  local file="$1"

  echo ""
  echo "  Import from URI"
  echo "  ───────────────"
  echo ""
  echo "  Supports:"
  echo "    • otpauth://totp/...?secret=...       (single account)"
  echo "    • otpauth-migration://offline?data=...  (Google Auth export)"
  echo "    • Paste the URI, or type 'c' to paste from clipboard"
  echo "    • Or save the URI to a file and type 'f <path>'"
  echo ""

  local uri
  read -r -p "  URI (or c/f): " uri
  if [ -z "$uri" ]; then
    err "URI is required"
    return
  fi

  # Read from clipboard
  if [ "$uri" = "c" ] || [ "$uri" = "C" ]; then
    if command -v pbpaste &>/dev/null; then
      uri=$(pbpaste)
      info "Read from clipboard"
    else
      err "pbpaste not available on this system"
      return
    fi
  fi

  # Read from file
  if [ "$uri" = "f" ] || [ "$uri" = "F" ]; then
    read -r -p "  File path: " fpath
    if [ -f "$fpath" ]; then
      uri=$(cat "$fpath" | head -1)
      info "Read from file: $fpath"
    else
      err "File not found: $fpath"
      return
    fi
  fi

  if [ -z "$uri" ]; then
    err "URI is required"
    return
  fi

  # Google Authenticator migration export
  if echo "$uri" | grep -qi "^otpauth-migration://"; then
    read -p "  Import all accounts from Google Auth export? (Y/n): " confirm
    if [ "$confirm" = "n" ] || [ "$confirm" = "N" ]; then
      info "Cancelled"
      return
    fi
    totp_parse_migration "$file" "$uri"
    return
  fi

  # Standard otpauth://totp/ACCOUNT?secret=...
  local account secret
  account=$(echo "$uri" | sed -n 's|otpauth://totp/\([^?]*\).*|\1|p')
  if [ -z "$account" ]; then
    account=$(echo "$uri" | sed -n 's|otpauth://TOTP/\([^?]*\).*|\1|p')
  fi
  account=$(echo "$account" | sed 's/%20/ /g; s/%40/@/g; s/%3A/:/g; s/%2F/\//g')

  secret=$(echo "$uri" | sed -n 's/.*[?&]secret=\([^&]*\).*/\1/p')

  if [ -z "$secret" ]; then
    err "Could not find 'secret' parameter in URI"
    return
  fi

  # If no account in URI, prompt for one
  if [ -z "$account" ]; then
    # Try to get issuer
    local issuer
    issuer=$(echo "$uri" | sed -n 's/.*[?&]issuer=\([^&]*\).*/\1/p')
    if [ -n "$issuer" ]; then
      account="$issuer"
    else
      read -p "  Account name (not found in URI): " account
      if [ -z "$account" ]; then
        err "Account name required"
        return
      fi
    fi
  fi

  # URL-decode issuer if used
  account=$(echo "$account" | sed 's/%20/ /g')

  # Remove spaces from secret
  secret=$(echo "$secret" | tr -d ' ')

  # Validate
  local test_code
  test_code=$(totp_generate_code "$secret")
  if [ -z "$test_code" ]; then
    err "Invalid secret in URI"
    return
  fi

  # Check for existing
  if grep -q "^${account}=" "$file" 2>/dev/null; then
    warn "Account '$account' already exists. Overwrite? (y/N): "
    read -p "  " overwrite
    if [ "$overwrite" != "y" ] && [ "$overwrite" != "Y" ]; then
      info "Cancelled"
      return
    fi
    grep -v "^${account}=" "$file" > "${file}.tmp" && mv "${file}.tmp" "$file"
  fi

  echo "${account}=${secret}" >> "$file"
  ok "Account '$account' imported (test code: $test_code)"
}


# ─── Google Authenticator migration parser ─────────────────
# Parses otpauth-migration://offline?data=BASE64 protobuf payload

totp_parse_migration() {
  local file="$1"
  local uri="$2"

  # Extract the base64 data parameter
  local b64data
  b64data=$(echo "$uri" | sed 's/.*[?&]data=\([^&]*\).*/\1/')
  if [ -z "$b64data" ] || [ "$b64data" = "$uri" ]; then
    err "Could not find 'data' parameter in URI"
    return
  fi

  info "Parsing Google Authenticator migration payload..."

  # Run Python via env vars and command-substituted heredoc
  local result
  result=$(TOTP_B64DATA="$b64data" TOTP_CONFIG="$file" python3 <<'PYEOF' 2>/dev/null
import base64, os, sys
from urllib.parse import unquote

b64 = os.environ['TOTP_B64DATA']
b64 = unquote(b64)  # decode %2B → +, %2F → /, etc.
b64 = b64.replace('-', '+').replace('_', '/')
pad = len(b64) % 4
if pad:
    b64 += '=' * (4 - pad)

try:
    raw = base64.b64decode(b64)
except Exception as e:
    print(f'ERROR|Base64 decode failed: {e}')
    sys.exit(1)

def decode_varint(data, offset):
    val = shift = 0
    while True:
        byte = data[offset]
        val |= (byte & 0x7f) << shift
        shift += 7
        offset += 1
        if not (byte & 0x80):
            break
    return val, offset

def decode_length_delimited(data, offset):
    length, offset = decode_varint(data, offset)
    return data[offset:offset + length], offset + length

def parse_fields(data):
    fields = {}
    off = 0
    while off < len(data):
        tag, off = decode_varint(data, off)
        fn = tag >> 3
        wt = tag & 0x7
        if wt == 0:
            v, off = decode_varint(data, off)
            fields[fn] = v
        elif wt == 2:
            v, off = decode_length_delimited(data, off)
            fields[fn] = v
        else:
            break
    return fields

# Parse top-level MigrationPayload
accounts = []
off = 0
while off < len(raw):
    tag, off = decode_varint(raw, off)
    fn = tag >> 3
    wt = tag & 0x7
    if fn == 1 and wt == 2:
        val, off = decode_length_delimited(raw, off)
        accounts.append(parse_fields(val))
    else:
        if wt == 0:
            _, off = decode_varint(raw, off)
        elif wt == 2:
            _, off = decode_length_delimited(raw, off)
        else:
            break

if not accounts:
    print('ERROR|No accounts found in migration payload')
    sys.exit(1)

config_path = os.environ['TOTP_CONFIG']

existing = set()
try:
    for line in open(config_path):
        if '=' in line:
            existing.add(line.split('=')[0].strip())
except FileNotFoundError:
    pass

digit_map = {0: 6, 1: 6, 2: 8}
algo_map = {0: 'SHA1', 1: 'SHA1', 2: 'SHA256', 3: 'SHA512'}

imported = 0
for i, acct in enumerate(accounts):
    raw_secret = acct.get(1, b'')
    name = acct.get(2, b'').decode('utf-8', errors='replace')
    issuer = acct.get(3, b'').decode('utf-8', errors='replace')
    otp_type = acct.get(6, 0)

    if otp_type == 1:
        print(f'SKIP_HOTP|{name}|{issuer}')
        continue

    if not raw_secret:
        print(f'SKIP_EMPTY|{name}|{issuer}')
        continue

    b32 = base64.b32encode(raw_secret).decode('utf-8').rstrip('=')

    if issuer and name:
        display = name if name.startswith(issuer + ':') else f'{issuer}:{name}'
    elif issuer:
        display = issuer
    elif name:
        display = name
    else:
        display = f'unknown_{i}'

    if display in existing:
        print(f'SKIP_EXISTS|{display}')
        continue

    with open(config_path, 'a') as f:
        f.write(f'{display}={b32}\n')
    imported += 1
    print(f'OK|{display} ({algo_map.get(acct.get(4, 0), "SHA1")}, {digit_map.get(acct.get(5, 0), 6)} digits)')

print(f'DONE|{imported}')
PYEOF
)

  echo "$result" | while IFS='|' read -r tag rest; do
    case "$tag" in
      OK)    ok "  $rest" ;;
      SKIP_HOTP)   warn "  Skipping HOTP: $rest" ;;
      SKIP_EMPTY)  warn "  Skipping empty secret: $rest" ;;
      SKIP_EXISTS) warn "  Already exists: $rest — skipped" ;;
      DONE)  info "  $rest account(s) imported" ;;
      ERROR) err "$rest" ;;
    esac
  done
}

# ─── QR decoder (native macOS via Swift, fallback to zbarimg) ─

totp_decode_qr() {
  local img="$1"

  # Native macOS: Swift + CoreImage CIDetector
  if command -v swift &>/dev/null; then
    local tmpfile
    tmpfile=$(mktemp /tmp/devkit-qr-XXXXXX.swift)
    cat > "$tmpfile" <<'SWIFT'
import Foundation
import CoreImage

let path = CommandLine.arguments[1]
guard let image = CIImage(contentsOf: URL(fileURLWithPath: path)) else { exit(1) }
let detector = CIDetector(ofType: CIDetectorTypeQRCode, context: nil, options: [CIDetectorAccuracy: CIDetectorAccuracyHigh])!
let features = detector.features(in: image)
for case let qr as CIQRCodeFeature in features {
    if let msg = qr.messageString, !msg.isEmpty {
        print(msg)
        exit(0)
    }
}
SWIFT
    local result
    result=$(swift "$tmpfile" "$img" 2>/dev/null)
    rm -f "$tmpfile"
    if [ -n "$result" ]; then
      echo "$result"
      return
    fi
  fi

  # Fallback: zbarimg (brew install zbar)
  if command -v zbarimg &>/dev/null; then
    local result
    result=$(zbarimg -q "$img" 2>/dev/null | sed 's/^QR-Code://i')
    if [ -n "$result" ]; then
      echo "$result"
      return
    fi
  fi

  # No decoder available
  warn "No QR decoder found"
  echo ""
  info "  Install one of:"
  echo "    • Xcode CLT (for Swift): xcode-select --install"
  echo "    • zbar: brew install zbar"
  return 1
}


# ─── Scan QR from image ────────────────────────────────────

totp_scan_qr() {
  local file="$1"

  echo ""
  echo "  Scan QR Code from Image"
  echo "  ───────────────────────"
  echo ""
  echo "  Two ways:"
  echo "    1) Take a screenshot (opens the cropper)"
  echo "    2) Specify an image file path"
  echo ""

  read -r -p "  Choice [1]: " scan_choice

  local image_path=""

  if [ "$scan_choice" = "2" ]; then
    read -r -p "  Image file path: " image_path
    if [ ! -f "$image_path" ]; then
      err "File not found: $image_path"
      return
    fi
  else
    # Take screenshot with macOS screencapture
    local tmp_img
    tmp_img=$(mktemp /tmp/devkit-qr-XXXXXX.png)
    info "Select the QR code area on screen..."
    echo ""
    local sc_err
    sc_err=$(screencapture -i "$tmp_img" 2>&1)
    if [ $? -ne 0 ] || [ ! -s "$tmp_img" ]; then
      rm -f "$tmp_img"
      err "Screenshot failed — ${sc_err:-cancelled or no permission}"
      echo ""
      warn "Grant Screen Recording permission to Terminal, then try again."
      read -p "  Open System Settings now? (y/N): " open_settings
      if [ "$open_settings" = "y" ] || [ "$open_settings" = "Y" ]; then
        open "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture" 2>/dev/null || \
        warn "Could not open settings — navigate manually to:"
        info "  System Settings → Privacy & Security → Screen Recording"
      fi
      echo ""
      info "Alternative: use option 2 to select an image file directly."
      return
    fi
    image_path="$tmp_img"
  fi

  echo ""
  info "Scanning QR code..."
  local scan_result
  scan_result=$(totp_decode_qr "$image_path")

  # Clean up temp screenshot
  if [ -f "$tmp_img" ] 2>/dev/null; then
    rm -f "$tmp_img"
  fi

  if [ -z "$scan_result" ]; then
    err "No QR code found in image"
    return
  fi

  local uri="$scan_result"

  echo ""
  ok "QR code detected!"
  echo "  URI: $uri"
  echo ""

  # Handle Google Authenticator migration QR
  if echo "$uri" | grep -qi "^otpauth-migration://"; then
    ok "Detected Google Authenticator export QR!"
    read -p "  Import all accounts? (Y/n): " confirm
    if [ "$confirm" = "n" ] || [ "$confirm" = "N" ]; then
      info "Cancelled"
      return
    fi
    totp_parse_migration "$file" "$uri"
    return
  fi

  # Standard otpauth://totp/... QR
  if echo "$uri" | grep -qi "^otpauth://"; then
    read -p "  Import this account? (Y/n): " confirm
    if [ "$confirm" = "n" ] || [ "$confirm" = "N" ]; then
      info "Cancelled"
      return
    fi
    # Feed the URI to the import function
    # We need to extract and pass the data
    local account secret
    account=$(echo "$uri" | sed -n 's|otpauth://[tT][oO][tT][pP]/\([^?]*\).*|\1|p')
    account=$(echo "$account" | sed 's/%20/ /g; s/%40/@/g')
    secret=$(echo "$uri" | sed -n 's/.*[?&]secret=\([^&]*\).*/\1/p')

    if [ -z "$secret" ]; then
      err "No secret found in QR code"
      return
    fi

    if [ -z "$account" ]; then
      account=$(echo "$uri" | sed -n 's/.*[?&]issuer=\([^&]*\).*/\1/p')
      account=$(echo "$account" | sed 's/%20/ /g')
      if [ -z "$account" ]; then
        read -p "  Account name (not in QR): " account
        [ -z "$account" ] && account="unknown"
      fi
    fi

    secret=$(echo "$secret" | tr -d ' ')

    local test_code
    test_code=$(totp_generate_code "$secret")
    if [ -z "$test_code" ]; then
      err "Invalid secret in QR code"
      return
    fi

    if grep -q "^${account}=" "$file" 2>/dev/null; then
      warn "Account '$account' already exists. Overwrite? (y/N): "
      read -p "  " overwrite
      if [ "$overwrite" != "y" ] && [ "$overwrite" != "Y" ]; then
        info "Cancelled"
        return
      fi
      grep -v "^${account}=" "$file" > "${file}.tmp" && mv "${file}.tmp" "$file"
    fi

    echo "${account}=${secret}" >> "$file"
    ok "Account '$account' imported from QR code (test code: $test_code)"
  else
    warn "Not an otpauth:// URI — it's: $uri"
    echo "  You can add it manually with option 2."
  fi
}


# ─── Remove ────────────────────────────────────────────────

totp_remove() {
  local file="$1"
  local accounts
  accounts=$(totp_read_secrets "$file")

  if [ -z "$accounts" ]; then
    warn "No accounts saved"
    return
  fi

  local names=()
  local i=1
  echo "  Saved accounts:"
  echo ""
  while IFS='=' read -r name secret; do
    names+=("$name")
    printf "  %2d)  %s\n" "$i" "$name"
    i=$((i + 1))
  done <<< "$accounts"

  echo ""
  read -p "  Account to remove [1-$(($i-1))]: " selection

  if ! [[ "$selection" =~ ^[0-9]+$ ]] || [ "$selection" -lt 1 ] || [ "$selection" -gt $(($i-1)) ]; then
    err "Invalid selection"
    return
  fi

  local selected="${names[$((selection-1))]}"
  read -p "  Remove '$selected'? (y/N): " confirm

  if [ "$confirm" != "y" ] && [ "$confirm" != "Y" ]; then
    info "Cancelled"
    return
  fi

  grep -v "^${selected}=" "$file" > "${file}.tmp" && mv "${file}.tmp" "$file"
  ok "Account '$selected' removed"
}


# ─── List accounts ─────────────────────────────────────────

totp_list_accounts() {
  local file="$1"
  local accounts
  accounts=$(totp_read_secrets "$file")

  if [ -z "$accounts" ]; then
    warn "No accounts saved"
    echo "  Add one with option 2."
    return
  fi

  echo ""
  printf "  %-20s  %s\n" "Account" "Secret (hidden)"
  echo "  ─────────────────────────────"
  while IFS='=' read -r name secret; do
    local masked
    if [ ${#secret} -gt 8 ]; then
      masked="${secret:0:4}...${secret: -4}"
    else
      masked="****"
    fi
    printf "  %-20s  %s\n" "$name" "$masked"
  done <<< "$accounts"

  local count
  count=$(echo "$accounts" | wc -l | tr -d ' ')
  echo ""
  echo "  $count account(s) saved"
}


# ─── Live codes with countdown ─────────────────────────────

totp_live() {
  local file="$1"
  local accounts
  accounts=$(totp_read_secrets "$file")

  if [ -z "$accounts" ]; then
    warn "No accounts saved"
    echo "  Add one with option 2."
    return
  fi

  # Parse accounts into arrays
  local names=() secrets=()
  while IFS='=' read -r name secret; do
    names+=("$name")
    secrets+=("$secret")
  done <<< "$accounts"

  local count=${#names[@]}

  echo ""
  info "TOTP Live Codes — Ctrl+C to stop"
  echo ""

  # Run refresh loop with INT trap that sets a flag (doesn't leak out of function)
  local stop_live=false
  local printed_lines=0
  local prev_window=-1
  local -a codes_cache
  codes_cache=()
  trap 'stop_live=true' INT

  while ! $stop_live; do
    now=$(date +%s)
    window=$((now / 30))
    remaining=$((30 - (now % 30)))

    # Only regenerate codes when the 30-second window ticks over
    if [ "$window" -ne "$prev_window" ]; then
      for ((i=0; i<count; i++)); do
        codes_cache[$i]=$(totp_generate_code "${secrets[$i]}")
      done
      prev_window=$window
    fi

    if [ "$printed_lines" -gt 0 ]; then
      printf "\033[%dA" "$printed_lines"
      printf "\033[J"
    fi
    printed_lines=$((count + 4))

    # Header with numbers
    printf "  \033[1m%-4s  %-20s  %-8s  %s\033[0m\n" " #" "Account" "Code" "Countdown"
    printf "  \033[2m%s\033[0m\n" "────────────────────────────────────────────────────"

    for ((i=0; i<count; i++)); do
      idx=$((i + 1))
      code="${codes_cache[$i]}"
      code_display="$code"
      name="${names[$i]}"
      [ ${#name} -gt 20 ] && name="${name:0:18}.."

      # Progress bar: 10 blocks, each = 3 seconds
      filled=$(( (remaining + 2) / 3 ))
      [ "$filled" -gt 10 ] && filled=10
      bar=""
      for ((j=0; j<filled; j++)); do bar="${bar}▓"; done
      for ((j=filled; j<10; j++)); do bar="${bar}░"; done

      secs=$(printf "%2ds" "$remaining")

      if [ "$remaining" -le 5 ]; then
        printf "  \033[31m[%d]  %-20s  %s  %s %s\033[0m\n" "$idx" "$name" "$code_display" "$bar" "$secs"
      elif [ "$remaining" -le 15 ]; then
        printf "  \033[33m[%d]  %-20s  %s  %s %s\033[0m\n" "$idx" "$name" "$code_display" "$bar" "$secs"
      else
        printf "  \033[32m[%d]  %-20s  %s  %s %s\033[0m\n" "$idx" "$name" "$code_display" "$bar" "$secs"
      fi
    done

    printf "  \033[2m%s\033[0m\n" "────────────────────────────────────────────────────"
    echo "  (Ctrl+C to stop  |  Enter # to copy code)"
    sleep 1
  done

  # Restore default INT handler
  trap - INT
  echo ""

  # Copy prompt after live view exits
  if [ "$count" -gt 0 ]; then
    read -r -p "  Copy code for account # (0 to skip): " copy_idx
    if [[ "$copy_idx" =~ ^[0-9]+$ ]] && [ "$copy_idx" -ge 1 ] && [ "$copy_idx" -le "$count" ]; then
      copy_code="${codes_cache[$((copy_idx - 1))]}"
      printf "%s" "$copy_code" | pbcopy 2>/dev/null
      ok "  ${names[$((copy_idx - 1))]}: $copy_code  (copied to clipboard)"
    fi
  fi
}
