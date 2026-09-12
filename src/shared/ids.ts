/**
 * UserScript と Worker の両方から使う識別子の規定。
 *
 * **このファイルは DOM lib と workerd lib の両方で型検査される**
 * (tsconfig.userscript.json と tsconfig.worker.json の両方が include する)。
 * どちらか片方にしか無いグローバルを使うと型検査が落ちるので、
 * ここには環境に依らないコードだけを置く。
 */

/**
 * プロジェクト識別子 `ph` の桁数。
 *
 * ADR-0007 決定 2 の改訂で 12 桁から 16 桁 (64 bit) に広げた。
 * `SHA-256(uid + ":" + プロジェクト名)` の先頭を取る。
 */
export const PH_LENGTH = 16;

/** 全プロジェクトの合算を表す予約値。 */
export const PH_ALL = "*";

const PH_PATTERN = new RegExp(`^[0-9a-f]{${PH_LENGTH}}$`);

/**
 * `ph` として受け付けてよい値かを判定する。
 *
 * 16 桁の小文字 16 進数か、合算を表す `*` のみ。
 * 大文字を弾くのは、同じプロジェクトが 2 行に分かれるのを防ぐため。
 */
export function isValidPh(value: string): boolean {
  return value === PH_ALL || PH_PATTERN.test(value);
}
