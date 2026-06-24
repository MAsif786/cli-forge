# devkit docker — Interactive Docker Manager
# Sourced by devkit — provides run_docker()

run_docker() {
  # Check Docker is available
  if ! command -v docker &>/dev/null; then
    err "Docker not installed"
    return 1
  fi

  # Check Docker daemon is running
  if ! timeout 5 docker info &>/dev/null; then
    err "Docker daemon not running"
    return 1
  fi

  # Trap Ctrl+C
  trap 'echo ""; info "Back to devkit"; return 0' INT

  local choice

  while true; do
    echo ""
    echo "========================================"
    echo "  devkit docker — Interactive Docker"
    echo "========================================"
    echo ""
    echo "  Containers:"
    echo "    1)  List running containers"
    echo "    2)  List all containers"
    echo "    3)  Start a container"
    echo "    4)  Stop a container"
    echo "    5)  Restart a container"
    echo "    6)  Remove a container"
    echo "    7)  View container logs"
    echo ""
    echo "  Images:"
    echo "    8)  List images"
    echo "    9)  Remove an image"
    echo "    10) Prune dangling images"
    echo ""
    echo "  System:"
    echo "    11) System prune (containers, images, volumes, build cache)"
    echo "    12) System disk usage"
    echo ""
    echo "    0)  Back to devkit"
    echo ""
    read -p "  Choice: " choice
    echo ""

    case "$choice" in
      1)  docker_list_containers "" ;;
      2)  docker_list_containers "all" ;;
      3)  docker_container_action "start" ;;
      4)  docker_container_action "stop" ;;
      5)  docker_container_action "restart" ;;
      6)  docker_container_action "rm" ;;
      7)  docker_logs ;;
      8)  docker_list_images ;;
      9)  docker_remove_image ;;
      10) docker_prune_images ;;
      11) docker_system_prune ;;
      12) docker_df ;;
      0)  info "Back to devkit"; break ;;
      *)  err "Invalid choice" ;;
    esac

    if [ "$choice" != "0" ]; then
      echo ""
      read -p "  Press Enter to continue... "
    fi
  done

  trap - INT
}


# ─── Helpers ───────────────────────────────────────────────

# Select a container interactively (running or all)
# Usage: docker_select_container [all]
# Returns container ID via $SELECTED_CONTAINER
docker_select_container() {
  local mode="${1:-}"  # empty = running, "all" = all
  local filter="$2"    # optional extra filter
  local header="$3"    # override header text
  local prompt="$4"    # override prompt text

  local fmt='{{.ID}}##{{.Names}}##{{.Image}}##{{.Status}}##{{.Ports}}'

  if [ "$mode" = "all" ]; then
    local default_header="All containers"
  else
    local default_header="Running containers"
  fi

  SELECTED_CONTAINER=""

  # Get container list — build docker args safely without eval
  local containers
  if [ -n "$filter" ]; then
    if [ "$mode" = "all" ]; then
      containers=$(docker ps -a --filter "$filter" --format "$fmt" 2>/dev/null)
    else
      containers=$(docker ps --filter "$filter" --format "$fmt" 2>/dev/null)
    fi
  else
    if [ "$mode" = "all" ]; then
      containers=$(docker ps -a --format "$fmt" 2>/dev/null)
    else
      containers=$(docker ps --format "$fmt" 2>/dev/null)
    fi
  fi

  if [ -z "$containers" ]; then
    warn "No containers found"
    return 1
  fi

  echo ""
  echo "  ${header:-$default_header}:"
  echo ""

  # Store IDs and display numbered list
  local ids=()
  local i=1
  while IFS='##' read -r id name image status ports; do
    ids+=("$id")
    local line="$name ($image) - $status"
    [ -n "$ports" ] && [ "$ports" != "<nil>" ] && line="$line, ports: $ports"
    printf "  %2d)  %s\n" "$i" "$line"
    i=$((i + 1))
  done <<< "$containers"

  if [ $i -eq 1 ]; then
    warn "No containers found"
    return 1
  fi

  echo ""
  read -p "  ${prompt:-Select container [1-$(($i-1))]}: " selection

  # Validate
  if ! [[ "$selection" =~ ^[0-9]+$ ]] || [ "$selection" -lt 1 ] || [ "$selection" -gt $(($i-1)) ]; then
    warn "Invalid selection"
    return 1
  fi

  SELECTED_CONTAINER="${ids[$((selection-1))]}"
  return 0
}


# ─── Container Actions ─────────────────────────────────────

docker_list_containers() {
  local mode="$1"
  local title
  local cmd

  if [ "$mode" = "all" ]; then
    title="All containers"
    cmd="docker ps -a"
  else
    title="Running containers"
    cmd="docker ps"
  fi

  echo ""
  echo "  $title:"
  echo ""

  local output
  output=$($cmd --format 'table {{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}' 2>/dev/null)

  if [ -z "$output" ] || echo "$output" | grep -q "^$"; then
    warn "No containers"
    return
  fi

  echo "$output" | while IFS= read -r line; do
    echo "  $line"
  done
}

docker_container_action() {
  local action="$1"

  local mode verb past
  case "$action" in
    start)   mode="all";   verb="Starting";  past="started" ;;
    stop)    mode="";      verb="Stopping";  past="stopped" ;;
    restart) mode="";      verb="Restarting"; past="restarted" ;;
    rm)      mode="all";   verb="Removing";  past="removed" ;;
  esac

  # For start, show stopped containers; for rm (force flag if running), show all
  local filter=""
  [ "$action" = "start" ] && filter="status=exited"

  if ! docker_select_container "$mode" "$filter"; then
    return
  fi

  local container="$SELECTED_CONTAINER"

  # Build docker command
  local docker_cmd="docker $action"
  [ "$action" = "rm" ] && docker_cmd="docker rm -f"
  [ "$action" = "restart" ] && docker_cmd="docker restart"

  echo ""
  info "$verb container..."
  echo "  $docker_cmd $container"

  local result
  result=$($docker_cmd "$container" 2>&1)
  local exit_code=$?

  if [ $exit_code -eq 0 ]; then
    ok "Container $past: $result"
  else
    err "Failed to $action container: $result"
  fi
}

docker_logs() {
  if ! docker_select_container "" "" "Running containers" "Which container logs?"; then
    return
  fi

  local container="$SELECTED_CONTAINER"

  echo ""
  read -p "  Tail lines [50]: " tail_lines
  tail_lines="${tail_lines:-50}"

  echo ""
  info "Fetching logs for $container (last $tail_lines lines)..."
  echo ""

  docker logs --tail "$tail_lines" "$container" 2>&1 | while IFS= read -r line; do
    echo "  $line"
  done

  echo ""
  read -p "  Follow logs with -f? (y/N): " follow
  if [ "$follow" = "y" ] || [ "$follow" = "Y" ]; then
    echo ""
    info "Tailing logs (Ctrl+C to stop)..."
    echo ""
    docker logs --tail "$tail_lines" -f "$container" 2>&1 | while IFS= read -r line; do
      echo "  $line"
    done
  fi
}


# ─── Images ────────────────────────────────────────────────

docker_list_images() {
  echo ""
  echo "  Images:"
  echo ""
  docker images --format 'table {{.Repository}}\t{{.Tag}}\t{{.ID}}\t{{.Size}}\t{{.CreatedSince}}' 2>/dev/null | while IFS= read -r line; do
    echo "  $line"
  done
}

docker_remove_image() {
  echo ""
  echo "  Images:"
  echo ""

  local images
  images=$(docker images --format '{{.Repository}}:{{.Tag}}\t{{.ID}}\t{{.Size}}' 2>/dev/null)

  if [ -z "$images" ]; then
    warn "No images found"
    return
  fi

  # Display numbered list
  local tags=()
  local i=1
  while IFS=$'\t' read -r tag id size; do
    tags+=("$tag")
    printf "  %2d)  %s  (%s, %s)\n" "$i" "$tag" "$id" "$size"
    i=$((i + 1))
  done <<< "$images"

  echo ""
  read -p "  Select image to remove [1-$(($i-1))]: " selection

  if ! [[ "$selection" =~ ^[0-9]+$ ]] || [ "$selection" -lt 1 ] || [ "$selection" -gt $(($i-1)) ]; then
    warn "Invalid selection"
    return
  fi

  local selected="${tags[$((selection-1))]}"

  echo ""
  info "Removing image: $selected"
  echo "  docker rmi $selected"

  local result
  result=$(docker rmi "$selected" 2>&1)
  local exit_code=$?

  if [ $exit_code -eq 0 ]; then
    ok "Image removed: $result"
  else
    err "Failed: $result"
  fi
}

docker_prune_images() {
  echo ""
  info "This removes all dangling (untagged) images."
  echo ""

  # Show what would be pruned
  local dangling
  dangling=$(docker images -f "dangling=true" --format '{{.Repository}}:{{.Tag}} {{.ID}} {{.Size}}' 2>/dev/null)

  if [ -z "$dangling" ]; then
    ok "No dangling images to prune"
    return
  fi

  warn "Dangling images that will be removed:"
  echo "$dangling" | while IFS= read -r line; do
    echo "  $line"
  done

  echo ""
  read -p "  Proceed? (y/N): " confirm
  if [ "$confirm" != "y" ] && [ "$confirm" != "Y" ]; then
    info "Cancelled"
    return
  fi

  echo ""
  info "Pruning dangling images..."
  echo "  docker image prune -f"
  echo ""

  docker image prune -f 2>&1 | while IFS= read -r line; do
    echo "  $line"
  done

  ok "Done"
}


# ─── System ────────────────────────────────────────────────

docker_system_prune() {
  echo ""
  warn "Docker system prune removes:"
  echo "  - All stopped containers"
  echo "  - All dangling images"
  echo "  - All unused networks"
  echo "  - All unused volumes"
  echo "  - All build cache"
  echo ""
  warn "This cannot be undone!"
  echo ""

  # Show reclaimable space estimate
  info "Current disk usage:"
  docker system df 2>/dev/null | while IFS= read -r line; do
    echo "  $line"
  done

  echo ""
  read -p "  Proceed with system prune -a --volumes? (y/N): " confirm
  if [ "$confirm" != "y" ] && [ "$confirm" != "Y" ]; then
    info "Cancelled"
    return
  fi

  echo ""
  info "Pruning system..."
  echo "  docker system prune -a --force --volumes"
  echo ""

  local result
  result=$(docker system prune -a --force --volumes 2>&1)
  local exit_code=$?

  if [ $exit_code -eq 0 ]; then
    echo "$result" | while IFS= read -r line; do
      echo "  $line"
    done
    ok "System prune complete"
  else
    err "Prune failed: $result"
  fi
}

docker_df() {
  echo ""
  docker system df 2>/dev/null | while IFS= read -r line; do
    echo "  $line"
  done
}
