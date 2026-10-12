// @vitest-environment jsdom
// Fullscreen sheet creator: Roll20 tabs, derived proficiency, save
// builds a Sheet with an ownerId.
import { expect, test } from "vitest";
import type { Sheet } from "../sheet/types";
import { createSheetCreator } from "./sheet-creator";

function setup(ownerId = "p2"): {
  el: HTMLElement;
  saved: Sheet[];
  cancelled: number;
} {
  const saved: Sheet[] = [];
  let cancelled = 0;
  const { el } = createSheetCreator({
    ownerId,
    onSave: (s) => saved.push(s),
    onCancel: () => {
      cancelled += 1;
    },
  });
  document.body.appendChild(el);
  return { el, saved, cancelled };
}

function teardown(el: HTMLElement): void {
  el.remove();
}

test("creator shows the four Roll20 tabs with Atributos first", () => {
  const { el } = setup();
  try {
    const tabs = [...el.querySelectorAll<HTMLButtonElement>(".creator-tab")].map(
      (b) => b.textContent,
    );
    expect(tabs).toEqual(["Atributos", "Perícias", "Magias/Equip", "Bio/Notas"]);
    expect(
      el.querySelector<HTMLElement>('[data-tab-panel="atributos"]')?.style.display,
    ).not.toBe("none");
    expect(
      el.querySelector<HTMLElement>('[data-tab-panel="pericias"]')?.style.display,
    ).toBe("none");
  } finally {
    teardown(el);
  }
});

test("clicking a tab switches the visible panel", () => {
  const { el } = setup();
  try {
    const tab = [...el.querySelectorAll<HTMLButtonElement>(".creator-tab")].find(
      (b) => b.textContent === "Perícias",
    )!;
    tab.click();
    expect(
      el.querySelector<HTMLElement>('[data-tab-panel="pericias"]')?.style.display,
    ).not.toBe("none");
    expect(
      el.querySelector<HTMLElement>('[data-tab-panel="atributos"]')?.style.display,
    ).toBe("none");
  } finally {
    teardown(el);
  }
});

test("level 5 derives proficiency +3 and save carries the ownerId", () => {
  const { el, saved } = setup("p2");
  try {
    el.querySelector<HTMLInputElement>(".creator-name")!.value = "Borin";
    const level = el.querySelector<HTMLInputElement>(".creator-level")!;
    level.value = "5";
    level.dispatchEvent(new Event("input"));
    expect(el.querySelector(".creator-prof")?.textContent).toContain("+3");

    el.querySelector<HTMLButtonElement>(".creator-save")!.click();
    expect(saved).toHaveLength(1);
    const sheet = saved[0];
    expect(sheet.name).toBe("Borin");
    expect(sheet.ownerId).toBe("p2");
    expect(sheet.level).toBe(5);
    expect(sheet.profBonus).toBe(3);
    expect(Object.keys(sheet.abilities ?? {})).toHaveLength(6);
    expect(sheet.skills).toHaveLength(17);
  } finally {
    teardown(el);
  }
});

test("cancel calls onCancel without saving", () => {
  const { el, saved } = setup();
  try {
    el.querySelector<HTMLButtonElement>(".creator-cancel")!.click();
    expect(saved).toHaveLength(0);
  } finally {
    teardown(el);
  }
});
