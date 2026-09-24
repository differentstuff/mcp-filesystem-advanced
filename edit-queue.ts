import fs from 'fs/promises';
import path from 'path';
import { randomBytes } from 'crypto';
import { diffLines } from 'diff';
import { normalizePath } from './path-utils.js';
import {
  applyEditsToContent,
  formatEditDiff,
  normalizeLineEndings,
  tryAcquireSubstrate,
  releaseSubstrate,
  type FileEdit,
  type OperationInfo,
} from './lib.js';

// ============================================================================
// Per-file batch queue for edit_file
// ============================================================================
// Parallel edit_file calls to the same file are serialized and merged here:
// the first concurrent call for a path opens a batch with a shared base
// snapshot; calls arriving while the window is open join it. Every call's net
// changes are recorded as line spans on the base; spans must be pairwise
// disjoint across calls. At flush, all accepted spans are spliced into the
// base (git-style, back-to-front) and stored in a single atomic write.
//
// Correctness never depends on coalescing: a call that misses the window
// simply forms the next batch and re-anchors on the fresh content.

/** How long the batch window stays open for new submissions (ms). */
export const EDIT_BATCH_WINDOW_MS = 10;

/**
 * A line span of net changes on the base content.
 */
interface ContentSpan {
  /** 0-based first base line covered by the change (inclusive). */
  baseStartLine: number;
  /** 0-based line after the last base line covered by the change (exclusive). */
  baseEndLine: number;
  /** Replacement lines spliced in place of baseLines[baseStartLine..baseEndLine). */
  newLines: string[];
  /** Whether the replacement's last line was followed by a newline. */
  endsWithNewline: boolean;
}

/**
 * A queued edit call together with its promise settlement functions.
 */
interface RegisteredCall {
  edits: FileEdit[];
  resolve: (diff: string) => void;
  reject: (error: Error) => void;
}

/**
 * An accepted call with its computed spans and result diff.
 */
interface AcceptedCall {
  call: RegisteredCall;
  spans: ContentSpan[];
  diff: string;
  /** First oldText line snippet, used in EDIT_CONFLICT messages. */
  snippet: string;
}

/**
 * Per-path batch state machine: loading → open (accepting joins) → flushing.
 */
interface ActiveBatch {
  filePath: string;
  base: string;
  baseLines: string[];
  baseStat: { mtimeMs: number; size: number };
  accepted: AcceptedCall[];
  timer: ReturnType<typeof setTimeout> | null;
  loading: Promise<void>;
  loadError?: unknown;
  flushing: boolean;
  finalized: boolean;
  flushPromise: Promise<void>;
  substrateOp: OperationInfo;
}

/** Open batch per resolved file path. */
const batches = new Map<string, ActiveBatch>();

/**
 * Map key for a file path, consistent with the substrate tracker's
 * normalization.
 */
function batchKey(filePath: string): string {
  return normalizePath(path.resolve(filePath));
}

/**
 * First non-empty line of oldText, trimmed and capped, for error messages.
 */
function firstLineSnippet(oldText: string): string {
  const first = oldText.split('\n').find(l => l.trim().length > 0) ?? oldText;
  return first.trim().substring(0, 60);
}

/**
 * Splits a diff replacement value into the line-array convention used for
 * splicing: a trailing newline becomes the separator to the next base line,
 * not an extra empty element.
 */
function splitReplacementLines(value: string): string[] {
  const lines = value.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

/**
 * Computes the net line spans a call's result covers on the base content,
 * using a line diff. Spans are disjoint and sorted ascending by construction.
 * Overlapping changes within one call are unioned by the diff itself.
 */
function computeSpans(base: string, result: string): ContentSpan[] {
  const parts = diffLines(base, result);
  const spans: ContentSpan[] = [];
  let baseLine = 0;
  let i = 0;
  while (i < parts.length) {
    const part = parts[i];
    if (part.added) {
      // Pure insertion at the current base line (zero-width span).
      spans.push({
        baseStartLine: baseLine,
        baseEndLine: baseLine,
        newLines: splitReplacementLines(part.value),
        endsWithNewline: part.value.endsWith('\n'),
      });
      i++;
      continue;
    }
    if (part.removed) {
      const start = baseLine;
      const removedCount = part.count ?? 0;
      baseLine += removedCount;
      const newLines: string[] = [];
      let endsWithNewline = false;
      let j = i + 1;
      while (j < parts.length && parts[j].added) {
        newLines.push(...splitReplacementLines(parts[j].value));
        endsWithNewline = parts[j].value.endsWith('\n');
        j++;
      }
      spans.push({ baseStartLine: start, baseEndLine: start + removedCount, newLines, endsWithNewline });
      i = j;
      continue;
    }
    baseLine += part.count ?? 0;
    i++;
  }
  return spans;
}

/**
 * Two spans conflict when their base line ranges intersect. Zero-width
 * insertions conflict only when they land strictly inside another span.
 */
function spansOverlap(a: ContentSpan, b: ContentSpan): boolean {
  return a.baseStartLine < b.baseEndLine && b.baseStartLine < a.baseEndLine;
}

/**
 * Human-readable overall footprint of a call's spans (1-based line range).
 */
function describeSpans(spans: ContentSpan[]): string {
  const start = Math.min(...spans.map(s => s.baseStartLine));
  const end = Math.max(...spans.map(s => s.baseEndLine));
  return `lines ${start + 1}-${end}`;
}

/**
 * Structured EDIT_CONFLICT error naming both clashing edits' spans and
 * oldText snippets.
 */
function conflictError(
  filePath: string,
  call: RegisteredCall,
  spans: ContentSpan[],
  other: AcceptedCall
): Error {
  return new Error(
    `EDIT_CONFLICT\n` +
    `  file: ${filePath}\n` +
    `  reason: this edit overlaps an earlier concurrent edit to the same file\n` +
    `  this_edit: ${describeSpans(spans)} (1-based): "${firstLineSnippet(call.edits[0]?.oldText ?? '')}"\n` +
    `  conflicting_edit: ${describeSpans(other.spans)} (1-based): "${other.snippet}"\n` +
    `  next_step: Re-read the file after the concurrent edits are stored, then retry with fresh oldText\n` +
    `  no changes were written for this edit`
  );
}

/**
 * Error for the staleness guard: the file changed externally between the
 * base read and the flush.
 */
function externalChangeError(batch: ActiveBatch): Error {
  return new Error(
    `EDIT_FAILED\n` +
    `  file: ${batch.filePath}\n` +
    `  reason: file_changed_externally — the file was modified outside this edit batch between read and write\n` +
    `  next_step: Re-read the file and retry the edits against the current content\n` +
    `  no changes were written`
  );
}

/**
 * Creates a new batch for the path: acquires the 'write' substrate for the
 * window and starts the shared base read (content + mtime/size capture).
 * Throws the substrate conflict error if a conflicting operation is active.
 */
function createBatch(filePath: string): ActiveBatch {
  const acquire = tryAcquireSubstrate(filePath, 'write');
  if (!acquire.success) {
    const conflict = acquire.conflict!;
    throw new Error(
      `Operation conflict: Path "${filePath}" is currently being ${conflict.type}ed ` +
      `(started ${Math.round((Date.now() - conflict.startTime) / 1000)}s ago). ` +
      `Please wait and retry, or use a different path.`
    );
  }

  const batch: ActiveBatch = {
    filePath,
    base: '',
    baseLines: [],
    baseStat: { mtimeMs: 0, size: 0 },
    accepted: [],
    timer: null,
    loading: Promise.resolve(),
    loadError: undefined,
    flushing: false,
    finalized: false,
    flushPromise: Promise.resolve(),
    substrateOp: acquire.acquired!,
  };

  batch.loading = (async () => {
    try {
      const [content, stat] = await Promise.all([
        fs.readFile(filePath, 'utf-8'),
        fs.stat(filePath),
      ]);
      batch.base = normalizeLineEndings(content);
      batch.baseLines = batch.base.split('\n');
      batch.baseStat = { mtimeMs: stat.mtimeMs, size: stat.size };
    } catch (error) {
      batch.loadError = error;
    }
  })();

  scheduleFlush(batch);
  return batch;
}

/**
 * (Re)schedules the batch window's debounce flush timer.
 */
function scheduleFlush(batch: ActiveBatch): void {
  if (batch.timer !== null) {
    clearTimeout(batch.timer);
  }
  batch.timer = setTimeout(() => {
    batch.timer = null;
    void flushBatch(batch);
  }, EDIT_BATCH_WINDOW_MS);
}

/**
 * Releases the substrate and removes the batch record exactly once.
 */
function finalizeBatch(batch: ActiveBatch): void {
  if (batch.finalized) return;
  batch.finalized = true;
  releaseSubstrate(batch.substrateOp);
  batches.delete(batchKey(batch.filePath));
}

/**
 * Rejects all accepted calls with the given error (used when the whole batch
 * fails: load error, external change, or write error). Calls that failed at
 * join time were already rejected individually.
 */
function settleAllCalls(batch: ActiveBatch, error: unknown): void {
  const err = error instanceof Error ? error : new Error(String(error));
  for (const accepted of batch.accepted) {
    accepted.call.reject(err);
  }
  batch.accepted = [];
}

/**
 * Merges all accepted spans into the base lines: sort by start line
 * descending and splice back-to-front so earlier splices never shift later
 * spans.
 */
function mergeSpans(batch: ActiveBatch): string {
  const out = [...batch.baseLines];
  const originalLength = batch.baseLines.length;
  const spans = batch.accepted
    .flatMap(accepted => accepted.spans)
    .sort((a, b) => b.baseStartLine - a.baseStartLine);
  for (const span of spans) {
    out.splice(span.baseStartLine, span.baseEndLine - span.baseStartLine, ...span.newLines);
    // Preserve a trailing newline when the change reaches EOF and the
    // replacement itself ended with one (the base had no final '' element).
    if (span.baseEndLine === originalLength && span.endsWithNewline) {
      out.push('');
    }
  }
  return out.join('\n');
}

/**
 * Flushes the batch: staleness guard, single atomic write (temp + rename),
 * then settles every accepted call with its own diff. Always releases the
 * substrate and deletes the batch record.
 */
async function flushBatch(batch: ActiveBatch): Promise<void> {
  if (batch.flushing || batch.finalized) return;
  batch.flushing = true;
  batch.flushPromise = (async () => {
    try {
      await batch.loading;

      if (batch.loadError !== undefined) {
        settleAllCalls(batch, batch.loadError);
        return;
      }

      if (batch.accepted.length > 0) {
        // Staleness guard: never clobber external modifications that landed
        // between the base read and this flush.
        const stat = await fs.stat(batch.filePath);
        if (stat.mtimeMs !== batch.baseStat.mtimeMs || stat.size !== batch.baseStat.size) {
          settleAllCalls(batch, externalChangeError(batch));
          return;
        }

        const merged = mergeSpans(batch);
        // Security: atomic rename, same pattern as applyFileEdits — replaces
        // the target atomically and does not follow symlinks.
        const tempPath = `${batch.filePath}.${randomBytes(16).toString('hex')}.tmp`;
        try {
          await fs.writeFile(tempPath, merged, 'utf-8');
          await fs.rename(tempPath, batch.filePath);
        } catch (error) {
          try {
            await fs.unlink(tempPath);
          } catch {}
          settleAllCalls(batch, error);
          return;
        }

        for (const accepted of batch.accepted) {
          accepted.call.resolve(accepted.diff);
        }
      }
    } finally {
      finalizeBatch(batch);
    }
  })();
  await batch.flushPromise;
}

/**
 * Registers one call with an open batch once the base is loaded: applies the
 * call's edits sequentially against the base (chaining preserved), computes
 * its net spans, checks for conflicts against already-accepted calls in
 * registration order, and either accepts the call (rescheduling the flush
 * timer) or rejects it with a structured error. A failed call never aborts
 * the batch.
 */
async function registerCall(batch: ActiveBatch, call: RegisteredCall): Promise<void> {
  try {
    await batch.loading;

    // Lost a race with the flush (base load took longer than the window):
    // chain into a fresh batch against the current content.
    if (batch.finalized) {
      enqueueEdits(batch.filePath, call.edits, false).then(call.resolve, call.reject);
      return;
    }

    if (batch.loadError !== undefined) {
      const error = batch.loadError instanceof Error
        ? batch.loadError
        : new Error(String(batch.loadError));
      settleAllCalls(batch, error);
      finalizeBatch(batch);
      call.reject(error);
      return;
    }

    // Apply the call's edits sequentially against the shared base snapshot.
    let finalContent: string;
    try {
      const dependencyHint = batch.accepted.length > 0
        ? 'oldText may depend on another concurrent edit to this file — retry after the batch is stored'
        : undefined;
      finalContent = applyEditsToContent(batch.base, call.edits, batch.filePath, { dependencyHint });
    } catch (error) {
      call.reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    const spans = computeSpans(batch.base, finalContent);

    // Conflict check in registration order (first-come-first-served).
    for (const accepted of batch.accepted) {
      for (const existing of accepted.spans) {
        for (const span of spans) {
          if (spansOverlap(existing, span)) {
            call.reject(conflictError(batch.filePath, call, spans, accepted));
            return;
          }
        }
      }
    }

    const diff = formatEditDiff(batch.base, finalContent, batch.filePath);
    batch.accepted.push({
      call,
      spans,
      diff,
      snippet: firstLineSnippet(call.edits[0]?.oldText ?? ''),
    });

    scheduleFlush(batch);
  } catch (error) {
    // A thrown bug in one call must fail only that call, never the batch.
    call.reject(error instanceof Error ? error : new Error(String(error)));
  }
}

/**
 * Entry point for edit_file. Queues a concurrent edit against the per-file
 * batch: resolves with the call's own unified diff, or rejects with a
 * structured EDIT_CONFLICT / EDIT_FAILED error.
 *
 * dryRun bypasses the queue entirely: it reads fresh content, runs the
 * sequential logic with the hardened matcher, and writes nothing.
 */
export async function enqueueEdits(
  filePath: string,
  edits: FileEdit[],
  dryRun: boolean = false
): Promise<string> {
  if (dryRun) {
    const content = normalizeLineEndings(await fs.readFile(filePath, 'utf-8'));
    const modifiedContent = applyEditsToContent(content, edits, filePath);
    return formatEditDiff(content, modifiedContent, filePath);
  }

  const key = batchKey(filePath);
  let batch = batches.get(key);

  if (batch && batch.flushing) {
    // Window already closing: wait for the flush, then re-anchor on the
    // fresh content in a new batch.
    await batch.flushPromise;
    batch = batches.get(key);
  }

  if (!batch) {
    batch = createBatch(filePath);
    batches.set(key, batch);
  }

  return new Promise<string>((resolve, reject) => {
    const call: RegisteredCall = { edits, resolve, reject };
    void registerCall(batch!, call);
  });
}
