#!/usr/bin/env bash
# upload-assets.sh <folder-name> <png>...: put screenshots on the orphan
# pr-assets branch (created on first use) and print each image URL.
# The repo is PUBLIC: only upload images you have looked at and that show
# sample data alone.
set -euo pipefail
repo=dwmkerr/signalbox folder=$1; shift
if ! gh api "repos/$repo/branches/pr-assets" >/dev/null 2>&1; then
  blob=$(gh api "repos/$repo/git/blobs" -f content="Screenshots for PR descriptions, one folder per PR or issue. Sample data only." -f encoding=utf-8 --jq .sha)
  tree=$(gh api "repos/$repo/git/trees" -f "tree[][path]=README.md" -f "tree[][mode]=100644" -f "tree[][type]=blob" -f "tree[][sha]=$blob" --jq .sha)
  commit=$(gh api "repos/$repo/git/commits" -f message="chore: start pr-assets branch" -f tree="$tree" --jq .sha)
  gh api "repos/$repo/git/refs" -f ref=refs/heads/pr-assets -f sha="$commit" >/dev/null
fi
tmp=$(mktemp -d)
for f in "$@"; do
  name=$(basename "$f")
  cp "$f" "$tmp/$name"; sips -Z 1400 "$tmp/$name" >/dev/null
  base64 -i "$tmp/$name" | tr -d '\n' > "$tmp/$name.b64"
  gh api -X PUT "repos/$repo/contents/$folder/$name" -f message="chore: screenshots for #$folder" \
    -f branch=pr-assets -F content=@"$tmp/$name.b64" >/dev/null
  echo "https://github.com/$repo/blob/pr-assets/$folder/$name?raw=true"
done
rm -rf "$tmp"
