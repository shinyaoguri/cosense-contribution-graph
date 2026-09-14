-- 記録の受け口 /v1/p.gif と共有 SVG が使うテーブル (design §5)。
--
-- **users と keys はまだ作らない。** 段階 4 (Google サインインとデバイス登録) で形が決まる。
-- 段階 4 までの書き込みは試験用の公開鍵 1 本で検証する (Issue #36)。

-- 共有 URL の解決表。全体用 (ph = '*') とプロジェクト別が混在する。
-- uid にインデックスを張らない (書き込みが 1 行余分にカウントされる。design §5)
CREATE TABLE graphs (
  public_id TEXT PRIMARY KEY,
  uid       TEXT NOT NULL,
  ph        TEXT NOT NULL
) WITHOUT ROWID;

-- 集計値。永続 (ADR-0013 決定 2)
CREATE TABLE daily (
  uid     TEXT NOT NULL,
  ph      TEXT NOT NULL,
  day     TEXT NOT NULL,
  w       INTEGER NOT NULL DEFAULT 0,
  r       INTEGER NOT NULL DEFAULT 0,
  pages   INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (uid, ph, day)
) WITHOUT ROWID;

-- 冪等マージ用のビットマップ。Cron で 90 日より古いものを削除する。
-- 行が 360 バイトを超えるので WITHOUT ROWID にしない (design §5)
CREATE TABLE daybits (
  uid   TEXT NOT NULL,
  ph    TEXT NOT NULL,
  day   TEXT NOT NULL,
  wbits BLOB NOT NULL,
  rbits BLOB NOT NULL,
  PRIMARY KEY (uid, ph, day)
);
