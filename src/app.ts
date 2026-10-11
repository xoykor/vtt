// Playable offline shell: local room + canvas map + sheet panel +
// dice roller. No network. Consumes the ready modules only:
// - net/peer (RoomState via OfflineRoom.apply)
// - map/grid + map/fog + map/light (geometry for the view)
// - map/tokens (via OfflineRoom)
// - sheet/srd + sheet/types (sheet panel encode/decode)
// - dice/roller + dice/scene (host-resolved rolls, rendered result)
// Task 4 bootstraps this into the webview via startApp(root).

import { createGrid, inBounds } from "./map/grid";
import { createFog, revealFog } from "./map/fog";
import { computeLight } from "./map/light";
import { decodeSheet, encodeSheet } from "./sheet/srd";
import type { Sheet } from "./sheet/types";
import { publishRoll, resolveRoll } from "./dice/roller";
import { frameForResult } from "./dice/scene";
import { createOfflineRoom } from "./ui/room";
import { eventToCell, renderMapView } from "./ui/mapview";

const MEMBERS = ["dm", "p1", "p2", "p3", "p4", "p5"];
const SIDES = [2, 4, 6, 8, 10, 12, 20, 100];

/** Bootstrap the offline shell into `root` (Task 4 webview entry). */
export function startApp(root: HTMLElement): void {
  const room = createOfflineRoom(MEMBERS);
  const grid = createGrid(10, 8);
  let selected = MEMBERS[0];
  let rollSeq = 0;

  const sheets = new Map<string, Sheet>(
    MEMBERS.map((id, i) => [
      id,
      decodeSheet(
        encodeSheet({ id, name: id, ac: 10 + (i % 3), hp: 10, maxHp: 10 }),
      ),
    ]),
  );

  root.innerHTML = "";
  const title = document.createElement("h1");
  title.textContent = "VTT — Sala offline";
  const wrap = document.createElement("div");
  wrap.style.display = "flex";
  wrap.style.gap = "16px";

  const canvas = document.createElement("canvas");
  const side = document.createElement("div");

  const sheetTitle = document.createElement("h2");
  sheetTitle.textContent = "Ficha";
  const sheetBox = document.createElement("div");
  const tokenList = document.createElement("div");
  const diceTitle = document.createElement("h2");
  diceTitle.textContent = "Dado";
  const sidesSel = document.createElement("select");
  for (const s of SIDES) {
    const opt = document.createElement("option");
    opt.value = String(s);
    opt.textContent = `d${s}`;
    if (s === 20) opt.selected = true;
    sidesSel.appendChild(opt);
  }
  const rollBtn = document.createElement("button");
  rollBtn.textContent = "Rolar";
  const rollOut = document.createElement("div");
  rollOut.textContent = "—";

  function draw(): void {
    const fog = revealFog(createFog(grid.width, grid.height), [
      { x: 0, y: 0 },
      { x: 7, y: 0 },
      { x: 7, y: 7 },
      { x: 0, y: 7 },
    ]);
    const lit = computeLight(
      { width: grid.width, height: grid.height, walls: new Array(grid.width * grid.height).fill(false) },
      [{ pos: { x: 0.5, y: 0.5 }, radius: 12 }],
    );
    renderMapView(canvas, {
      grid,
      tokens: room.tokens(),
      fog: fog.visible,
      lit,
    });
  }

  function showSheet(): void {
    const sheet = sheets.get(selected);
    sheetBox.textContent = sheet
      ? `${sheet.name} — CA ${sheet.ac} — HP ${sheet.hp}/${sheet.maxHp}`
      : "—";
  }

  for (const id of MEMBERS) {
    const btn = document.createElement("button");
    btn.textContent = id;
    btn.addEventListener("click", () => {
      selected = id;
      showSheet();
    });
    tokenList.appendChild(btn);
  }

  canvas.addEventListener("click", (ev) => {
    const cell = eventToCell(canvas, ev.clientX, ev.clientY);
    if (!cell || !inBounds(grid, cell.x, cell.y)) return;
    if (room.moveToken(selected, { x: cell.x, y: cell.y })) draw();
  });

  rollBtn.addEventListener("click", () => {
    const result = resolveRoll({ sides: Number(sidesSel.value) });
    room.apply(publishRoll(result, `offline-${++rollSeq}`));
    rollOut.textContent = frameForResult(result).faces
      .map((f) => f.label)
      .join(" ") + ` = ${result.total}`;
  });

  showSheet();
  draw();
  side.append(sheetTitle, tokenList, sheetBox, diceTitle, sidesSel, rollBtn, rollOut);
  wrap.append(canvas, side);
  root.append(title, wrap);
}
