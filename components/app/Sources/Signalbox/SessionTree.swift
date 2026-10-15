import Foundation

/// Explicit expansion choices for this app run. New parents stay collapsed.
struct SessionTreeExpansion {
    private var expanded = Set<String>()

    /// Search reveals paths temporarily without changing the user's choices.
    func isExpanded(_ key: String, searching: Bool = false) -> Bool {
        searching || expanded.contains(key)
    }

    mutating func toggle(_ key: String) {
        if expanded.contains(key) { expanded.remove(key) } else { expanded.insert(key) }
    }

    /// Navigating to an unread descendant opens only the path needed to reach it.
    mutating func reveal(ancestors: [String]) {
        expanded.formUnion(ancestors)
    }
}

/// A session's recorded relationship, independent of presentation and activity.
struct SessionTreeNode {
    /// Unique identity within the current board.
    let key: String
    /// Explicit parent identity; nil keeps the session at the root.
    let parent: String?
}

/// A deterministic forest. Cyclic claims are discarded rather than hiding sessions.
struct SessionForest {
    /// Roots ordered by the earliest member in the input's authoritative order.
    let roots: [String]
    /// Children in authoritative input order.
    let children: [String: [String]]
    /// Validated immediate parents.
    let parents: [String: String]

    init(_ nodes: [SessionTreeNode]) {
        let keys = Set(nodes.map(\.key))
        var links: [String: String] = [:]
        for node in nodes {
            if let parent = node.parent, parent != node.key, keys.contains(parent) { links[node.key] = parent }
        }
        var cyclic = Set<String>()
        for node in nodes {
            var path: [String] = []
            var positions: [String: Int] = [:]
            var key = node.key
            while let parent = links[key] {
                if let start = positions[key] { cyclic.formUnion(path[start...]); break }
                positions[key] = path.count
                path.append(key)
                key = parent
            }
        }
        for key in cyclic { links.removeValue(forKey: key) }
        var grouped: [String: [String]] = [:]
        var rootOrder: [String] = []
        var seen = Set<String>()
        for node in nodes {
            if let parent = links[node.key] { grouped[parent, default: []].append(node.key) }
            var root = node.key
            while let parent = links[root] { root = parent }
            if seen.insert(root).inserted { rootOrder.append(root) }
        }
        parents = links
        children = grouped
        roots = rootOrder
    }

    /// Ancestors from nearest to root; construction guarantees termination.
    func ancestors(of key: String) -> [String] {
        var result: [String] = []
        var current = key
        while let parent = parents[current] { result.append(parent); current = parent }
        return result
    }

    /// Descendants in display order, excluding the parent itself.
    func descendants(of key: String) -> [String] {
        (children[key] ?? []).flatMap { [$0] + descendants(of: $0) }
    }

    /// Concrete sessions in a branch, children before parents. Placeholders
    /// are excluded so actions cannot create events for synthetic identities.
    func sessionKeys(inBranch key: String, existingKeys: Set<String>) -> [String] {
        ([key] + descendants(of: key)).reversed().filter { existingKeys.contains($0) }
    }
}
