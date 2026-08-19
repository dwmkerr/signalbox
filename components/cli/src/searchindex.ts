import { Database } from "bun:sqlite";
import { mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { stateDir } from "./client";
import {
  discoverTranscripts,
  parseTurns,
  type TranscriptFile,
} from "./transcripts";

const schemaVersion = 1;
const indexFilename = "search.db";

const createFiles = `
CREATE TABLE files (
  path        TEXT PRIMARY KEY,
  agent       TEXT NOT NULL,
  session_uuid TEXT NOT NULL,
  cwd         TEXT,
  mtime_ms    INTEGER NOT NULL,
  size        INTEGER NOT NULL,
  byte_offset INTEGER NOT NULL,
  indexed_ts  TEXT NOT NULL
);`;

const createTurns = `
CREATE TABLE turns (
  id           INTEGER PRIMARY KEY,
  path         TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
  session_uuid TEXT NOT NULL,
  agent        TEXT NOT NULL,
  cwd          TEXT,
  role         TEXT NOT NULL,   -- "user" | "assistant"
  ts           TEXT,            -- RFC3339 when the line carried one
  text         TEXT NOT NULL
);`;

const createTurnsBySession = "CREATE INDEX turns_by_session ON turns(session_uuid);";
const createTurnsByPath = "CREATE INDEX turns_by_path ON turns(path);";
const createTurnsFts = `
CREATE VIRTUAL TABLE turns_fts USING fts5(
  text,
  content='turns',
  content_rowid='id',
  tokenize="unicode61 remove_diacritics 2",
  prefix='2 3'
);`;

interface FileRow {
  path: string;
  agent: string;
  session_uuid: string;
  cwd: string | null;
  mtime_ms: number;
  size: number;
  byte_offset: number;
  indexed_ts: string;
}

interface FileSnapshot {
  file: TranscriptFile;
  mtimeMs: number;
  size: number;
  row?: FileRow;
}

interface BatchResult {
  turnsAdded: number;
  incomplete: boolean;
}

/** Limits one sweep to a small slice of the hub's event loop. */
export interface SweepOptions {
  /** Maximum wall-clock time available before another transcript batch may start. */
  budgetMs: number;
}

/** Describes the durable work completed by one bounded index sweep. */
export interface SweepSummary {
  /** Number of discovered transcript files whose current metadata was inspected. */
  filesScanned: number;
  /** Number of transcript file records inserted, advanced, rebuilt, or removed. */
  filesUpdated: number;
  /** Number of new turn rows committed to both the content and FTS tables. */
  turnsAdded: number;
  /** Whether another sweep has transcript or deletion work available. */
  workRemains: boolean;
}

/** Reports persisted index progress for CLI and Settings surfaces. */
export interface IndexStatus {
  /** Number of transcript files currently recorded in the index. */
  filesKnown: number;
  /** Number of discovered, incomplete, changed, or vanished files needing work. */
  filesPending: number;
  /** Number of user and assistant turns currently indexed. */
  turnsIndexed: number;
  /** Most recent committed indexing timestamp, or null before the first commit. */
  lastSweepTime: string | null;
  /** Whether discovered corpus content remains to be indexed for the initial build. */
  firstBuildInProgress: boolean;
  /** Bytes occupied by the database and its durable WAL contents on disk. */
  indexSizeBytes: number;
}

/** Owns one SQLite connection to the local transcript search index. */
export interface SearchIndex {
  /** Commits bounded transcript progress without holding work for a later transaction. */
  sweep(opts: SweepOptions): SweepSummary;
  /** Reads current durable counts and compares them with the local transcript corpus. */
  status(): IndexStatus;
  /** Releases this process's SQLite connection while leaving the index intact. */
  close(): void;
}

function readUserVersion(db: Database): number {
  return db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
}

function createSchema(db: Database): void {
  const objects = db.query<{ count: number }, []>(`
    SELECT count(*) AS count
    FROM sqlite_schema
    WHERE name NOT LIKE 'sqlite_%'
  `).get()?.count ?? 0;
  if (objects !== 0) {
    throw new Error("search index has schema objects but no supported schema version");
  }

  db.transaction(() => {
    db.run(createFiles);
    db.run(createTurns);
    db.run(createTurnsBySession);
    db.run(createTurnsByPath);
    db.run(createTurnsFts);
    db.run(`PRAGMA user_version = ${schemaVersion}`);
  })();
}

function fileRows(db: Database): FileRow[] {
  return db.query<FileRow, []>(`
    SELECT path, agent, session_uuid, cwd, mtime_ms, size, byte_offset, indexed_ts
    FROM files
    ORDER BY path
  `).all();
}

function snapshot(file: TranscriptFile, row?: FileRow): FileSnapshot | undefined {
  try {
    const stats = statSync(file.path);
    if (!stats.isFile()) return undefined;
    return {
      file,
      mtimeMs: Math.trunc(stats.mtimeMs),
      size: stats.size,
      row,
    };
  } catch {
    return undefined;
  }
}

function needsIndexing(item: FileSnapshot): boolean {
  const row = item.row;
  return row === undefined
    || row.mtime_ms !== item.mtimeMs
    || row.size !== item.size
    || row.byte_offset < item.size;
}

class SqliteSearchIndex implements SearchIndex {
  constructor(
    private readonly db: Database,
    private readonly indexPath: string,
  ) {}

  private removeFile(path: string): void {
    this.db.transaction(() => {
      // FTS external-content rows need explicit removal before the content
      // rows disappear through the foreign-key cascade.
      this.db.query<never, [string]>(`
        DELETE FROM turns_fts
        WHERE rowid IN (SELECT id FROM turns WHERE path = ?)
      `).run(path);
      this.db.query<never, [string]>("DELETE FROM files WHERE path = ?").run(path);
    })();
  }

  private indexBatch(item: FileSnapshot): BatchResult {
    const existing = item.row;
    const fromOffset = existing && item.size >= existing.size ? existing.byte_offset : 0;
    const rebuild = existing !== undefined && item.size < existing.size;
    const parsed = parseTurns(item.file.path, item.file.agent, fromOffset);
    const sessionUuid = parsed.sessionUuid ?? existing?.session_uuid ?? item.file.sessionUuid;
    const cwd = parsed.cwd ?? existing?.cwd ?? item.file.cwd ?? null;
    const indexedTs = new Date().toISOString();

    this.db.transaction(() => {
      if (rebuild) {
        // FTS cannot infer deletions after its external content has gone.
        this.db.query<never, [string]>(`
          DELETE FROM turns_fts
          WHERE rowid IN (SELECT id FROM turns WHERE path = ?)
        `).run(item.file.path);
        this.db.query<never, [string]>("DELETE FROM turns WHERE path = ?").run(item.file.path);
      }

      this.db.query<never, [string, string, string, string | null, number, number, number, string]>(`
        INSERT INTO files (
          path, agent, session_uuid, cwd, mtime_ms, size, byte_offset, indexed_ts
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(path) DO UPDATE SET
          agent = excluded.agent,
          session_uuid = excluded.session_uuid,
          cwd = excluded.cwd,
          mtime_ms = excluded.mtime_ms,
          size = excluded.size,
          byte_offset = excluded.byte_offset,
          indexed_ts = excluded.indexed_ts
      `).run(
        item.file.path,
        item.file.agent,
        sessionUuid,
        cwd,
        item.mtimeMs,
        Math.max(item.size, parsed.endOffset),
        parsed.endOffset,
        indexedTs,
      );

      for (const turn of parsed.turns) {
        const inserted = this.db.query<never, [string, string, string, string | null, string, string | null, string]>(`
          INSERT INTO turns (path, session_uuid, agent, cwd, role, ts, text)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          item.file.path,
          sessionUuid,
          item.file.agent,
          cwd,
          turn.role,
          turn.ts ?? null,
          turn.text,
        );
        this.db.query<never, [number | bigint, string]>(`
          INSERT INTO turns_fts(rowid, text) VALUES (?, ?)
        `).run(inserted.lastInsertRowid, turn.text);
      }
    })();

    return {
      turnsAdded: parsed.turns.length,
      incomplete: parsed.endOffset < item.size,
    };
  }

  sweep(opts: SweepOptions): SweepSummary {
    if (!Number.isFinite(opts.budgetMs) || opts.budgetMs < 0) {
      throw new RangeError("budgetMs must be a finite non-negative number");
    }

    const started = performance.now();
    const deadline = started + opts.budgetMs;
    const discovered = discoverTranscripts();
    const rows = fileRows(this.db);
    const rowsByPath = new Map(rows.map((row) => [row.path, row]));
    const snapshots = discovered
      .map((file) => snapshot(file, rowsByPath.get(file.path)))
      .filter((item): item is FileSnapshot => item !== undefined);
    const availablePaths = new Set(snapshots.map((item) => item.file.path));
    const vanished = rows.filter((row) => !availablePaths.has(row.path));
    const pending = snapshots.filter(needsIndexing);

    let filesUpdated = 0;
    let turnsAdded = 0;
    let remaining = vanished.length + pending.length;

    for (const row of vanished) {
      if (performance.now() >= deadline) break;
      this.removeFile(row.path);
      filesUpdated++;
      remaining--;
    }

    if (remaining === pending.length) {
      for (const item of pending) {
        if (performance.now() >= deadline) break;
        const result = this.indexBatch(item);
        turnsAdded += result.turnsAdded;
        filesUpdated++;
        remaining--;
        if (result.incomplete) remaining++;
      }
    }

    return {
      filesScanned: discovered.length,
      filesUpdated,
      turnsAdded,
      workRemains: remaining > 0,
    };
  }

  status(): IndexStatus {
    const rows = fileRows(this.db);
    const rowsByPath = new Map(rows.map((row) => [row.path, row]));
    const discovered = discoverTranscripts();
    const snapshots = discovered
      .map((file) => snapshot(file, rowsByPath.get(file.path)))
      .filter((item): item is FileSnapshot => item !== undefined);
    const availablePaths = new Set(snapshots.map((item) => item.file.path));
    let filesPending = rows.filter((row) => !availablePaths.has(row.path)).length;
    filesPending += snapshots.filter(needsIndexing).length;

    const aggregate = this.db.query<{
      files_known: number;
      turns_indexed: number;
      last_sweep_time: string | null;
    }, []>(`
      SELECT
        (SELECT count(*) FROM files) AS files_known,
        (SELECT count(*) FROM turns) AS turns_indexed,
        (SELECT max(indexed_ts) FROM files) AS last_sweep_time
    `).get()!;

    let indexSizeBytes = 0;
    for (const path of [this.indexPath, `${this.indexPath}-wal`]) {
      try {
        indexSizeBytes += statSync(path).size;
      } catch {
        // A checkpointed database normally has no WAL file to count.
      }
    }

    return {
      filesKnown: aggregate.files_known,
      filesPending,
      turnsIndexed: aggregate.turns_indexed,
      lastSweepTime: aggregate.last_sweep_time,
      firstBuildInProgress: filesPending > 0,
      indexSizeBytes,
    };
  }

  close(): void {
    this.db.close();
  }
}

/** Opens the versioned WAL index beneath Signalbox's local state directory. */
export function openIndex(dir = stateDir()): SearchIndex {
  mkdirSync(dir, { recursive: true });
  const indexPath = join(dir, indexFilename);
  const db = new Database(indexPath, { create: true, readwrite: true, strict: true });

  try {
    db.run("PRAGMA foreign_keys = ON");
    db.run("PRAGMA journal_mode = WAL");
    const version = readUserVersion(db);
    if (version === 0) createSchema(db);
    else if (version !== schemaVersion) {
      throw new Error(`unsupported search index schema version ${version}`);
    }
    return new SqliteSearchIndex(db, indexPath);
  } catch (err) {
    db.close();
    throw err;
  }
}
