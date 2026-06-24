# devkit curl — Interactive HTTP Client
# Sourced by devkit — provides run_curl()

run_curl() {
  local method url headers=() params=() body curl_args response_headers

  # Trap Ctrl+C to exit cleanly
  trap 'echo ""; info "Bye!"; return 1' INT

  while true; do
    # --- Collect request details ---
    echo ""
    echo "========================================"
    echo "  devkit curl — Interactive HTTP Client"
    echo "========================================"
    echo ""

    # Method
    read -p "  Method [GET]: " method
    method="${method:-GET}"
    method=$(echo "$method" | tr '[:lower:]' '[:upper:]')

    # URL
    read -p "  URL: " url
    if [ -z "$url" ]; then
      err "URL is required"
      echo ""
      continue
    fi

    # Headers
    headers=()
    echo ""
    echo "  Headers (leave empty to finish):"
    while true; do
      read -p "    Header: " header
      [ -z "$header" ] && break
      headers+=("$header")
    done

    # Query params
    params=()
    echo ""
    echo "  Query params (leave empty to finish):"
    while true; do
      read -p "    Param: " param
      [ -z "$param" ] && break
      params+=("$param")
    done

    # Body (skip for GET and HEAD)
    body=""
    if [ "$method" != "GET" ] && [ "$method" != "HEAD" ]; then
      echo ""
      echo "  Body (JSON or text, empty to skip):"
      read -p "    " body
    fi

    # Build final URL with query params
    local final_url="$url"
    if [ ${#params[@]} -gt 0 ]; then
      local query_string=""
      for param in "${params[@]}"; do
        if [ -z "$query_string" ]; then
          query_string="$param"
        else
          query_string="${query_string}&${param}"
        fi
      done
      if [[ "$url" == *\?* ]]; then
        final_url="${url}&${query_string}"
      else
        final_url="${url}?${query_string}"
      fi
    fi

    # --- Build curl command ---
    curl_args=(-s -S -i)
    curl_args+=(-X "$method")
    curl_args+=("$final_url")

    for header in "${headers[@]}"; do
      curl_args+=(-H "$header")
    done

    if [ -n "$body" ]; then
      curl_args+=(-d "$body")
    fi

    # --- Display the request ---
    echo ""
    echo "--- Request --------------------------------------------------"
    echo "  curl \\"
    echo "    -X $method \\"
    echo "    $final_url"
    for header in "${headers[@]}"; do
      echo "    -H \"$header\" \\"
    done
    if [ -n "$body" ]; then
      echo "    -d '$body'"
    else
      echo "    (no body)"
    fi
    echo ""

    # --- Execute ---
    echo "--- Response -------------------------------------------------"
    local response
    response=$(curl "${curl_args[@]}" 2>&1)
    local curl_exit=$?

    if [ $curl_exit -ne 0 ]; then
      echo ""
      err "curl failed (exit $curl_exit):"
      echo "$response"
      echo ""
      echo "--- Next? ---------------------------------------------------"
      echo "  r) Repeat this request"
      echo "  n) New request"
      echo "  q) Quit"
      read -p "  Choice [n]: " next_choice
      case "${next_choice:-n}" in
        r|R) continue ;;
        q|Q) info "Bye!"; break ;;
        *)   continue ;;
      esac
    fi

    # Separate headers from body (macOS-compatible split at first blank line)
    local resp_headers resp_body
    resp_headers=$(echo "$response" | awk '!body{print} /^$/{body=1}' | sed '/^$/d')
    resp_body=$(echo "$response" | awk 'body{print} /^$/{body=1}')

    # Print headers
    echo "$resp_headers" | while IFS= read -r line; do
      echo "  $line"
    done

    # Print body — pretty-print JSON if jq available
    if [ -n "$resp_body" ]; then
      echo ""
      if command -v jq &>/dev/null && echo "$resp_body" | jq . >/dev/null 2>&1; then
        echo "$resp_body" | jq . | while IFS= read -r line; do
          echo "  $line"
        done
      else
        echo "$resp_body" | while IFS= read -r line; do
          echo "  $line"
        done
      fi
    fi
    echo ""

    # --- Post-response menu ---
    echo "--- Next? ---------------------------------------------------"
    echo "  r) Repeat this request"
    echo "  n) New request"
    echo "  q) Quit"
    read -p "  Choice [n]: " next_choice
    case "${next_choice:-n}" in
      r|R) continue ;;
      q|Q) info "Bye!"; break ;;
      *)   continue ;;
    esac
  done

  trap - INT
}
