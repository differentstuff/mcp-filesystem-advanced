# MCP Filesystem Advanced

An enhanced Model Context Protocol (MCP) server for filesystem access with **Reaktionsnetzwerk-inspired operation tracking**, automatic parent directory creation, and intelligent conflict detection.

## Features

- **Auto-create parent directories** - Write operations automatically create missing parent directories
- **Operation tracking** - Detects and prevents conflicts when multiple operations target the same paths
- **Detailed feedback** - Returns information about what was created vs what already existed
- **Secure by default** - Path validation, symlink protection, atomic writes

## Installation

```bash
# Clone or copy the repository
cd mcp-filesystem-advanced

# Install dependencies and build
npm install
npm run build
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
| `search_files` | Search with glob patterns |
| `get_file_info` | Get file metadata |
| `list_allowed_directories` | Show accessible directories |

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