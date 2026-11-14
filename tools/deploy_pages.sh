#!/usr/bin/env bash
# Publishes the app to GitHub Pages: the committed files of HEAD plus the local model files that are
# kept out of git (Canyon bike, rider mannequin and head), pushed as a single commit to the gh-pages
# branch. Run from the repository root: tools/deploy_pages.sh
set -euo pipefail

root=$(git rev-parse --show-toplevel)
cd "$root"
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT

git archive HEAD | tar -x -C "$out"
for f in assets/bike/bike.glb assets/rider/dummy.gltf assets/rider/dummy.bin assets/rider/head.glb; do
  if [ -f "$f" ]; then mkdir -p "$out/$(dirname "$f")"; cp "$f" "$out/$f"; else echo "missing (skipped): $f"; fi
done
rm -rf "$out/tools" "$out/tests" "$out/node_modules" "$out/supabase" "$out/docs"
touch "$out/.nojekyll" # serve every file as is
# model URLs carry their version (js/asset-url.js): a new export is fetched at once, not the saved copy
git ls-tree -r HEAD assets | awk 'BEGIN { printf "// written by tools/deploy_pages.sh\nexport default {\n" } { printf "  \"%s\": \"%s\",\n", $4, substr($3, 1, 8) } END { print "};" }' > "$out/js/asset-versions.js"

cd "$out"
git init -q -b gh-pages
git add -A && git add -f assets/bike/bike.glb assets/rider/dummy.gltf assets/rider/dummy.bin assets/rider/head.glb # git-ignored in the source repo
git -c user.name="$(git -C "$root" config user.name)" -c user.email="$(git -C "$root" config user.email)" \
  commit -q -m "Deploy $(git -C "$root" rev-parse --short HEAD)"
git push -q -f "$(git -C "$root" remote get-url origin)" gh-pages
echo "Pushed to gh-pages from $(git -C "$root" rev-parse --short HEAD)"
