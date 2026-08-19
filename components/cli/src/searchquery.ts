import type { Database } from "bun:sqlite";
import type { Event } from "./event";

const maxQueryTerms = 32;
const maxTermCodePoints = 128;
const queryToken = /[\p{L}\p{N}\p{Co}][\p{L}\p{N}\p{M}\p{Co}]*/gu;

/** Identifies whether a content-search result still has a row on the board. */
export type SearchResultState = "live" | "ended";

/** A transcript search result grouped around its best matching turn. */
export interface SearchResult {
  /** Stable transcript session identifier shared by every matching turn. */
  sessionUuid: string;
  /** Agent that owns the best matching turn. */
  agent: string;
  /** Working directory recorded for the best matching turn, when available. */
  cwd: string | null;
  /** FTS5-generated excerpt with matches enclosed in `<mark>` elements. */
  snippet: string;
  /** Timestamp of the turn used for the snippet, when available. */
  ts: string | null;
  /** Number of matching turns in this session. */
  hitCount: number;
  /** Whether the session can still be resolved to a current board row. */
  state: SearchResultState;
  /** Current board key used to jump to a live result, or null for an ended result. */
  sessionKey: string | null;
}

/** Runs safe, grouped full-text queries against an open transcript index. */
export interface SearchQuery {
  /** Counts matching turns using prefix expressions suitable for live feedback. */
  countHits(q: string): number;
  /** Returns the best matching turn from each session, ordered by relevance and recency. */
  search(q: string, limit: number, liveSessions?: readonly Event[]): SearchResult[];
}

interface SearchRow {
  session_uuid: string;
  agent: string;
  cwd: string | null;
  snippet: string;
  ts: string | null;
  hit_count: number;
}

function boundedTerm(term: string): string {
  return Array.from(term).slice(0, maxTermCodePoints).join("");
}

function matchExpression(q: string): string {
  const terms = q.normalize("NFC").match(queryToken)?.slice(0, maxQueryTerms) ?? [];
  return terms.map((raw) => {
    const term = boundedTerm(raw).replaceAll('"', '""');
    const prefix = Array.from(term).length >= 2 ? "*" : "";
    return `"${term}"${prefix}`;
  }).join(" AND ");
}

class SqliteSearchQuery implements SearchQuery {
  constructor(private readonly db: Database) {}

  countHits(q: string): number {
    const expression = matchExpression(q);
    if (!expression) return 0;
    return this.db.query<{ count: number }, [string]>(`
      SELECT count(*) AS count
      FROM turns_fts
      WHERE turns_fts MATCH ?
    `).get(expression)?.count ?? 0;
  }

  search(q: string, limit: number, liveSessions: readonly Event[] = []): SearchResult[] {
    if (!Number.isInteger(limit) || limit < 0) {
      throw new RangeError("limit must be a non-negative integer");
    }
    const expression = matchExpression(q);
    if (!expression || limit === 0) return [];

    const rows = this.db.query<SearchRow, [string, number]>(`
      WITH matches AS (
        SELECT
          turns.id,
          turns.session_uuid,
          turns.agent,
          turns.cwd,
          turns.ts,
          bm25(turns_fts) AS rank,
          snippet(turns_fts, 0, '<mark>', '</mark>', '...', 32) AS snippet
        FROM turns_fts
        JOIN turns ON turns.id = turns_fts.rowid
        WHERE turns_fts MATCH ?
      ), ranked AS (
        SELECT
          *,
          count(*) OVER (PARTITION BY session_uuid) AS hit_count,
          row_number() OVER (
            PARTITION BY session_uuid
            ORDER BY rank ASC, coalesce(ts, '') DESC, id DESC
          ) AS selected
        FROM matches
      )
      SELECT session_uuid, agent, cwd, snippet, ts, hit_count
      FROM ranked
      WHERE selected = 1
      ORDER BY rank ASC, coalesce(ts, '') DESC, session_uuid ASC
      LIMIT ?
    `).all(expression, limit);

    const sessionForPath = this.db.query<{ session_uuid: string }, [string]>(`
      SELECT session_uuid FROM files WHERE path = ?
    `);
    const liveKeys = new Map<string, string>();
    for (const session of liveSessions) {
      if (!session.transcript) continue;
      const indexed = sessionForPath.get(session.transcript);
      if (indexed && !liveKeys.has(indexed.session_uuid)) {
        liveKeys.set(indexed.session_uuid, session.session_key);
      }
    }

    return rows.map((row) => {
      const sessionKey = liveKeys.get(row.session_uuid) ?? null;
      return {
        sessionUuid: row.session_uuid,
        agent: row.agent,
        cwd: row.cwd,
        snippet: row.snippet,
        ts: row.ts,
        hitCount: row.hit_count,
        state: sessionKey === null ? "ended" : "live",
        sessionKey,
      };
    });
  }
}

/** Creates the query facade for an already-open, schema-checked search database. */
export function createSearchQuery(db: Database): SearchQuery {
  return new SqliteSearchQuery(db);
}
