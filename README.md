# MCP Filesystem Advanced

An enhanced Model Context Protocol (MCP) server for filesystem access with **Reaktionsnetzwerk-inspired operation tracking**, automatic parent directory creation, and intelligent conflict detection.

## Features

- **Auto-create parent directories** - Write operations automatically create missing parent directories
- **Operation tracking** - Detects and prevents conflicts when multiple operations target the same paths
- **Detailed feedback** - Returns information about what was created vs what already existed
- **Secure by default** - Path validation, symlink protection, atomic writes

## Installation

All dependencies are pinned to exact versions in `package.json`. The lock file (`package-lock.json`) guarantees identical installs across machines.

```bash
# Clone or copy the repository
cd mcp-filesystem-advanced

# Install pinned dependencies and build (uses npm ci for strict reproducibility)
./setup.sh
```

### Setup Options

| Command | What it does |
|---------|-------------|
| `./setup.sh` | Install exact versions from lock file, then build |
| `./setup.sh --check` | Show available updates and known vulnerabilities (dry run) |
| `./setup.sh --update-patch` | Bump patch versions only (e.g. 3.2.4 → 3.2.6), then build |
| `./setup.sh --update` | Bump all dependencies to latest, then build |

**Why `npm ci`?** Unlike `npm install`, `npm ci` installs *exactly* the dependency tree recorded in the lock file. It deletes `node_modules` first and fails if the lock file is out of sync — no silent drift. This guarantees that every machine gets the same build.

### Manual Alternative

If you prefer not to use `setup.sh`:

```bash
npm ci          # Strict install from lock file (recommended)
npm run build   # Compile TypeScript
```

### Checking for Updates

```bash
# See what's outdated
npm run deps:check

# Bump patch versions only (safest)
npm run deps:update:patch

# Bump minor versions
npm run deps:update:minor

# Bump everything to latest
npm run deps:update
```

## Configuration Examples

### LibreChat

Add to your `librechat.yaml`:

```yaml
mcpServers:
  filesystem:
    type: stdio
    command: node
    args:
      - /path/to/mcp-filesystem-advanced/dist/index.js
      - /path/to/allowed/directory
      - /another/allowed/directory  # Multiple directories supported
```

### OpenWebUI

Add to your OpenWebUI configuration:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "node",
      "args": [
        "/path/to/mcp-filesystem-advanced/dist/index.js",
        "/path/to/allowed/directory"
      ]
    }
  }
}
```

### Claude Desktop

Add to `claude_desktop_config.json`:

**macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
**Linux**: `~/.config/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "node",
      "args": [
        "/path/to/mcp-filesystem-advanced/dist/index.js",
        "/path/to/allowed/directory"
      ]
    }
  }
}
```

### Cursor IDE

Add to your Cursor settings (`.cursor/mcp.json` or via Settings > MCP):

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "node",
      "args": [
        "/path/to/mcp-filesystem-advanced/dist/index.js",
        "/path/to/allowed/directory"
      ]
    }
  }
}
```

### Windsurf

Add to your Windsurf configuration:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "node",
      "args": [
        "/path/to/mcp-filesystem-advanced/dist/index.js",
        "/path/to/allowed/directory"
      ]
    }
  }
}
```

### Zed Editor

Add to your `~/.config/zed/settings.json`:

```json
{
  "mcp_servers": {
    "filesystem": {
      "command": "node",
      "args": [
        "/path/to/mcp-filesystem-advanced/dist/index.js",
        "/path/to/allowed/directory"
      ]
    }
  }
}
```

### Generic MCP Client

For any MCP-compatible client:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "node",
      "args": [
        "/path/to/mcp-filesystem-advanced/dist/index.js",
        "/path/to/allowed/directory"
      ]
    }
  }
}
```

## Available Tools

| Tool | Description |
|------|-------------|
| `read_text_file` | Read file contents (with optional head/tail) |
| `read_media_file` | Read image/audio files as base64 |
| `read_multiple_files` | Read multiple files at once |
| `write_file` | Write file (auto-creates parent dirs) |
| `edit_file` | Make line-based edits to a file |
| `create_directory` | Create directory (auto-creates parents) |
| `ensure_directory` | Explicitly ensure directory exists |
| `list_directory` | List directory contents |
| `list_directory_with_sizes` | List with file sizes |
| `directory_tree` | Get recursive tree structure |
| `move_file` | Move/rename files or directories |
| `search_files` | Search file/directory **names** by glob pattern |
| `grep_files` | Search file **contents** for a pattern |
| `get_file_info` | Get file metadata |
| `list_allowed_directories` | Show accessible directories |

### When to Use Which Search Tool

| You want to… | Use | Example |
|---------------|-----|---------|
| Find files by name or extension | `search_files` | `pattern: "*.py"` → all Python files |
| Find where a function/variable/string is defined | `grep_files` | `pattern: "def my_function"` → content matches |
| Locate a file when you know part of its path | `search_files` | `pattern: "**/config.yaml"` → path matches |
| Find all usages of an import or API call | `grep_files` | `pattern: "from os import"`, `filePattern: "*.py"` |
| Get an overview of project structure | `directory_tree` | Recursive tree view |

**Key distinction:** `search_files` matches file/directory **names** (glob on paths). `grep_files` opens files and matches **content** (regex on text).

## Enhanced Behavior

### Auto-Create Parent Directories

```javascript
// Before (old behavior): Would fail if /project/src doesn't exist
write_file("/project/src/utils.ts", content)
// Error: Parent directory does not exist

// After (new behavior): Automatically creates parents
write_file("/project/src/utils.ts", content)
// Response:
// Created parent directories:
//   - /project
//   - /project/src
// Successfully wrote 1234 bytes to /project/src/utils.ts
```

### Operation Conflict Detection

When multiple operations target overlapping paths:

```javascript
// Operation 1: write_file("/project/src/file.ts", content)
// Operation 2 (parallel): write_file("/project/src/other.ts", content)

// Operation 2 returns:
// Operation conflict: Path "/project/src" is currently being written 
// (started 0s ago). Please wait and retry, or use a different path.
```

## Development

```bash
# Build
npm run build

# Watch mode
npm run watch

# Run tests
npm test
```

## License

MIT