import { describe, it, expect } from 'vitest';
import { applyEditsDetailed } from '../lib.js';

const FILE = '/test/file.txt';

/** Ten distinct lines; zero-padded so no line is a substring of another. */
function lineFile(n: number): string {
  return Array.from({ length: n }, (_, i) => `line ${String(i + 1).padStart(2, '0')}`).join('\n') + '\n';
}

describe('applyEditsDetailed (batch resolver)', () => {
  it('applies 10 disjoint original-anchored edits in a single call', () => {
    const content = lineFile(10);
    const edits = Array.from({ length: 10 }, (_, i) => ({
      oldText: `line ${String(i + 1).padStart(2, '0')}`,
      newText: `edited ${String(i + 1).padStart(2, '0')}`,
    }));

    const result = applyEditsDetailed(content, edits, FILE);

    const expected = Array.from({ length: 10 }, (_, i) => `edited ${String(i + 1).padStart(2, '0')}`).join('\n') + '\n';
    expect(result.content).toBe(expected);
    expect(result.appliedOrigin).toEqual(Array(10).fill('original'));
  });

  it('Bug 2 repro: edit 2 targets the ORIGINAL occurrence, not the copy created by edit 1', () => {
    // Original: an h-line, then a g-block, then the h-block. Edit 1 rewrites
    // the g-block into a copy of the h-block; edit 2 rewrites the h-block.
    // Chained semantics corrupted this by letting edit 2 match the copy.
    const content = [
      'line_h_003',
      'line_g_001',
      'line_g_002',
      'line_g_003',
      'line_g_004',
      'line_g_005',
      'line_h_001',
      'line_h_002',
      'line_h_003',
    ].join('\n') + '\n';

    const edits = [
      {
        oldText: 'line_g_001\nline_g_002\nline_g_003\nline_g_004\nline_g_005',
        newText: 'line_h_001\nline_h_002\nline_h_003',
      },
      {
        oldText: 'line_h_001\nline_h_002\nline_h_003',
        newText: 'MODIFIED_H',
      },
    ];

    const result = applyEditsDetailed(content, edits, FILE);

    const lines = result.content.split('\n');
    // MODIFIED_H lands at the original H position (after the copy), and the
    // copy created by edit 1 stays intact at G's old position.
    expect(lines[0]).toBe('line_h_003');
    expect(lines[1]).toBe('line_h_001');
    expect(lines[2]).toBe('line_h_002');
    expect(lines[3]).toBe('line_h_003');
    expect(lines[4]).toBe('MODIFIED_H');
    expect(result.appliedOrigin).toEqual(['original', 'original']);
  });

  it('applies a chained edit (oldText only exists after an earlier edit) via the fallback pass', () => {
    const content = 'A1\nA2\nA3\n';
    const edits = [
      { oldText: 'A1', newText: 'A1-beta' },
      { oldText: 'A1-beta', newText: 'A1-gamma' },
    ];

    const result = applyEditsDetailed(content, edits, FILE);

    expect(result.content).toBe('A1-gamma\nA2\nA3\n');
    expect(result.appliedOrigin).toEqual(['original', 'chained']);
  });

  it('rejects overlapping original-anchored edits, naming both indexes, and writes nothing', () => {
    const content = 'A1\nA2\nA3\nA4\nA5\nA6\n';
    const edits = [
      { oldText: 'A2\nA3\nA4', newText: 'B' },
      { oldText: 'A3\nA4\nA5', newText: 'C' },
    ];

    expect(() => applyEditsDetailed(content, edits, FILE)).toThrow(
      /EDIT FAILED — NOTHING WAS WRITTEN[\s\S]*edits #1 and #2 target overlapping regions[\s\S]*edit #1: lines 2-4[\s\S]*edit #2: lines 3-5/
    );
  });

  it('rejects an unresolvable edit with an exact first line and per-edit status', () => {
    const content = 'A1\nA2\nA3\n';
    const edits = [
      { oldText: 'A1', newText: 'B1' },
      { oldText: 'missing text', newText: 'X' },
    ];

    try {
      applyEditsDetailed(content, edits, FILE);
      expect.unreachable('expected the batch to be rejected');
    } catch (error) {
      const message = (error as Error).message;
      expect(message.split('\n')[0]).toBe('EDIT FAILED — NOTHING WAS WRITTEN');
      expect(message).toContain('edit #2: not found');
      expect(message).toContain('1 of 2 edits could not be applied');
    }
  });

  it('reports an ambiguous edit with its match lines in the batch failure', () => {
    const content = 'dup\nX\ndup\nY\n';
    const edits = [{ oldText: 'dup', newText: 'Z' }];

    try {
      applyEditsDetailed(content, edits, FILE);
      expect.unreachable('expected the batch to be rejected');
    } catch (error) {
      const message = (error as Error).message;
      expect(message.split('\n')[0]).toBe('EDIT FAILED — NOTHING WAS WRITTEN');
      expect(message).toContain('edit #1: ambiguous — matches lines 1, 3 (1-based)');
    }
  });

  it('fixpoint: an edit ambiguous in the original becomes applicable after another edit removes the duplicate', () => {
    const content = 'dup\nX\ndup\nY\n';
    const edits = [
      { oldText: 'dup\nX', newText: 'kept' },
      { oldText: 'dup', newText: 'Z' },
    ];

    const result = applyEditsDetailed(content, edits, FILE);

    expect(result.content).toBe('kept\nZ\nY\n');
    expect(result.appliedOrigin).toEqual(['original', 'chained']);
  });

  it('chained pass is strict: an edit that would be context-resolvable in the working copy stays unresolved', () => {
    // Edit 1 creates the repeated-Q content; edit 2 targets 'Q', which in the
    // working copy has 4 occurrences, one of which context expansion could
    // uniquely identify. Strict chained matching must NOT use that escape
    // hatch — the edit stays unresolved and the batch is rejected.
    const content = 'ORIGINAL_BLOCK\n';
    const edits = [
      {
        oldText: 'ORIGINAL_BLOCK',
        newText: 'K\nQ\nK\nQ\nK\nQ\nK\nM\nQ\nN',
      },
      { oldText: 'Q', newText: 'QX' },
    ];

    expect(() => applyEditsDetailed(content, edits, FILE)).toThrow(
      /EDIT FAILED — NOTHING WAS WRITTEN[\s\S]*edit #2: ambiguous/
    );
  });

  it('returns content unchanged for an empty edits array', () => {
    const content = 'A1\nA2\n';
    const result = applyEditsDetailed(content, [], FILE);
    expect(result.content).toBe(content);
    expect(result.appliedOrigin).toEqual([]);
  });

  it('rejects an edit with empty oldText as not-found', () => {
    const content = 'A1\nA2\n';
    const edits = [{ oldText: '', newText: 'X' }];

    expect(() => applyEditsDetailed(content, edits, FILE)).toThrow(
      /EDIT FAILED — NOTHING WAS WRITTEN[\s\S]*edit #1: not found/
    );
  });

  it('includes the dependency hint as a note line when provided', () => {
    const content = 'A1\nA2\n';
    const edits = [{ oldText: 'missing', newText: 'X' }];

    expect(() =>
      applyEditsDetailed(content, edits, FILE, { dependencyHint: 'depends on another call' })
    ).toThrow(/EDIT FAILED — NOTHING WAS WRITTEN[\s\S]*note: depends on another call/);
  });
});
