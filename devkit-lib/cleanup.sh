# devkit cleanup tool
# Sourced by devkit — provides run_cleanup()

run_cleanup() {
  local total_freed=0
  local items_to_clean=()

  scan_docker() {
    echo ""
    echo "========================================"
    echo "  Docker"
    echo "========================================"
    if ! command -v docker &>/dev/null; then
      ok "Docker not installed - skipping"
      return
    fi
    local df
    df=$(timeout 30 docker system df 2>/dev/null) || { err "Docker daemon not responding - skipping"; return; }

    local img reclaim img_size build_size
    img=$(echo "$df" | awk '/Images/{print $4}' | sed 's/GB/G/' | sed 's/MB/M/' | sed 's/kB/k/')
    reclaim=$(echo "$df" | grep -E 'Images|Build Cache' | awk '{sum+=$5} END{print sum}')

    if [ -z "$reclaim" ] || [ "$reclaim" = "0" ]; then
      ok "Docker - nothing significant to reclaim"
      return
    fi

    local reclaim_hr
    if echo "$reclaim" | grep -qE '^[0-9]+(\.[0-9]+)?$'; then
      reclaim_hr=$(echo "$reclaim" | awk '{printf "%.1fGB", $1}')
    else
      reclaim_hr="${reclaim}GB"
    fi

    warn "Docker images + build cache: ~${reclaim_hr} reclaimable"
    echo "  $(echo "$df" | head -1)"
    echo "  $(echo "$df" | grep Images)"
    echo "  $(echo "$df" | grep "Build Cache")"
    echo "  $(echo "$df" | grep "Local Volumes")"

    items_to_clean+=("Docker (images + build cache): ~${reclaim_hr}")
    eval "__docker_reclaim=$reclaim"
  }

  clean_docker() {
    info "Pruning Docker system..."
    docker system prune -a --force --volumes 2>&1 | tail -1
    info "Docker cleanup complete."
  }

  scan_npm() {
    echo ""
    echo "========================================"
    echo "  npm / pnpm Cache"
    echo "========================================"
    local npm_size pnpm_size
    npm_size=$(du -sh ~/.npm 2>/dev/null | awk '{print $1}') || npm_size="0B"
    pnpm_size=$(du -sh ~/Library/Caches/pnpm 2>/dev/null | awk '{print $1}') || pnpm_size="0B"

    if [ "$npm_size" != "0B" ]; then
      warn "npm cache: $npm_size"
      items_to_clean+=("npm cache: $npm_size")
    else
      ok "npm cache: clean"
    fi
    if [ "$pnpm_size" != "0B" ]; then
      warn "pnpm cache: $pnpm_size"
      items_to_clean+=("pnpm cache: $pnpm_size")
    fi
  }

  clean_npm() {
    info "Cleaning npm cache..."
    npm cache clean --force 2>/dev/null && ok "npm cache cleaned" || warn "npm cache clean skipped"
    rm -rf ~/Library/Caches/pnpm 2>/dev/null && ok "pnpm cache cleaned"
  }

  scan_pip() {
    echo ""
    echo "========================================"
    echo "  pip / uv / pre-commit / pipenv Caches"
    echo "========================================"
    for dir in ~/Library/Caches/pip ~/.cache/uv ~/.cache/pre-commit ~/.cache/pipenv ~/.cache/poetry; do
      local size
      size=$(du -sh "$dir" 2>/dev/null | awk '{print $1}') || continue
      if [ "$size" != "0B" ] && [ -n "$size" ]; then
        warn "$(basename "$dir"): $size"
        items_to_clean+=("$(basename "$dir"): $size")
      else
        ok "$(basename "$dir"): clean"
      fi
    done
  }

  clean_pip() {
    rm -rf ~/Library/Caches/pip ~/.cache/uv ~/.cache/pre-commit ~/.cache/pipenv ~/.cache/poetry 2>/dev/null
    ok "pip/uv/pre-commit caches cleaned"
  }

  scan_homebrew() {
    echo ""
    echo "========================================"
    echo "  Homebrew"
    echo "========================================"
    if ! command -v brew &>/dev/null; then
      ok "Homebrew not installed - skipping"
      return
    fi
    local size
    size=$(du -sh ~/Library/Caches/Homebrew 2>/dev/null | awk '{print $1}')
    if [ -n "$size" ] && [ "$size" != "0B" ]; then
      warn "Homebrew cache: $size"
      items_to_clean+=("Homebrew cache: $size")
    else
      ok "Homebrew cache: clean"
    fi
  }

  clean_homebrew() {
    brew cleanup --prune=all 2>/dev/null
    rm -rf ~/Library/Caches/Homebrew/downloads/* 2>/dev/null
    ok "Homebrew cleaned"
  }

  scan_caches() {
    echo ""
    echo "========================================"
    echo "  System & App Caches"
    echo "========================================"
    for dir in \
      ~/Library/Caches/Google \
      ~/Library/Caches/Steam \
      ~/Library/Caches/SiriTTS \
      ~/Library/Caches/vscode-cpptools \
      ~/Library/Caches/Microsoft\ Edge \
      ~/Library/Caches/com.anthropic.claudefordesktop.ShipIt \
      ~/Library/Caches/GeoServices \
      ~/Library/Caches/puppeteer
    do
      local size
      size=$(du -sh "$dir" 2>/dev/null | awk '{print $1}') || continue
      if [ -n "$size" ] && [ "$size" != "0B" ]; then
        local name
        name=$(basename "$dir")
        warn "$name: $size"
        items_to_clean+=("$name cache: $size")
      fi
    done
  }

  clean_caches() {
    rm -rf \
      ~/Library/Caches/Google \
      ~/Library/Caches/Steam \
      ~/Library/Caches/SiriTTS \
      ~/Library/Caches/vscode-cpptools \
      ~/Library/Caches/Microsoft\ Edge \
      ~/Library/Caches/GeoServices \
      ~/Library/Caches/puppeteer \
      2>/dev/null
    ok "App caches cleaned"
  }

  scan_trash() {
    echo ""
    echo "========================================"
    echo "  Trash"
    echo "========================================"
    local size
    size=$(du -sh ~/.Trash 2>/dev/null | awk '{print $1}')
    if [ -n "$size" ] && [ "$size" != "0B" ] && [ "$size" != "0" ]; then
      warn "Trash: $size"
      items_to_clean+=("Trash: $size")
    else
      ok "Trash is empty"
    fi
  }

  clean_trash() {
    rm -rf ~/.Trash/* 2>/dev/null
    ok "Trash emptied"
  }

  scan_old_venvs() {
    echo ""
    echo "========================================"
    echo "  Old Virtual Environments"
    echo "========================================"
    for dir in ~/.venv ~/.venv2 ~/.venv3 ~/venv ~/env; do
      local size
      size=$(du -sh "$dir" 2>/dev/null | awk '{print $1}') || continue
      if [ -n "$size" ] && [ "$size" != "0B" ]; then
        warn "$(basename "$dir"): $size"
        items_to_clean+=("Old venv ($(basename "$dir")): $size")
      fi
    done
  }

  clean_old_venvs() {
    for dir in ~/.venv2 ~/.venv3 ~/venv ~/env; do
      rm -rf "$dir" 2>/dev/null
    done
    ok "Old virtual environments removed"
  }

  scan_old_projects() {
    echo ""
    echo "========================================"
    echo "  Large node_modules (in ~/Desktop)"
    echo "========================================"
    local found=false
    while IFS= read -r -d '' dir; do
      local size
      size=$(du -sh "$dir" 2>/dev/null | awk '{print $1}')
      if [ -n "$size" ]; then
        warn "$(basename "$(dirname "$dir")")/node_modules: $size"
        items_to_clean+=("node_modules ($(basename "$(dirname "$dir")")): $size")
        found=true
      fi
    done < <(timeout 15 find ~/Desktop -maxdepth 3 -name node_modules -type d -size +100M -not -path "*/\.*" -print0 2>/dev/null)
    if [ "$found" = false ]; then
      ok "No large node_modules found on Desktop"
    fi
  }

  scan_developer() {
    echo ""
    echo "========================================"
    echo "  Xcode / Developer"
    echo "========================================"
    if [ -d ~/Library/Developer ]; then
      local size
      size=$(du -sh ~/Library/Developer 2>/dev/null | awk '{print $1}')
      if [ -n "$size" ] && [ "$size" != "0B" ]; then
        warn "Developer data: $size"
        items_to_clean+=("Xcode/Developer data: $size")
        echo "  (derived data, archives, simulators)"
      fi
    else
      ok "No Developer data found"
    fi
  }

  clean_developer() {
    rm -rf ~/Library/Developer/Xcode/DerivedData 2>/dev/null
    rm -rf ~/Library/Developer/Xcode/Archives 2>/dev/null
    rm -rf ~/Library/Developer/CoreSimulator/Caches 2>/dev/null
    ok "Xcode derived data and archives cleaned"
  }

  scan_downloads() {
    echo ""
    echo "========================================"
    echo "  ~/Downloads"
    echo "========================================"
    local size
    size=$(du -sh ~/Downloads 2>/dev/null | awk '{print $1}')
    local count
    count=$(find ~/Downloads -maxdepth 1 -type f 2>/dev/null | wc -l | tr -d ' ')
    local dmg_count
    dmg_count=$(find ~/Downloads -maxdepth 1 -name "*.dmg" -type f 2>/dev/null | wc -l | tr -d ' ')
    local big_count
    big_count=$(find ~/Downloads -maxdepth 1 -type f -size +100M 2>/dev/null | wc -l | tr -d ' ')

    warn "Downloads: $size ($count files)"
    if [ "$dmg_count" -gt 0 ]; then
      warn "  DMG installers: $dmg_count files"
    fi
    if [ "$big_count" -gt 0 ]; then
      warn "  Files >100MB: $big_count files"
    fi
    items_to_clean+=("Downloads: $size ($dmg_count DMGs, $big_count large files)")
  }

  clean_downloads() {
    rm -f ~/Downloads/*.dmg ~/Downloads/*.crdownload ~/Downloads/*.part 2>/dev/null
    ok "DMGs and partial downloads removed"
  }

  show_summary() {
    echo ""
    echo "========================================"
    echo -e "  ${YELLOW}Cleanup Summary${NC}"
    echo "========================================"
    if [ ${#items_to_clean[@]} -eq 0 ]; then
      echo "  Nothing to clean - system is tidy!"
      return
    fi
    for item in "${items_to_clean[@]}"; do
      echo -e "  ${RED}*${NC} $item"
    done
    echo ""
  }

  ask_cleanup() {
    if [ ${#items_to_clean[@]} -eq 0 ]; then
      echo ""
      info "Nothing to clean - system is tidy!"
      return
    fi

    echo ""
    echo "========================================"
    echo -e "  ${YELLOW}Select items to clean${NC}"
    echo "========================================"
    echo ""

    for i in "${!items_to_clean[@]}"; do
      echo "  $((i+1))) ${items_to_clean[$i]}"
    done

    echo "  a) Clean ALL"
    echo "  0) Cancel"

    read -p $'\n  Enter choice(s) [1-'"${#items_to_clean[@]}"$', a, or 0]: ' choices

    if [ "$choices" = "0" ]; then
      echo ""
      info "Cancelled - nothing cleaned."
      return
    fi

    local run_all=false
    if [ "$choices" = "a" ] || [ "$choices" = "A" ]; then
      run_all=true
    fi

    local freed=0
    echo ""

    # Docker (index 0 if present)
    if [ ${#items_to_clean[@]} -ge 1 ] && ( [ "$run_all" = true ] || echo "$choices" | grep -qw "1" ); then
      clean_docker
      echo ""
    fi

    # npm (index 1 if present)
    if [ ${#items_to_clean[@]} -ge 2 ] && ( [ "$run_all" = true ] || echo "$choices" | grep -qw "2" ); then
      clean_npm
      echo ""
    fi

    # pip (index 2 if present)
    if [ ${#items_to_clean[@]} -ge 3 ] && ( [ "$run_all" = true ] || echo "$choices" | grep -qw "3" ); then
      clean_pip
      echo ""
    fi

    # Homebrew (index 3 if present)
    if [ ${#items_to_clean[@]} -ge 4 ] && ( [ "$run_all" = true ] || echo "$choices" | grep -qw "4" ); then
      clean_homebrew
      echo ""
    fi

    # System caches (index 4 if present)
    if [ ${#items_to_clean[@]} -ge 5 ] && ( [ "$run_all" = true ] || echo "$choices" | grep -qw "5" ); then
      clean_caches
      echo ""
    fi

    # Trash (index 5 if present)
    if [ ${#items_to_clean[@]} -ge 6 ] && ( [ "$run_all" = true ] || echo "$choices" | grep -qw "6" ); then
      clean_trash
      echo ""
    fi

    # Old venvs (index 6 if present)
    if [ ${#items_to_clean[@]} -ge 7 ] && ( [ "$run_all" = true ] || echo "$choices" | grep -qw "7" ); then
      clean_old_venvs
      echo ""
    fi

    # node_modules (index 7 if present)
    if [ ${#items_to_clean[@]} -ge 8 ] && ( [ "$run_all" = true ] || echo "$choices" | grep -qw "8" ); then
      info "Removing large node_modules... (use with care)"
      find ~/Desktop -maxdepth 3 -name node_modules -type d -size +100M -not -path "*/\.*" -exec rm -rf {} + 2>/dev/null
      ok "Large node_modules removed"
      echo ""
    fi

    # Xcode (index 8 if present)
    if [ ${#items_to_clean[@]} -ge 9 ] && ( [ "$run_all" = true ] || echo "$choices" | grep -qw "9" ); then
      clean_developer
      echo ""
    fi

    # Downloads (index 9 if present)
    if [ ${#items_to_clean[@]} -ge 10 ] && ( [ "$run_all" = true ] || echo "$choices" | grep -qw "10" ); then
      clean_downloads
      echo ""
    fi

    echo "========================================"
    info "Cleanup complete!"
    echo "========================================"
  }

  # ====== Main ======
  echo ""
  echo "========================================"
  echo "  Mac Storage Cleanup"
  echo "  $(date)"
  echo "========================================"
  echo ""

  # Check disk usage before
  local disk_before
  disk_before=$(df -h / | awk 'NR==2{print $4}')
  info "Available: $(df -h / | awk 'NR==2{print $4}')"

  echo "  Scanning Docker ... "; scan_docker
  echo "  Scanning npm/pnpm ... "; scan_npm
  echo "  Scanning Python caches ... "; scan_pip
  echo "  Scanning Homebrew ... "; scan_homebrew
  echo "  Scanning app caches ... "; scan_caches
  echo "  Checking Trash ... "; scan_trash
  echo "  Scanning old virtual envs ... "; scan_old_venvs
  echo "  Scanning for large node_modules ... "; scan_old_projects
  echo "  Scanning Xcode data ... "; scan_developer
  echo "  Scanning Downloads ... "; scan_downloads

  show_summary
  ask_cleanup

  echo ""
  echo "========================================"
  info "Disk available: $(df -h / | awk 'NR==2{print $4}') (was ${disk_before})"
  echo "========================================"
  echo ""
}
