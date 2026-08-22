import { Database } from "bun:sqlite";
import { mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { stateDir } from "./client";
import type { Event } from "./event";
import {
  createSearchQuery,
  type SearchQuery,
  type SearchResult,
} from "./searchquery";
import {
  discoverTranscripts,
  parseTurns,
  type TranscriptFile,
} from "./transcripts";

export type { SearchResult, SearchResultState } from "./searchquery";

const schemaVersion = 2;
const indexFilename = "search.db";

// Walking real transcript roots costs several indexing ticks, while a new
// transcript can wait briefly before becoming searchable.
const discoveryIntervalMs = 30_000;

const createMeta = `
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

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
  next?: FileSnapshot;
  madeProgress: boolean;
}

/** Limits one sweep to a small slice of the hub's event loop. */
export interface SweepOptions {
  /** Maximum indexing time available before another bounded work unit may start. */
  budgetMs: number;
}

/** Describes the durable work completed by one bounded index sweep. */
export interface SweepSummary {
  /** Number of transcript files found by the most recent discovery refresh. */
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
export interface SearchIndex extends SearchQuery {
  /** Commits bounded progress from the work list retained across sweep ticks. */
  sweep(opts: SweepOptions): SweepSummary;
  /** Reads current durable counts and the retained discovery work list. */
  status(): IndexStatus;
  /** Releases this process's SQLite connection while leaving the index intact. */
  close(): void;
}

/** Selects whether an index connection may create or update durable search state. */
export interface OpenIndexOptions {
  /** Prevents schema creation, transcript discovery, and every index write. */
  readonly?: boolean;
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
    db.run(createMeta);
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
  private readonly query: SearchQuery;
  private pending: FileSnapshot[] = [];
  private pendingIndex = 0;
  private vanished: FileRow[] = [];
  private vanishedIndex = 0;
  private discoveredCount = 0;
  private lastDiscoveryMs = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly db: Database,
    private readonly indexPath: string,
    private readonly readonly: boolean = false,
  ) {
    this.query = createSearchQuery(db);
    // The one-off walk belongs to index startup so every recurring budget can
    // be spent committing transcript progress.
    if (!readonly) this.refreshDiscovery();
  }

  countHits(q: string): number {
    return this.query.countHits(q);
  }

  search(q: string, limit: number, liveSessions: readonly Event[] = []): SearchResult[] {
    return this.query.search(q, limit, liveSessions);
  }

  private refreshDiscovery(): void {
    const discovered = discoverTranscripts();
    const rows = fileRows(this.db);
    const rowsByPath = new Map(rows.map((row) => [row.path, row]));
    const snapshots = discovered
      .map((file) => snapshot(file, rowsByPath.get(file.path)))
      .filter((item): item is FileSnapshot => item !== undefined);
    const availablePaths = new Set(snapshots.map((item) => item.file.path));

    this.discoveredCount = discovered.length;
    this.vanished = rows.filter((row) => !availablePaths.has(row.path));
    this.vanishedIndex = 0;
    this.pending = snapshots.filter(needsIndexing);
    this.pendingIndex = 0;
    this.lastDiscoveryMs = Date.now();
  }

  private hasWork(): boolean {
    return this.vanishedIndex < this.vanished.length
      || this.pendingIndex < this.pending.length;
  }

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

    const row: FileRow = {
      path: item.file.path,
      agent: item.file.agent,
      session_uuid: sessionUuid,
      cwd,
      mtime_ms: item.mtimeMs,
      size: Math.max(item.size, parsed.endOffset),
      byte_offset: parsed.endOffset,
      indexed_ts: indexedTs,
    };
    return {
      turnsAdded: parsed.turns.length,
      next: parsed.endOffset < item.size ? { ...item, row } : undefined,
      madeProgress: parsed.endOffset > fromOffset,
    };
  }

  sweep(opts: SweepOptions): SweepSummary {
    if (this.readonly) throw new Error("search index is open read-only");
    if (!Number.isFinite(opts.budgetMs) || opts.budgetMs < 0) {
      throw new RangeError("budgetMs must be a finite non-negative number");
    }

    if (Date.now() - this.lastDiscoveryMs >= discoveryIntervalMs) {
      this.refreshDiscovery();
    }

    const deadline = performance.now() + opts.budgetMs;

    let filesUpdated = 0;
    let turnsAdded = 0;
    let attempted = false;

    while (this.hasWork()) {
      if (attempted && performance.now() >= deadline) break;
      attempted = true;

      const vanished = this.vanished[this.vanishedIndex];
      if (vanished) {
        this.vanishedIndex++;
        this.removeFile(vanished.path);
        filesUpdated++;
        continue;
      }

      const item = this.pending[this.pendingIndex];
      if (item) {
        this.pendingIndex++;
        const result = this.indexBatch(item);
        turnsAdded += result.turnsAdded;
        filesUpdated++;
        if (result.next) this.pending.push(result.next);
        // A trailing partial line cannot advance until its writer appends. Do
        // not spend the rest of this tick retrying the same bytes.
        if (result.next && !result.madeProgress) break;
      }
    }

    const workRemains = this.hasWork();
    // Reaching an empty queue once is what ends the first build, so record it
    // the moment it happens rather than inferring it later.
    if (!workRemains) this.markFirstBuildDone();

    return {
      filesScanned: this.discoveredCount,
      filesUpdated,
      turnsAdded,
      workRemains,
    };
  }

  // A durable marker, because "has pending work" is a different question: one
  // active session writing a line makes work pending again forever after, and a
  // status built on that would claim to be building for the rest of time.
  private firstBuildDone(): boolean {
    const row = this.db
      .query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'first_build_done'")
      .get();
    return row !== null && row !== undefined;
  }

  private markFirstBuildDone(): void {
    this.db.run(
      "INSERT OR IGNORE INTO meta (key, value) VALUES ('first_build_done', ?)",
      [new Date().toISOString()],
    );
  }

  status(): IndexStatus {
    const filesPending = this.vanished.length - this.vanishedIndex
      + this.pending.length - this.pendingIndex;

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
      // "Has pending work" is not the same question: a single active session
      // writing one line makes work pending forever after. The first build is
      // over once a sweep has seen the corpus fully indexed, once, ever.
      firstBuildInProgress: filesPending > 0 && !this.firstBuildDone(),
      indexSizeBytes,
    };
  }

  close(): void {
    this.db.close();
  }
}

/** Opens the versioned WAL index beneath Signalbox's local state directory. */
export function openIndex(dir = stateDir(), options: OpenIndexOptions = {}): SearchIndex {
  const readonly = options.readonly ?? false;
  if (!readonly) mkdirSync(dir, { recursive: true });
  const indexPath = join(dir, indexFilename);
  const db = new Database(indexPath, readonly
    ? { readonly: true, strict: true }
    : { create: true, readwrite: true, strict: true });

  try {
    if (!readonly) {
      db.run("PRAGMA foreign_keys = ON");
      db.run("PRAGMA journal_mode = WAL");
    }
    const version = readUserVersion(db);
    if (version === 0) {
      if (readonly) throw new Error("search index has no schema");
      createSchema(db);
    }
    else if (version !== schemaVersion) {
      throw new Error(`unsupported search index schema version ${version}`);
    }
    return new SqliteSearchIndex(db, indexPath, readonly);
  } catch (err) {
    db.close();
    throw err;
  }
}
