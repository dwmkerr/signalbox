import Foundation

/// Runnable without launching the app or granting Accessibility permissions.
@main
struct SessionTreeChecks {
    static func main() {
        let tree = SessionForest([
            .init(key: "grandchild", parent: "worker"),
            .init(key: "unrelated", parent: nil),
            .init(key: "root", parent: nil),
            .init(key: "sibling", parent: "root"),
            .init(key: "worker", parent: "root"),
        ])
        precondition(tree.roots == ["root", "unrelated"], "Latest descendant orders its tree")
        precondition(tree.children["root"] == ["sibling", "worker"], "Sibling order remains authoritative")
        precondition(tree.ancestors(of: "grandchild") == ["worker", "root"], "Direct parent remains distinct from family root")
        precondition(tree.descendants(of: "root") == ["sibling", "worker", "grandchild"], "Depth-first navigation reaches grandchildren")
        let broken = SessionForest([
            .init(key: "a", parent: "b"), .init(key: "b", parent: "a"),
            .init(key: "c", parent: "a"), .init(key: "missing", parent: "absent"),
            .init(key: "self", parent: "self"),
        ])
        precondition(broken.roots == ["a", "b", "missing", "self"], "Bad edges cannot hide sessions")
        precondition(broken.parents == ["c": "a"], "Only cycle edges are discarded")
        precondition(broken.descendants(of: "a") == ["c"], "Valid children of a cyclic claim survive")
        precondition(SessionForest([]).roots.isEmpty, "Empty board remains empty")
        var expansion = SessionTreeExpansion()
        precondition(!expansion.isExpanded("root"), "Trees start collapsed")
        expansion.toggle("root")
        precondition(expansion.isExpanded("root") && !expansion.isExpanded("new-worker"), "New children do not inherit expansion")
        expansion.toggle("root")
        precondition(expansion.isExpanded("root", searching: true), "Search reveals collapsed paths")
        precondition(!expansion.isExpanded("root"), "Clearing search restores collapse")
        expansion.reveal(ancestors: tree.ancestors(of: "grandchild"))
        precondition(expansion.isExpanded("root") && expansion.isExpanded("worker") && !expansion.isExpanded("unrelated"), "Unread navigation opens only its ancestor path")
        let realKeys: Set<String> = ["root", "worker", "grandchild", "sibling", "unrelated"]
        let branch = tree.sessionKeys(inBranch: "root", existingKeys: realKeys)
        precondition(Set(branch) == realKeys.subtracting(["unrelated"]), "Collapsed parent actions include the entire recorded branch")
        precondition(branch.last == "root" && branch.firstIndex(of: "grandchild")! < branch.firstIndex(of: "worker")!, "Children are removed before their parents")
        precondition(Set(tree.sessionKeys(inBranch: "worker", existingKeys: realKeys)) == ["worker", "grandchild"], "Worker actions leave ancestors and siblings alone")
        precondition(tree.sessionKeys(inBranch: "unrelated", existingKeys: realKeys) == ["unrelated"], "Standalone sessions keep their single-row actions")
        let orphan = SessionForest([.init(key: "context", parent: nil), .init(key: "child", parent: "context")])
        precondition(orphan.sessionKeys(inBranch: "context", existingKeys: ["child"]) == ["child"], "Context actions target real children, never synthetic keys")
        precondition(orphan.sessionKeys(inBranch: "missing", existingKeys: ["child"]).isEmpty, "An absent branch has no action targets")
        print("19 session forest, expansion and branch-action checks passed")
    }
}
