-- デバイスごとの公開鍵 (design §5)。/v1/p.gif の署名を (uid, kid) で引いて検証する。
--
-- **記録の疎通確認の試験用の公開鍵 (どの uid にも書けた) を消すために、段階 4 より先に作る** (Issue #54)。
-- 行を入れるデバイス登録 (/v1/enroll.gif) は段階 4 なので、それまでは空で、記録は全部 403 になる。
--
-- **last_seen はまだ作らない。** 送信のたびの書き込みになり、D1 Free の書き込み予算 (design §11) に
-- 入っていない。users と一緒に段階 4 で決める。
-- 行は約 120 バイトで小さいので WITHOUT ROWID にする (design §5)
CREATE TABLE keys (
  uid     TEXT NOT NULL,
  kid     TEXT NOT NULL,
  pubkey  BLOB NOT NULL,     -- 65 バイトの非圧縮 SEC1
  created INTEGER NOT NULL,  -- unix 秒
  PRIMARY KEY (uid, kid)
) WITHOUT ROWID;
