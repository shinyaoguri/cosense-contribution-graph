#!/usr/bin/env bash
# 配布ページ (Cosense の公開プロジェクト /cosense-grass) の script.js が、手元で作ったバンドルと
# バイト単位で一致するかを見る (Issue #47)。同じ commit から作ったバンドルは一致する。
#
#   scripts/check-distribution.sh <page> <bundle>
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
trap 'rm -f "$fetched"' EXIT

status="$(curl -sS --max-time 30 -o "$fetched" -w '%{http_code}' "${url}?nocache=$(date +%s)")" || {
  echo "NG: ${url} を取得できなかった" >&2
  exit 2
}
# file:// は状態コードを持たない (000)
if [[ "$status" != "200" && ! ( "$url" == file://* && "$status" == "000" ) ]]; then
  echo "NG: ${url} が ${status} を返した" >&2
  exit 2
fi

bundle_sha="$(sha256 "$bundle")"
bundle_bytes="$(bytes "$bundle")"
page_sha="$(sha256 "$fetched")"
page_bytes="$(bytes "$fetched")"

if [[ "$bundle_sha" == "$page_sha" ]]; then
  result="fresh"
  message="OK: 配布ページ ${page} は手元のバンドルと一致する"
else
  result="stale"
  message="NG: 配布ページ ${page} が手元のバンドルと違う"
fi

echo "$message"
echo "  バンドル     ${bundle_sha} (${bundle_bytes} バイト)"
echo "  配布ページ   ${page_sha} (${page_bytes} バイト) ${url}"

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  {
    echo "result=${result}"
    echo "url=${url}"
    echo "bundle_sha=${bundle_sha}"
    echo "bundle_bytes=${bundle_bytes}"
    echo "page_sha=${page_sha}"
    echo "page_bytes=${page_bytes}"
  } >>"$GITHUB_OUTPUT"
fi
if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  {
    echo "### ${message}"
    echo
    echo "| | SHA-256 | バイト |"
    echo "|---|---|---|"
    echo "| main から作ったバンドル | \`${bundle_sha}\` | ${bundle_bytes} |"
    echo "| [${page}](${url}) | \`${page_sha}\` | ${page_bytes} |"
  } >>"$GITHUB_STEP_SUMMARY"
fi

[[ "$result" == "fresh" ]] || exit 1
