import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import { enqueueEdits } from '../edit-queue.js';
import { writeFileContent, setAllowedDirectories } from '../lib.js';

// Mock fs at the module boundary (edit-queue.ts and lib.ts both import it)
vi.mock('fs/promises');
const mockFs = fs as any;

/** Ten distinct lines; zero-padded so no line is a substring of another. */
function lineFile(n: number): string {
  return Array.from({ length: n }, (_, i) => `line ${String(i + 1).padStart(2, '0')}`).join('\n') + '\n';
}

const FILE_PATH = '/test/file.txt';

describe('edit-queue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const allowedDirs = process.platform === 'win32'
      ? ['C:\\Users\\test', 'C:\\temp', 'C:\\allowed']
      : ['/home/user', '/tmp', '/allowed'];
    setAllowedDirectories(allowedDirs);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setAllowedDirectories([]);
  });

  describe('parallel disjoint edits', () => {
    it('merges 10 parallel disjoint edits into a single atomic write', async () => {
      const content = lineFile(10);
      mockFs.readFile.mockResolvedValue(content);
      mockFs.stat.mockResolvedValue({ mtimeMs: 1000, size: content.length });
      mockFs.writeFile.mockResolvedValue(undefined);
      mockFs.rename.mockResolvedValue(undefined);

      const calls = Array.from({ length: 10 }, (_, i) =>
        enqueueEdits(FILE_PATH, [{ oldText: `line ${String(i + 1).padStart(2, '0')}`, newText: `edited ${String(i + 1).padStart(2, '0')}` }], false)
      );
      const results = await Promise.all(calls);

      expect(results).toHaveLength(10);
      for (const result of results) {
        expect(result).toContain('diff');
      }

      // Exactly one atomic write (temp + rename) for the whole batch window
      expect(mockFs.writeFile).toHaveBeenCalledTimes(1);
      expect(mockFs.rename).toHaveBeenCalledTimes(1);

      const written = mockFs.writeFile.mock.calls[0][1] as string;
      for (let i = 1; i <= 10; i++) {
        expect(written).toContain(`edited ${String(i).padStart(2, '0')}`);
      }
      expect(written).not.toContain('line ');
    });

    it('applies two sequential calls as separate batches against fresh content', async () => {
      let currentContent = lineFile(3);
      let lastWritten = '';
      mockFs.readFile.mockImplementation(async () => currentContent);
      mockFs.stat.mockResolvedValue({ mtimeMs: 1000, size: currentContent.length });
      mockFs.writeFile.mockImplementation(async (_p: unknown, c: string) => { lastWritten = c; });
      mockFs.rename.mockImplementation(async () => { currentContent = lastWritten; });

      await enqueueEdits(FILE_PATH, [{ oldText: 'line 01', newText: 'beta' }], false);
      await enqueueEdits(FILE_PATH, [{ oldText: 'beta', newText: 'gamma' }], false);

      expect(currentContent).toBe('gamma\nline 02\nline 03\n');
      expect(mockFs.writeFile).toHaveBeenCalledTimes(2);
    });
  });

  describe('overlapping parallel edits', () => {
    it('rejects the later call with EDIT_CONFLICT naming both spans and stores only the earlier edit', async () => {
      const content = 'A1\nA2\nA3\nA4\nA5\nA6\n';
      mockFs.readFile.mockResolvedValue(content);
      mockFs.stat.mockResolvedValue({ mtimeMs: 1000, size: content.length });
      mockFs.writeFile.mockResolvedValue(undefined);
      mockFs.rename.mockResolvedValue(undefined);

      const first = enqueueEdits(FILE_PATH, [{ oldText: 'A2\nA3\nA4', newText: 'B' }], false);
      const second = enqueueEdits(FILE_PATH, [{ oldText: 'A3\nA4\nA5', newText: 'C' }], false);

      // Call 1 covers lines 2-4, call 2 covers lines 3-5 → overlap.
      // Attach the rejection expectation first: the conflict is decided at
      // join time, before the sibling promise is awaited.
      const secondExpect = expect(second).rejects.toThrow(/EDIT_CONFLICT[\s\S]*lines 3-5[\s\S]*lines 2-4/);
      await expect(first).resolves.toContain('diff');
      await secondExpect;

      expect(mockFs.writeFile).toHaveBeenCalledTimes(1);
      const written = mockFs.writeFile.mock.calls[0][1] as string;
      expect(written).toBe('A1\nB\nA5\nA6\n');
    });
  });

  describe('dependency on a concurrent edit', () => {
    it('fails the dependent call with a dependency hint and still stores the other call', async () => {
      const content = 'A1\nA2\nA3\nA4\nA5\n';
      mockFs.readFile.mockResolvedValue(content);
      mockFs.stat.mockResolvedValue({ mtimeMs: 1000, size: content.length });
      mockFs.writeFile.mockResolvedValue(undefined);
      mockFs.rename.mockResolvedValue(undefined);

      const first = enqueueEdits(FILE_PATH, [{ oldText: 'A2', newText: 'A2-changed' }], false);
      // oldText only exists after the first call's edit is applied
      const second = enqueueEdits(FILE_PATH, [{ oldText: 'A2-changed', newText: 'A2-final' }], false);

      // Attach the rejection expectation first: the dependent call fails at
      // join time, before the sibling promise is awaited.
      const secondExpect = expect(second).rejects.toThrow(/EDIT_FAILED[\s\S]*not found[\s\S]*concurrent edit/);
      await expect(first).resolves.toContain('diff');
      await secondExpect;

      expect(mockFs.writeFile).toHaveBeenCalledTimes(1);
      const written = mockFs.writeFile.mock.calls[0][1] as string;
      expect(written).toBe('A1\nA2-changed\nA3\nA4\nA5\n');
    });
  });

  describe('ambiguous oldText', () => {
    it('rejects the call with the match count and all match lines and writes nothing', async () => {
      const content = 'dup\nX\ndup\nY\n';
      mockFs.readFile.mockResolvedValue(content);
      mockFs.stat.mockResolvedValue({ mtimeMs: 1000, size: content.length });
      mockFs.writeFile.mockResolvedValue(undefined);
      mockFs.rename.mockResolvedValue(undefined);

      await expect(enqueueEdits(FILE_PATH, [{ oldText: 'dup', newText: 'Z' }], false))
        .rejects.toThrow(/EDIT_FAILED[\s\S]*ambiguous[\s\S]*2 locations[\s\S]*match_lines: 1, 3/);

      expect(mockFs.writeFile).not.toHaveBeenCalled();
    });
  });

  describe('write_file during an open batch window', () => {
    it('gives write_file the existing conflict error and leaves the batch unaffected', async () => {
      const filePath = process.platform === 'win32' ? 'C:\\allowed\\file.txt' : '/allowed/file.txt';
      const content = 'A1\nA2\nA3\n';
      mockFs.readFile.mockResolvedValue(content);
      mockFs.stat.mockResolvedValue({ mtimeMs: 1000, size: content.length, isDirectory: () => true });
      mockFs.realpath.mockImplementation(async (p: any) => p.toString());
      mockFs.writeFile.mockResolvedValue(undefined);
      mockFs.rename.mockResolvedValue(undefined);

      const batchCall = enqueueEdits(filePath, [{ oldText: 'A2', newText: 'B2' }], false);

      // The batch holds the 'write' substrate for its window
      await expect(writeFileContent(filePath, 'clobber')).rejects.toThrow('Operation conflict');

      await expect(batchCall).resolves.toContain('diff');
      expect(mockFs.writeFile).toHaveBeenCalledTimes(1);
    });
  });

  describe('external modification (staleness guard)', () => {
    it('fails the whole batch loudly and writes nothing when the file changed externally', async () => {
      const content = 'A1\nA2\nA3\n';
      mockFs.readFile.mockResolvedValue(content);
      mockFs.stat
        .mockResolvedValueOnce({ mtimeMs: 1000, size: content.length })
        .mockResolvedValueOnce({ mtimeMs: 2000, size: content.length });
      mockFs.writeFile.mockResolvedValue(undefined);
      mockFs.rename.mockResolvedValue(undefined);

      await expect(enqueueEdits(FILE_PATH, [{ oldText: 'A1', newText: 'B1' }], false))
        .rejects.toThrow('file_changed_externally');

      expect(mockFs.writeFile).not.toHaveBeenCalled();
    });

    it('releases the substrate after a failed flush so later writes succeed', async () => {
      const filePath = process.platform === 'win32' ? 'C:\\allowed\\file.txt' : '/allowed/file.txt';
      const content = 'A1\nA2\nA3\n';
      mockFs.readFile.mockResolvedValue(content);
      mockFs.stat
        .mockResolvedValueOnce({ mtimeMs: 1000, size: content.length })
        .mockResolvedValueOnce({ mtimeMs: 2000, size: content.length })
        .mockResolvedValue({ mtimeMs: 3000, size: 5, isDirectory: () => true });
      mockFs.realpath.mockImplementation(async (p: any) => p.toString());
      mockFs.writeFile.mockResolvedValue(undefined);
      mockFs.rename.mockResolvedValue(undefined);

      await expect(enqueueEdits(filePath, [{ oldText: 'A1', newText: 'B1' }], false))
        .rejects.toThrow('file_changed_externally');

      // The batch's 'write' substrate was released in the flush's finally block
      await expect(writeFileContent(filePath, 'fresh')).resolves.toBeTruthy();
    });
  });

  describe('chained edits within a single call', () => {
    it('lets edit 2 reference text produced by edit 1', async () => {
      const content = 'A1\nA2\nA3\n';
      mockFs.readFile.mockResolvedValue(content);
      mockFs.stat.mockResolvedValue({ mtimeMs: 1000, size: content.length });
      mockFs.writeFile.mockResolvedValue(undefined);
      mockFs.rename.mockResolvedValue(undefined);

      await enqueueEdits(FILE_PATH, [
        { oldText: 'A1', newText: 'A1-beta' },
        { oldText: 'A1-beta', newText: 'A1-gamma' },
      ], false);

      expect(mockFs.writeFile).toHaveBeenCalledTimes(1);
      const written = mockFs.writeFile.mock.calls[0][1] as string;
      expect(written).toBe('A1-gamma\nA2\nA3\n');
    });
  });

  describe('dryRun', () => {
    it('previews the diff without queue participation and without writing', async () => {
      const content = 'A1\nA2\nA3\n';
      mockFs.readFile.mockResolvedValue(content);
      mockFs.writeFile.mockResolvedValue(undefined);

      const result = await enqueueEdits(FILE_PATH, [{ oldText: 'A2', newText: 'B2' }], true);

      expect(result).toContain('diff');
      expect(result).toContain('+B2');
      expect(mockFs.writeFile).not.toHaveBeenCalled();
      expect(mockFs.rename).not.toHaveBeenCalled();
      // No stat call: the queue (base snapshot + staleness guard) was bypassed
      expect(mockFs.stat).not.toHaveBeenCalled();
    });
  });
});
