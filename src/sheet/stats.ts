// Ability modifiers and initiative totals (pure, hermetic). Shared by
// the sheet panel and the sheet creator so rolls stay consistent.

/** Standard 5e ability modifier: floor((score - 10) / 2). */
export function abilityMod(score: number): number {
  return Math.floor((score - 10) / 2);
}

/** Signed modifier text (`+3` / `-1`). */
export function modText(mod: number): string {
  return mod >= 0 ? `+${mod}` : `${mod}`;
}

/** Initiative total: dex modifier plus the sheet's misc bonus. */
export function initiativeTotal(dexScore: number, misc: number): number {
  return abilityMod(dexScore) + misc;
}
