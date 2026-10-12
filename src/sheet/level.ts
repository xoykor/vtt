// Proficiency bonus derived from character level (pure, hermetic).
// 5e table: 2 + floor((level - 1) / 4). Fractional levels use the band
// they sit in; levels below 1 clamp to 1. No WotC text, just the table.

/** Proficiency bonus for `level` (2 at lv 1-4, +1 every 4 levels). */
export function profBonusForLevel(level: number): number {
  if (typeof level !== "number" || !Number.isFinite(level)) {
    throw new Error(`invalid level: ${String(level)}`);
  }
  const clamped = Math.max(1, Math.floor(level));
  return 2 + Math.floor((clamped - 1) / 4);
}
