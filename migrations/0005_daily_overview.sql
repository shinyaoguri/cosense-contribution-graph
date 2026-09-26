-- 活動の概観 (4 軸) の集計値 (design §4・§5、ADR-0021、Issue #151)。
--
-- 作る (wc) と関わる (wo) は分の数、links は作ったリンクの件数。**ビットマップは持たない** (送るのは数だけ) ので、
-- pages / created と同じく max で守る。育てるは w − wc − wo から出す (0 で打ち切る) ので列を持たない。
-- 既存の行は 0 のまま (遡って分けられない)。
ALTER TABLE daily ADD COLUMN wc INTEGER NOT NULL DEFAULT 0;
ALTER TABLE daily ADD COLUMN wo INTEGER NOT NULL DEFAULT 0;
ALTER TABLE daily ADD COLUMN links INTEGER NOT NULL DEFAULT 0;
