# Curl Tool

Interactive HTTP request builder — a Postman-like experience in your terminal.

## Commands

| Command | Description |
|---------|-------------|
| `request` | Walk through building and sending an HTTP request |

## Usage

```
devkit[curl]> request
```

The tool guides you through:
1. **Method** — GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS
2. **URL** — the endpoint
3. **Headers** — add/edit/remove headers interactively
4. **Body** — for POST/PUT/PATCH: JSON body (opens `$EDITOR`)
5. **Execute** — shows the full curl command, then sends it

Response status, headers, and body are displayed with syntax highlighting.

## Output

After each request, you can:
- View the raw response
- Copy the curl command for reuse
- Make another request
