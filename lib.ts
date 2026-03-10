import fs from "fs/promises";
import path from "path";
import os from 'os';
import { randomBytes } from 'crypto';
import { diffLines, createTwoFilesPatch } from 'diff';
import { minimatch } from 'minimatch';
import { normalizePath, expandHome } from './path-utils.js';
import { isPathWithinAllowedDirectories } from './path-validation.js';

// Global allowed directories - set by the main module
let allowedDirectories: string[] = [];

// ============================================================================
// Reaktionsnetzwerk-inspired Types and Interfaces
// ============================================================================
// Each tool is like an enzyme: it has specific inputs (substrates),
// produces specific outputs (products), and has activation conditions.
// This design makes tools composable and their behavior predictable.

/**
 * Result of a write operation with detailed feedback.
 * This follows the "enzyme" model: clear inputs, clear outputs.
 */
export interface WriteResult {
  path: string;
  created: boolean;
  parentDirsCreated: string[];
  bytesWritten: number;
}

/**
 * Result of a directory creation operation.
 */
export interface DirectoryResult {
  path: string;
  created: boolean;
  dirsCreated: string[];
}

/**
 * Options for path validation.
 */
export interface ValidatePathOptions {
  /** If true, allow paths where parent directory doesn't exist yet */
  allowMissingParent?: boolean;
}

/**
 * Information about a path's parent directory status.
 */
export interface ParentStatus {
  exists: boolean;
  path: string;
  needsCreation: string[]; // List of directories that need to be created
}

// ============================================================================
// Substrate Tracking (Enzyme-Substrate Binding Model)
// ============================================================================
// In metabolic networks, enzymes bind to substrates temporarily.
// When a substrate is already bound, other enzymes are "inhibited".
// This tracker implements that concept for filesystem operations.

/**
 * Types of operations that can lock a substrate (path).
 */
export type OperationType = 'read' | 'write' | 'create' | 'move' | 'delete';

/**
 * Information about an active operation.
 */
export interface OperationInfo {
  id: string;
  path: string;
  type: OperationType;
  startTime: number;
  pid: number;
}

/**
 * Result of trying to acquire a substrate.
 */
export interface AcquireResult {
  success: boolean;
  conflict?: OperationInfo;
  acquired?: OperationInfo;
}

/**
 * SubstrateTracker implements enzyme-substrate binding semantics.
 * 
 * Like in metabolic networks:
 * - Enzymes (tools) bind to substrates (paths) temporarily
 * - When substrate is bound, other modifying enzymes are inhibited
 * - Read operations can share substrates (like multiple enzymes reading same metabolite)
 * - Write operations are exclusive (like an enzyme transforming a metabolite)
 */
class SubstrateTracker {
  private activeOperations: Map<string, OperationInfo[]> = new Map();
  private operationTimeout: number;

  constructor(timeoutMs: number = 30000) {
    this.operationTimeout = timeoutMs;
    // Clean up stale operations periodically
    setInterval(() => this.cleanupStaleOperations(), 5000);
  }

  /**
   * Normalizes a path for consistent tracking.
   */
  private normalizePathForTracking(filePath: string): string {
    return normalizePath(path.resolve(filePath));
  }

  /**
   * Gets all paths that would be affected by an operation.
   * For write operations, this includes the target and all parent directories.
   */
  private getAffectedPaths(filePath: string, type: OperationType): string[] {
    const normalized = this.normalizePathForTracking(filePath);
    const paths: string[] = [normalized];
    
    // For write/create operations, also track parent directories
    // This prevents conflicts like: creating /a/b while writing /a/b/c.txt
    if (type === 'write' || type === 'create') {
      let current = path.dirname(normalized);
      while (true) {
        paths.push(current);
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
      }
    }
    
    return paths;
  }

  /**
   * Checks if an operation type conflicts with another.
   * Read operations don't conflict with each other.
   * Write operations conflict with everything.
   */
  private conflictsWith(existing: OperationType, newOp: OperationType): boolean {
    // Read operations can coexist
    if (existing === 'read' && newOp === 'read') return false;
    // Any write operation conflicts with any other operation
    if (existing !== 'read' || newOp !== 'read') return true;
    return false;
  }

  /**
   * Try to acquire (bind to) a substrate.
   * Returns success=true if acquired, or conflict info if blocked.
   */
  tryAcquire(filePath: string, type: OperationType): AcquireResult {
    const affectedPaths = this.getAffectedPaths(filePath, type);
    const id = randomBytes(8).toString('hex');
    const now = Date.now();

    // Check for conflicts on all affected paths
    for (const checkPath of affectedPaths) {
      const existing = this.activeOperations.get(checkPath) || [];
      for (const op of existing) {
        if (this.conflictsWith(op.type, type)) {
          return {
            success: false,
            conflict: op
          };
        }
      }
    }

    // No conflicts - acquire all affected paths
    const operation: OperationInfo = {
      id,
      path: this.normalizePathForTracking(filePath),
      type,
      startTime: now,
      pid: process.pid
    };

    for (const acquirePath of affectedPaths) {
      const existing = this.activeOperations.get(acquirePath) || [];
      existing.push(operation);
      this.activeOperations.set(acquirePath, existing);
    }

    return {
      success: true,
      acquired: operation
    };
  }

  /**
   * Release a substrate after operation completes.
   */
  release(operation: OperationInfo): void {
    const affectedPaths = this.getAffectedPaths(operation.path, operation.type);
    
    for (const releasePath of affectedPaths) {
      const existing = this.activeOperations.get(releasePath) || [];
      const filtered = existing.filter(op => op.id !== operation.id);
      
      if (filtered.length === 0) {
        this.activeOperations.delete(releasePath);
      } else {
        this.activeOperations.set(releasePath, filtered);
      }
    }
  }

  /**
   * Clean up operations that have been running too long.
   * This handles cases where operations crash without releasing.
   */
  private cleanupStaleOperations(): void {
    const now = Date.now();
    const staleIds = new Set<string>();

    for (const [path, operations] of this.activeOperations) {
      for (const op of operations) {
        if (now - op.startTime > this.operationTimeout) {
          staleIds.add(op.id);
        }
      }
    }

    // Remove stale operations
    for (const [path, operations] of this.activeOperations) {
      const filtered = operations.filter(op => !staleIds.has(op.id));
      if (filtered.length === 0) {
        this.activeOperations.delete(path);
      } else {
        this.activeOperations.set(path, filtered);
      }
    }
  }

  /**
   * Get info about current active operations (for debugging).
   */
  getActiveOperations(): Map<string, OperationInfo[]> {
    return new Map(this.activeOperations);
  }
}

// Global substrate tracker instance
const substrateTracker = new SubstrateTracker();

/**
 * Execute a filesystem operation with substrate tracking.
 * This wraps operations with automatic acquire/release semantics.
 */
export async function withSubstrateLock<T>(
  filePath: string,
  type: OperationType,
  operation: () => Promise<T>
): Promise<T> {
  const acquireResult = substrateTracker.tryAcquire(filePath, type);
  
  if (!acquireResult.success) {
    const conflict = acquireResult.conflict!;
    throw new Error(
      `Operation conflict: Path "${filePath}" is currently being ${conflict.type}ed ` +
      `(started ${Math.round((Date.now() - conflict.startTime) / 1000)}s ago). ` +
      `Please wait and retry, or use a different path.`
    );
  }

  try {
    return await operation();
  } finally {
    substrateTracker.release(acquireResult.acquired!);
  }
}

// Function to set allowed directories from the main module
export function setAllowedDirectories(directories: string[]): void {
  allowedDirectories = [...directories];
}

// Function to get current allowed directories
export function getAllowedDirectories(): string[] {
  return [...allowedDirectories];
}

// ============================================================================
// Reaktionsnetzwerk-inspired Core Functions
// ============================================================================
// These functions implement the "enzyme" model: they have clear activation
// conditions (substrates) and produce predictable outputs (products).

/**
 * Checks the status of a path's parent directory.
 * This is a "sensor" function - it reads state without modifying it.
 * 
 * @param filePath - The file path to check
 * @returns Information about the parent directory status
 */
export async function checkParentStatus(filePath: string): Promise<ParentStatus> {
  const parentDir = path.dirname(filePath);
  const needsCreation: string[] = [];
  
  // Walk up the tree to find what needs to be created
  let current = parentDir;
  const toCheck: string[] = [];
  
  while (true) {
    toCheck.unshift(current);
    const parent = path.dirname(current);
    if (parent === current) break; // Reached root
    current = parent;
  }
  
  // Check each level from root down
  for (const dir of toCheck) {
    try {
      const stats = await fs.stat(dir);
      if (!stats.isDirectory()) {
        // Exists but not a directory - this is an error condition
        throw new Error(`Path component exists but is not a directory: ${dir}`);
      }
      // Exists and is a directory - stop here
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        needsCreation.push(dir);
      } else {
        throw error;
      }
    }
  }
  
  return {
    exists: needsCreation.length === 0,
    path: parentDir,
    needsCreation
  };
}

/**
 * Ensures the parent directory of a file exists, creating it if necessary.
 * This is a "synthase" function - it creates new structures.
 * 
 * Like an enzyme, it has:
 * - Activation condition: needs parent directory
 * - Substrate: file path
 * - Product: existing parent directory
 * - Byproduct: list of directories created
 * 
 * @param filePath - The file path whose parent should exist
 * @returns List of directories that were created (empty if already existed)
 */
export async function ensureParentDirectory(filePath: string): Promise<string[]> {
  const parentDir = path.dirname(filePath);
  const created: string[] = [];
  
  // Check if parent already exists
  try {
    const stats = await fs.stat(parentDir);
    if (stats.isDirectory()) {
      return []; // Already exists, nothing to create
    }
    throw new Error(`Parent path exists but is not a directory: ${parentDir}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
  
  // Parent doesn't exist - create it recursively
  // Using recursive mkdir which creates all intermediate directories
  await fs.mkdir(parentDir, { recursive: true });
  
  // Determine what was actually created by checking which dirs now exist
  // that didn't exist before (we know parent didn't exist)
  let current = parentDir;
  while (true) {
    created.unshift(current);
    const parent = path.dirname(current);
    if (parent === current) break; // Reached root
    
    // Check if this level was just created
    try {
      const stats = await fs.stat(parent);
      if (stats.isDirectory()) {
        // Parent existed before, so we're done
        break;
      }
    } catch {
      // Parent also didn't exist, continue up
      current = parent;
    }
  }
  
  return created;
}

/**
 * Creates a directory recursively, returning detailed information about what was created.
 * This is a "synthase" function - it creates new structures.
 * 
 * @param dirPath - The directory path to create
 * @returns Information about what was created
 */
export async function createDirectoryRecursive(dirPath: string): Promise<DirectoryResult> {
  const created: string[] = [];
  
  // Check if already exists
  try {
    const stats = await fs.stat(dirPath);
    if (stats.isDirectory()) {
      return {
        path: dirPath,
        created: false,
        dirsCreated: []
      };
    }
    throw new Error(`Path exists but is not a directory: ${dirPath}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
  
  // Directory doesn't exist - create it recursively
  // First, find what needs to be created
  const parentStatus = await checkParentStatus(path.join(dirPath, '.placeholder'));
  
  // Create the directory
  await fs.mkdir(dirPath, { recursive: true });
  
  // Determine what was created
  let current = dirPath;
  while (true) {
    created.unshift(current);
    const parent = path.dirname(current);
    if (parent === current) break; // Reached root
    
    try {
      const stats = await fs.stat(parent);
      if (stats.isDirectory()) {
        break; // Parent existed before
      }
    } catch {
      current = parent;
    }
  }
  
  return {
    path: dirPath,
    created: true,
    dirsCreated: created
  };
}

// Type definitions
interface FileInfo {
  size: number;
  created: Date;
  modified: Date;
  accessed: Date;
  isDirectory: boolean;
  isFile: boolean;
  permissions: string;
}

export interface SearchOptions {
  excludePatterns?: string[];
}

export interface SearchResult {
  path: string;
  isDirectory: boolean;
}

// Pure Utility Functions
export function formatSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  if (bytes === 0) return '0 B';
  
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  
  if (i < 0 || i === 0) return `${bytes} ${units[0]}`;
  
  const unitIndex = Math.min(i, units.length - 1);
  return `${(bytes / Math.pow(1024, unitIndex)).toFixed(2)} ${units[unitIndex]}`;
}

export function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

export function createUnifiedDiff(originalContent: string, newContent: string, filepath: string = 'file'): string {
  // Ensure consistent line endings for diff
  const normalizedOriginal = normalizeLineEndings(originalContent);
  const normalizedNew = normalizeLineEndings(newContent);

  return createTwoFilesPatch(
    filepath,
    filepath,
    normalizedOriginal,
    normalizedNew,
    'original',
    'modified'
  );
}

// Helper function to resolve relative paths against allowed directories
function resolveRelativePathAgainstAllowedDirectories(relativePath: string): string {
  if (allowedDirectories.length === 0) {
    // Fallback to process.cwd() if no allowed directories are set
    return path.resolve(process.cwd(), relativePath);
  }

  // Try to resolve relative path against each allowed directory
  for (const allowedDir of allowedDirectories) {
    const candidate = path.resolve(allowedDir, relativePath);
    const normalizedCandidate = normalizePath(candidate);
    
    // Check if the resulting path lies within any allowed directory
    if (isPathWithinAllowedDirectories(normalizedCandidate, allowedDirectories)) {
      return candidate;
    }
  }
  
  // If no valid resolution found, use the first allowed directory as base
  // This provides a consistent fallback behavior
  return path.resolve(allowedDirectories[0], relativePath);
}

// Security & Validation Functions

/**
 * Validates a requested path and returns the validated absolute path.
 * 
 * This is a "sensor" function - it reads state and validates conditions.
 * Like an enzyme, it has activation conditions:
 * - Path must be within allowed directories
 * - For existing files, symlinks must resolve to allowed directories
 * - For new files, parent must exist (unless allowMissingParent is true)
 * 
 * @param requestedPath - The path to validate
 * @param options - Validation options
 * @returns The validated absolute path
 * @throws Error if path is invalid or outside allowed directories
 */
export async function validatePath(
  requestedPath: string,
  options: ValidatePathOptions = {}
): Promise<string> {
  const { allowMissingParent = false } = options;
  
  const expandedPath = expandHome(requestedPath);
  const absolute = path.isAbsolute(expandedPath)
    ? path.resolve(expandedPath)
    : resolveRelativePathAgainstAllowedDirectories(expandedPath);

  const normalizedRequested = normalizePath(absolute);

  // Security: Check if path is within allowed directories before any file operations
  const isAllowed = isPathWithinAllowedDirectories(normalizedRequested, allowedDirectories);
  if (!isAllowed) {
    throw new Error(`Access denied - path outside allowed directories: ${absolute} not in ${allowedDirectories.join(', ')}`);
  }

  // Security: Handle symlinks by checking their real path to prevent symlink attacks
  // This prevents attackers from creating symlinks that point outside allowed directories
  try {
    const realPath = await fs.realpath(absolute);
    const normalizedReal = normalizePath(realPath);
    if (!isPathWithinAllowedDirectories(normalizedReal, allowedDirectories)) {
      throw new Error(`Access denied - symlink target outside allowed directories: ${realPath} not in ${allowedDirectories.join(', ')}`);
    }
    return realPath;
  } catch (error) {
    // Security: For new files that don't exist yet, verify parent directory
    // This ensures we can't create files in unauthorized locations
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      const parentDir = path.dirname(absolute);
      try {
        const realParentPath = await fs.realpath(parentDir);
        const normalizedParent = normalizePath(realParentPath);
        if (!isPathWithinAllowedDirectories(normalizedParent, allowedDirectories)) {
          throw new Error(`Access denied - parent directory outside allowed directories: ${realParentPath} not in ${allowedDirectories.join(', ')}`);
        }
        return absolute;
      } catch (parentError) {
        // If allowMissingParent is true, we can proceed even if parent doesn't exist
        // But we still need to validate that the path structure is within allowed directories
        if (allowMissingParent) {
          // Walk up the tree until we find an existing parent
          let currentParent = parentDir;
          while (true) {
            const grandparent = path.dirname(currentParent);
            if (grandparent === currentParent) {
              // Reached root without finding existing directory
              // This is unusual but could happen with relative paths
              throw new Error(`Cannot validate path - no existing parent found in allowed directories: ${parentDir}`);
            }
            
            try {
              const realGrandparentPath = await fs.realpath(grandparent);
              const normalizedGrandparent = normalizePath(realGrandparentPath);
              if (isPathWithinAllowedDirectories(normalizedGrandparent, allowedDirectories)) {
                return absolute;
              }
              throw new Error(`Access denied - ancestor directory outside allowed directories: ${realGrandparentPath} not in ${allowedDirectories.join(', ')}`);
            } catch (gpError) {
              if ((gpError as NodeJS.ErrnoException).code !== 'ENOENT') {
                throw gpError;
              }
              currentParent = grandparent;
            }
          }
        }
        throw new Error(`Parent directory does not exist: ${parentDir}`);
      }
    }
    throw error;
  }
}


// File Operations
export async function getFileStats(filePath: string): Promise<FileInfo> {
  const stats = await fs.stat(filePath);
  return {
    size: stats.size,
    created: stats.birthtime,
    modified: stats.mtime,
    accessed: stats.atime,
    isDirectory: stats.isDirectory(),
    isFile: stats.isFile(),
    permissions: stats.mode.toString(8).slice(-3),
  };
}

export async function readFileContent(filePath: string, encoding: string = 'utf-8'): Promise<string> {
  return await fs.readFile(filePath, encoding as BufferEncoding);
}

/**
 * Writes content to a file, automatically creating parent directories if needed.
 * This is a "synthase" function - it creates new structures.
 * 
 * Like an enzyme, it has:
 * - Activation condition: valid path within allowed directories
 * - Substrate: file path and content
 * - Product: file written to disk
 * - Byproduct: list of directories created (if any)
 * 
 * @param filePath - The file path to write to
 * @param content - The content to write
 * @returns Detailed result including what was created
 */
export async function writeFileContent(filePath: string, content: string): Promise<WriteResult> {
  return withSubstrateLock(filePath, 'write', async () => {
    // Validate path with allowMissingParent=true so we can auto-create parents
    const validPath = await validatePath(filePath, { allowMissingParent: true });
    
    // Ensure parent directory exists (auto-create if needed)
    const parentDirsCreated = await ensureParentDirectory(validPath);
    
    // Write the file
    const bytesWritten = Buffer.byteLength(content, 'utf-8');
    
    try {
      // Security: 'wx' flag ensures exclusive creation - fails if file/symlink exists,
      // preventing writes through pre-existing symlinks
      await fs.writeFile(validPath, content, { encoding: "utf-8", flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        // Security: Use atomic rename to prevent race conditions where symlinks
        // could be created between validation and write. Rename operations
        // replace the target file atomically and don't follow symlinks.
        const tempPath = `${validPath}.${randomBytes(16).toString('hex')}.tmp`;
        try {
          await fs.writeFile(tempPath, content, 'utf-8');
          await fs.rename(tempPath, validPath);
        } catch (renameError) {
          try {
            await fs.unlink(tempPath);
          } catch {}
          throw renameError;
        }
      } else {
        throw error;
      }
    }
    
    return {
      path: validPath,
      created: true,
      parentDirsCreated,
      bytesWritten
    };
  });
}


// File Editing Functions
interface FileEdit {
  oldText: string;
  newText: string;
}

export async function applyFileEdits(
  filePath: string,
  edits: FileEdit[],
  dryRun: boolean = false
): Promise<string> {
  // Read file content and normalize line endings
  const content = normalizeLineEndings(await fs.readFile(filePath, 'utf-8'));

  // Apply edits sequentially
  let modifiedContent = content;
  for (const edit of edits) {
    const normalizedOld = normalizeLineEndings(edit.oldText);
    const normalizedNew = normalizeLineEndings(edit.newText);

    // If exact match exists, use it
    if (modifiedContent.includes(normalizedOld)) {
      modifiedContent = modifiedContent.replace(normalizedOld, normalizedNew);
      continue;
    }

    // Otherwise, try line-by-line matching with flexibility for whitespace
    const oldLines = normalizedOld.split('\n');
    const contentLines = modifiedContent.split('\n');
    let matchFound = false;

    for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
      const potentialMatch = contentLines.slice(i, i + oldLines.length);

      // Compare lines with normalized whitespace
      const isMatch = oldLines.every((oldLine, j) => {
        const contentLine = potentialMatch[j];
        return oldLine.trim() === contentLine.trim();
      });

      if (isMatch) {
        // Preserve original indentation of first line
        const originalIndent = contentLines[i].match(/^\s*/)?.[0] || '';
        const newLines = normalizedNew.split('\n').map((line, j) => {
          if (j === 0) return originalIndent + line.trimStart();
          // For subsequent lines, try to preserve relative indentation
          const oldIndent = oldLines[j]?.match(/^\s*/)?.[0] || '';
          const newIndent = line.match(/^\s*/)?.[0] || '';
          if (oldIndent && newIndent) {
            const relativeIndent = newIndent.length - oldIndent.length;
            return originalIndent + ' '.repeat(Math.max(0, relativeIndent)) + line.trimStart();
          }
          return line;
        });

        contentLines.splice(i, oldLines.length, ...newLines);
        modifiedContent = contentLines.join('\n');
        matchFound = true;
        break;
      }
    }

    if (!matchFound) {
      throw new Error(`Could not find exact match for edit:\n${edit.oldText}`);
    }
  }

  // Create unified diff
  const diff = createUnifiedDiff(content, modifiedContent, filePath);

  // Format diff with appropriate number of backticks
  let numBackticks = 3;
  while (diff.includes('`'.repeat(numBackticks))) {
    numBackticks++;
  }
  const formattedDiff = `${'`'.repeat(numBackticks)}diff\n${diff}${'`'.repeat(numBackticks)}\n\n`;

  if (!dryRun) {
    // Security: Use atomic rename to prevent race conditions where symlinks
    // could be created between validation and write. Rename operations
    // replace the target file atomically and don't follow symlinks.
    const tempPath = `${filePath}.${randomBytes(16).toString('hex')}.tmp`;
    try {
      await fs.writeFile(tempPath, modifiedContent, 'utf-8');
      await fs.rename(tempPath, filePath);
    } catch (error) {
      try {
        await fs.unlink(tempPath);
      } catch {}
      throw error;
    }
  }

  return formattedDiff;
}

// Memory-efficient implementation to get the last N lines of a file
export async function tailFile(filePath: string, numLines: number): Promise<string> {
  const CHUNK_SIZE = 1024; // Read 1KB at a time
  const stats = await fs.stat(filePath);
  const fileSize = stats.size;
  
  if (fileSize === 0) return '';
  
  // Open file for reading
  const fileHandle = await fs.open(filePath, 'r');
  try {
    const lines: string[] = [];
    let position = fileSize;
    let chunk = Buffer.alloc(CHUNK_SIZE);
    let linesFound = 0;
    let remainingText = '';
    
    // Read chunks from the end of the file until we have enough lines
    while (position > 0 && linesFound < numLines) {
      const size = Math.min(CHUNK_SIZE, position);
      position -= size;
      
      const { bytesRead } = await fileHandle.read(chunk, 0, size, position);
      if (!bytesRead) break;
      
      // Get the chunk as a string and prepend any remaining text from previous iteration
      const readData = chunk.slice(0, bytesRead).toString('utf-8');
      const chunkText = readData + remainingText;
      
      // Split by newlines and count
      const chunkLines = normalizeLineEndings(chunkText).split('\n');
      
      // If this isn't the end of the file, the first line is likely incomplete
      // Save it to prepend to the next chunk
      if (position > 0) {
        remainingText = chunkLines[0];
        chunkLines.shift(); // Remove the first (incomplete) line
      }
      
      // Add lines to our result (up to the number we need)
      for (let i = chunkLines.length - 1; i >= 0 && linesFound < numLines; i--) {
        lines.unshift(chunkLines[i]);
        linesFound++;
      }
    }
    
    return lines.join('\n');
  } finally {
    await fileHandle.close();
  }
}

// New function to get the first N lines of a file
export async function headFile(filePath: string, numLines: number): Promise<string> {
  const fileHandle = await fs.open(filePath, 'r');
  try {
    const lines: string[] = [];
    let buffer = '';
    let bytesRead = 0;
    const chunk = Buffer.alloc(1024); // 1KB buffer
    
    // Read chunks and count lines until we have enough or reach EOF
    while (lines.length < numLines) {
      const result = await fileHandle.read(chunk, 0, chunk.length, bytesRead);
      if (result.bytesRead === 0) break; // End of file
      bytesRead += result.bytesRead;
      buffer += chunk.slice(0, result.bytesRead).toString('utf-8');
      
      const newLineIndex = buffer.lastIndexOf('\n');
      if (newLineIndex !== -1) {
        const completeLines = buffer.slice(0, newLineIndex).split('\n');
        buffer = buffer.slice(newLineIndex + 1);
        for (const line of completeLines) {
          lines.push(line);
          if (lines.length >= numLines) break;
        }
      }
    }
    
    // If there is leftover content and we still need lines, add it
    if (buffer.length > 0 && lines.length < numLines) {
      lines.push(buffer);
    }
    
    return lines.join('\n');
  } finally {
    await fileHandle.close();
  }
}

export async function searchFilesWithValidation(
  rootPath: string,
  pattern: string,
  allowedDirectories: string[],
  options: SearchOptions = {}
): Promise<string[]> {
  const { excludePatterns = [] } = options;
  const results: string[] = [];

  async function search(currentPath: string) {
    const entries = await fs.readdir(currentPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);

      try {
        await validatePath(fullPath);

        const relativePath = path.relative(rootPath, fullPath);
        const shouldExclude = excludePatterns.some(excludePattern =>
          minimatch(relativePath, excludePattern, { dot: true })
        );

        if (shouldExclude) continue;

        // Use glob matching for the search pattern
        if (minimatch(relativePath, pattern, { dot: true })) {
          results.push(fullPath);
        }

        if (entry.isDirectory()) {
          await search(fullPath);
        }
      } catch {
        continue;
      }
    }
  }

  await search(rootPath);
  return results;
}
