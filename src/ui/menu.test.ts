// @vitest-environment jsdom
// Menu wiring for the vault backdrop: canvas lifecycle on hide/show and
// the persisted mute toggle.
import { afterEach, expect, test } from "vitest";
import { MENU_MUTED_KEY, createMenu } from "./menu";

const handlers = {
  onHost: () => undefined,
  onJoin: () => undefined,
  onCreateSheet: () => undefined,
  onOpenLibrary: () => undefined,
};

afterEach(() => {
  window.localStorage?.removeItem(MENU_MUTED_KEY);
  document.body.innerHTML = "";
});

function muteButton(root: HTMLElement): HTMLButtonElement {
  const btn = root.querySelector<HTMLButtonElement>(".menu-mute-btn");
  if (!btn) throw new Error("mute button missing");
  return btn;
}

test("menu mounts the backdrop canvas and an unmuted toggle by default", () => {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const menu = createMenu(root, handlers);
  try {
    expect(root.querySelector("canvas.menu-backdrop-canvas")).not.toBeNull();
    expect(root.querySelector(".menu-backdrop-overlay")).not.toBeNull();
    const btn = muteButton(root);
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    expect(btn.textContent).toBe("🔊");
  } finally {
    menu.hide();
  }
});

test("mute toggle persists the choice and later menus start muted", () => {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const menu = createMenu(root, handlers);
  try {
    muteButton(root).click();
    expect(window.localStorage.getItem(MENU_MUTED_KEY)).toBe("1");
    const btn = muteButton(root);
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    expect(btn.textContent).toBe("🔇");
  } finally {
    menu.hide();
  }

  const root2 = document.createElement("div");
  document.body.appendChild(root2);
  const menu2 = createMenu(root2, handlers);
  try {
    expect(muteButton(root2).getAttribute("aria-pressed")).toBe("true");
  } finally {
    menu2.hide();
  }
});

test("hide removes the backdrop canvas; show mounts it again", () => {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const menu = createMenu(root, handlers);
  try {
    expect(root.querySelector("canvas")).not.toBeNull();
    menu.hide();
    expect(root.querySelector("canvas")).toBeNull();
    menu.show();
    expect(root.querySelector("canvas.menu-backdrop-canvas")).not.toBeNull();
  } finally {
    menu.hide();
  }
});
