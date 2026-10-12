// @vitest-environment jsdom
// Menu "Hospedar" without the Tauri bridge: clicking must show the
// setup guidance (never call invoke, never leave an empty status).
import { afterEach, expect, test } from "vitest";
import { HOST_UNAVAILABLE_MESSAGE, startApp } from "./app";

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

test("Hospedar without Tauri shows the installer guidance", () => {
  const root = document.createElement("div");
  document.body.appendChild(root);
  try {
    startApp(root);
    clickButton(root, "Hospedar");
    const status = root.querySelector(".menu-status");
    expect(status?.textContent).toBe(HOST_UNAVAILABLE_MESSAGE);
    expect(status?.classList.contains("error")).toBe(true);
    // The menu stays up: the user can still create a sheet offline.
    expect(
      (root.querySelector(".menu-container") as HTMLElement)?.style.display,
    ).not.toBe("none");
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
