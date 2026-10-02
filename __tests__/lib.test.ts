import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { promisify } from 'util';
import {
  // Pure utility functions
  formatSize,
  normalizeLineEndings,
  createUnifiedDiff,
  sliceLines,
  // Security & validation functions
  validatePath,
  setAllowedDirectories,
  // File operations
  getFileStats,
  readFileContent,
  writeFileContent,
  // Search & filtering functions
  searchFilesWithValidation,
  grepFilesWithValidation,
  // File editing functions
  applyEditsToContent,
  locateEdit,
  tailFile,
  headFile
} from '../lib.js';

// Mock fs and child_process modules (child_process mocked to force the native grep fallback deterministically)
vi.mock('fs/promises');
vi.mock('child_process');
const mockFs = fs as any;
const mockCp = (await import('child_process')).execFile as any;

/**
 * Mocks fs.open with a handle that serves the given bytes to reads at
 * absolute positions — emulating real fs.read semantics, where data is
 * written INTO the caller-supplied buffer (the returned `buffer` property
 * is ignored by callers).
 */
function mockFileBytes(bytes: string | Buffer) {
  const source = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes as string);
  const handle = {
    read: vi.fn(async (target: Buffer, _offset: number, length: number, position: number) => {
      const end = Math.min(position + length, source.length);
      const copied = end > position ? source.copy(target, 0, position, end) : 0;
      return { bytesRead: copied, buffer: target };
    }),
    close: vi.fn().mockResolvedValue(undefined),
  };
  mockFs.open.mockResolvedValue(handle);
  return handle;
}

describe('Lib Functions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Set up allowed directories for tests
    const allowedDirs = process.platform === 'win32' ? ['C:\\Users\\test', 'C:\\temp', 'C:\\allowed'] : ['/home/user', '/tmp', '/allowed'];
    setAllowedDirectories(allowedDirs);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // Clear allowed directories after tests
    setAllowedDirectories([]);
  });

  describe('Pure Utility Functions', () => {
    describe('formatSize', () => {
      it('formats bytes correctly', () => {
        expect(formatSize(0)).toBe('0 B');
        expect(formatSize(512)).toBe('512 B');
        expect(formatSize(1024)).toBe('1.00 KB');
        expect(formatSize(1536)).toBe('1.50 KB');
        expect(formatSize(1048576)).toBe('1.00 MB');
        expect(formatSize(1073741824)).toBe('1.00 GB');
        expect(formatSize(1099511627776)).toBe('1.00 TB');
      });

      it('handles edge cases', () => {
        expect(formatSize(1023)).toBe('1023 B');
        expect(formatSize(1025)).toBe('1.00 KB');
        expect(formatSize(1048575)).toBe('1024.00 KB');
      });

      it('handles very large numbers beyond TB', () => {
        // The function only supports up to TB, so very large numbers will show as TB
        expect(formatSize(1024 * 1024 * 1024 * 1024 * 1024)).toBe('1024.00 TB');
        expect(formatSize(Number.MAX_SAFE_INTEGER)).toContain('TB');
      });

      it('handles negative numbers', () => {
        // Negative numbers will result in NaN for the log calculation
        expect(formatSize(-1024)).toContain('NaN');
        expect(formatSize(-0)).toBe('0 B');
      });

      it('handles decimal numbers', () => {
        expect(formatSize(1536.5)).toBe('1.50 KB');
        expect(formatSize(1023.9)).toBe('1023.9 B');
      });

      it('handles very small positive numbers', () => {
        expect(formatSize(1)).toBe('1 B');
        expect(formatSize(0.5)).toBe('0.5 B');
        expect(formatSize(0.1)).toBe('0.1 B');
      });
    });

    describe('normalizeLineEndings', () => {
      it('converts CRLF to LF', () => {
        expect(normalizeLineEndings('line1\r\nline2\r\nline3')).toBe('line1\nline2\nline3');
      });

      it('leaves LF unchanged', () => {
        expect(normalizeLineEndings('line1\nline2\nline3')).toBe('line1\nline2\nline3');
      });

      it('handles mixed line endings', () => {
        expect(normalizeLineEndings('line1\r\nline2\nline3\r\n')).toBe('line1\nline2\nline3\n');
      });

      it('handles empty string', () => {
        expect(normalizeLineEndings('')).toBe('');
      });
    });

    describe('createUnifiedDiff', () => {
      it('creates diff for simple changes', () => {
        const original = 'line1\nline2\nline3';
        const modified = 'line1\nmodified line2\nline3';
        const diff = createUnifiedDiff(original, modified, 'test.txt');
        
        expect(diff).toContain('--- test.txt');
        expect(diff).toContain('+++ test.txt');
        expect(diff).toContain('-line2');
        expect(diff).toContain('+modified line2');
      });

      it('handles CRLF normalization', () => {
        const original = 'line1\r\nline2\r\n';
        const modified = 'line1\nmodified line2\n';
        const diff = createUnifiedDiff(original, modified);
        
        expect(diff).toContain('-line2');
        expect(diff).toContain('+modified line2');
      });

      it('handles identical content', () => {
        const content = 'line1\nline2\nline3';
        const diff = createUnifiedDiff(content, content);
        
        // Should not contain any +/- lines for identical content (excluding header lines)
        expect(diff.split('\n').filter((line: string) => line.startsWith('+++') || line.startsWith('---'))).toHaveLength(2);
        expect(diff.split('\n').filter((line: string) => line.startsWith('+') && !line.startsWith('+++'))).toHaveLength(0);
        expect(diff.split('\n').filter((line: string) => line.startsWith('-') && !line.startsWith('---'))).toHaveLength(0);
      });

      it('handles empty content', () => {
        const diff = createUnifiedDiff('', '');
        expect(diff).toContain('--- file');
        expect(diff).toContain('+++ file');
      });

      it('handles default filename parameter', () => {
        const diff = createUnifiedDiff('old', 'new');
        expect(diff).toContain('--- file');
        expect(diff).toContain('+++ file');
      });

      it('handles custom filename', () => {
        const diff = createUnifiedDiff('old', 'new', 'custom.txt');
        expect(diff).toContain('--- custom.txt');
        expect(diff).toContain('+++ custom.txt');
      });
    });

    describe('sliceLines', () => {
      const content = Array.from({ length: 150 }, (_, i) => `line ${i + 1}`).join('\n');

      it('applies offset before head: offset=100, head=50 returns lines 101-150', () => {
        const result = sliceLines(content, 100, 50);
        const lines = result.split('\n');
        expect(lines).toHaveLength(50);
        expect(lines[0]).toBe('line 101');
        expect(lines[49]).toBe('line 150');
      });

      it('applies offset before tail: offset=10, tail=5 returns the last 5 lines of the remainder', () => {
        const result = sliceLines(content, 10, undefined, 5);
        const lines = result.split('\n');
        expect(lines).toHaveLength(5);
        expect(lines[0]).toBe('line 146');
        expect(lines[4]).toBe('line 150');
      });

      it('returns empty for offset beyond EOF', () => {
        expect(sliceLines(content, 500, 50)).toBe('');
        expect(sliceLines(content, 500)).toBe('');
      });

      it('passes content through unchanged at offset=0 with no head/tail', () => {
        expect(sliceLines('a\nb\nc', 0)).toBe('a\nb\nc');
      });

      it('applies head alone at offset=0', () => {
        expect(sliceLines('a\nb\nc\nd', 0, 2)).toBe('a\nb');
      });

      it('applies tail alone at offset=0', () => {
        expect(sliceLines('a\nb\nc\nd', 0, undefined, 2)).toBe('c\nd');
      });

      it('treats a trailing newline as a line terminator for tail selection', () => {
        // Editor convention, symmetric with tailFile: the last 2 lines of
        // 'a\nb\nc\n' are 'b' and 'c', not 'c' and the phantom empty line.
        expect(sliceLines('a\nb\nc\n', 1, undefined, 2)).toBe('b\nc');
        expect(sliceLines('a\nb\nc\n', 0, undefined, 2)).toBe('b\nc');
      });

      it('passes the exact remainder through for offset-only (trailing newline kept)', () => {
        expect(sliceLines('a\nb\nc\n', 1)).toBe('b\nc\n');
        expect(sliceLines('a\nb\nc', 1)).toBe('b\nc');
        expect(sliceLines('a\nb\nc\n', 0)).toBe('a\nb\nc\n');
      });

      it('returns empty when offset equals the line count', () => {
        expect(sliceLines('a\nb\nc\n', 3)).toBe('');
        expect(sliceLines('a\nb\nc\n', 4)).toBe('');
      });

      it('normalizes CRLF input', () => {
        expect(sliceLines('a\r\nb\r\nc\r\n', 1, 1)).toBe('b');
        expect(sliceLines('a\r\nb\r\nc\r\n', 1)).toBe('b\nc\n');
      });

      it('preserves genuinely empty lines while slicing', () => {
        // 'a\n\nb\n' has three lines: 'a', '' and 'b'.
        expect(sliceLines('a\n\nb\n', 0, 2)).toBe('a\n');
        expect(sliceLines('a\n\nb\n', 1)).toBe('\nb\n');
      });
    });
  });

  describe('Security & Validation Functions', () => {
    describe('validatePath', () => {
      // Use Windows-compatible paths for testing
      const allowedDirs = process.platform === 'win32' ? ['C:\\Users\\test', 'C:\\temp'] : ['/home/user', '/tmp'];

      beforeEach(() => {
        mockFs.realpath.mockImplementation(async (path: any) => path.toString());
      });

      it('validates allowed paths', async () => {
        const testPath = process.platform === 'win32' ? 'C:\\Users\\test\\file.txt' : '/home/user/file.txt';
        const result = await validatePath(testPath);
        expect(result).toBe(testPath);
      });

      it('rejects disallowed paths', async () => {
        const testPath = process.platform === 'win32' ? 'C:\\Windows\\System32\\file.txt' : '/etc/passwd';
        await expect(validatePath(testPath))
          .rejects.toThrow('Access denied - path outside allowed directories');
      });

      it('handles non-existent files by checking parent directory', async () => {
        const newFilePath = process.platform === 'win32' ? 'C:\\Users\\test\\newfile.txt' : '/home/user/newfile.txt';
        const parentPath = process.platform === 'win32' ? 'C:\\Users\\test' : '/home/user';
        
        // Create an error with the ENOENT code that the implementation checks for
        const enoentError = new Error('ENOENT') as NodeJS.ErrnoException;
        enoentError.code = 'ENOENT';
        
        mockFs.realpath
          .mockRejectedValueOnce(enoentError)
          .mockResolvedValueOnce(parentPath);
        
        const result = await validatePath(newFilePath);
        expect(result).toBe(path.resolve(newFilePath));
      });

      it('rejects when parent directory does not exist', async () => {
        const newFilePath = process.platform === 'win32' ? 'C:\\Users\\test\\nonexistent\\newfile.txt' : '/home/user/nonexistent/newfile.txt';
        
        // Create errors with the ENOENT code
        const enoentError1 = new Error('ENOENT') as NodeJS.ErrnoException;
        enoentError1.code = 'ENOENT';
        const enoentError2 = new Error('ENOENT') as NodeJS.ErrnoException;
        enoentError2.code = 'ENOENT';
        
        mockFs.realpath
          .mockRejectedValueOnce(enoentError1)
          .mockRejectedValueOnce(enoentError2);
        
        await expect(validatePath(newFilePath))
          .rejects.toThrow('Parent directory does not exist');
      });

      it('resolves relative paths against allowed directories instead of process.cwd()', async () => {
        const relativePath = 'test-file.txt';
        const originalCwd = process.cwd;
        
        // Mock process.cwd to return a directory outside allowed directories
        const disallowedCwd = process.platform === 'win32' ? 'C:\\Windows\\System32' : '/root';
        (process as any).cwd = vi.fn(() => disallowedCwd);
        
        try {
          const result = await validatePath(relativePath);
          
          // Result should be resolved against first allowed directory, not process.cwd()
          const expectedPath = process.platform === 'win32' 
            ? path.resolve('C:\\Users\\test', relativePath)
            : path.resolve('/home/user', relativePath);
          
          expect(result).toBe(expectedPath);
          expect(result).not.toContain(disallowedCwd);
        } finally {
          // Restore original process.cwd
          process.cwd = originalCwd;
        }
      });
    });
  });

  describe('File Operations', () => {
    describe('getFileStats', () => {
      it('returns file statistics including lineCount', async () => {
        const mockStats = {
          size: 1024,
          birthtime: new Date('2023-01-01'),
          mtime: new Date('2023-01-02'),
          atime: new Date('2023-01-03'),
          isDirectory: () => false,
          isFile: () => true,
          mode: 0o644
        };

        mockFs.stat.mockResolvedValueOnce(mockStats as any);
        mockFileBytes('a\nb\nc');

        const result = await getFileStats('/test/file.txt');

        expect(result).toEqual({
          size: 1024,
          created: new Date('2023-01-01'),
          modified: new Date('2023-01-02'),
          accessed: new Date('2023-01-03'),
          isDirectory: false,
          isFile: true,
          permissions: '644',
          lineCount: 3
        });
      });

      it('counts lines with editor convention: trailing newline does not add a line', async () => {
        const mockStats = {
          size: 6,
          birthtime: new Date('2023-01-01'),
          mtime: new Date('2023-01-02'),
          atime: new Date('2023-01-03'),
          isDirectory: () => false,
          isFile: () => true,
          mode: 0o644
        };

        mockFs.stat.mockResolvedValueOnce(mockStats as any);
        mockFileBytes('a\nb\nc\n');

        const result = await getFileStats('/test/file.txt');
        expect(result.lineCount).toBe(3);
      });

      it('counts a non-empty file without trailing newline as one line', async () => {
        const mockStats = {
          size: 3,
          birthtime: new Date('2023-01-01'),
          mtime: new Date('2023-01-02'),
          atime: new Date('2023-01-03'),
          isDirectory: () => false,
          isFile: () => true,
          mode: 0o644
        };

        mockFs.stat.mockResolvedValueOnce(mockStats as any);
        mockFileBytes('abc');

        const result = await getFileStats('/test/file.txt');
        expect(result.lineCount).toBe(1);
      });

      it('reports lineCount 0 for an empty file', async () => {
        const mockStats = {
          size: 0,
          birthtime: new Date('2023-01-01'),
          mtime: new Date('2023-01-02'),
          atime: new Date('2023-01-03'),
          isDirectory: () => false,
          isFile: () => true,
          mode: 0o644
        };

        mockFs.stat.mockResolvedValueOnce(mockStats as any);
        mockFileBytes('');

        const result = await getFileStats('/test/file.txt');
        expect(result.lineCount).toBe(0);
      });

      it('handles directory statistics and omits lineCount', async () => {
        const mockStats = {
          size: 4096,
          birthtime: new Date('2023-01-01'),
          mtime: new Date('2023-01-02'),
          atime: new Date('2023-01-03'),
          isDirectory: () => true,
          isFile: () => false,
          mode: 0o755
        };

        mockFs.stat.mockResolvedValueOnce(mockStats as any);

        const result = await getFileStats('/test/dir');

        expect(result.isDirectory).toBe(true);
        expect(result.isFile).toBe(false);
        expect(result.permissions).toBe('755');
        expect(result).not.toHaveProperty('lineCount');
        expect(mockFs.open).not.toHaveBeenCalled();
      });
    });

    describe('readFileContent', () => {
      it('reads file with default encoding', async () => {
        mockFs.readFile.mockResolvedValueOnce('file content');
        
        const result = await readFileContent('/test/file.txt');
        
        expect(result).toBe('file content');
        expect(mockFs.readFile).toHaveBeenCalledWith('/test/file.txt', 'utf-8');
      });

      it('reads file with custom encoding', async () => {
        mockFs.readFile.mockResolvedValueOnce('file content');
        
        const result = await readFileContent('/test/file.txt', 'ascii');
        
        expect(result).toBe('file content');
        expect(mockFs.readFile).toHaveBeenCalledWith('/test/file.txt', 'ascii');
      });
    });

    describe('writeFileContent', () => {
      it('writes file content', async () => {
        mockFs.writeFile.mockResolvedValueOnce(undefined);
        
        mockFs.realpath.mockImplementation(async (p: any) => p.toString());
        // Parent directory exists — writeFileContent only auto-creates missing parents
        mockFs.stat.mockResolvedValue({ isDirectory: () => true } as any);
        // Platform-aware: validatePath normalizes to native separators (win32 → backslashes)
        const filePath = process.platform === 'win32' ? 'C:\\allowed\\file.txt' : '/allowed/file.txt';
        const result = await writeFileContent(filePath, 'new content');

        expect(mockFs.writeFile).toHaveBeenCalledWith(filePath, 'new content', { encoding: "utf-8", flag: 'wx' });
        expect(result.path).toBe(filePath);
        expect(result.parentDirsCreated).toEqual([]);
      });

      it('rejects paths outside allowed directories', async () => {
        await expect(writeFileContent('/test/file.txt', 'new content'))
          .rejects.toThrow('Access denied - path outside allowed directories');
      });
    });

  });

  describe('Search & Filtering Functions', () => {
    describe('searchFilesWithValidation', () => {
      beforeEach(() => {
        mockFs.realpath.mockImplementation(async (path: any) => path.toString());
      });


      it('excludes files matching exclude patterns', async () => {
        const mockEntries = [
          { name: 'test.txt', isDirectory: () => false },
          { name: 'test.log', isDirectory: () => false },
          { name: 'node_modules', isDirectory: () => true }
        ];
        
        mockFs.readdir.mockResolvedValueOnce(mockEntries as any);
        
        const testDir = process.platform === 'win32' ? 'C:\\allowed\\dir' : '/allowed/dir';
        const allowedDirs = process.platform === 'win32' ? ['C:\\allowed'] : ['/allowed'];
        
        // Mock realpath to return the same path for validation to pass
        mockFs.realpath.mockImplementation(async (inputPath: any) => {
          const pathStr = inputPath.toString();
          // Return the path as-is for validation
          return pathStr;
        });
        
        const result = await searchFilesWithValidation(
          testDir,
          '*test*',
          allowedDirs,
          { excludePatterns: ['*.log', 'node_modules'] }
        );
        
        const expectedResult = process.platform === 'win32' ? 'C:\\allowed\\dir\\test.txt' : '/allowed/dir/test.txt';
        expect(result).toEqual([expectedResult]);
      });

      it('throws with incomplete-results notice when validation fails during search', async () => {
        const mockEntries = [
          { name: 'test.txt', isDirectory: () => false },
          { name: 'invalid_file.txt', isDirectory: () => false }
        ];
        
        mockFs.readdir.mockResolvedValueOnce(mockEntries as any);
        
        // Mock validatePath to throw error for invalid_file.txt
        mockFs.realpath.mockImplementation(async (path: any) => {
          if (path.toString().includes('invalid_file.txt')) {
            throw new Error('Access denied');
          }
          return path.toString();
        });
        
        const testDir = process.platform === 'win32' ? 'C:\\allowed\\dir' : '/allowed/dir';
        const allowedDirs = process.platform === 'win32' ? ['C:\\allowed'] : ['/allowed'];
        
        const error = await searchFilesWithValidation(
          testDir,
          '*test*',
          allowedDirs,
          {}
        ).catch((e: Error) => e);
        expect(error).toBeInstanceOf(Error);
        expect(error.message).toMatch(/search incomplete/);
        expect(error.message).toMatch(/invalid_file\.txt: Access denied/);
        
        // (Old swallow-behavior assertions removed — the notify contract is asserted above.)
      });

      it('handles complex exclude patterns with wildcards', async () => {
        const mockEntries = [
          { name: 'test.txt', isDirectory: () => false },
          { name: 'test.backup', isDirectory: () => false },
          { name: 'important_test.js', isDirectory: () => false }
        ];
        
        mockFs.readdir.mockResolvedValueOnce(mockEntries as any);
        
        const testDir = process.platform === 'win32' ? 'C:\\allowed\\dir' : '/allowed/dir';
        const allowedDirs = process.platform === 'win32' ? ['C:\\allowed'] : ['/allowed'];
        
        const result = await searchFilesWithValidation(
          testDir,
          '*test*',
          allowedDirs,
          { excludePatterns: ['*.backup'] }
        );
        
        const expectedResults = process.platform === 'win32' ? [
          'C:\\allowed\\dir\\test.txt',
          'C:\\allowed\\dir\\important_test.js'
        ] : [
          '/allowed/dir/test.txt',
          '/allowed/dir/important_test.js'
        ];
        expect(result).toEqual(expectedResults);
      });
    });
  });

  describe('File Editing Functions', () => {
    // Note: applyFileEdits was removed — the only edit write path is the
    // per-file batch queue (edit-queue.ts), which holds the write path lock
    // and performs the atomic temp+rename write. Its fs-level behavior
    // (single atomic write, dryRun writes nothing) is covered by
    // edit-queue.test.ts. The tests below exercise the pure resolver.
    describe('applyEditsToContent', () => {
      it('applies simple text replacement', () => {
        const result = applyEditsToContent(
          'line1\nline2\nline3\n',
          [{ oldText: 'line2', newText: 'modified line2' }],
          '/test/file.txt'
        );
        expect(result).toBe('line1\nmodified line2\nline3\n');
      });

      it('applies multiple edits', () => {
        const result = applyEditsToContent(
          'line1\nline2\nline3\n',
          [
            { oldText: 'line1', newText: 'first line' },
            { oldText: 'line3', newText: 'third line' }
          ],
          '/test/file.txt'
        );
        expect(result).toBe('first line\nline2\nthird line\n');
      });

      it('handles whitespace-flexible matching', () => {
        const result = applyEditsToContent(
          '  line1\n    line2\n  line3\n',
          [{ oldText: 'line2', newText: 'modified line2' }],
          '/test/file.txt'
        );
        expect(result).toBe('  line1\n    modified line2\n  line3\n');
      });

      it('throws error for non-matching edits', () => {
        // Current error contract: EDIT FAILED — NOTHING WAS WRITTEN, with a
        // line-number hint
        expect(() =>
          applyEditsToContent('line1\nline2\nline3\n', [{ oldText: 'nonexistent line', newText: 'replacement' }], '/test/file.txt')
        ).toThrow('EDIT FAILED — NOTHING WAS WRITTEN');
      });

      it('handles complex multi-line edits with indentation', () => {
        const result = applyEditsToContent(
          'function test() {\n  console.log("hello");\n  return true;\n}',
          [{
            oldText: '  console.log("hello");\n  return true;',
            newText: '  console.log("world");\n  console.log("test");\n  return false;'
          }],
          '/test/file.js'
        );
        expect(result).toBe('function test() {\n  console.log("world");\n  console.log("test");\n  return false;\n}');
      });

      it('handles edits with different indentation patterns', () => {
        const result = applyEditsToContent(
          '    if (condition) {\n        doSomething();\n    }',
          [{
            oldText: 'doSomething();',
            newText: 'doSomethingElse();\n        doAnotherThing();'
          }],
          '/test/file.js'
        );
        expect(result).toBe('    if (condition) {\n        doSomethingElse();\n        doAnotherThing();\n    }');
      });

      it('normalizes CRLF in edit texts against LF content', () => {
        // The resolver is pure: file-content normalization is the caller's
        // job (the edit queue normalizes the base it reads; see
        // edit-queue.test.ts). Edit oldText/newText are normalized here.
        const result = applyEditsToContent(
          'line1\nline2\nline3\n',
          [{ oldText: 'line2\r\n', newText: 'modified line2\r\n' }],
          '/test/file.txt'
        );
        expect(result).toBe('line1\nmodified line2\nline3\n');
      });

      it('fails with EDIT FAILED ambiguous for multi-occurrence oldText instead of replacing the first', () => {
        expect(() =>
          applyEditsToContent('dup\nX\ndup\nY\n', [{ oldText: 'dup', newText: 'Z' }], '/test/file.txt')
        ).toThrow(/EDIT FAILED — NOTHING WAS WRITTEN[\s\S]*ambiguous[\s\S]*matches lines 1, 3/);
      });

      it('resolves ambiguous oldText via context expansion when one candidate has unique context', () => {
        // 'Q' occurs four times: three inside the repeated 'K Q' block (their
        // ±context repeats too), one with unique context (M Q N). Context
        // expansion resolves to line 9.
        const result = applyEditsToContent(
          'K\nQ\nK\nQ\nK\nQ\nK\nM\nQ\nN\n',
          [{ oldText: 'Q', newText: 'QX' }],
          '/test/file.txt'
        );
        expect(result).toBe('K\nQ\nK\nQ\nK\nQ\nK\nM\nQX\nN\n');
      });

      it('handles chained edits where edit 2 references edit 1 output', () => {
        const result = applyEditsToContent(
          'A1\nA2\nA3\n',
          [
            { oldText: 'A1', newText: 'A1-beta' },
            { oldText: 'A1-beta', newText: 'A1-gamma' }
          ],
          '/test/file.txt'
        );
        expect(result).toBe('A1-gamma\nA2\nA3\n');
      });
    });

    describe('locateEdit', () => {
      it('locates a unique exact match and returns its char span', () => {
        const content = 'A1\nA2\nA3\n';
        const loc = locateEdit(content, 'A2', 'B2');
        expect(loc).not.toBeNull();
        expect(loc!.occurrences).toBe(1);
        expect(loc!.start).toBe(3);
        expect(loc!.end).toBe(5);
        expect(loc!.replacement).toBe('B2');
        expect(loc!.matchLines).toEqual([2]);
      });

      it('returns null when oldText cannot be located', () => {
        expect(locateEdit('A1\nA2\n', 'missing', 'x')).toBeNull();
      });

      it('returns null for empty oldText', () => {
        expect(locateEdit('A1\nA2\n', '', 'x')).toBeNull();
      });

      it('reports ambiguity with occurrence count and 1-based match lines', () => {
        const content = 'dup\nX\ndup\nY\n';
        const loc = locateEdit(content, 'dup', 'Z');
        expect(loc).not.toBeNull();
        expect(loc!.occurrences).toBe(2);
        expect(loc!.matchLines).toEqual([1, 3]);
      });

      it('resolves ambiguous matches via context expansion when one candidate has unique context', () => {
        const content = 'K\nQ\nK\nQ\nK\nQ\nK\nM\nQ\nN\n';
        const loc = locateEdit(content, 'Q', 'QX');
        expect(loc).not.toBeNull();
        expect(loc!.occurrences).toBe(1);
        expect(loc!.matchLines).toEqual([9]);
        expect(loc!.start).toBe(16);
        expect(loc!.replacement).toBe('QX');
      });
    });

    describe('tailFile', () => {
      it('handles empty files', async () => {
        mockFs.stat.mockResolvedValue({ size: 0 } as any);
        
        const result = await tailFile('/test/empty.txt', 5);
        
        expect(result).toBe('');
        expect(mockFs.open).not.toHaveBeenCalled();
      });

      it('calls stat to check file size', async () => {
        mockFs.stat.mockResolvedValue({ size: 100 } as any);
        
        // Mock file handle with proper typing
        const mockFileHandle = {
          read: vi.fn(),
          close: vi.fn()
        } as any;
        
        mockFileHandle.read.mockResolvedValue({ bytesRead: 0 });
        mockFileHandle.close.mockResolvedValue(undefined);
        
        mockFs.open.mockResolvedValue(mockFileHandle);
        
        await tailFile('/test/file.txt', 2);
        
        expect(mockFs.stat).toHaveBeenCalledWith('/test/file.txt');
        expect(mockFs.open).toHaveBeenCalledWith('/test/file.txt', 'r');
      });

      it('returns the last N lines of a file without trailing newline', async () => {
        mockFileBytes('line1\nline2\nline3');
        mockFs.stat.mockResolvedValue({ size: 17 } as any);

        const result = await tailFile('/test/file.txt', 2);

        expect(result).toBe('line2\nline3');
        expect(mockFs.open).toHaveBeenCalledWith('/test/file.txt', 'r');
      });

      it('returns the last N lines across multiple chunk reads', async () => {
        // 1KB chunk size: a 3KB file forces several reads; the tail must
        // still be assembled correctly across chunk boundaries.
        const lines = Array.from({ length: 300 }, (_, i) => `line ${String(i + 1).padStart(3, '0')}`);
        const content = lines.join('\n');
        mockFileBytes(content);
        mockFs.stat.mockResolvedValue({ size: content.length } as any);

        const result = await tailFile('/test/file.txt', 2);

        expect(result).toBe('line 299\nline 300');
      });

      it('treats a trailing newline as a line terminator, not an extra empty line', async () => {
        // Editor convention, symmetric with headFile: 'a\nb\nc\n' has three
        // lines, so tail=2 returns lines 2-3 ('b\nc'), not 'c\n'.
        mockFileBytes('line1\nline2\nline3\n');
        mockFs.stat.mockResolvedValue({ size: 18 } as any);

        const result = await tailFile('/test/file.txt', 2);

        expect(result).toBe('line2\nline3');
      });

      it('returns all lines when tail exceeds the line count (no trailing newline in output)', async () => {
        // Symmetric with headFile: line selection joins with LF and never
        // appends a trailing newline.
        mockFileBytes('line1\nline2\nline3\n');
        mockFs.stat.mockResolvedValue({ size: 18 } as any);

        const result = await tailFile('/test/file.txt', 10);

        expect(result).toBe('line1\nline2\nline3');
      });

      it('normalizes CRLF line endings', async () => {
        mockFileBytes('line1\r\nline2\r\nline3\r\n');
        mockFs.stat.mockResolvedValue({ size: 24 } as any);

        const result = await tailFile('/test/file.txt', 2);

        expect(result).toBe('line2\nline3');
      });

      it('preserves genuinely empty lines inside the tail', async () => {
        // 'a\n\nb\n' has three lines: 'a', '' and 'b'. The trailing-newline
        // fix must only drop the position AFTER the final newline, never a
        // real empty line.
        mockFileBytes('a\n\nb\n');
        mockFs.stat.mockResolvedValue({ size: 6 } as any);

        const result = await tailFile('/test/file.txt', 3);

        expect(result).toBe('a\n\nb');
      });

      it('rejects and still closes the handle when a read fails', async () => {
        const handle = mockFileBytes('line1\nline2\nline3');
        handle.read.mockRejectedValueOnce(new Error('read failed'));
        mockFs.stat.mockResolvedValue({ size: 17 } as any);

        await expect(tailFile('/test/file.txt', 2)).rejects.toThrow('read failed');
        expect(handle.close).toHaveBeenCalled();
      });
    });

    describe('headFile', () => {
      it('opens file for reading', async () => {
        mockFileBytes('line1\nline2\nline3');

        await headFile('/test/file.txt', 2);

        expect(mockFs.open).toHaveBeenCalledWith('/test/file.txt', 'r');
      });

      it('returns the first N lines of a file without trailing newline', async () => {
        mockFileBytes('line1\nline2\nline3\nline4');

        const result = await headFile('/test/file.txt', 2);

        expect(result).toBe('line1\nline2');
      });

      it('returns all lines when fewer exist than requested', async () => {
        mockFileBytes('line1\nline2\nend');

        const result = await headFile('/test/file.txt', 5);

        expect(result).toBe('line1\nline2\nend');
      });

      it('stops at the requested line count when the file has a trailing newline', async () => {
        mockFileBytes('line1\nline2\nline3\n');

        const result = await headFile('/test/file.txt', 2);

        expect(result).toBe('line1\nline2');
      });

      it('returns lines assembled across multiple chunk reads', async () => {
        // 1KB chunk size: a 3KB file forces several reads; the head must
        // still stop exactly at the requested line count.
        const lines = Array.from({ length: 300 }, (_, i) => `line ${String(i + 1).padStart(3, '0')}`);
        const content = lines.join('\n');
        mockFileBytes(content);

        const result = await headFile('/test/file.txt', 2);

        expect(result).toBe('line 001\nline 002');
      });

      it('normalizes CRLF line endings (no dangling \\r on lines)', async () => {
        mockFileBytes('line1\r\nline2\r\nline3\r\n');

        const result = await headFile('/test/file.txt', 2);

        expect(result).toBe('line1\nline2');
      });

      it('rejects and still closes the handle when a read fails', async () => {
        const handle = mockFileBytes('line1\nline2\nline3');
        handle.read.mockRejectedValueOnce(new Error('read failed'));

        await expect(headFile('/test/file.txt', 2)).rejects.toThrow('read failed');
        expect(handle.close).toHaveBeenCalled();
      });
    });
  });

  describe('grepFilesWithValidation', () => {
    beforeEach(() => {
      mockFs.realpath.mockImplementation(async (p: any) => p.toString());
      // Force native fallback deterministically: the availability probe must
      // fail on every path promisify may have bound to. Node's execFile
      // carries a util.promisify.custom implementation that the automock
      // preserves — promisify() returns THAT function directly, bypassing
      // the callback-style mock below. Cover both.
      mockCp.mockImplementation((_cmd: any, _args: any, cb: any) => {
        cb(new Error('ripgrep not found'));
      });
      const customPromisified = mockCp[promisify.custom];
      if (typeof customPromisified?.mockImplementation === 'function') {
        customPromisified.mockImplementation(() =>
          Promise.reject(new Error('ripgrep not found'))
        );
      }
    });

    it('searches a single file when the path points to a file (regression: silent ENOTDIR false negative)', async () => {
      const content = 'const a = 1;\nconst shimValues = { x: 1 };\nconst b = 2;\n';
      mockFs.stat.mockResolvedValue({
        size: content.length,
        isDirectory: () => false,
        isFile: () => true
      } as any);

      // Binary sniff (isBinaryFile reads first 8KB): emulate real fs.read by
      // writing the file bytes INTO the caller-supplied buffer. Returning a
      // separate buffer in the result object would leave the zero-filled
      // buffer untouched, and isBinaryFile would see null bytes → "binary".
      const fileBytes = Buffer.from('ok');
      const mockFileHandle = {
        read: vi.fn(async (buf: Buffer, offset: number, length: number) => {
          fileBytes.copy(buf, offset, 0, Math.min(length, fileBytes.length));
          return { bytesRead: fileBytes.length, buffer: buf };
        }),
        close: vi.fn().mockResolvedValue(undefined)
      } as any;
      mockFs.open.mockResolvedValue(mockFileHandle);

      mockFs.readFile.mockResolvedValue(content);

      const result = await grepFilesWithValidation(
        process.platform === 'win32' ? 'C:\\allowed\\dir\\index.js' : '/allowed/dir/index.js',
        'shimValues',
        process.platform === 'win32' ? ['C:\\allowed'] : ['/allowed']
      );

      expect(result.matches).toHaveLength(1);
      expect(result.matches[0].line).toBe(2);
      expect(result.matches[0].snippet).toContain('shimValues');
      expect(result.truncated).toBe(false);
      expect(result.skippedFiles).toBe(0);
      expect(result.errors).toEqual([]);
    });

    it('returns no matches for a zero-byte file root', async () => {
      mockFs.stat.mockResolvedValue({
        size: 0,
        isDirectory: () => false,
        isFile: () => true
      } as any);

      const result = await grepFilesWithValidation(
        process.platform === 'win32' ? 'C:\\allowed\\dir\\empty.js' : '/allowed/dir/empty.js',
        'anything',
        process.platform === 'win32' ? ['C:\\allowed'] : ['/allowed']
      );

      expect(result.matches).toHaveLength(0);
      expect(result.skippedFiles).toBe(0);
    });

    it('reports a binary file root as skipped with an explanatory error', async () => {
      mockFs.stat.mockResolvedValue({
        size: 100,
        isDirectory: () => false,
        isFile: () => true
      } as any);

      // Binary sniff (isBinaryFile reads first 8KB): file bytes written into
      // the caller-supplied buffer (see mock read semantics above) contain a
      // null byte → reported as binary.
      const binaryBytes = Buffer.from('a\0bc');
      const mockFileHandle = {
        read: vi.fn(async (buf: Buffer, offset: number, length: number) => {
          binaryBytes.copy(buf, offset, 0, Math.min(length, binaryBytes.length));
          return { bytesRead: binaryBytes.length, buffer: buf };
        }),
        close: vi.fn().mockResolvedValue(undefined)
      } as any;
      mockFs.open.mockResolvedValue(mockFileHandle);

      const result = await grepFilesWithValidation(
        process.platform === 'win32' ? 'C:\\allowed\\dir\\blob.bin' : '/allowed/dir/blob.bin',
        'anything',
        process.platform === 'win32' ? ['C:\\allowed'] : ['/allowed']
      );

      expect(result.matches).toHaveLength(0);
      expect(result.skippedFiles).toBe(1);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain('binary');
    });
  });
});
