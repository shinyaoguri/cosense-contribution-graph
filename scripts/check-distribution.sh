#!/usr/bin/env bash
# 配布ページ (Cosense の公開プロジェクト /cosense-grass) の script.js が、手元で作ったバンドルと
# バイト単位で一致するかを見る (Issue #47)。同じ commit から作ったバンドルは一致する。
#
# **比べる前に、手元のバンドルから末尾の改行 1 つを落とす** (Issue #105)。Cosense はページを行の配列で
# 持つので、配信される script.js には末尾の改行が無い。落とさずに比べると**どれだけ正しく貼っても
# 永久に「違う」と言い続ける** (実際 #60 はそれで開いたままだった)。
#
#   scripts/check-distribution.sh <page> <bundle>
#
# **比べるのは先頭の指紋の行 (`// cosense-grass build ...`) を除いた本体** (scripts/bundle-fingerprint.ts)。
# 指紋には commit が入り、コードが同じでも main が進むたびに変わる。含めて比べると、docs だけの commit でも
# 「古い」と知らせ、`npm run paste` が同じコードを貼り直す。配布ページの指紋が自分の本体と合わなければ、
# 手で編集されたなどで指紋を信じられないので、そう添える (一致の判定は本体で行うので変わらない)。
#
# 終了コード: 0 = 一致 / 1 = 違う (配布ページが古い) / 2 = 取得できなかった (見張りの失敗)
#
# **外部 URL を見るので `npm run check` からは呼ばない** (check-links.sh と同じ方針)。
# 呼ぶのは .github/workflows/distribution.yml だけで、required の検査にしない。
#
# 環境変数
# - DISTRIBUTION_BASE  取得先のベース (既定 https://scrapbox.io/api/code/cosense-grass)。
#                      ローカルで file:// を指して一致・不一致を試すため
# - GITHUB_OUTPUT / GITHUB_STEP_SUMMARY  あれば結果を書く (Actions の中)
set -euo pipefail

page="${1:?ページ名を渡す (例: dev)}"
bundle="${2:?バンドルのパスを渡す (例: dist/userscript.js)}"
base="${DISTRIBUTION_BASE:-https://scrapbox.io/api/code/cosense-grass}"

if [[ ! -f "$bundle" ]]; then
  echo "NG: バンドル ${bundle} が無い (npm run build:userscript を先に走らせる)" >&2
  exit 2
fi

sha256() {
  if command -v sha256sum >/dev/null; then
    sha256sum "$1" | cut -d ' ' -f 1
  else
    shasum -a 256 "$1" | cut -d ' ' -f 1
  fi
}

bytes() {
  wc -c <"$1" | tr -d ' '
}

# **キャッシュを避けるクエリを付ける。** /api/code/... はエッジに 2 時間キャッシュされ (research §2)、
# 付けないと貼った直後から最長 2 時間は古い中身を見て「古い」と誤って知らせる。
# 利用者に届くまでの遅れは見ない (利用者が同じキャッシュを通るかは未確認)
url="${base}/${page}/script.js"
fetched="$(mktemp)"

status="$(curl -sS --max-time 30 -o "$fetched" -w '%{http_code}' "${url}?nocache=$(date +%s)")" || {
  echo "NG: ${url} を取得できなかった" >&2
  exit 2
}
# file:// は状態コードを持たない (000)
if [[ "$status" != "200" && ! ( "$url" == file://* && "$status" == "000" ) ]]; then
  echo "NG: ${url} が ${status} を返した" >&2
  exit 2
fi

# 指紋の行と末尾の改行 1 つを落とした本体で比べる (上記)。指紋の本体も同じ形から計算している
normalized="$(mktemp)"
page_body="$(mktemp)"
trap 'rm -f "$fetched" "$normalized" "$page_body"' EXIT
body() {
  perl -0pe 's/\A\/\/ cosense-grass build [^\n]*\n//; s/\n\z//' "$1"
}
body "$bundle" >"$normalized"
body "$fetched" >"$page_body"

# 先頭行の指紋 (無ければ空)。表示用で、一致の判定には使わない
fingerprint() {
  head -n 1 "$1" | perl -ne 'print $1 if /^\/\/ cosense-grass build (.*)$/'
}
bundle_fingerprint="$(fingerprint "$bundle")"
page_fingerprint="$(fingerprint "$fetched")"

bundle_sha="$(sha256 "$normalized")"
bundle_bytes="$(bytes "$normalized")"
page_sha="$(sha256 "$page_body")"
page_bytes="$(bytes "$page_body")"

if [[ "$bundle_sha" == "$page_sha" ]]; then
  result="fresh"
  message="OK: 配布ページ ${page} は手元のバンドルと一致する"
else
  result="stale"
  message="NG: 配布ページ ${page} が手元のバンドルと違う"
fi

echo "$message"
echo "  バンドル     ${bundle_sha} (${bundle_bytes} バイト。指紋の行と末尾の改行を落とした姿)"
echo "               build ${bundle_fingerprint:-(指紋なし)}"
echo "  配布ページ   ${page_sha} (${page_bytes} バイト) ${url}"
echo "               build ${page_fingerprint:-(指紋なし)}"
# 配布ページの指紋が自分の本体と合うか。合わなければ、ページを見た人が指紋を信じると取り違える
if [[ -n "$page_fingerprint" && "${page_fingerprint:0:12}" != "${page_sha:0:12}" ]]; then
  echo "  注意: 配布ページの指紋 ${page_fingerprint:0:12} が本体 (${page_sha:0:12}) と合わない。手で編集されたかもしれない"
fi

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  {
    echo "result=${result}"
    echo "url=${url}"
    echo "bundle_sha=${bundle_sha}"
    echo "bundle_bytes=${bundle_bytes}"
    echo "page_sha=${page_sha}"
    echo "page_bytes=${page_bytes}"
    echo "bundle_fingerprint=${bundle_fingerprint}"
    echo "page_fingerprint=${page_fingerprint}"
  } >>"$GITHUB_OUTPUT"
fi
if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  {
    echo "### ${message}"
    echo
    echo "| | SHA-256 | バイト | 指紋 |"
    echo "|---|---|---|---|"
    echo "| main から作ったバンドル (指紋の行と末尾の改行を落とした姿) | \`${bundle_sha}\` | ${bundle_bytes} | \`${bundle_fingerprint:-なし}\` |"
    echo "| [${page}](${url}) | \`${page_sha}\` | ${page_bytes} | \`${page_fingerprint:-なし}\` |"
  } >>"$GITHUB_STEP_SUMMARY"
fi

[[ "$result" == "fresh" ]] || exit 1
