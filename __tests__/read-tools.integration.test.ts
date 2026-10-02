import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

/**
 * Integration tests for the read_text_file line-selection contract
 * (offset/head/tail) and get_file_info lineCount, driven against the real
 * built server over stdio. These cover the handler in index.ts, which has
 * no unit-test seam (index.ts starts a server on import).
 *
 * Requires dist/ to be built (npm run build) — same requirement as
 * startup-validation.test.ts.
 */
describe('read_text_file paging / tail contract (integration)', () => {
  let client: Client;
  let transport: StdioClientTransport;
  let testDir: string;

  async function readText(args: Record<string, unknown>): Promise<string> {
    const result = (await client.callTool({
      name: 'read_text_file',
      arguments: { path: path.join(testDir, 'file.txt'), ...args },
    })) as { content: Array<{ type: string; text: string }> };
    return result.content[0].text;
  }

  beforeAll(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-read-test-'));

    // 150 lines, no trailing newline
    const lines = Array.from({ length: 150 }, (_, i) => `line ${i + 1}`);
    await fs.writeFile(path.join(testDir, 'file.txt'), lines.join('\n'));

    // Trailing-newline file: three lines
    await fs.writeFile(path.join(testDir, 'trailing.txt'), 'a\nb\nc\n');

    // CRLF file
    await fs.writeFile(path.join(testDir, 'crlf.txt'), 'a\r\nb\r\nc\r\n');

    const serverPath = path.resolve(__dirname, '../dist/index.js');
    transport = new StdioClientTransport({
      command: 'node',
      args: [serverPath, testDir],
    });
    client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
    await client.connect(transport);
  }, 30000);

  afterAll(async () => {
    await client?.close();
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it('pages with offset+head: offset=100, head=50 returns lines 101-150', async () => {
    const text = await readText({ offset: 100, head: 50 });
    const lines = text.split('\n');
    expect(lines).toHaveLength(50);
    expect(lines[0]).toBe('line 101');
    expect(lines[49]).toBe('line 150');
  });

  it('applies offset before tail: offset=10, tail=5 returns the last 5 lines of the remainder', async () => {
    const text = await readText({ offset: 10, tail: 5 });
    const lines = text.split('\n');
    expect(lines).toHaveLength(5);
    expect(lines[0]).toBe('line 146');
    expect(lines[4]).toBe('line 150');
  });

  it('returns empty for offset beyond EOF', async () => {
    expect(await readText({ offset: 500 })).toBe('');
    expect(await readText({ offset: 500, head: 10 })).toBe('');
  });

  it('treats a trailing newline as a line terminator for tail (end-to-end)', async () => {
    const text = await readText({ path: path.join(testDir, 'trailing.txt'), tail: 2 });
    expect(text).toBe('b\nc');
  });

  it('returns LF-normalized text for CRLF files on every read path', async () => {
    const full = await readText({ path: path.join(testDir, 'crlf.txt') });
    expect(full).toBe('a\nb\nc\n');

    const head = await readText({ path: path.join(testDir, 'crlf.txt'), head: 2 });
    expect(head).toBe('a\nb');

    const tail = await readText({ path: path.join(testDir, 'crlf.txt'), tail: 2 });
    expect(tail).toBe('b\nc');

    const paged = await readText({ path: path.join(testDir, 'crlf.txt'), offset: 1, head: 1 });
    expect(paged).toBe('b');
  });

  it('reports lineCount with editor convention in get_file_info', async () => {
    const result = (await client.callTool({
      name: 'get_file_info',
      arguments: { path: path.join(testDir, 'trailing.txt') },
    })) as { content: Array<{ type: string; text: string }> };
    const info = result.content[0].text;
    expect(info).toContain('lineCount: 3');
    expect(info).not.toContain('undefined');
  });

  it('rejects an empty edits array for edit_file (no pointless atomic write)', async () => {
    let rejected = false;
    try {
      const result = await client.callTool({
        name: 'edit_file',
        arguments: { path: path.join(testDir, 'trailing.txt'), edits: [] },
      });
      rejected = (result as { isError?: boolean }).isError === true;
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);

    // The file must be untouched
    const after = await fs.readFile(path.join(testDir, 'trailing.txt'), 'utf-8');
    expect(after).toBe('a\nb\nc\n');
  });

  it.each([
    ['head', 0],
    ['tail', 0],
  ])('rejects %s=0 at schema validation (contradictory: full file via one path, empty via the other)', async (_param, zero) => {
    let rejected = false;
    try {
      const result = await client.callTool({
        name: 'read_text_file',
        arguments: { path: path.join(testDir, 'trailing.txt'), [_param]: zero },
      });
      rejected = (result as { isError?: boolean }).isError === true;
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);

    // The file must be untouched
    const after = await fs.readFile(path.join(testDir, 'trailing.txt'), 'utf-8');
    expect(after).toBe('a\nb\nc\n');
  });
});
