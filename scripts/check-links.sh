#!/usr/bin/env bash
# Markdown 内の相対リンクが実在するかを検査する。
#
# 外部 URL は対象にしない。このリポジトリの docs は Cosense と Cloudflare の一次情報への
# 出典 URL を大量に持つので、到達性を CI で見ると先方の都合で赤くなり信用されなくなる。
# 出典の鮮度は docs/research.md の基準日付きの記述で人間が管理する。
set -uo pipefail

cd "$(dirname "$0")/.."

# コードフェンスの中身とインラインコードを落として標準出力へ出す (Issue #121)。
# 正規表現の `[...](...)` がリンクの記法と同じ形になるので、コードの中はリンクではない。
# - フェンスは ``` と ~~~。閉じるのは、同じ文字で、開いたときより短くない行だけ
#   (4 つのバッククォートで開いた中にある 3 つのフェンスでは閉じない)
# - インラインコードは `...` を消す。`[`code`](path)` は `[](path)` になり、リンク先は検査され続ける
strip_code() {
  awk '
    {
      s = $0
      sub(/^[ \t]+/, "", s)
      c = substr(s, 1, 1)
      n = 0
      if (c == "`" || c == "~") {
        while (substr(s, n + 1, 1) == c) n++
      }
      rest = substr(s, n + 1)
      # バッククォートのフェンスの info 文字列は、バッククォートを含められない
      if (n >= 3 && !(c == "`" && !in_fence && index(rest, "`") > 0)) {
        if (!in_fence) {
          in_fence = 1; fence_char = c; fence_len = n
          next
        }
        if (c == fence_char && n >= fence_len && rest ~ /^[ \t]*$/) {
          in_fence = 0
          next
        }
      }
      if (!in_fence) print
    }
  ' "$1" | sed -E 's/`[^`]*`//g'
}

errors=$(
  find . -name '*.md' -not -path './.git/*' -not -path './node_modules/*' -print | while read -r md; do
    dir=$(dirname "$md")
    strip_code "$md" 2>/dev/null | grep -oE '\]\([^)]+\)' | sed -E 's/^\]\(//; s/\)$//' | while read -r target; do
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

# ADR は 1 件 1 ファイルなので、足したファイルを一覧に載せ忘れると索引から辿れなくなる (Issue #149)
unlisted=$(
  for adr in docs/decisions/[0-9][0-9][0-9][0-9]-*.md; do
    name=$(basename "$adr")
    grep -qF "]($name)" docs/decisions/README.md || echo "  $adr"
  done
)

if [ -n "$unlisted" ]; then
  echo "docs/decisions/README.md の一覧に載っていない ADR があります:"
  echo "$unlisted"
  exit 1
fi

echo "Markdown の相対リンクはすべて解決できました"
