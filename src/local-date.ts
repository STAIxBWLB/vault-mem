/**
 * The local calendar date as YYYY-MM-DD, from the same local clock the vault log lines use (`log-format.ts`).
 * Every user-facing calendar date (report names, trend rows, L11 staleness, `promoted_at`, skill reports) comes from here,
 * so an early-morning run in a timezone ahead of UTC is not dated the previous day.
 */
export function localDate(now: Date = new Date()): string {
  const pad = (value: number, size = 2) => String(value).padStart(size, "0");
  return `${pad(now.getFullYear(), 4)}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
