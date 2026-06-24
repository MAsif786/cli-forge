# DB Tool

Interactive database client — save connections, list tables, and run SQL queries against PostgreSQL, SQLite, and MySQL.

## Commands

| Command | Description |
|---------|-------------|
| `saved` | List saved database connections |
| `connect` | Connect to a database (set as active) |
| `tables` | List tables on the active connection |
| `query` | Run a SQL query on the active connection |
| `save` | Save a new database connection |
| `remove` | Remove a saved connection |
| `disconnect` | Clear the active connection |

## Usage

```
devkit[db]> save                     # Save a connection (Postgres / SQLite / MySQL)
devkit[db]> saved                    # List saved connections
devkit[db]> connect <name>           # Activate a saved connection
devkit[db]> tables                   # List tables
devkit[db]> query                    # Type SQL with autocomplete suggestions
```

## Query autocomplete

When typing a SQL query, table names and column names are suggested based on the active connection's schema. Suggestions update as you type after keywords like `FROM`, `SELECT`, `WHERE`, `JOIN`, etc.

## Connection storage

Connections saved to `~/.devkit/db.json`.

## Prerequisites

CLI clients for the databases you use:

```bash
brew install postgresql@16    # psql
brew install mysql-client      # mysql
# sqlite3 is built into macOS
```
