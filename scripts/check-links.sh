#!/usr/bin/env bash
# Markdown 内の相対リンクが実在するかを検査する。
#
# 外部 URL は対象にしない。このリポジトリの docs は Cosense と Cloudflare の一次情報への
# 出典 URL を大量に持つので、到達性を CI で見ると先方の都合で赤くなり信用されなくなる。
# 出典の鮮度は docs/research.md の基準日付きの記述で人間が管理する。
set -uo pipefail

cd "$(dirname "$0")/.."

errors=$(
  find . -name '*.md' -not -path './.git/*' -not -path './node_modules/*' -print | while read -r md; do
    dir=$(dirname "$md")
    grep -oE '\]\([^)]+\)' "$md" 2>/dev/null | sed -E 's/^\]\(//; s/\)$//' | while read -r target; do
      case "$target" in
        http://* | https://* | mailto:* | '#'*) continue ;;
      esac
      path=${target%%#*}
      [ -z "$path" ] && continue
      [ -e "$dir/$path" ] || echo "  $md -> $target"
    done
  done
)

if [ -n "$errors" ]; then
  echo "リンク先が見つかりません:"
  echo "$errors"
  exit 1
fi

echo "Markdown の相対リンクはすべて解決できました"
