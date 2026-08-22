import { Database } from "bun:sqlite";
import { describe, expect, spyOn, test } from "bun:test";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { openIndex, type SearchIndex, type SweepSummary } from "./searchindex";

const rootVariables = [
  "SIGNALBOX_CLAUDE_TRANSCRIPTS_DIR",
  "SIGNALBOX_CODEX_TRANSCRIPTS_DIR",
  "SIGNALBOX_CURSOR_TRANSCRIPTS_DIR",
] as const;

const claudeUuid = "11111111-1111-4111-8111-111111111111";
const codexUuid = "22222222-2222-4222-8222-222222222222";
const cursorUuid = "33333333-3333-4333-8333-333333333333";

interface Corpus {
  root: string;
  indexDir: string;
  claudeRoot: string;
  codexRoot: string;
  cursorRoot: string;
  claudePath: string;
  codexPath: string;
  cursorPath: string;
}

interface StoredTurn {
  path: string;
  session_uuid: string;
  agent: string;
  role: string;
  text: string;
}

function jsonl(entries: unknown[]): string {
  return entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
}

function write(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

function createCorpus(): Corpus {
  const root = mkdtempSync(join(tmpdir(), "signalbox-searchindex-"));
  const claudeRoot = join(root, "claude-projects");
  const codexRoot = join(root, "codex-sessions");
  const cursorRoot = join(root, "cursor-projects");
  const claudePath = join(claudeRoot, "-work-claude", `${claudeUuid}.jsonl`);
  const codexPath = join(
    codexRoot,
    "2026",
    "08",
    "19",
    `rollout-2026-08-19T09-30-00-${codexUuid}.jsonl`,
  );
  const cursorPath = join(
    cursorRoot,
    "work-cursor",
    "agent-transcripts",
    cursorUuid,
    `${cursorUuid}.jsonl`,
  );

  write(claudePath, jsonl([
    {
      type: "user",
      cwd: "/work/claude",
      timestamp: "2026-08-19T09:00:00.000Z",
      message: { role: "user", content: "claude first prompt" },
    },
    {
      type: "assistant",
      cwd: "/work/claude",
      timestamp: "2026-08-19T09:00:01.000Z",
      message: { role: "assistant", content: "claude first reply" },
    },
  ]));
  write(codexPath, jsonl([
    { type: "session_meta", payload: { session_id: codexUuid, cwd: "/work/codex" } },
    {
      type: "event_msg",
      timestamp: "2026-08-19T09:30:00.000Z",
      payload: { type: "user_message", message: "codex first prompt" },
    },
    {
      type: "event_msg",
      timestamp: "2026-08-19T09:30:01.000Z",
      payload: { type: "agent_message", message: "codex first reply" },
    },
  ]));
  write(cursorPath, jsonl([
    {
      role: "user",
      cwd: "/work/cursor",
      timestamp: "2026-08-19T10:00:00.000Z",
      message: { content: "cursor first prompt" },
    },
    {
      role: "assistant",
      cwd: "/work/cursor",
      timestamp: "2026-08-19T10:00:01.000Z",
      message: { content: "cursor first reply" },
    },
  ]));

  return {
    root,
    indexDir: join(root, "state"),
    claudeRoot,
    codexRoot,
    cursorRoot,
    claudePath,
    codexPath,
    cursorPath,
  };
}

function withCorpus(run: (corpus: Corpus) => void): void {
  const previous = rootVariables.map((name) => process.env[name]);
  const corpus = createCorpus();
  const roots = [corpus.claudeRoot, corpus.codexRoot, corpus.cursorRoot];
  rootVariables.forEach((name, index) => { process.env[name] = roots[index]; });
  try {
    run(corpus);
  } finally {
    rootVariables.forEach((name, index) => {
      const value = previous[index];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    });
  }
}

function openDatabase(corpus: Corpus): Database {
  return new Database(join(corpus.indexDir, "search.db"), { readonly: true, strict: true });
}

function turns(db: Database): StoredTurn[] {
  return db.query<StoredTurn, []>(`
    SELECT path, session_uuid, agent, role, text
    FROM turns
    ORDER BY id
  `).all();
}

function build(index: SearchIndex): void {
  const result = index.sweep({ budgetMs: 5_000 });
  expect(result).toEqual({
    filesScanned: 3,
    filesUpdated: 3,
    turnsAdded: 6,
    workRemains: false,
  });
}

function sweepOneFile(index: SearchIndex): SweepSummary {
  const clock = spyOn(performance, "now")
    .mockReturnValueOnce(0)
    .mockReturnValue(2);
  try {
    return index.sweep({ budgetMs: 1 });
  } finally {
    clock.mockRestore();
  }
}

function sweepAfterDiscoveryRefresh(index: SearchIndex): SweepSummary {
  const clock = spyOn(Date, "now").mockReturnValue(Number.MAX_SAFE_INTEGER);
  try {
    return index.sweep({ budgetMs: 5_000 });
  } finally {
    clock.mockRestore();
  }
}

function addProductionSizedCorpus(corpus: Corpus, count: number): void {
  const project = join(corpus.claudeRoot, "-work-production-sized");
  mkdirSync(project, { recursive: true });
  for (let index = 0; index < count; index++) {
    const tail = index.toString(16).padStart(12, "0");
    const sessionUuid = `aaaaaaaa-aaaa-4aaa-8aaa-${tail}`;
    writeFileSync(join(project, `${sessionUuid}.jsonl`), jsonl([{
      type: "user",
      cwd: "/work/production-sized",
      message: { role: "user", content: `production budget turn ${index}` },
    }]));
  }
}

describe("openIndex", () => {
  test("creates the versioned contract schema in WAL mode", () => withCorpus((corpus) => {
    const index = openIndex(corpus.indexDir);
    const db = openDatabase(corpus);
    try {
      expect(db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(2);
      expect(db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode).toBe("wal");
      expect(db.query<{ name: string }, []>(`
        SELECT name FROM sqlite_schema
        WHERE type IN ('table', 'index') AND name IN (
          'files', 'meta', 'turns', 'turns_by_session', 'turns_by_path', 'turns_fts'
        )
        ORDER BY name
      `).all().map((row) => row.name)).toEqual([
        "files",
        "meta",
        "turns",
        "turns_by_path",
        "turns_by_session",
        "turns_fts",
      ]);
    } finally {
      db.close();
      index.close();
    }
  }));
});

describe("sweep", () => {
  test("makes durable progress at the production budget on a real-sized corpus", () => withCorpus((corpus) => {
    const additionalFiles = 1_000;
    addProductionSizedCorpus(corpus, additionalFiles);
    const index = openIndex(corpus.indexDir);
    try {
      let totalTurnsAdded = 0;
      let sweeps = 0;
      let workRemains = true;

      while (workRemains) {
        const result = index.sweep({ budgetMs: 10 });
        const previousTotal = totalTurnsAdded;
        totalTurnsAdded += result.turnsAdded;
        expect(totalTurnsAdded).toBeGreaterThan(previousTotal);
        workRemains = result.workRemains;
        expect(++sweeps).toBeLessThan(additionalFiles + 4);
      }

      expect(sweeps).toBeGreaterThan(1);
      expect(totalTurnsAdded).toBe(additionalFiles + 6);
      expect(index.status().turnsIndexed).toBe(additionalFiles + 6);
    } finally {
      index.close();
    }
  }));

  test("does not discover new files again until the discovery interval elapses", () => withCorpus((corpus) => {
    const clock = spyOn(Date, "now").mockReturnValue(1_000);
    const index = openIndex(corpus.indexDir);
    try {
      build(index);
      const sessionUuid = "44444444-4444-4444-8444-444444444444";
      write(join(corpus.claudeRoot, "-work-new", `${sessionUuid}.jsonl`), jsonl([{
        type: "user",
        message: { role: "user", content: "found after refresh" },
      }]));

      expect(index.sweep({ budgetMs: 10 })).toEqual({
        filesScanned: 3,
        filesUpdated: 0,
        turnsAdded: 0,
        workRemains: false,
      });

      clock.mockReturnValue(31_000);
      expect(index.sweep({ budgetMs: 10 })).toEqual({
        filesScanned: 4,
        filesUpdated: 1,
        turnsAdded: 1,
        workRemains: false,
      });
    } finally {
      index.close();
      clock.mockRestore();
    }
  }));

  test("builds a fresh fixture corpus and keeps FTS readable concurrently", () => withCorpus((corpus) => {
    const index = openIndex(corpus.indexDir);
    try {
      expect(index.status()).toMatchObject({
        filesKnown: 0,
        filesPending: 3,
        turnsIndexed: 0,
        lastSweepTime: null,
        firstBuildInProgress: true,
      });

      build(index);
      const db = openDatabase(corpus);
      try {
        expect(turns(db)).toEqual([
          {
            path: corpus.claudePath,
            session_uuid: claudeUuid,
            agent: "claude",
            role: "user",
            text: "claude first prompt",
          },
          {
            path: corpus.claudePath,
            session_uuid: claudeUuid,
            agent: "claude",
            role: "assistant",
            text: "claude first reply",
          },
          {
            path: corpus.codexPath,
            session_uuid: codexUuid,
            agent: "codex",
            role: "user",
            text: "codex first prompt",
          },
          {
            path: corpus.codexPath,
            session_uuid: codexUuid,
            agent: "codex",
            role: "assistant",
            text: "codex first reply",
          },
          {
            path: corpus.cursorPath,
            session_uuid: cursorUuid,
            agent: "cursor",
            role: "user",
            text: "cursor first prompt",
          },
          {
            path: corpus.cursorPath,
            session_uuid: cursorUuid,
            agent: "cursor",
            role: "assistant",
            text: "cursor first reply",
          },
        ]);
        expect(db.query<{ count: number }, [string]>(
          "SELECT count(*) AS count FROM turns_fts WHERE turns_fts MATCH ?",
        ).get("prompt")?.count).toBe(3);
      } finally {
        db.close();
      }

      const status = index.status();
      expect(status.filesKnown).toBe(3);
      expect(status.filesPending).toBe(0);
      expect(status.turnsIndexed).toBe(6);
      expect(status.lastSweepTime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(status.firstBuildInProgress).toBe(false);
      expect(status.indexSizeBytes).toBeGreaterThan(0);
    } finally {
      index.close();
    }
  }));

  // The flag names the first build, not "has pending work". One active session
  // appending a line makes work pending again, and a surface built on the wrong
  // question would claim to be building for the rest of the machine's life.
  test("first build ends for good once the corpus is fully indexed", () => withCorpus((corpus) => {
    const index = openIndex(corpus.indexDir);
    try {
      while (index.sweep({ budgetMs: 50 }).workRemains) { /* drain */ }
      expect(index.status().firstBuildInProgress).toBe(false);

      // A session speaks again. Whether that work has been noticed yet depends
      // on the discovery cadence, but either way the first build is long over
      // and must never be reported as running again.
      appendFileSync(corpus.claudePath, jsonl([{
        type: "user",
        cwd: "/work/claude",
        message: { role: "user", content: "a fresh line arrives" },
      }]));
      index.sweep({ budgetMs: 0 });
      expect(index.status().firstBuildInProgress).toBe(false);
    } finally {
      index.close();
    }
  }));

  test("does no work when a second sweep sees unchanged metadata and offsets", () => withCorpus((corpus) => {
    const index = openIndex(corpus.indexDir);
    try {
      build(index);
      expect(index.sweep({ budgetMs: 5_000 })).toEqual({
        filesScanned: 3,
        filesUpdated: 0,
        turnsAdded: 0,
        workRemains: false,
      });
      expect(index.status().turnsIndexed).toBe(6);
    } finally {
      index.close();
    }
  }));

  test("indexes only turns appended after the durable byte offset", () => withCorpus((corpus) => {
    const index = openIndex(corpus.indexDir);
    try {
      build(index);
      appendFileSync(corpus.claudePath, jsonl([{
        type: "user",
        cwd: "/work/claude",
        message: { role: "user", content: "appended prompt" },
      }, {
        type: "assistant",
        cwd: "/work/claude",
        message: { role: "assistant", content: "appended reply" },
      }]));

      expect(sweepAfterDiscoveryRefresh(index)).toMatchObject({
        filesUpdated: 1,
        turnsAdded: 2,
        workRemains: false,
      });
      expect(index.sweep({ budgetMs: 5_000 }).turnsAdded).toBe(0);

      const db = openDatabase(corpus);
      try {
        expect(db.query<{ text: string }, [string]>(
          "SELECT text FROM turns WHERE path = ? ORDER BY id",
        ).all(corpus.claudePath).map((row) => row.text)).toEqual([
          "claude first prompt",
          "claude first reply",
          "appended prompt",
          "appended reply",
        ]);
        expect(db.query<{ byte_offset: number }, [string]>(
          "SELECT byte_offset FROM files WHERE path = ?",
        ).get(corpus.claudePath)?.byte_offset).toBe(statSync(corpus.claudePath).size);
      } finally {
        db.close();
      }
    } finally {
      index.close();
    }
  }));

  test("rebuilds a truncated file and removes its old FTS rows", () => withCorpus((corpus) => {
    const index = openIndex(corpus.indexDir);
    try {
      build(index);
      const originalSize = statSync(corpus.claudePath).size;
      writeFileSync(corpus.claudePath, jsonl([{
        type: "user",
        message: { role: "user", content: "replacement" },
      }]));
      expect(statSync(corpus.claudePath).size).toBeLessThan(originalSize);

      expect(sweepAfterDiscoveryRefresh(index)).toMatchObject({
        filesUpdated: 1,
        turnsAdded: 1,
        workRemains: false,
      });
      const db = openDatabase(corpus);
      try {
        expect(db.query<{ text: string }, [string]>(
          "SELECT text FROM turns WHERE path = ?",
        ).all(corpus.claudePath)).toEqual([{ text: "replacement" }]);
        expect(db.query<{ count: number }, [string]>(
          "SELECT count(*) AS count FROM turns_fts WHERE turns_fts MATCH ?",
        ).get("claude")?.count).toBe(0);
        expect(db.query<{ count: number }, [string]>(
          "SELECT count(*) AS count FROM turns_fts WHERE turns_fts MATCH ?",
        ).get("replacement")?.count).toBe(1);
      } finally {
        db.close();
      }
    } finally {
      index.close();
    }
  }));

  test("removes turns and FTS rows when a transcript vanishes", () => withCorpus((corpus) => {
    const index = openIndex(corpus.indexDir);
    try {
      build(index);
      unlinkSync(corpus.codexPath);

      expect(sweepAfterDiscoveryRefresh(index)).toMatchObject({
        filesUpdated: 1,
        turnsAdded: 0,
        workRemains: false,
      });
      const db = openDatabase(corpus);
      try {
        expect(db.query<{ count: number }, [string]>(
          "SELECT count(*) AS count FROM files WHERE path = ?",
        ).get(corpus.codexPath)?.count).toBe(0);
        expect(db.query<{ count: number }, [string]>(
          "SELECT count(*) AS count FROM turns WHERE path = ?",
        ).get(corpus.codexPath)?.count).toBe(0);
        expect(db.query<{ count: number }, [string]>(
          "SELECT count(*) AS count FROM turns_fts WHERE turns_fts MATCH ?",
        ).get("codex")?.count).toBe(0);
      } finally {
        db.close();
      }
    } finally {
      index.close();
    }
  }));

  test("commits tiny-budget progress and resumes to the unbounded total", () => withCorpus((corpus) => {
    const firstIndex = openIndex(corpus.indexDir);
    try {
      expect(sweepOneFile(firstIndex)).toEqual({
        filesScanned: 3,
        filesUpdated: 1,
        turnsAdded: 2,
        workRemains: true,
      });
    } finally {
      firstIndex.close();
    }

    const durableDb = openDatabase(corpus);
    try {
      expect(durableDb.query<{ count: number }, []>(
        "SELECT count(*) AS count FROM files",
      ).get()?.count).toBe(1);
      expect(durableDb.query<{ count: number }, []>(
        "SELECT count(*) AS count FROM turns",
      ).get()?.count).toBe(2);
    } finally {
      durableDb.close();
    }

    const resumedIndex = openIndex(corpus.indexDir);
    const unboundedIndex = openIndex(join(corpus.root, "unbounded-state"));
    try {
      let resumed = resumedIndex.sweep({ budgetMs: 5_000 });
      let sweeps = 1;
      while (resumed.workRemains) {
        expect(sweeps++).toBeLessThan(10);
        resumed = resumedIndex.sweep({ budgetMs: 5_000 });
      }
      expect(resumed.workRemains).toBe(false);

      expect(unboundedIndex.sweep({ budgetMs: Number.MAX_SAFE_INTEGER }).workRemains).toBe(false);
      expect(resumedIndex.status().turnsIndexed).toBe(unboundedIndex.status().turnsIndexed);
      expect(resumedIndex.status().turnsIndexed).toBe(6);
    } finally {
      unboundedIndex.close();
      resumedIndex.close();
    }
  }));

  test("reports pending files and indexed turns throughout the first build", () => withCorpus((corpus) => {
    const index = openIndex(corpus.indexDir);
    try {
      expect(sweepOneFile(index).workRemains).toBe(true);
      const midBuild = index.status();
      expect(midBuild).toMatchObject({
        filesKnown: 1,
        filesPending: 2,
        turnsIndexed: 2,
        firstBuildInProgress: true,
      });

      const db = openDatabase(corpus);
      try {
        expect(db.query<{ count: number }, []>(
          "SELECT count(*) AS count FROM turns",
        ).get()?.count).toBe(midBuild.turnsIndexed);
      } finally {
        db.close();
      }

      expect(index.sweep({ budgetMs: 5_000 }).workRemains).toBe(false);
      const complete = index.status();
      expect(complete).toMatchObject({
        filesKnown: 3,
        filesPending: 0,
        turnsIndexed: 6,
        firstBuildInProgress: false,
      });

      const completedDb = openDatabase(corpus);
      try {
        expect(completedDb.query<{ count: number }, []>(
          "SELECT count(*) AS count FROM turns",
        ).get()?.count).toBe(complete.turnsIndexed);
      } finally {
        completedDb.close();
      }
    } finally {
      index.close();
    }
  }));
});
