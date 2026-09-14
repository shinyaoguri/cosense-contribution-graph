-- 登録トークン (design §5、§6)。/auth/callback が発行し、/v1/enroll.gif が 1 回だけ使う。
--
-- **トークンそのものは保存しない。** SHA-256 の 16 進 64 桁だけを持つので、D1 が漏れても期限内のトークンで
-- 他人の uid に鍵を登録できない。トークンは 128 bit の乱数なので、ソルトも遅いハッシュも要らない。
--
-- 有効期限は 5 分。使ったら消し、使われなかったものは Cron が消す。表は常に小さいので expires に
-- インデックスを張らない (書き込みのたびに 1 行余分に数えられる。design §5)。
--
-- 発行する /auth/callback は OAuth クライアントが要るのでまだ無い (Issue #61)。それまでは空で、登録は全部 403 になる。
CREATE TABLE enroll_tokens (
  token_hash TEXT NOT NULL PRIMARY KEY,  -- SHA-256(トークン) の 16 進 64 桁
  uid        TEXT NOT NULL,
  expires    INTEGER NOT NULL            -- unix 秒。これ以下の時刻なら使える
) WITHOUT ROWID;
