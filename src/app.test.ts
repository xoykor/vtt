// @vitest-environment jsdom
// Menu "Hospedar" without the Tauri bridge: clicking enters the local
// offline table as GM (same enterTable path as Tauri success) with a
// visible LOCAL-session note — never the Tauri-only dead-end.
import { afterEach, expect, test } from "vitest";
import { HOST_UNAVAILABLE_MESSAGE, LOCAL_SESSION_NOTE, startApp } from "./app";

function clickButton(root: HTMLElement, label: string): HTMLButtonElement {
  const btn = [...root.querySelectorAll("button")].find((b) =>
    b.textContent?.includes(label),
  );
  if (!btn) throw new Error(`button not found: ${label}`);
  (btn as HTMLButtonElement).click();
  return btn as HTMLButtonElement;
}

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI__;
});

test("Hospedar without Tauri enters the local table as GM", () => {
  const root = document.createElement("div");
  document.body.appendChild(root);
  try {
    startApp(root);
    clickButton(root, "Hospedar");
    // Same enterTable path as the Tauri success: table mounted, menu hidden.
    expect(root.querySelector(".app-content")).not.toBeNull();
    expect(
      (root.querySelector(".menu-container") as HTMLElement)?.style.display,
    ).toBe("none");
    // No dead-end hint anymore.
    expect(root.querySelector(".menu-status")?.textContent).not.toBe(
      HOST_UNAVAILABLE_MESSAGE,
    );
    // Visible LOCAL-session note inside the table (LAN guidance).
    const note = root.querySelector(".local-session-note");
    expect(note).not.toBeNull();
    expect(note?.textContent).toBe(LOCAL_SESSION_NOTE);
    expect(note?.textContent).toMatch(/LOCAL/);
    expect(note?.textContent).toMatch(/Tauri/);
    expect(note?.textContent).toMatch(/ZeroTier\/Radmin/);
  } finally {
    root.remove();
  }
});

test("Criar Ficha opens the fullscreen creator without the map", () => {
  const root = document.createElement("div");
  document.body.appendChild(root);
  try {
    startApp(root);
    clickButton(root, "Criar Ficha");
    expect(root.querySelector(".sheet-creator")).not.toBeNull();
    // Separate route: the table (map canvas) is not mounted yet.
    expect(root.querySelector(".app-content")).toBeNull();
    expect(
      (root.querySelector(".menu-container") as HTMLElement)?.style.display,
    ).toBe("none");

    // Cancelling returns to the menu.
    const creator = root.querySelector(".sheet-creator")!;
    creator.querySelector<HTMLButtonElement>(".creator-cancel")!.click();
    expect(root.querySelector(".sheet-creator")).toBeNull();
    expect(
      (root.querySelector(".menu-container") as HTMLElement)?.style.display,
    ).not.toBe("none");
  } finally {
    root.remove();
  }
});

test("saving a sheet from the creator opens the saved-character library", () => {
  const root = document.createElement("div");
  document.body.appendChild(root);
  try {
    startApp(root);
    clickButton(root, "Criar Ficha");
    root.querySelector<HTMLInputElement>(".creator-name")!.value = "Borin";
    root.querySelector<HTMLButtonElement>(".creator-save")!.click();
    expect(root.querySelector(".sheet-creator")).toBeNull();
    // No table/grid outside a session: the library is the destination.
    expect(root.querySelector(".char-library")).not.toBeNull();
    expect(root.querySelector(".app-content")).toBeNull();
    expect(root.querySelector("canvas")).toBeNull();
  } finally {
    root.remove();
  }
});
test("Hospedar with Tauri creates the room via create_room and opens the table", async () => {
  const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
  (window as unknown as Record<string, unknown>).__TAURI__ = {
    core: {
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        calls.push({ cmd, args });
        return "room-7000";
      },
    },
  };
  const root = document.createElement("div");
  document.body.appendChild(root);
  try {
    startApp(root);
    clickButton(root, "Hospedar");
    await new Promise((r) => setTimeout(r, 10));
    expect(calls[0]?.cmd).toBe("create_room");
    expect(root.querySelector(".app-content")).not.toBeNull();
    expect(root.querySelector(".menu-status")?.textContent).toMatch(
      /Sala hospedada/,
    );
  } finally {
    root.remove();
  }
});
