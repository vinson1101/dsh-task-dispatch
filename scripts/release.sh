#!/usr/bin/env bash
# 发布正式版：同时上传「带版本号」与「固定名」两个资产，并验证 latest 链接可用。
#
# 用法：
#   scripts/release.sh [release-notes.md]
#
# 为什么必须传两个：
#   - 带版本号（dsh-task-dispatch-0.6.2.tgz）：可钉住版本、可追溯
#   - 固定名（dsh-task-dispatch.tgz）：目录与 README 用的 latest 链接按字面取文件名，
#     名字里带版本号的话，下次发版就会 404
set -euo pipefail
cd "$(dirname "$0")/.."

PKG_NAME=$(node -p "require('./package.json').name")
VERSION=$(node -p "require('./package.json').version")
OWNER=$(gh repo view --json owner -q .owner.login)
TAG="v$VERSION"
VERSIONED="$PKG_NAME-$VERSION.tgz"
FIXED="$PKG_NAME.tgz"
NOTES="${1:-}"

echo "==> 发布 $PKG_NAME@$VERSION"

npm pack --cache "${NPM_CACHE:-/tmp/npmcache}" >/dev/null
cp "$VERSIONED" "$FIXED"

if ! git rev-parse "$TAG" >/dev/null 2>&1; then
  git tag -a "$TAG" -m "$PKG_NAME $VERSION"
fi
git push origin "$TAG"

if gh release view "$TAG" >/dev/null 2>&1; then
  echo "==> release 已存在，补充上传资产"
  gh release upload "$TAG" "$VERSIONED" "$FIXED" --clobber
elif [ -n "$NOTES" ]; then
  gh release create "$TAG" "$VERSIONED" "$FIXED" --title "$PKG_NAME $VERSION" --notes-file "$NOTES"
else
  gh release create "$TAG" "$VERSIONED" "$FIXED" --title "$PKG_NAME $VERSION" --generate-notes
fi

URL="https://github.com/$OWNER/$PKG_NAME/releases/latest/download/$FIXED"
echo "==> 验证 latest 链接 $URL"
code=$(curl -sIL -o /dev/null -m 40 -w '%{http_code}' "$URL")
if [ "$code" != "200" ]; then
  echo "失败：latest 链接返回 $code（检查 release 里是否有 $FIXED）" >&2
  exit 1
fi

tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
curl -sL -m 60 -o "$tmp" "$URL"
got=$(tar -xOf "$tmp" "package/package.json" | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).version")
if [ "$got" != "$VERSION" ]; then
  echo "失败：latest 下载到的版本是 $got，期望 $VERSION（latest 可能指向了旧 release）" >&2
  exit 1
fi

echo "==> 完成：latest 指向 $got"
