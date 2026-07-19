#!/usr/bin/env node

import { FastMCP } from "fastmcp";
import { z } from "zod";
import fs from "fs/promises";
import { createReadStream } from "fs";
import path from "path";
import { minimatch } from "minimatch";
import { normalizePath, expandHome } from './path-utils.js';
import { getValidRootDirectories } from './roots-utils.js';
import {
  // Function imports
  formatSize,
  validatePath,
  getFileStats,
  readFileContent,
  writeFileContent,
  searchFilesWithValidation,
  applyFileEdits,
  tailFile,
  headFile,
  setAllowedDirectories,
  // New Reaktionsnetzwerk-inspired imports
  ensureParentDirectory,
  createDirectoryRecursive,
  checkParentStatus,
  withSubstrateLock,
  type WriteResult,
  type DirectoryResult,
  type OperationType,
  // Grep / content search
  grepFilesWithValidation,
  formatGrepResult,
} from './lib.js';

// Command line argument parsing
const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("Usage: mcp-server-filesystem [allowed-directory] [additional-directories...]");
  console.error("Note: Allowed directories can be provided via:");
  console.error("  1. Command-line arguments (shown above)");
  console.error("  2. MCP roots protocol (if client supports it)");
  console.error("At least one directory must be provided by EITHER method for the server to operate.");
}

// Store allowed directories in normalized and resolved form
// We store BOTH the original path AND the resolved path to handle symlinks correctly
// This fixes the macOS /tmp -> /private/tmp symlink issue where users specify /tmp
// but the resolved path is /private/tmp
let allowedDirectories = (await Promise.all(
  args.map(async (dir) => {
    const expanded = expandHome(dir);
    const absolute = path.resolve(expanded);
    const normalizedOriginal = normalizePath(absolute);
    try {
      // Security: Resolve symlinks in allowed directories during startup
      // This ensures we know the real paths and can validate against them later
      const resolved = await fs.realpath(absolute);
      const normalizedResolved = normalizePath(resolved);
      // Return both original and resolved paths if they differ
      // This allows matching against either /tmp or /private/tmp on macOS
      if (normalizedOriginal !== normalizedResolved) {
        return [normalizedOriginal, normalizedResolved];
      }
      return [normalizedResolved];
    } catch (error) {
      // If we can't resolve (doesn't exist), use the normalized absolute path
      // This allows configuring allowed dirs that will be created later
      return [normalizedOriginal];
    }
  })
)).flat();

// Filter to only accessible directories, warn about inaccessible ones
const accessibleDirectories: string[] = [];
for (const dir of allowedDirectories) {
  try {
    const stats = await fs.stat(dir);
    if (stats.isDirectory()) {
      accessibleDirectories.push(dir);
    } else {
      console.error(`Warning: ${dir} is not a directory, skipping`);
    }
  } catch (error) {
    console.error(`Warning: Cannot access directory ${dir}, skipping`);
  }
}

// Exit only if ALL paths are inaccessible (and some were specified)
if (accessibleDirectories.length === 0 && allowedDirectories.length > 0) {
  console.error("Error: None of the specified directories are accessible");
  process.exit(1);
}

allowedDirectories = accessibleDirectories;

// Initialize the global allowedDirectories in lib.ts
setAllowedDirectories(allowedDirectories);

// Schema definitions
const ReadTextFileArgsSchema = z.object({
  path: z.string(),
  tail: z.number().optional().describe('If provided, returns only the last N lines of the file'),
  head: z.number().optional().describe('If provided, returns only the first N lines of the file')
});

const ReadMediaFileArgsSchema = z.object({
  path: z.string()
});

const ReadMultipleFilesArgsSchema = z.object({
  paths: z
    .array(z.string())
    .min(1, "At least one file path must be provided")
    .describe("Array of file paths to read. Each path must be a string pointing to a valid file within allowed directories."),
});

const WriteFileArgsSchema = z.object({
  path: z.string(),
  content: z.string(),
});

const EditOperation = z.object({
  oldText: z.string().describe('Text to search for - must match exactly'),
  newText: z.string().describe('Text to replace with')
});

const EditFileArgsSchema = z.object({
  path: z.string(),
  edits: z.array(EditOperation),
  dryRun: z.boolean().default(false).describe('Preview changes using git-style diff format')
});

const CreateDirectoryArgsSchema = z.object({
  path: z.string(),
});

const EnsureDirectoryArgsSchema = z.object({
  path: z.string(),
});

const ListDirectoryArgsSchema = z.object({
  path: z.string(),
});

const ListDirectoryWithSizesArgsSchema = z.object({
  path: z.string(),
  sortBy: z.enum(['name', 'size']).optional().default('name').describe('Sort entries by name or size'),
});

const DirectoryTreeArgsSchema = z.object({
  path: z.string(),
  excludePatterns: z.array(z.string()).optional().default([])
});

const MoveFileArgsSchema = z.object({
  source: z.string(),
  destination: z.string(),
});

const SearchFilesArgsSchema = z.object({
  path: z.string(),
  pattern: z.string(),
  excludePatterns: z.array(z.string()).optional().default([])
});

const GrepFilesArgsSchema = z.object({
  path: z.string().describe('Directory to search in'),
  pattern: z.string().describe('Content search pattern (supports regex syntax). Use this to find where a function, variable, string, or pattern is defined or used.'),
  excludePatterns: z.array(z.string()).optional().default([])
    .describe('Additional glob patterns to exclude (additive to built-in defaults like node_modules, .git, venv, etc.)'),
  includeIgnored: z.boolean().optional().default(false)
    .describe('If true, bypass built-in default exclusions (e.g., node_modules, .git, venv, *.lock, etc.) and .gitignore. Use when you know what you are looking for is in an excluded directory.'),
  includeSnippet: z.boolean().optional().default(true)
    .describe('If true (default), include the matching line content in results. Set to false for path:lineNumber only.'),
  contextLines: z.number().optional().default(0)
    .describe('Number of context lines to show before and after each match. Default 0 (match line only).'),
  maxResults: z.number().optional().default(100)
    .describe('Maximum number of matches to return. Default 100, hard ceiling 1000.'),
  filePattern: z.string().optional()
    .describe('Glob pattern to restrict which files to search (e.g., "*.py", "*.{ts,js}"). Intersected with the content search.'),
});

const GetFileInfoArgsSchema = z.object({
  path: z.string(),
});

// Server setup
const server = new FastMCP({
  name: "secure-filesystem-server",
  version: "0.2.0",
});

// Reads a file as a stream of buffers, concatenates them, and then encodes
// the result to a Base64 string. This is a memory-efficient way to handle
// binary data from a stream before the final encoding.
async function readFileAsBase64Stream(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    const chunks: Buffer[] = [];
    stream.on('data', (chunk) => {
      chunks.push(chunk as Buffer);
    });
    stream.on('end', () => {
      const finalBuffer = Buffer.concat(chunks);
      resolve(finalBuffer.toString('base64'));
    });
    stream.on('error', (err) => reject(err));
  });
}

// Tool registrations

// read_file (deprecated) and read_text_file
const readTextFileHandler = async (args: z.infer<typeof ReadTextFileArgsSchema>) => {
  const validPath = await validatePath(args.path);

  if (args.head && args.tail) {
    throw new Error("Cannot specify both head and tail parameters simultaneously");
  }

  let content: string;
  if (args.tail) {
    content = await tailFile(validPath, args.tail);
  } else if (args.head) {
    content = await headFile(validPath, args.head);
  } else {
    content = await readFileContent(validPath);
  }

  return content;
};

server.addTool({
  name: "read_file",
  description: "Read the complete contents of a file as text. DEPRECATED: Use read_text_file instead.",
  parameters: ReadTextFileArgsSchema,
  execute: readTextFileHandler,
  annotations: { readOnlyHint: true }
});

server.addTool({
  name: "read_text_file",
  description:
    "Read the complete contents of a file from the file system as text. " +
    "Handles various text encodings and provides detailed error messages " +
    "if the file cannot be read. Use this tool when you need to examine " +
    "the contents of a single file. Use the 'head' parameter to read only " +
    "the first N lines of a file, or the 'tail' parameter to read only " +
    "the last N lines of a file. Operates on the file as text regardless of extension. " +
    "Only works within allowed directories.",
  parameters: z.object({
    path: z.string(),
    tail: z.number().optional().describe("If provided, returns only the last N lines of the file"),
    head: z.number().optional().describe("If provided, returns only the first N lines of the file")
  }),
  execute: readTextFileHandler,
  annotations: { readOnlyHint: true }
});

server.addTool({
  name: "read_media_file",
  description:
    "Read an image or audio file. Returns the base64 encoded data and MIME type. " +
    "Only works within allowed directories.",
  parameters: z.object({
    path: z.string()
  }),
  execute: async (args: z.infer<typeof ReadMediaFileArgsSchema>) => {
    const validPath = await validatePath(args.path);
    const extension = path.extname(validPath).toLowerCase();
    const mimeTypes: Record<string, string> = {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".bmp": "image/bmp",
      ".svg": "image/svg+xml",
      ".mp3": "audio/mpeg",
      ".wav": "audio/wav",
      ".ogg": "audio/ogg",
      ".flac": "audio/flac",
    };
    const mimeType = mimeTypes[extension] || "application/octet-stream";
    const data = await readFileAsBase64Stream(validPath);

    // FastMCP v3 only supports 'image' and 'audio' content types
    if (mimeType.startsWith("image/")) {
      return { type: "image" as const, data, mimeType };
    } else if (mimeType.startsWith("audio/")) {
      return { type: "audio" as const, data, mimeType };
    } else {
      // For other binary types, return as text with base64 encoding info
      return `Binary file (${mimeType}), base64 encoded (${data.length} chars):\n${data}`;
    }
  },
  annotations: { readOnlyHint: true }
});

server.addTool({
  name: "read_multiple_files",
  description:
    "Read the contents of multiple files simultaneously. This is more " +
    "efficient than reading files one by one when you need to analyze " +
    "or compare multiple files. Each file's content is returned with its " +
    "path as a reference. Failed reads for individual files won't stop " +
    "the entire operation. Only works within allowed directories.",
  parameters: z.object({
    paths: z.array(z.string())
      .min(1)
      .describe("Array of file paths to read. Each path must be a string pointing to a valid file within allowed directories.")
  }),
  execute: async (args: z.infer<typeof ReadMultipleFilesArgsSchema>) => {
    const results = await Promise.all(
      args.paths.map(async (filePath: string) => {
        try {
          const validPath = await validatePath(filePath);
          const content = await readFileContent(validPath);
          return `${filePath}:\n${content}\n`;
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          return `${filePath}: Error - ${errorMessage}`;
        }
      }),
    );
    return results.join("\n---\n");
  },
  annotations: { readOnlyHint: true }
});

server.addTool({
  name: "write_file",
  description:
    "Create a new file or completely overwrite an existing file with new content. " +
    "Use with caution as it will overwrite existing files without warning. " +
    "Handles text content with proper encoding. " +
    "IMPORTANT: This tool automatically creates parent directories if they don't exist. " +
    "Only works within allowed directories.",
  parameters: z.object({
    path: z.string(),
    content: z.string()
  }),
  execute: async (args: z.infer<typeof WriteFileArgsSchema>) => {
    const result = await writeFileContent(args.path, args.content);
    
    // Build detailed response message
    const messages: string[] = [];
    
    if (result.parentDirsCreated.length > 0) {
      messages.push(`Created parent directories:`);
      for (const dir of result.parentDirsCreated) {
        messages.push(`  - ${dir}`);
      }
    }
    
    messages.push(`Successfully wrote ${result.bytesWritten} bytes to ${result.path}`);
    
    return messages.join('\n');
  },
  annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: true }
});

server.addTool({
  name: "edit_file",
  description:
    "Make line-based edits to a text file. Each edit replaces exact line sequences " +
    "with new content. Returns a git-style diff showing the changes made. " +
    "On failure, returns EDIT_FAILED with a line-number hint — read the file at that location and retry with the correct oldText. " +
    "Only works within allowed directories.",
  parameters: z.object({
    path: z.string(),
    edits: z.array(z.object({
      oldText: z.string().describe("Text to search for - must match exactly"),
      newText: z.string().describe("Text to replace with")
    })),
    dryRun: z.boolean().default(false).describe("Preview changes using git-style diff format")
  }),
  execute: async (args: z.infer<typeof EditFileArgsSchema>) => {
    const validPath = await validatePath(args.path);
    return await applyFileEdits(validPath, args.edits, args.dryRun);
  },
  annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true }
});

server.addTool({
  name: "create_directory",
  description:
    "Create a new directory or ensure a directory exists. Can create multiple " +
    "nested directories in one operation. If the directory already exists, " +
    "this operation will succeed silently. Perfect for setting up directory " +
    "structures for projects or ensuring required paths exist. " +
    "IMPORTANT: This tool automatically creates parent directories if they don't exist. " +
    "Only works within allowed directories.",
  parameters: z.object({
    path: z.string()
  }),
  execute: async (args: z.infer<typeof CreateDirectoryArgsSchema>) => {
    const validPath = await validatePath(args.path, { allowMissingParent: true });
    const result = await createDirectoryRecursive(validPath);
    
    // Build detailed response message
    const messages: string[] = [];
    
    if (result.created) {
      if (result.dirsCreated.length > 0) {
        messages.push(`Created directories:`);
        for (const dir of result.dirsCreated) {
          messages.push(`  - ${dir}`);
        }
      } else {
        messages.push(`Successfully created directory ${result.path}`);
      }
    } else {
      messages.push(`Directory already exists: ${result.path}`);
    }
    
    return messages.join('\n');
  },
  annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false }
});

server.addTool({
  name: "ensure_directory",
  description:
    "Explicitly ensure a directory exists, creating it and any parent directories " +
    "if necessary. This is a more explicit version of create_directory that " +
    "provides detailed feedback about what was created vs what already existed. " +
    "Use this when you want to set up directory structures before other operations. " +
    "IMPORTANT: This tool automatically creates parent directories if they don't exist. " +
    "Only works within allowed directories.",
  parameters: z.object({
    path: z.string()
  }),
  execute: async (args: z.infer<typeof EnsureDirectoryArgsSchema>) => {
    const validPath = await validatePath(args.path, { allowMissingParent: true });
    const result = await createDirectoryRecursive(validPath);
    
    // Build detailed response message
    const messages: string[] = [];
    
    if (result.created) {
      if (result.dirsCreated.length > 0) {
        messages.push(`Created directories:`);
        for (const dir of result.dirsCreated) {
          messages.push(`  - ${dir}`);
        }
      } else {
        messages.push(`Successfully created directory ${result.path}`);
      }
    } else {
      messages.push(`Directory already exists: ${result.path}`);
    }
    
    return messages.join('\n');
  },
  annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false }
});

server.addTool({
  name: "list_directory",
  description:
    "Get a detailed listing of all files and directories in a specified path. " +
    "Results clearly distinguish between files and directories with [FILE] and [DIR] " +
    "prefixes. This tool is essential for understanding directory structure and " +
    "finding specific files within a directory. Only works within allowed directories.",
  parameters: z.object({
    path: z.string()
  }),
  execute: async (args: z.infer<typeof ListDirectoryArgsSchema>) => {
    const validPath = await validatePath(args.path);
    const entries = await fs.readdir(validPath, { withFileTypes: true });
    return entries
      .map((entry) => `${entry.isDirectory() ? "[DIR]" : "[FILE]"} ${entry.name}`)
      .join("\n");
  },
  annotations: { readOnlyHint: true }
});

server.addTool({
  name: "list_directory_with_sizes",
  description:
    "Get a detailed listing of all files and directories in a specified path, including sizes. " +
    "Results clearly distinguish between files and directories with [FILE] and [DIR] " +
    "prefixes. This tool is useful for understanding directory structure and " +
    "finding specific files within a directory. Only works within allowed directories.",
  parameters: z.object({
    path: z.string(),
    sortBy: z.enum(["name", "size"]).optional().default("name").describe("Sort entries by name or size")
  }),
  execute: async (args: z.infer<typeof ListDirectoryWithSizesArgsSchema>) => {
    const validPath = await validatePath(args.path);
    const entries = await fs.readdir(validPath, { withFileTypes: true });

    // Get detailed information for each entry
    const detailedEntries = await Promise.all(
      entries.map(async (entry) => {
        const entryPath = path.join(validPath, entry.name);
        try {
          const stats = await fs.stat(entryPath);
          return {
            name: entry.name,
            isDirectory: entry.isDirectory(),
            size: stats.size,
            mtime: stats.mtime
          };
        } catch (error) {
          return {
            name: entry.name,
            isDirectory: entry.isDirectory(),
            size: 0,
            mtime: new Date(0)
          };
        }
      })
    );

    // Sort entries based on sortBy parameter
    const sortedEntries = [...detailedEntries].sort((a, b) => {
      if (args.sortBy === 'size') {
        return b.size - a.size; // Descending by size
      }
      // Default sort by name
      return a.name.localeCompare(b.name);
    });

    // Format the output
    const formattedEntries = sortedEntries.map(entry =>
      `${entry.isDirectory ? "[DIR]" : "[FILE]"} ${entry.name.padEnd(30)} ${
        entry.isDirectory ? "" : formatSize(entry.size).padStart(10)
      }`
    );

    // Add summary
    const totalFiles = detailedEntries.filter(e => !e.isDirectory).length;
    const totalDirs = detailedEntries.filter(e => e.isDirectory).length;
    const totalSize = detailedEntries.reduce((sum, entry) => sum + (entry.isDirectory ? 0 : entry.size), 0);

    const summary = [
      "",
      `Total: ${totalFiles} files, ${totalDirs} directories`,
      `Combined size: ${formatSize(totalSize)}`
    ];

    return [...formattedEntries, ...summary].join("\n");
  },
  annotations: { readOnlyHint: true }
});

server.addTool({
  name: "directory_tree",
  description:
    "Get a recursive tree view of files and directories as a JSON structure. " +
    "Each entry includes 'name', 'type' (file/directory), and 'children' for directories. " +
    "Files have no children array, while directories always have a children array (which may be empty). " +
    "The output is formatted with 2-space indentation for readability. Only works within allowed directories.",
  parameters: z.object({
    path: z.string(),
    excludePatterns: z.array(z.string()).optional().default([])
  }),
  execute: async (args: z.infer<typeof DirectoryTreeArgsSchema>) => {
    interface TreeEntry {
      name: string;
      type: 'file' | 'directory';
      children?: TreeEntry[];
    }
    const rootPath = args.path;

    async function buildTree(currentPath: string, excludePatterns: string[] = []): Promise<TreeEntry[]> {
      const validPath = await validatePath(currentPath);
      const entries = await fs.readdir(validPath, { withFileTypes: true });
      const result: TreeEntry[] = [];

      for (const entry of entries) {
        const relativePath = path.relative(rootPath, path.join(currentPath, entry.name));
        const shouldExclude = excludePatterns.some(pattern => {
          if (pattern.includes('*')) {
            return minimatch(relativePath, pattern, { dot: true });
          }
          // For files: match exact name or as part of path
          // For directories: match as directory path
          return minimatch(relativePath, pattern, { dot: true }) ||
            minimatch(relativePath, `**/${pattern}`, { dot: true }) ||
            minimatch(relativePath, `**/${pattern}/**`, { dot: true });
        });
        if (shouldExclude)
          continue;

        const entryData: TreeEntry = {
          name: entry.name,
          type: entry.isDirectory() ? 'directory' : 'file'
        };

        if (entry.isDirectory()) {
          const subPath = path.join(currentPath, entry.name);
          entryData.children = await buildTree(subPath, excludePatterns);
        }

        result.push(entryData);
      }

      return result;
    }

    const treeData = await buildTree(rootPath, args.excludePatterns);
    return JSON.stringify(treeData, null, 2);
  },
  annotations: { readOnlyHint: true }
});

server.addTool({
  name: "move_file",
  description:
    "Move or rename files and directories. Can move files between directories " +
    "and rename them in a single operation. If the destination exists, the " +
    "operation will fail. Works across different directories and can be used " +
    "for simple renaming within the same directory. " +
    "IMPORTANT: This tool automatically creates parent directories for the destination if they don't exist. " +
    "Both source and destination must be within allowed directories.",
  parameters: z.object({
    source: z.string(),
    destination: z.string()
  }),
  execute: async (args: z.infer<typeof MoveFileArgsSchema>) => {
    // Use substrate lock for both source and destination
    return withSubstrateLock(args.source, 'move', async () => {
      return withSubstrateLock(args.destination, 'move', async () => {
        const validSourcePath = await validatePath(args.source);
        const validDestPath = await validatePath(args.destination, { allowMissingParent: true });
        
        // Ensure destination parent directory exists
        const parentDirsCreated = await ensureParentDirectory(validDestPath);
        
        await fs.rename(validSourcePath, validDestPath);
        
        // Build detailed response message
        const messages: string[] = [];
        
        if (parentDirsCreated.length > 0) {
          messages.push(`Created parent directories for destination:`);
          for (const dir of parentDirsCreated) {
            messages.push(`  - ${dir}`);
          }
        }
        
        messages.push(`Successfully moved ${args.source} to ${args.destination}`);
        
        return messages.join('\n');
      });
    });
  },
  annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true }
});

server.addTool({
  name: "search_files",
  description:
    "Recursively search for files and directories matching a glob pattern on their PATHS. " +
    "This tool matches file and directory NAMES only — it does NOT open or read file contents. " +
    "Use pattern like '*.ext' to match files by extension, and '**/*.ext' to match in all subdirectories. " +
    "To search file CONTENTS (e.g., find where a function or string is defined), use grep_files instead. " +
    "Returns full paths to all matching items. " +
    "Only searches within allowed directories.",
  parameters: z.object({
    path: z.string(),
    pattern: z.string(),
    excludePatterns: z.array(z.string()).optional().default([])
  }),
  execute: async (args: z.infer<typeof SearchFilesArgsSchema>) => {
    const validPath = await validatePath(args.path);
    const results = await searchFilesWithValidation(validPath, args.pattern, allowedDirectories, { excludePatterns: args.excludePatterns });
    return results.length > 0 ? results.join("\n") : "No matches found";
  },
  annotations: { readOnlyHint: true }
});

server.addTool({
  name: "grep_files",
  description:
    "Search file contents for a pattern. " +
    "Unlike search_files which only matches file/directory names by glob pattern, " +
    "this tool opens files and searches their content. " +
    "Use this when you need to find where a function, variable, string, or pattern " +
    "is defined or used in the codebase. " +
    "Returns matches in the format: path:lineNumber:snippet (or path:lineNumber when includeSnippet is false). " +
    "Supports regex syntax for the search pattern; simple strings work as-is. " +
    "Automatically skips binary files, files over 10MB, and common non-code directories " +
    "(node_modules, .git, __pycache__, venv, *.lock, etc.) unless includeIgnored is true. " +
    "Use filePattern to restrict search to specific file types (e.g., '*.py', '*.{ts,js}'). " +
    "Only searches within allowed directories.",
  parameters: GrepFilesArgsSchema,
  execute: async (args: z.infer<typeof GrepFilesArgsSchema>) => {
    const result = await grepFilesWithValidation(
      args.path,
      args.pattern,
      allowedDirectories,
      {
        excludePatterns: args.excludePatterns,
        includeIgnored: args.includeIgnored,
        includeSnippet: args.includeSnippet,
        contextLines: args.contextLines,
        maxResults: args.maxResults,
        filePattern: args.filePattern,
      }
    );
    return formatGrepResult(result, args.includeSnippet);
  },
  annotations: { readOnlyHint: true }
});

server.addTool({
  name: "get_file_info",
  description:
    "Retrieve detailed metadata about a file or directory. Returns comprehensive " +
    "information including size, creation time, last modified time, permissions, " +
    "and type. This tool is perfect for understanding file characteristics " +
    "without reading the actual content. Only works within allowed directories.",
  parameters: z.object({
    path: z.string()
  }),
  execute: async (args: z.infer<typeof GetFileInfoArgsSchema>) => {
    const validPath = await validatePath(args.path);
    const info = await getFileStats(validPath);
    return Object.entries(info)
      .map(([key, value]) => `${key}: ${value}`)
      .join("\n");
  },
  annotations: { readOnlyHint: true }
});

server.addTool({
  name: "list_allowed_directories",
  description:
    "Returns the list of directories that this server is allowed to access. " +
    "Subdirectories within these allowed directories are also accessible. " +
    "Use this to understand which directories and their nested paths are available " +
    "before trying to access files.",
  parameters: z.object({}),
  execute: async () => {
    return `Allowed directories:\n${allowedDirectories.join('\n')}`;
  },
  annotations: { readOnlyHint: true }
});

// Handle roots changes using FastMCP's built-in session support
server.on("connect", (event) => {
  const session = event.session;
  
  // Update allowed directories from initial roots
  if (session.roots && session.roots.length > 0) {
    updateAllowedDirectoriesFromRoots(session.roots);
  }
  
  // Listen for dynamic roots changes
  session.on("rootsChanged", (event) => {
    console.error(`Roots changed: ${event.roots.length} root directories`);
    updateAllowedDirectoriesFromRoots(event.roots);
  });
});

// Updates allowed directories based on MCP client roots
// Merges client roots with command-line configured directories instead of replacing
async function updateAllowedDirectoriesFromRoots(requestedRoots: any[]) {
  const validatedRootDirs = await getValidRootDirectories(requestedRoots);
  if (validatedRootDirs.length > 0) {
    // Merge with existing directories, using Set to deduplicate
    allowedDirectories = [...new Set([...allowedDirectories, ...validatedRootDirs])];
    setAllowedDirectories(allowedDirectories); // Update the global state in lib.ts
    console.error(`Merged allowed directories from MCP roots: ${validatedRootDirs.length} new, ${allowedDirectories.length} total`);
  } else {
    console.error("No valid root directories provided by client, keeping existing directories");
  }
}

// Start server
async function runServer() {
  await server.start();
  console.error("Secure MCP Filesystem Server running on stdio");
  if (allowedDirectories.length === 0) {
    console.error("Started without allowed directories - waiting for client to provide roots via MCP protocol");
  }
}

runServer().catch((error) => {
  console.error("Fatal error running server:", error);
  process.exit(1);
});
