// @vitest-environment jsdom
import { expect, test, vi } from "vitest";
import {
  canSeeChat,
  decodeChat,
  encodeChat,
  parseChatInput,
  parseDiceExpr,
  publishChat,
  renderChatPanel,
  type ChatMessage,
} from "./chat";
import { createOfflineRoom } from "./room";

function msg(over: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "1",
    ts: 1000,
    from: "Borin",
    kind: "say",
    text: "olá",
    ...over,
  };
}

test("dice expressions parse NdX+m (missing count means 1)", () => {
  expect(parseDiceExpr("d20")).toEqual({ count: 1, sides: 20, mod: 0 });
  expect(parseDiceExpr("2d6+3")).toEqual({ count: 2, sides: 6, mod: 3 });
  expect(parseDiceExpr("4d8-2")).toEqual({ count: 4, sides: 8, mod: -2 });
  expect(parseDiceExpr("D12")).toEqual({ count: 1, sides: 12, mod: 0 });
  expect(parseDiceExpr(" prints")).toBeNull();
  expect(parseDiceExpr("2d")).toBeNull();
  expect(parseDiceExpr("0d6")).toBeNull();
  expect(parseDiceExpr("abc")).toBeNull();
});

test("chat commands parse to kinds (plain text is speech)", () => {
  expect(parseChatInput("olá pessoal")).toEqual({ kind: "say", text: "olá pessoal" });
  expect(parseChatInput("/em acena").kind).toBe("emote");
  expect(parseChatInput("/me acena").kind).toBe("emote");
  expect(parseChatInput("/ooc preciso sair").kind).toBe("ooc");
  expect(parseChatInput("/desc Uma porta range")).toEqual({ kind: "desc", text: "Uma porta range" });
  const whisper = parseChatInput("/w Gandalf venha cá");
  expect(whisper.kind).toBe("whisper");
  expect(whisper.target).toBe("Gandalf");
  expect(whisper.text).toBe("venha cá");
  const roll = parseChatInput("/r 2d6+3");
  expect(roll.kind).toBe("roll");
  expect(roll.dice).toEqual({ count: 2, sides: 6, mod: 3 });
  expect(parseChatInput("/gmroll d20").kind).toBe("gmroll");
  expect(parseChatInput("/gr d20").kind).toBe("gmroll");
  // Incomplete commands report an error instead of sending text.
  expect(parseChatInput("/w").error).toMatch(/uso/i);
  expect(parseChatInput("/r banana").error).toMatch(/\/r NdX/i);
  expect(parseChatInput("/xyz algo").error).toMatch(/desconhecido/i);
});

test("whispers and gm rolls stay hidden from other players (fail-closed)", () => {
  const whisper = msg({ kind: "whisper", target: "Gandalf" });
  expect(canSeeChat(whisper, { isGM: true, name: "Mestre" })).toBe(true);
  expect(canSeeChat(whisper, { isGM: false, name: "Gandalf" })).toBe(true);
  expect(canSeeChat(whisper, { isGM: false, name: "Borin" })).toBe(true); // sender
  expect(canSeeChat(whisper, { isGM: false, name: "Curioso" })).toBe(false);
  const gmroll = msg({ kind: "gmroll" });
  expect(canSeeChat(gmroll, { isGM: true, name: "Mestre" })).toBe(true);
  expect(canSeeChat(gmroll, { isGM: false, name: "Borin" })).toBe(false);
  expect(canSeeChat(msg(), { isGM: false, name: "Qualquer" })).toBe(true);
});

test("chat messages encode/decode through chat:<ts> keys", () => {
  const original = msg({ kind: "roll", text: "2d6+3" });
  const json = encodeChat(original);
  expect(decodeChat(json)).toEqual(original);
  expect(() => decodeChat("{broken")).toThrow();
  expect(() => decodeChat(JSON.stringify({ kind: "say" }))).toThrow();
  expect(() => decodeChat(JSON.stringify(msg({ kind: "portal" })))).toThrow();
});

test("publish broadcasts as chat:<ts> and denies unknown roles", () => {
  const room = createOfflineRoom([]);
  expect(publishChat(room, msg({ ts: 42 }), "player")).toBe(true);
  expect(room.getState()["chat:42"]).toContain("olá");
  expect(publishChat(room, msg({ ts: 43 }), "ghost")).toBe(false);
  expect(room.getState()["chat:43"]).toBeUndefined();
  // Guests (players on the network path) may talk.
  expect(publishChat(room, msg({ ts: 44 }), "guest")).toBe(true);
});

test("panel sends on Enter, keeps Shift+Enter as newline, shows speaking name", () => {
  const room = createOfflineRoom([]);
  const box = document.createElement("div");
  const panel = renderChatPanel(box, { speaker: "Borin", role: "player", room });
  const input = box.querySelector<HTMLTextAreaElement>("[data-testid=chat-input]")!;
  const log = box.querySelector("[data-testid=chat-log]")!;

  input.value = "olá";
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  expect(log.textContent).toMatch(/Borin/);
  expect(log.textContent).toMatch(/olá/);
  expect(room.getState()["chat:" + panel.messages()[0].ts]).toContain("olá");

  // Shift+Enter writes a newline instead of sending.
  const before = panel.messages().length;
  input.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true }),
  );
  expect(panel.messages()).toHaveLength(before);
});

test("emote, whisper and desc render with their own styling hooks", () => {
  const box = document.createElement("div");
  renderChatPanel(box, { speaker: "Borin" });
  const log = box.querySelector("[data-testid=chat-log]")!;
  const input = box.querySelector<HTMLTextAreaElement>("[data-testid=chat-input]")!;
  for (const text of ["/em acena", "/w Gandalf psiu", "/desc Luzes se apagam"]) {
    input.value = text;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  }
  // Non-GM /desc is denied fail-closed (only the GM narrates centered).
  const kinds = [...log.querySelectorAll("[data-testid=chat-msg]")].map(
    (n) => (n as HTMLElement).dataset.kind,
  );
  expect(kinds).toEqual(["emote", "whisper"]);
  expect(log.textContent).toMatch(/para Gandalf/);
});

test("public roll shows a breakdown+total card with clickable expand", () => {
  const box = document.createElement("div");
  // Fixed rng: faces predictable (0.5 on d6 -> 4).
  renderChatPanel(box, { speaker: "Borin", rng: () => 0.5 });
  const input = box.querySelector<HTMLTextAreaElement>("[data-testid=chat-input]")!;
  input.value = "/r 2d6+3";
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  const card = box.querySelector("[data-testid=roll-card]")!;
  expect(card.textContent).toMatch(/11/); // 4+4+3
  const detail = box.querySelector("[data-testid=roll-detail]")!;
  expect(detail.hasAttribute("hidden")).toBe(true);
  box.querySelector<HTMLButtonElement>("[data-testid=roll-toggle]")!.click();
  expect(detail.hasAttribute("hidden")).toBe(false);
  expect(detail.textContent).toMatch(/4/);
});

test("gmroll from a non-GM is denied and never broadcast", () => {
  const room = createOfflineRoom([]);
  const onBroadcast = vi.fn();
  const box = document.createElement("div");
  renderChatPanel(box, { speaker: "Borin", isGM: false, role: "player", room, onBroadcast });
  const input = box.querySelector<HTMLTextAreaElement>("[data-testid=chat-input]")!;
  input.value = "/gmroll d20";
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  expect(box.querySelector("[data-testid=chat-status]")!.textContent).toMatch(/mestre/i);
  expect(Object.keys(room.getState()).filter((k) => k.startsWith("chat:"))).toEqual([]);
  expect(onBroadcast).not.toHaveBeenCalled();
});
