// Master map editor panel: new grid maps from brush assets or from an
// imported image, on the three layers from src/map/layers.ts
// (`fundo`/`gm`/`player`). The host paints and imports; every write
// goes through the host-authoritative `placeTile(map, tile, role)` with
// the caller's real role plus an explicit host guard, so guests and
// unknown roles are denied fail-closed and never reach `room.apply`.
// Visibility comes from `visibleLayers`/`visibleTiles` only — every
// peer keeps the same `tile:*` partition and draws what its role may
// see. The tile preview toggle ("Ver como jogador") lets the master
// check the player view without leaving the table. Deltas apply via
// `room.apply`, the same path as tokens and rolls. Pure DOM + one 2D
// canvas preview (CELL from src/ui/mapview.ts); no central server,
// no WotC art.

import {
  decodeMapInfo,
  encodeMapInfo,
  isMapLayer,
  layerLabel,
  MAP_INFO_KEY,
  MAP_LAYERS,
  mapFromState,
  visibleTiles,
  type MapLayer,
} from "../map/layers";
import { placeTile } from "../map/editor";
import {
  blobToBytes,
  defaultDecodeImage,
  rasterToImport,
  type ImageDecoder,
} from "../map/image-import";
import { CELL, eventToCell } from "./mapview";
import type { OfflineRoom } from "./room";
import type { PlaceHandler } from "./editor-panel";

export interface MapEditorOptions {
  /** Local room: deltas apply here via `room.apply`. */
  room: OfflineRoom;
  /** Caller role: only `host` writes (fail-closed). */
  role: string;
  /** Status line sink (import/brush feedback). */
  onStatus?: (msg: string) => void;
  /** Initial grid width (map:info in the room wins when valid). */
  width?: number;
  /** Initial grid height (map:info in the room wins when valid). */
  height?: number;
  /** Image decoder override (tests inject a synthetic raster). */
  decodeImage?: ImageDecoder;
}

const DEFAULT_WIDTH = 10;
const DEFAULT_HEIGHT = 8;
const DEFAULT_BRUSH = "tijolo";
const HOST_ONLY = "Apenas o mestre pode editar o mapa.";

/** Layer fill colors for the canvas preview (draw order = MAP_LAYERS). */
const LAYER_COLORS: Record<MapLayer, string> = {
  fundo: "#3d3d52",
  gm: "#6e3b3b",
  player: "#3b6e4c",
};

/** Brush callback reuses the editor-panel contract (tile + its delta). */
function makeBrushHandler(
  room: OfflineRoom,
  say: (msg: string) => void,
  draw: () => void,
): PlaceHandler {
  return (tile, delta) => {
    room.apply(delta);
    say(`Pincel: ${tile.asset} em ${tile.layer} (${tile.x},${tile.y}).`);
    draw();
  };
}

/** Render the master map editor into `container`. */
export function renderMapEditor(
  container: HTMLElement,
  opts: MapEditorOptions,
): void {
  const { room, role } = opts;
  const say = (msg: string): void => {
    status.textContent = msg;
    opts.onStatus?.(msg);
  };
  const canWrite = (): boolean => role === "host";

  container.innerHTML = "";

  const title = document.createElement("h2");
  title.textContent = "Editor de mapa";

  // ── Active layer ──
  const layerLabelEl = document.createElement("label");
  layerLabelEl.textContent = "Camada: ";
  const layerSel = document.createElement("select");
  layerSel.dataset.testid = "layer";
  for (const layer of MAP_LAYERS) {
    const opt = document.createElement("option");
    opt.value = layer;
    opt.textContent = layerLabel(layer);
    layerSel.appendChild(opt);
  }
  layerSel.value = "fundo";
  layerLabelEl.appendChild(layerSel);

  // ── Player-view preview ──
  const viewLabel = document.createElement("label");
  const viewToggle = document.createElement("input");
  viewToggle.type = "checkbox";
  viewToggle.dataset.testid = "view-as-player";
  viewLabel.append(viewToggle, document.createTextNode(" Ver como jogador"));

  // ── Grid size + new map ──
  const sizeWrap = document.createElement("div");
  const widthInput = document.createElement("input");
  widthInput.type = "number";
  widthInput.min = "1";
  widthInput.dataset.testid = "width";
  const heightInput = document.createElement("input");
  heightInput.type = "number";
  heightInput.min = "1";
  heightInput.dataset.testid = "height";
  const newMapBtn = document.createElement("button");
  newMapBtn.textContent = "Criar mapa";
  newMapBtn.dataset.testid = "new-map";
  sizeWrap.append("Largura ", widthInput, " Altura ", heightInput, newMapBtn);

  // ── Brush ──
  const brushLabel = document.createElement("label");
  brushLabel.textContent = "Pincel (asset): ";
  const brushInput = document.createElement("input");
  brushInput.type = "text";
  brushInput.value = DEFAULT_BRUSH;
  brushInput.dataset.testid = "brush";
  brushLabel.appendChild(brushInput);

  // ── Image import ──
  const importLabel = document.createElement("label");
  importLabel.textContent = "Importar imagem para a grade: ";
  const importInput = document.createElement("input");
  importInput.type = "file";
  importInput.accept = "image/*";
  importInput.dataset.testid = "import";
  importLabel.appendChild(importInput);

  // ── Preview + lists ──
  const canvas = document.createElement("canvas");
  canvas.dataset.testid = "grid";
  canvas.style.border = "1px solid #555";
  canvas.style.maxWidth = "100%";
  const tiles = document.createElement("div");
  tiles.dataset.testid = "tiles";
  const status = document.createElement("div");
  status.dataset.testid = "status";
  status.setAttribute("aria-live", "polite");

  // Grid geometry: an explicit option wins unless the room already
  // carries a valid map:info descriptor (host-authoritative size).
  let mapWidth = opts.width ?? DEFAULT_WIDTH;
  let mapHeight = opts.height ?? DEFAULT_HEIGHT;
  const stored = decodeMapInfo(room.getState()[MAP_INFO_KEY] ?? "");
  if (stored) {
    mapWidth = stored.width;
    mapHeight = stored.height;
  }
  widthInput.value = String(mapWidth);
  heightInput.value = String(mapHeight);

  const activeLayer = (): MapLayer =>
    isMapLayer(layerSel.value) ? layerSel.value : "fundo";
  /** Role the preview draws as: the host picks, everyone else is fixed —
   *  players/guests see the player view, unknown roles keep their own
   *  role so `visibleTiles` denies them fail-closed. */
  const viewRole = (): string => {
    if (role === "host") return viewToggle.checked ? "player" : role;
    return role;
  };

  function draw(): void {
    const map = mapFromState(mapWidth, mapHeight, room.getState());
    const seen = visibleTiles(map, viewRole());
    try {
      canvas.width = mapWidth * CELL;
      canvas.height = mapHeight * CELL;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.fillStyle = "#1a1a22";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        for (const tile of seen) {
          ctx.fillStyle =
            LAYER_COLORS[tile.layer as MapLayer] ?? "#888";
          ctx.fillRect(tile.x * CELL, tile.y * CELL, CELL, CELL);
          ctx.fillStyle = "#fff";
          ctx.font = "9px sans-serif";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(
            tile.asset.slice(0, 6),
            (tile.x + 0.5) * CELL,
            (tile.y + 0.5) * CELL,
          );
        }
        ctx.strokeStyle = "#444";
        ctx.lineWidth = 1;
        for (let x = 0; x <= mapWidth; x++) {
          ctx.beginPath();
          ctx.moveTo(x * CELL, 0);
          ctx.lineTo(x * CELL, mapHeight * CELL);
          ctx.stroke();
        }
        for (let y = 0; y <= mapHeight; y++) {
          ctx.beginPath();
          ctx.moveTo(0, y * CELL);
          ctx.lineTo(mapWidth * CELL, y * CELL);
          ctx.stroke();
        }
      }
    } catch {
      // jsdom/CI has no 2D context: the tile list below stays authoritative.
    }
    tiles.textContent = seen.length
      ? `Visíveis (${seen.length}): ` +
        seen.map((t) => `tile:${t.layer}:${t.x},${t.y}=${t.asset}`).join(", ")
      : "Nenhum tile visível.";
  }

  const onPlace: PlaceHandler = makeBrushHandler(room, say, draw);

  function denyIfGuest(): boolean {
    if (canWrite()) return false;
    say(HOST_ONLY);
    return true;
  }

  newMapBtn.addEventListener("click", () => {
    if (denyIfGuest()) return;
    const w = Number(widthInput.value);
    const h = Number(heightInput.value);
    if (!Number.isInteger(w) || w < 1 || !Number.isInteger(h) || h < 1) {
      say("Tamanho inválido: use inteiros maiores que zero.");
      return;
    }
    mapWidth = w;
    mapHeight = h;
    const remove = Object.keys(room.getState()).filter((k) =>
      k.startsWith("tile:"),
    );
    room.apply({
      upsert: { [MAP_INFO_KEY]: encodeMapInfo({ width: w, height: h }) },
      remove,
    });
    say(`Mapa criado: ${w}x${h}.`);
    draw();
  });

  canvas.addEventListener("click", (ev) => {
    const cell = eventToCell(canvas, ev.clientX, ev.clientY);
    if (!cell || cell.x >= mapWidth || cell.y >= mapHeight) return;
    if (denyIfGuest()) return;
    const asset = brushInput.value.trim();
    const res = placeTile(
      mapFromState(mapWidth, mapHeight, room.getState()),
      { x: cell.x, y: cell.y, layer: activeLayer(), asset },
      role,
    );
    if (!res.ok) {
      say(`Pincel falhou: ${res.error}`);
      return;
    }
    onPlace(
      { x: cell.x, y: cell.y, layer: activeLayer(), asset },
      res.delta,
    );
  });

  importInput.addEventListener("change", () => {
    const run = async (): Promise<void> => {
      if (denyIfGuest()) {
        importInput.value = "";
        return;
      }
      const file = importInput.files?.[0];
      if (!file) return;
      say("Importando imagem...");
      try {
        const decode = opts.decodeImage ?? defaultDecodeImage;
        // Fail-closed order: role already checked; decode, then import
        // onto the active layer for the current grid.
        const raster = await decode(await blobToBytes(file));
        const { delta, tiles: imported } = rasterToImport(
          raster,
          mapWidth,
          mapHeight,
          activeLayer(),
        );
        room.apply(delta);
        say(
          `Imagem importada: ${imported.length} tiles na camada ${layerLabel(activeLayer())}.`,
        );
        draw();
      } catch (e) {
        say(
          `Falha ao importar: ${e instanceof Error ? e.message : String(e)}`,
        );
      } finally {
        importInput.value = "";
      }
    };
    void run();
  });

  // Non-hosts cannot switch views: players/guests are pinned to the
  // player preview, unknown roles stay denied (fail-closed).
  if (role !== "host") {
    viewToggle.checked = role === "player" || role === "guest";
    viewToggle.disabled = true;
  }
  // `click` covers jsdom's checkbox activation (which may not emit
  // `change`); `change` covers real browsers and keyboard toggles.
  // `draw` is idempotent, so a double fire is harmless.
  viewToggle.addEventListener("click", draw);
  viewToggle.addEventListener("change", draw);

  container.append(
    title,
    layerLabelEl,
    viewLabel,
    sizeWrap,
    brushLabel,
    importLabel,
    canvas,
    tiles,
    status,
  );
  draw();
}
