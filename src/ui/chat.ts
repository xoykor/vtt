// Table chat panel (right side, toggleable): message log + input.
// Commands: plain speech, `/em` emote, `/ooc` out-of-character,
// `/w <name> msg` whisper, `/r NdX+m` public roll (resolved with the
// existing `resolveRoll`, shown as a breakdown+total card with a
// clickable expand), `/gmroll` (GM-only visibility) and `/desc`
// (GM-only centered narration). Enter sends, Shift+Enter writes a
// newline, and the speaker name is the current character ("speaking
// as"). Messages also broadcast over the existing delta transport as
// `chat:<ts>` keys: best-effort (transport errors never break the
// local log) and fail-closed for unknown roles, which stay local.
// Whispers and GM rolls stay hidden from other players. Pure DOM +
// the ready dice/peer primitives; no new dependencies.

import { resolveRoll, type RngLike, type RollResult } from "../dice/roller";
import type { Delta } from "../net/peer";
import type { OfflineRoom } from "./room";

/** Message kinds the log renders (each has its own styling hook). */
export type ChatKind = "say" | "emote" | "ooc" | "whisper" | "roll" | "gmroll" | "desc";

export interface DiceRequest {
  count: number;
  sides: number;
  mod: number;
}

export interface ChatMessage {
  /** Unique id (`<ts>-<seq>`). */
  id: string;
  /** Millis timestamp; also the broadcast key suffix. */
  ts: number;
  /** Speaking-as name (current character or display name). */
  from: string;
  kind: ChatKind;
  text: string;
  /** Whisper recipient (whispers only). */
  target?: string;
  /** Resolved dice (roll/gmroll only). */
  roll?: RollResult;
}

const CHAT_PREFIX = "chat:";

/** Roles allowed to broadcast (everyone at a real table may talk). */
const SPEAKING_ROLES = new Set(["host", "gm", "player", "guest"]);

/**
 * Parse a dice expression like `2d6+3` / `d20` / `4d8-2`.
 * Null when it is not dice (fail-closed: never guess).
 */
export function parseDiceExpr(expr: string): DiceRequest | null {
  const m = /^\s*(\d*)\s*[dD]\s*(\d+)\s*([+-]\s*\d+)?\s*$/.exec(expr);
  if (!m) return null;
  const count = m[1] === "" ? 1 : Number(m[1]);
  const sides = Number(m[2]);
  const mod = m[3] === undefined ? 0 : Number(m[3].replace(/\s+/g, ""));
  if (!Number.isInteger(count) || count < 1) return null;
  if (!Number.isInteger(sides) || sides < 2) return null;
  if (!Number.isFinite(mod)) return null;
  return { count, sides, mod };
}

export interface ParsedInput {
  kind?: ChatKind;
  text?: string;
  target?: string;
  dice?: DiceRequest;
  /** Set when the line cannot be sent (usage hint for the status line). */
  error?: string;
}

/**
 * Parse one input line into a command. Plain text is speech; unknown
 * `/commands` and incomplete commands return `{ error }` so the panel
 * can explain instead of sending garbage.
 */
export function parseChatInput(raw: string): ParsedInput {
  const line = raw.trim();
  if (!line.startsWith("/")) return { kind: "say", text: line };
  const space = line.indexOf(" ");
  const cmd = (space === -1 ? line : line.slice(0, space)).toLowerCase();
  const rest = space === -1 ? "" : line.slice(space + 1).trim();
  switch (cmd) {
    case "/em":
    case "/me":
      if (!rest) return { error: "Uso: /em <ação> — ex. /em acena." };
      return { kind: "emote", text: rest };
    case "/ooc":
      if (!rest) return { error: "Uso: /ooc <mensagem>." };
      return { kind: "ooc", text: rest };
    case "/w":
    case "/whisper": {
      const gap = rest.indexOf(" ");
      if (gap === -1) return { error: "Uso: /w <nome> <mensagem>." };
      const target = rest.slice(0, gap).trim();
      const text = rest.slice(gap + 1).trim();
      if (!target || !text) return { error: "Uso: /w <nome> <mensagem>." };
      return { kind: "whisper", target, text };
    }
    case "/r":
    case "/roll": {
      const dice = parseDiceExpr(rest);
      if (!dice) return { error: "Uso: /r NdX+m — ex. /r 2d6+3." };
      return { kind: "roll", text: rest.replace(/\s+/g, ""), dice };
    }
    case "/gmroll":
    case "/gr": {
      const dice = parseDiceExpr(rest);
      if (!dice) return { error: "Uso: /gmroll NdX+m — ex. /gmroll d20." };
      return { kind: "gmroll", text: rest.replace(/\s+/g, ""), dice };
    }
    case "/desc":
      if (!rest) return { error: "Uso: /desc <narração do mestre>." };
      return { kind: "desc", text: rest };
    default:
      return { error: `Comando desconhecido: ${cmd}. Tente /r, /w, /em, /ooc.` };
  }
}

/**
 * True when `viewer` may read `msg`. GM rolls are GM-only; whispers
 * reach the GM, the recipient and the sender; narration and public
 * lines reach everyone (fail-closed for strangers: unknown viewers
 * never see whispers or GM rolls).
 */
export function canSeeChat(msg: ChatMessage, viewer: { isGM: boolean; name: string }): boolean {
  switch (msg.kind) {
    case "gmroll":
      return viewer.isGM;
    case "whisper":
      return viewer.isGM || viewer.name === msg.target || viewer.name === msg.from;
    default:
      return true;
  }
}

/** Canonical broadcast key for a message: `chat:<ts>`. */
export function chatKey(ts: number): string {
  return `${CHAT_PREFIX}${ts}`;
}

/** True for keys in the chat partition. */
export function isChatKey(key: string): boolean {
  return key.startsWith(CHAT_PREFIX);
}

/** Encode a message as one JSON RoomState value. */
export function encodeChat(msg: ChatMessage): string {
  return JSON.stringify(msg);
}

function isChatKind(value: unknown): value is ChatKind {
  return (
    value === "say" ||
    value === "emote" ||
    value === "ooc" ||
    value === "whisper" ||
    value === "roll" ||
    value === "gmroll" ||
    value === "desc"
  );
}

/** Decode + validate a chat value (throws on anything malformed). */
export function decodeChat(json: string): ChatMessage {
  const raw = JSON.parse(json) as Record<string, unknown>;
  if (typeof raw.id !== "string" || raw.id.length === 0) throw new Error("missing field: id");
  if (typeof raw.ts !== "number" || !Number.isFinite(raw.ts)) throw new Error("missing field: ts");
  if (typeof raw.from !== "string" || raw.from.length === 0) {
    throw new Error("missing field: from");
  }
  if (!isChatKind(raw.kind)) throw new Error("missing field: kind");
  if (typeof raw.text !== "string" || raw.text.length === 0) {
    throw new Error("missing field: text");
  }
  const msg: ChatMessage = {
    id: raw.id,
    ts: raw.ts,
    from: raw.from,
    kind: raw.kind,
    text: raw.text,
  };
  if (raw.target !== undefined) {
    if (typeof raw.target !== "string" || raw.target.length === 0) {
      throw new Error("missing field: target");
    }
    msg.target = raw.target;
  }
  if (raw.roll !== undefined) {
    const roll = raw.roll as Record<string, unknown>;
    if (!Array.isArray(roll.rolls) || typeof roll.total !== "number") {
      throw new Error("missing field: roll");
    }
    msg.roll = roll as unknown as RollResult;
  }
  return msg;
}

/**
 * Broadcast `msg` as `chat:<ts>` through the room (same delta path as
 * tokens/rolls). Unknown roles are denied fail-closed; transport
 * errors report false and never throw (best-effort).
 */
export function publishChat(room: OfflineRoom, msg: ChatMessage, role: string): boolean {
  if (!SPEAKING_ROLES.has(role)) return false;
  try {
    let ts = msg.ts;
    let key = chatKey(ts);
    const state = room.getState();
    while (state[key] !== undefined) {
      ts += 1;
      key = chatKey(ts);
    }
    room.apply({ upsert: { [key]: encodeChat({ ...msg, ts }) } });
    return true;
  } catch {
    return false;
  }
}

/** Short dice label (`2d6+3`) rebuilt from a resolved request. */
export function diceLabel(dice: DiceRequest): string {
  const mod = dice.mod > 0 ? `+${dice.mod}` : dice.mod < 0 ? `${dice.mod}` : "";
  return `${dice.count}d${dice.sides}${mod}`;
}

export interface ChatPanelOptions {
  /** Speaking-as name (current character or display name). A function
   *  is re-read on every send/refresh so it follows the selection. */
  speaker: string | (() => string);
  /** True for the GM (may send /gmroll and /desc). */
  isGM?: boolean;
  /** Broadcast role (unknown roles stay local-only, fail-closed). */
  role?: string;
  /** Local room for broadcast + history (omit for a local-only log). */
  room?: OfflineRoom;
  /** Entropy for `/r` (tests inject a fixed rng). */
  rng?: RngLike;
  /** Mirror for the network backend (host pushes the delta onward). */
  onBroadcast?: (delta: Delta) => void;
}

export interface ChatPanel {
  /** Panel root (`section[data-testid=chat-panel]`). */
  el: HTMLElement;
  /** Send one input line (Enter path); false when denied/invalid. */
  send(raw: string): boolean;
  /** Messages shown in this log, oldest first. */
  messages(): ChatMessage[];
  /** Re-read `chat:*` history from the room (skips visible dupes). */
  refresh(): void;
}

/** Render the chat panel into `container`. */
export function renderChatPanel(container: HTMLElement, opts: ChatPanelOptions): ChatPanel {
  const isGM = opts.isGM ?? false;
  const role = opts.role ?? "host";
  const rng = opts.rng ?? Math.random;
  const speakerName = (): string =>
    typeof opts.speaker === "function" ? opts.speaker() : opts.speaker;
  const shown: ChatMessage[] = [];
  const seenIds = new Set<string>();
  let seq = 0;

  const el = document.createElement("section");
  el.dataset.testid = "chat-panel";
  el.className = "chat-panel";
  el.setAttribute("aria-label", "Bate-papo da mesa");

  const title = document.createElement("h2");
  title.textContent = "Bate-papo";
  const speakerLine = document.createElement("div");
  speakerLine.className = "chat-speaker";
  const paintSpeaker = (): void => {
    speakerLine.textContent = `Falando como ${speakerName()}`;
  };
  paintSpeaker();

  const log = document.createElement("div");
  log.dataset.testid = "chat-log";
  log.className = "chat-log";
  log.setAttribute("role", "log");
  log.setAttribute("aria-live", "polite");

  const form = document.createElement("div");
  form.className = "chat-form";
  const input = document.createElement("textarea");
  input.dataset.testid = "chat-input";
  input.className = "chat-input";
  input.rows = 2;
  input.placeholder = "Fale ou use /r 2d6+3 · /w nome msg · /em · /ooc";
  input.setAttribute("aria-label", "Mensagem (Enter envia, Shift+Enter quebra linha)");
  const sendBtn = document.createElement("button");
  sendBtn.type = "button";
  sendBtn.dataset.testid = "chat-send";
  sendBtn.className = "menu-btn chat-send";
  sendBtn.textContent = "Enviar";

  const status = document.createElement("div");
  status.dataset.testid = "chat-status";
  status.className = "chat-status";
  status.setAttribute("aria-live", "polite");

  const say = (text: string): void => {
    status.textContent = text;
  };

  function appendMessage(message: ChatMessage): void {
    if (seenIds.has(message.id)) return;
    if (!canSeeChat(message, { isGM, name: speakerName() })) return;
    seenIds.add(message.id);
    shown.push(message);
    shown.sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1));
    log.appendChild(renderMessage(message));
    log.scrollTop = log.scrollHeight;
  }

  function send(raw: string): boolean {
    const line = raw.trim();
    if (!line) {
      say("Escreva uma mensagem antes de enviar.");
      return false;
    }
    const parsed = parseChatInput(line);
    if (parsed.error || !parsed.kind || parsed.text === undefined) {
      say(parsed.error ?? "Mensagem inválida.");
      return false;
    }
    if ((parsed.kind === "gmroll" || parsed.kind === "desc") && !isGM) {
      say("Apenas o mestre pode usar esse comando.");
      return false;
    }
    let roll: RollResult | undefined;
    if (parsed.dice) {
      try {
        roll = resolveRoll(
          { sides: parsed.dice.sides, count: parsed.dice.count, mod: parsed.dice.mod },
          rng,
        );
      } catch {
        say("Rolagem inválida: use dados como d20 ou 2d6+3.");
        return false;
      }
    }
    const ts = Date.now();
    seq += 1;
    const message: ChatMessage = {
      id: `${ts}-${seq}`,
      ts,
      from: speakerName(),
      kind: parsed.kind,
      text: parsed.text,
      ...(parsed.target ? { target: parsed.target } : {}),
      ...(roll ? { roll } : {}),
    };
    appendMessage(message);
    if (opts.room) {
      const before = opts.room.getState();
      const ok = publishChat(opts.room, message, role);
      if (ok) {
        try {
          const after = opts.room.getState();
          const key = Object.keys(after).find(
            (k) => isChatKey(k) && before[k] === undefined && after[k] !== undefined,
          );
          if (key) opts.onBroadcast?.({ upsert: { [key]: after[key] } });
        } catch {
          // History diff is best-effort; the message is already shown.
        }
      }
    }
    say(kindHint(parsed.kind, parsed.target));
    return true;
  }

  function refresh(): void {
    paintSpeaker();
    if (!opts.room) return;
    const entries: { ts: number; json: string }[] = [];
    for (const [key, json] of Object.entries(opts.room.getState())) {
      if (!isChatKey(key)) continue;
      const ts = Number(key.slice(CHAT_PREFIX.length));
      if (!Number.isFinite(ts)) continue;
      entries.push({ ts, json });
    }
    entries.sort((a, b) => a.ts - b.ts);
    for (const entry of entries) {
      try {
        appendMessage(decodeChat(entry.json));
      } catch {
        // Broken or hostile values never reach the log.
      }
    }
  }

  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      if (send(input.value)) input.value = "";
    }
  });
  sendBtn.addEventListener("click", () => {
    if (send(input.value)) input.value = "";
  });

  form.append(input, sendBtn);
  el.append(title, speakerLine, log, form, status);
  container.appendChild(el);
  refresh();

  return {
    el,
    send,
    messages: () => [...shown],
    refresh,
  };
}

/** Status hint after a successful send. */
function kindHint(kind: ChatKind, target?: string): string {
  switch (kind) {
    case "whisper":
      return `Sussurro enviado para ${target ?? "alguém"}.`;
    case "roll":
      return "Rolagem publicada para a mesa.";
    case "gmroll":
      return "Rolagem secreta do mestre registrada.";
    case "desc":
      return "Narração publicada.";
    case "emote":
      return "Ação interpretada.";
    case "ooc":
      return "Mensagem fora do jogo enviada.";
    default:
      return "Mensagem enviada.";
  }
}

/** Build one log entry (textContent only — chat never injects HTML). */
function renderMessage(message: ChatMessage): HTMLElement {
  const article = document.createElement("article");
  article.dataset.testid = "chat-msg";
  article.dataset.kind = message.kind;
  article.dataset.from = message.from;
  article.className = `chat-msg chat-${message.kind}`;

  const head = document.createElement("div");
  head.className = "chat-head";
  const who = document.createElement("strong");
  who.textContent = message.from;
  head.appendChild(who);
  const tag = document.createElement("span");
  tag.className = "chat-tag";
  switch (message.kind) {
    case "emote":
      tag.textContent = "interpreta";
      break;
    case "ooc":
      tag.textContent = "(fora do jogo)";
      break;
    case "whisper":
      tag.textContent = message.from === message.target ? "" : `sussurra para ${message.target ?? "?"}`;
      break;
    case "roll":
      tag.textContent = "rola";
      break;
    case "gmroll":
      tag.textContent = "mestre (secreto)";
      break;
    case "desc":
      tag.textContent = "narração";
      break;
    default:
      tag.textContent = "diz";
      break;
  }
  if (tag.textContent) head.appendChild(document.createTextNode(` ${tag.textContent}`));

  article.appendChild(head);

  if ((message.kind === "roll" || message.kind === "gmroll") && message.roll) {
    article.appendChild(renderRollCard(message));
  } else {
    const body = document.createElement("div");
    body.className = "chat-text";
    body.textContent = message.kind === "emote" ? `*${message.text}*` : message.text;
    article.appendChild(body);
  }
  return article;
}

/** Roll result card: `2d6+3 = 11` with a clickable breakdown expand. */
function renderRollCard(message: ChatMessage): HTMLElement {
  const roll = message.roll as RollResult;
  const card = document.createElement("div");
  card.dataset.testid = "roll-card";
  card.className = "roll-card";

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.dataset.testid = "roll-toggle";
  toggle.className = "roll-toggle";
  const faces = roll.rolls.length;
  const shape = `${faces}d${roll.sides}`;
  const mod = roll.mod > 0 ? `+${roll.mod}` : roll.mod < 0 ? `${roll.mod}` : "";
  toggle.textContent = `🎲 ${shape}${mod} = ${roll.total} (detalhes)`;
  toggle.setAttribute("aria-expanded", "false");

  const detail = document.createElement("div");
  detail.dataset.testid = "roll-detail";
  detail.className = "roll-detail";
  detail.setAttribute("hidden", "");
  detail.textContent =
    `Dados: ${roll.rolls.join(" + ") || "—"}` +
    (roll.mod !== 0 ? `, modificador ${roll.mod >= 0 ? "+" : ""}${roll.mod}` : ", sem modificador") +
    `, total ${roll.total}.`;

  toggle.addEventListener("click", () => {
    const hidden = detail.hasAttribute("hidden");
    if (hidden) detail.removeAttribute("hidden");
    else detail.setAttribute("hidden", "");
    toggle.setAttribute("aria-expanded", hidden ? "true" : "false");
  });

  card.append(toggle, detail);
  return card;
}
