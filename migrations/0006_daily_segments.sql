-- 時間帯の区間ごとの分の数 (design §5、Issue #208)。
--
-- 区間は暦の日 (クライアントのローカル日付) の 0–9 / 9–13 / 13–18 / 18–24 時で、sw0..sw3 が書いた分 (w)、
-- sr0..sr3 が読んだだけの分 (r & ~w)。受け口がマージした後のビットマップから数え、区間ごとに w と合計を max で守る。
-- **NULL は「時間帯の内訳なし」で、0 分とは区別する** (既定 NULL)。8 列はそろって NULL か、そろって値を持つ。
-- 既存の行は NULL で入り、Cron が daybits の残る範囲 (90 日) だけ遡って埋める。それより古い行は NULL のまま。
ALTER TABLE daily ADD COLUMN sw0 INTEGER;
ALTER TABLE daily ADD COLUMN sw1 INTEGER;
ALTER TABLE daily ADD COLUMN sw2 INTEGER;
ALTER TABLE daily ADD COLUMN sw3 INTEGER;
ALTER TABLE daily ADD COLUMN sr0 INTEGER;
ALTER TABLE daily ADD COLUMN sr1 INTEGER;
ALTER TABLE daily ADD COLUMN sr2 INTEGER;
ALTER TABLE daily ADD COLUMN sr3 INTEGER;
