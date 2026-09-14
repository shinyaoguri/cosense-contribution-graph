/**
 * 記録を受け付ける日付の窓と、ビットマップの保持日数 (design §6、ADR-0012、ADR-0013 決定 2)。
 *
 * **day はクライアントのローカル日付** (ADR-0002)。サーバは UTC で動くので、時差の分だけ窓を広げる。
 * 地球上のローカル時刻は UTC−12 から UTC+14 に収まる。
 */
import { fromEpochDay, toEpochDay } from "../shared/graph.ts";

/** これより古い日は受け付けない。導入前の活動は遡らない (ADR-0012)。 */
export const ACCEPT_PAST_DAYS = 30;

/**
 * ビットマップ (daybits) の保持日数。Cron が消す。
 *
 * **受け付ける窓より十分長くする。** 受け付けた日のビットマップが必ず残っていれば、
 * マージした値がそのまま正しい集計値になる (`merge.ts`)。
 */
export const DAYBITS_RETENTION_DAYS = 90;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** 最も進んだタイムゾーン (UTC+14) と最も遅れたタイムゾーン (UTC−12)。 */
const MAX_AHEAD_MS = 14 * HOUR_MS;
const MAX_BEHIND_MS = 12 * HOUR_MS;

function utcEpochDay(ms: number): number {
  return Math.floor(ms / DAY_MS);
}

/**
 * 記録を受け付ける日か。
 *
 * - **未来の日を拒否する。** システム時計を進めるだけで未来の草が生えてしまう。
 *   ただし UTC+14 の地域では UTC の翌日がすでに今日なので、`(UTC 現在 + 14h) の日付` までは受ける
 * - **30 日より古い日を拒否する。** UTC−12 の地域の今日を基準に数える
 */
export function acceptsDay(day: string, nowMs: number): boolean {
  const target = toEpochDay(day);
  const latest = utcEpochDay(nowMs + MAX_AHEAD_MS);
  const earliest = utcEpochDay(nowMs - MAX_BEHIND_MS) - ACCEPT_PAST_DAYS;
  return target >= earliest && target <= latest;
}

/**
 * 共有 SVG の「今日」を決めるタイムゾーン。`users.tz` の既定 (design §5)。
 * **段階 4 で users を作るまでは全員これ。** day はクライアントのローカル日付なので、他の地域の利用者は
 * 今日の列が 1 日ずれて見えうる。
 */
export const DEFAULT_TIME_ZONE = "Asia/Tokyo";

/** `timeZone` での今日を `YYYY-MM-DD` で返す。 */
export function todayIn(timeZone: string, nowMs: number): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(nowMs));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/** これより前の日のビットマップを Cron が消す (この日は残す)。 */
export function daybitsCutoff(nowMs: number): string {
  return fromEpochDay(utcEpochDay(nowMs) - DAYBITS_RETENTION_DAYS);
}
