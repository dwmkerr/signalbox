import Foundation

/// One session that contains matching turns, as returned by `GET /search`.
///
/// Results are grouped by session rather than by turn: a session that mentions
/// the term forty times is one row carrying its best snippet and that count,
/// because the user is looking for the conversation, not each occurrence.
struct SearchResult: Decodable, Equatable {
    /// The transcript's own session id, stable across the session's lifetime.
    let sessionUuid: String
    /// Agent that owns the best matching turn ("claude", "codex", "cursor").
    let agent: String
    /// Working directory recorded for the best matching turn, when known.
    let cwd: String?
    /// FTS5 excerpt with each match wrapped in a `<mark>` element.
    let snippet: String
    /// Timestamp of the turn the snippet came from, when the line carried one.
    let ts: String?
    /// Number of matching turns in this session.
    let hitCount: Int
    /// "live" when the session is still on the board, "ended" otherwise.
    let state: String
    /// Board key for a live result; nil once the session has left the board.
    let sessionKey: String?

    /// Whether this session is still on the board and can therefore be jumped to.
    var isLive: Bool { state == "live" }

    // Decoded leniently for the same reason as every other hub payload: a
    // schema tweak on the hub side must not blank the whole result list.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        sessionUuid = (try? c.decode(String.self, forKey: .sessionUuid)) ?? ""
        agent = (try? c.decodeIfPresent(String.self, forKey: .agent)) ?? ""
        cwd = try? c.decodeIfPresent(String.self, forKey: .cwd)
        snippet = (try? c.decodeIfPresent(String.self, forKey: .snippet)) ?? ""
        ts = try? c.decodeIfPresent(String.self, forKey: .ts)
        hitCount = (try? c.decodeIfPresent(Int.self, forKey: .hitCount)) ?? 0
        state = (try? c.decodeIfPresent(String.self, forKey: .state)) ?? "ended"
        sessionKey = try? c.decodeIfPresent(String.self, forKey: .sessionKey)
    }

    private enum CodingKeys: String, CodingKey {
        case sessionUuid, agent, cwd, snippet, ts, hitCount, state, sessionKey
    }

    init(
        sessionUuid: String, agent: String, cwd: String?, snippet: String,
        ts: String?, hitCount: Int, state: String, sessionKey: String?
    ) {
        self.sessionUuid = sessionUuid
        self.agent = agent
        self.cwd = cwd
        self.snippet = snippet
        self.ts = ts
        self.hitCount = hitCount
        self.state = state
        self.sessionKey = sessionKey
    }
}

/// The body of a successful `GET /search`.
struct SearchDoc: Decodable {
    let enabled: Bool
    let query: String
    let results: [SearchResult]

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        enabled = (try? c.decodeIfPresent(Bool.self, forKey: .enabled)) ?? true
        query = (try? c.decodeIfPresent(String.self, forKey: .query)) ?? ""
        results = (try? c.decodeIfPresent([SearchResult].self, forKey: .results)) ?? []
    }

    private enum CodingKeys: String, CodingKey { case enabled, query, results }
}

/// Index progress, from `GET /search/status`.
struct SearchIndexStatus: Decodable, Equatable {
    /// Transcript files currently recorded in the index.
    let filesKnown: Int
    /// Files discovered but not yet indexed, or changed since they were.
    let filesPending: Int
    /// Turns currently searchable.
    let turnsIndexed: Int
    /// Whether the index is still working through its initial corpus.
    let firstBuildInProgress: Bool
    /// Bytes the index occupies on disk.
    let indexSizeBytes: Int

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        filesKnown = (try? c.decodeIfPresent(Int.self, forKey: .filesKnown)) ?? 0
        filesPending = (try? c.decodeIfPresent(Int.self, forKey: .filesPending)) ?? 0
        turnsIndexed = (try? c.decodeIfPresent(Int.self, forKey: .turnsIndexed)) ?? 0
        firstBuildInProgress =
            (try? c.decodeIfPresent(Bool.self, forKey: .firstBuildInProgress)) ?? false
        indexSizeBytes = (try? c.decodeIfPresent(Int.self, forKey: .indexSizeBytes)) ?? 0
    }

    private enum CodingKeys: String, CodingKey {
        case filesKnown, filesPending, turnsIndexed, firstBuildInProgress, indexSizeBytes
    }

    init(
        filesKnown: Int, filesPending: Int, turnsIndexed: Int,
        firstBuildInProgress: Bool, indexSizeBytes: Int
    ) {
        self.filesKnown = filesKnown
        self.filesPending = filesPending
        self.turnsIndexed = turnsIndexed
        self.firstBuildInProgress = firstBuildInProgress
        self.indexSizeBytes = indexSizeBytes
    }
}

/// The body of `GET /search/status`.
struct SearchStatusDoc: Decodable {
    let enabled: Bool
    let status: SearchIndexStatus?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        enabled = (try? c.decodeIfPresent(Bool.self, forKey: .enabled)) ?? false
        status = try? c.decodeIfPresent(SearchIndexStatus.self, forKey: .status)
    }

    private enum CodingKeys: String, CodingKey { case enabled, status }
}

/// Why a search produced no results, kept distinct from an empty result list.
///
/// "Off", "this hub cannot answer that", and "nothing matched" look identical
/// if they all reduce to zero rows, and a user who sees an empty panel cannot
/// tell a broken feature from a disabled one. The hub answers each with its own
/// status, so the app keeps them apart all the way to the surface.
enum SearchAvailability: Equatable {
    /// Results were returned (possibly an empty list, meaning nothing matched).
    case available([SearchResult])
    /// The setting is off on the machine that owns the transcripts (HTTP 409).
    case disabled
    /// This hub is a forwarder and never serves search (HTTP 501).
    case notSupported
    /// The hub could not be reached, or answered with something unusable.
    case unreachable
}

extension SearchAvailability {
    /// Results when there are some, empty otherwise; for callers that only render rows.
    var results: [SearchResult] {
        if case .available(let rows) = self { return rows }
        return []
    }
}

/// One run of literal or matched text within a snippet.
struct SnippetRun: Equatable {
    let text: String
    let isMatch: Bool
}

/// Splits an FTS5 snippet into literal and matched runs.
///
/// The hub sends the snippet with matches wrapped in `<mark>`, which is markup
/// no AppKit view renders: drawn as-is the user reads the tags instead of the
/// text. Splitting here keeps the parsing in one place for every surface that
/// highlights a result.
func snippetRuns(_ snippet: String) -> [SnippetRun] {
    var runs: [SnippetRun] = []
    var rest = Substring(snippet)
    while let open = rest.range(of: "<mark>") {
        let before = rest[rest.startIndex..<open.lowerBound]
        if !before.isEmpty { runs.append(SnippetRun(text: String(before), isMatch: false)) }
        let afterOpen = rest[open.upperBound...]
        guard let close = afterOpen.range(of: "</mark>") else {
            // An unterminated mark means truncated markup; keep the text rather
            // than dropping the tail of the snippet.
            if !afterOpen.isEmpty { runs.append(SnippetRun(text: String(afterOpen), isMatch: true)) }
            return runs
        }
        let matched = afterOpen[afterOpen.startIndex..<close.lowerBound]
        if !matched.isEmpty { runs.append(SnippetRun(text: String(matched), isMatch: true)) }
        rest = afterOpen[close.upperBound...]
    }
    if !rest.isEmpty { runs.append(SnippetRun(text: String(rest), isMatch: false)) }
    return runs
}
