#!/usr/bin/env node

// Simple CLI:
//   node tools/patch_to_level.js input.orca levels/generated-level.orca generated-level.json [layout] [guardsPerPatch] [wallChar] [ammoPickups] [medikitPickups]
//
// input.orca:
//   - can be a small exported selection from ORCA
//   - OR a full ORCA grid export containing one or more *commented* patches
//
// HOW PATCHES ARE DETECTED (IMPORTANT):
// - Each unlockable patch must be surrounded by a rectangular frame of '#':
//     #....................#
//     #....patch code......#
//     #....patch code......#
//     #....................#
// - The frame is interpreted as a rectangle whose top/left is the smallest (x,y)
//   of '#' for that patch and whose bottom/right is the largest (x,y) of '#'
//   that belong to the same vertical rails.
// - Multiple patches CAN share rows as long as their '#' frames do not overlap.
// - If NO '#' rails are found at all, the script will:
//     * auto-wrap the entire non-empty area in a single comment block
//     * treat that as ONE patch.
//
// LAYOUTS:
//
// 1) layout = "arena" (default)
//    - All patches are kept inside a single "cluster" (their relative positions
//      are preserved as in the input).
//    - The cluster is centered into ROOM_W x ROOM_H.
//    - Liberation triggers are one per patch (one targetBlock per frame).
//
// 2) layout = "rooms_line"
//    - Ogni patch diventa una stanza rettangolare, chiusa da muri (WALL_CHAR),
//      con il codice patch dentro e margini di pavimento '.' attorno.
//    - Le stanze sono disposte in linea orizzontale, collegate da un corridoio
//      orizzontale in basso e da un “pozzo” verticale per stanza.
//
// 3) layout = "dungeon"
//    - Layout “dungeon-like” basato su stanze rettangolari + corridoi a L:
//      * la griglia parte tutta piena di muri (WALL_CHAR);
//      * per ogni patch viene “scavata” una stanza abbastanza grande per
//        contenere la patch + margini (pavimento '.');
//      * le stanze sono collegate fra loro in catena con corridoi a L
//        (prima orizzontali, poi verticali) fra i loro centri;
//      * le patch vengono infine inserite dentro le stanze; tutto il resto
//        rimane muro.
//
// GUARDS:
//
// - You can control guards per patch via CLI or env:
//     guardsPerPatch = process.argv[6] OR env.GUARDS_PER_PATCH OR env.GPP
// - If guardsPerPatch > 0:
//     * For each patch we create guardsPerPatch guards whose patrol rect
//       is the patch rectangle expanded by a small margin.
// - If guardsPerPatch == 0 or not set:
//     * We fall back to the old static 3-guard config.
//
// OUTPUT:
// - generated-level.orca : a ROOM_W x ROOM_H ORCA grid.
// - generated-level.json : level config for overlay.js, with one
//                          liberationTrigger per patch block.

const fs = require('fs');
const path = require('path');

// ----- CLI args -------------------------------------------------------

if (process.argv.length < 5) {
  console.error('Usage: node patch_to_level.js <input.orca> <output.orca> <output.json> [layout] [guardsPerPatch] [wallChar]');
  process.exit(1);
}

const inputPath   = process.argv[2];
const outOrcaPath = process.argv[3];
const outJsonPath = process.argv[4];
const layoutArg   = process.argv[5] || process.env.LAYOUT || 'arena';
let layout = layoutArg.toLowerCase();

// Guards per patch (0 => use legacy static guards)
const guardsArg = process.argv[6] || process.env.GUARDS_PER_PATCH || process.env.GPP;
const GUARDS_PER_PATCH = guardsArg ? Math.max(0, parseInt(guardsArg, 10) || 0) : 0;

// Wall char: 7th CLI arg OR env.WALL_CHAR, default 'y'
const wallCharCli  = process.argv[7];
const wallCharEnv  = process.env.WALL_CHAR;
const WALL_CHAR_RAW = (wallCharCli && wallCharCli.length > 0)
  ? wallCharCli
  : (wallCharEnv && wallCharEnv.length > 0 ? wallCharEnv : 'y');
const WALL_CHAR = WALL_CHAR_RAW[0]; // ensure single char

// Pickups: ammo / medikit counts (can be overridden via CLI or env)
//   argv[8] -> AMMO_PICKUPS
//   argv[9] -> MEDIKIT_PICKUPS
//   or env.AMMO_PICKUPS / env.MEDIKIT_PICKUPS
const ammoArg = process.argv[8] || process.env.AMMO_PICKUPS;
const medArg  = process.argv[9] || process.env.MEDIKIT_PICKUPS;

// Default: 3 ammo, 1 medikit if not specified
const AMMO_PICKUP_COUNT = ammoArg != null
  ? Math.max(0, parseInt(ammoArg, 10) || 0)
  : 3;

const MEDIKIT_PICKUP_COUNT = medArg != null
  ? Math.max(0, parseInt(medArg, 10) || 0)
  : 1;

// Room size can be overridden via environment variables, e.g.
//   ROOM_W=100 ROOM_H=40 node ...
const ROOM_W = parseInt(process.env.ROOM_W, 10) || 140;
const ROOM_H = parseInt(process.env.ROOM_H, 10) || 40;

// Margins for layouts that build rooms from patches
// rooms_line usa ROOM_MARGIN_X / ROOM_MARGIN_Y fissi.
// dungeon usa i range MIN/MAX qui sotto per creare variabilita.
const ROOM_MARGIN_X   = parseInt(process.env.ROOM_MARGIN_X, 10) || 2;
const ROOM_MARGIN_Y   = parseInt(process.env.ROOM_MARGIN_Y, 10) || 1;
const ROOM_GAP_COLS   = parseInt(process.env.ROOM_GAP_COLS, 10) || 4;

// Dungeon: per lato, margini minimi e massimi intorno alla patch.
// Default: 2..4 celle per lato, ma puoi alzare con
//   ROOM_MARGIN_X_MAX / ROOM_MARGIN_Y_MAX
const ROOM_MARGIN_X_MIN = parseInt(process.env.ROOM_MARGIN_X_MIN, 10) || ROOM_MARGIN_X;
const ROOM_MARGIN_X_MAX = parseInt(process.env.ROOM_MARGIN_X_MAX, 10) || (ROOM_MARGIN_X + 4);
const ROOM_MARGIN_Y_MIN = parseInt(process.env.ROOM_MARGIN_Y_MIN, 10) || ROOM_MARGIN_Y;
const ROOM_MARGIN_Y_MAX = parseInt(process.env.ROOM_MARGIN_Y_MAX, 10) || (ROOM_MARGIN_Y + 4);

// Dungeon: spessore corridoi (in celle), min/max.
// Default: 1..4
const CORRIDOR_WIDTH_MIN = parseInt(process.env.CORRIDOR_WIDTH_MIN, 10) || 1;
const CORRIDOR_WIDTH_MAX = parseInt(process.env.CORRIDOR_WIDTH_MAX, 10) || 6;

// Dungeon: target fraction of the map area we allow rooms to occupy
// (used for adaptive margins / corridor widths).
// 0.65 means "try to keep total room area around 65% of map area".
// Can be overridden with env.DUNGEON_TARGET_FILL.
const DUNGEON_TARGET_FILL = parseFloat(process.env.DUNGEON_TARGET_FILL || '0.65');



// Sanitize layout
if (layout !== 'arena' && layout !== 'rooms_line' && layout !== 'dungeon') {
  console.warn('[patch_to_level] Unknown layout "' + layout + '", falling back to "arena".');
  layout = 'arena';
}

// ----- Helpers: grid loading / slicing --------------------------------

// Load raw lines from file, keep them as-is (no trimming of empty lines).
function loadRawLines(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  // Split on CRLF or LF, keep empty lines.
  let lines = raw.split(/\r?\n/);
  // Remove a final trailing empty line from the export, if present.
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  if (lines.length === 0) {
    throw new Error('Input ORCA file is empty.');
  }
  return lines;
}

// Normalize to rectangular grid padded with '.' on the right.
function normalizeGrid(lines) {
  const width = Math.max(...lines.map((l) => l.length));
  const height = lines.length;
  const grid = [];

  for (let y = 0; y < height; y++) {
    const row = lines[y].padEnd(width, '.').split('');
    grid.push(row);
  }

  return { width, height, grid };
}

// Find bounding box of all non-dot glyphs.
// If no non-dot glyphs, throws.
function findNonDotBoundingBox(grid) {
  const height = grid.length;
  const width = grid[0].length;

  let minX = width;
  let maxX = -1;
  let minY = height;
  let maxY = -1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const ch = grid[y][x];
      if (ch !== '.') {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX === -1) {
    throw new Error('Input ORCA file contains only dots (no operators or #).');
  }

  return { minX, minY, maxX, maxY };
}

// Extract a sub-grid given a bounding box.
function sliceGrid(grid, minX, minY, maxX, maxY) {
  const height = maxY - minY + 1;
  const width = maxX - minX + 1;
  const out = [];
  for (let y = minY; y <= maxY; y++) {
    const row = [];
    for (let x = minX; x <= maxX; x++) {
      row.push(grid[y][x]);
    }
    out.push(row);
  }
  return { width, height, grid: out };
}

// Wrap a whole cluster grid into a single comment block using '#':
//  top row    : #...........#
//  inner rows : #<cluster>#
//  bottom row : #...........#
function wrapGridWithCommentFrame(cluster) {
  const h = cluster.length;
  const w = cluster[0].length;

  const newGrid = [];

  // top row: # + dots + #
  const topRow = ['#'];
  for (let i = 0; i < w; i++) {
    topRow.push('.');
  }
  topRow.push('#');
  newGrid.push(topRow);

  // body rows: # + original row + #
  for (let y = 0; y < h; y++) {
    const row = ['#', ...cluster[y], '#'];
    newGrid.push(row);
  }

  // bottom row: same as top
  newGrid.push([...topRow]);

  return newGrid;
}

// ----- Comment-block detection ----------------------------------------
//
// Supports multiple patches on the same rows, placed side-by-side, as long
// as their '#' frames do not overlap.
//
// Assumptions:
// - '#' is used ONLY for patch frames (no random '#' inside patch code).
// - Each frame is a vertical pair of rails (xLeft,xRight) spanning several
//   consecutive rows.
// - Different frames have different rail columns.
//
// Algorithm outline:
//   - For each row, collect all x where grid[y][x] == '#'.
//   - Group those positions into pairs (x0,x1), (x2,x3), ...
//   - For each pair, track a vertical run of rows where BOTH columns still
//     contain '#': that run forms one block.
//   - When a pair disappears (no rails for that (xL,xR) on the next row),
//     we finalize its block.

function findCommentBlocks(clusterGrid) {
  const height = clusterGrid.length;
  const width = clusterGrid[0].length;
  const blocks = [];

  // key: "xL:xR" -> { x, yStart, yEnd, w }
  const active = new Map();

  for (let y = 0; y < height; y++) {
    const row = clusterGrid[y];

    // Collect all columns with '#'
    const rails = [];
    for (let x = 0; x < width; x++) {
      if (row[x] === '#') {
        rails.push(x);
      }
    }

    // Pair them: (rails[0], rails[1]), (rails[2], rails[3]), ...
    const rowPairs = [];
    for (let i = 0; i + 1 < rails.length; i += 2) {
      const xL = rails[i];
      const xR = rails[i + 1];
      rowPairs.push({ xL, xR });
    }

    const seenThisRow = new Set();

    // Extend or start blocks for the pairs we see on this row
    for (let i = 0; i < rowPairs.length; i++) {
      const p = rowPairs[i];
      const key = p.xL + ':' + p.xR;
      seenThisRow.add(key);

      const existing = active.get(key);
      if (existing) {
        // Extend vertical run
        existing.yEnd = y;
      } else {
        // Start new block at this row
        active.set(key, {
          x: p.xL,
          yStart: y,
          yEnd: y,
          w: p.xR - p.xL + 1
        });
      }
    }

    // Any active block whose pair is NOT seen on this row must end on row y-1
    for (const [key, blk] of active.entries()) {
      if (!seenThisRow.has(key)) {
        const hBlock = blk.yEnd - blk.yStart + 1;
        if (blk.w >= 3 && hBlock >= 3) {
          blocks.push({
            x: blk.x,
            y: blk.yStart,
            w: blk.w,
            h: hBlock
          });
        }
        active.delete(key);
      }
    }
  }

  // Finalize any block still active at the end
  for (const [key, blk] of active.entries()) {
    const hBlock = blk.yEnd - blk.yStart + 1;
    if (blk.w >= 3 && hBlock >= 3) {
      blocks.push({
        x: blk.x,
        y: blk.yStart,
        w: blk.w,
        h: hBlock
      });
    }
  }

  return blocks;
}

// Prepare the "cluster" and ensure it has at least one comment block.
// If no blocks are found, auto-wrap the cluster in a single '#'-framed block.
function prepareCommentedCluster(fullGrid) {
  const { minX, minY, maxX, maxY } = findNonDotBoundingBox(fullGrid);
  const sliced = sliceGrid(fullGrid, minX, minY, maxX, maxY);
  let clusterGrid = sliced.grid;

  // Try to detect explicit comment blocks.
  let blocks = findCommentBlocks(clusterGrid);

  if (blocks.length === 0) {
    // No comment rails: auto-wrap whole cluster.
    console.warn('[patch_to_level] No comment blocks found, auto-wrapping entire patch.');
    clusterGrid = wrapGridWithCommentFrame(clusterGrid);
    blocks = findCommentBlocks(clusterGrid);
    if (blocks.length === 0) {
      throw new Error('Failed to auto-wrap patch into a comment block.');
    }
  }

  return {
    clusterGrid,
    clusterWidth: clusterGrid[0].length,
    clusterHeight: clusterGrid.length,
    blocks
  };
}

// ----- Level grid assembly --------------------------------------------

// Build a full ORCA grid and insert a cluster (2D array of chars) at (originX, originY).
function buildLevelGrid(roomW, roomH, clusterGrid, originX, originY) {
  const grid = [];
  for (let y = 0; y < roomH; y++) {
    const row = new Array(roomW).fill('.');
    grid.push(row);
  }

  const ch = clusterGrid.length;
  const cw = clusterGrid[0].length;

  for (let y = 0; y < ch; y++) {
    const gy = originY + y;
    if (gy < 0 || gy >= roomH) continue;
    for (let x = 0; x < cw; x++) {
      const gx = originX + x;
      if (gx < 0 || gx >= roomW) continue;
      const chGlyph = clusterGrid[y][x] || '.';
      grid[gy][gx] = chGlyph;
    }
  }

  return grid.map((row) => row.join('')).join('\n') + '\n';
}

// ----- Generic helpers to work on ORCA grid strings -------------------

// Convert "\n"-joined ORCA text into { grid, width, height }
function stringToGrid(str) {
  const lines = str.replace(/\n$/, '').split('\n');
  const height = lines.length;
  const width = lines[0].length;
  const grid = lines.map((line) => line.split(''));
  return { grid, width, height };
}

// Convert 2D char array back into ORCA text.
function gridToString(grid) {
  return grid.map((row) => row.join('')).join('\n') + '\n';
}

// Heuristically detect the wall character in a dungeon:
// pick the most frequent non-dot, non-# glyph.
function detectWallChar(grid) {
  const counts = new Map();
  for (let y = 0; y < grid.length; y++) {
    const row = grid[y];
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      if (ch === '.' || ch === '#') continue;
      const prev = counts.get(ch) || 0;
      counts.set(ch, prev + 1);
    }
  }

  let wallChar = 'x';
  let bestCount = 0;
  for (const [ch, count] of counts.entries()) {
    if (count > bestCount) {
      bestCount = count;
      wallChar = ch;
    }
  }
  return wallChar;
}

// BFS corridor digging: connect spawn room door to nearest existing floor cell ('.')
function connectSpawnRoomToDungeon(
  grid,
  wallChar,
  doorCol,
  doorRow,
  innerMinX,
  innerMinY,
  innerMaxX,
  innerMaxY
) {
  const height = grid.length;
  const width = grid[0].length;

  function inSpawnInterior(x, y) {
    return (
      x >= innerMinX &&
      x <= innerMaxX &&
      y >= innerMinY &&
      y <= innerMaxY
    );
  }

  function idx(x, y) {
    return y * width + x;
  }

  const visited = new Array(width * height).fill(false);
  const prev = new Array(width * height).fill(-1);
  const queue = [];

  queue.push({ x: doorCol, y: doorRow });
  visited[idx(doorCol, doorRow)] = true;

  const dirs = [
    { dx: 1, dy: 0 },
    { dx: -1, dy: 0 },
    { dx: 0, dy: 1 },
    { dx: 0, dy: -1 }
  ];

  let targetIndex = -1;

  while (queue.length > 0 && targetIndex === -1) {
    const cur = queue.shift();
    const cx = cur.x;
    const cy = cur.y;

    for (let i = 0; i < dirs.length; i++) {
      const nx = cx + dirs[i].dx;
      const ny = cy + dirs[i].dy;

      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;

      const ch = grid[ny][nx];

      // For the search we allow existing floor '.' and solid walls `wallChar`.
      // All other glyphs (patch code, operators, etc) are treated as obstacles.
      if (ch !== wallChar && ch !== '.') continue;

      const index = idx(nx, ny);
      if (visited[index]) continue;

      visited[index] = true;
      prev[index] = idx(cx, cy);

      // First floor we find that is NOT inside the spawn interior becomes our target.
      if (ch === '.' && !inSpawnInterior(nx, ny)) {
        targetIndex = index;
        break;
      }

      queue.push({ x: nx, y: ny });
    }
  }

  if (targetIndex === -1) {
    console.warn(
      '[patch_to_level] Spawn room created but no existing dungeon floor found to connect to.'
    );
    return;
  }

  const startIndex = idx(doorCol, doorRow);
  let cur = targetIndex;

  // Walk back from target to door and carve walls into floor.
  while (cur !== -1 && cur !== startIndex) {
    const cx = cur % width;
    const cy = (cur - cx) / width;

    if (!inSpawnInterior(cx, cy) && grid[cy][cx] === wallChar) {
      grid[cy][cx] = '.';
    }

    cur = prev[cur];
  }
}

// Inject a small 3x3 spawn room (5x5 including walls) into a dungeon layout,
// connect it with a 1-tile corridor to the nearest existing floor,
// and return the modified ORCA grid string plus playerSpawn coordinates.
function injectPlayerSpawnRoomIntoDungeon(orcaGridStr) {
  const { grid, width, height } = stringToGrid(orcaGridStr);

  // Detect which glyph is being used as "wall".
  const wallChar = detectWallChar(grid);

  const roomW = 5; // 3x3 interior + 1 wall on each side
  const roomH = 5;

  let spawnRoomX = null;
  let spawnRoomY = null;

  const maxStartX = Math.max(1, width - roomW - 1);
  const maxStartY = Math.max(1, height - roomH - 1);

  // Find a 5x5 area made entirely of walls, leaving a small border.
  outer:
  for (let y = 1; y <= maxStartY; y++) {
    for (let x = 1; x <= maxStartX; x++) {
      let ok = true;
      for (let yy = 0; yy < roomH && ok; yy++) {
        for (let xx = 0; xx < roomW; xx++) {
          if (grid[y + yy][x + xx] !== wallChar) {
            ok = false;
            break;
          }
        }
      }
      if (ok) {
        spawnRoomX = x;
        spawnRoomY = y;
        break outer;
      }
    }
  }

  // Fallback: if we did not find a full-wall region, just pick (1,1)
  // and overwrite whatever is there (should be very rare).
  if (spawnRoomX === null) {
    spawnRoomX = 1;
    spawnRoomY = 1;
  }

  const innerMinX = spawnRoomX + 1;
  const innerMaxX = spawnRoomX + roomW - 2;
  const innerMinY = spawnRoomY + 1;
  const innerMaxY = spawnRoomY + roomH - 2;

  // Carve 3x3 interior as walkable floor.
  for (let y = innerMinY; y <= innerMaxY; y++) {
    for (let x = innerMinX; x <= innerMaxX; x++) {
      grid[y][x] = '.';
    }
  }

  // Player spawn in the center of the 3x3 interior.
  const spawnCol = innerMinX + Math.floor((innerMaxX - innerMinX) / 2);
  const spawnRow = innerMinY + Math.floor((innerMaxY - innerMinY) / 2);

  // Door cell: bottom-middle of the interior.
  const doorCol = spawnCol;
  const doorRow = innerMaxY;

  // Dig a 1-tile corridor from the door to the nearest existing dungeon floor.
  connectSpawnRoomToDungeon(
    grid,
    wallChar,
    doorCol,
    doorRow,
    innerMinX,
    innerMinY,
    innerMaxX,
    innerMaxY
  );

  const newStr = gridToString(grid);

  return {
    orcaGrid: newStr,
    playerSpawn: { col: spawnCol, row: spawnRow }
  };
}

// ----- JSON config generation -----------------------------------------
//
// commentBlocksGlobal: array of { id, x, y, w, h } in ROOM coordinates.
// playerSpawn: optional { col, row } suggested spawn for the player.
// levelGrid: 2D grid (array of rows) of the final ORCA level.
// layout: string, "arena" | "rooms_line" | "dungeon".
// ----- JSON config generation -----------------------------------------
//
// commentBlocksGlobal: array of { id, x, y, w, h } in ROOM coordinates.
// playerSpawn: optional { col, row } suggested spawn for the player.
// levelGrid: 2D grid (array of rows) of the final ORCA level.
// layout: string, "arena" | "rooms_line" | "dungeon".
function createLevelJson(commentBlocksGlobal, playerSpawn, levelGrid, layout) {
  const fovProfiles = {
    A: {
      depth: 9,
      widths: [1, 1, 3, 3, 3, 5, 5, 5, 7]
    }
  };

  const guards = [];
  const pickups = []; // NEW: ammo / medikit pickups

  // Decide high-level layout type used by overlay.js
  const layoutType = (layout === 'dungeon') ? 'dungeon' : 'arena';

  // Grid info helper
  const hasGrid = Array.isArray(levelGrid) && levelGrid.length > 0;
  const gridH = hasGrid ? levelGrid.length : 0;
  const gridW = hasGrid ? levelGrid[0].length : 0;

  // Defaults:
  // - dungeon  -> guards per room (per patch) default 3
  //              pattern: 2 outside patch, 1 inside patch
  // - arena    -> guards per sector (N/S/W/E) default 3
  const DEFAULT_DUNGEON_GUARDS_PER_ROOM   = 2;
  const DEFAULT_ARENA_GUARDS_PER_SECTOR   = 3;

  // GUARDS_PER_PATCH meaning:
  // - in dungeon: "total guards per room" (if > 0), with the pattern:
  //       first 2 guards try to spawn OUTSIDE the patch,
  //       third guard tries to spawn INSIDE the patch,
  //       additional guards (4th, 5th, ...) spawn OUTSIDE.
  //   If GUARDS_PER_PATCH == 0 we use DEFAULT_DUNGEON_GUARDS_PER_ROOM (=3).
  //
  // - in arena: "guards per sector" (if > 0), otherwise default 3.
  const dungeonGuardsPerRoom =
    (GUARDS_PER_PATCH > 0) ? GUARDS_PER_PATCH : DEFAULT_DUNGEON_GUARDS_PER_ROOM;

  const arenaGuardsPerSector =
    (GUARDS_PER_PATCH > 0) ? GUARDS_PER_PATCH : DEFAULT_ARENA_GUARDS_PER_SECTOR;


  // Helper: collect all walkable ('.') cells inside a rectangle.
  function collectWalkableCells(minCol, maxCol, minRow, maxRow) {
    const cells = [];
    if (!hasGrid) {
      return cells;
    }

    for (let row = minRow; row <= maxRow; row++) {
      if (row < 0 || row >= gridH) continue;
      for (let col = minCol; col <= maxCol; col++) {
        if (col < 0 || col >= gridW) continue;
        if (levelGrid[row][col] === '.') {
          cells.push({ col, row });
        }
      }
    }
    return cells;
  }

  // Simple helper: pick up to "count" random distinct cells from a list.
  function pickRandomCells(candidates, count) {
    const result = [];
    if (!candidates || candidates.length === 0 || count <= 0) {
      return result;
    }

    // Fisher–Yates shuffle on a local copy
    const pool = candidates.slice();
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = pool[i];
      pool[i] = pool[j];
      pool[j] = tmp;
    }

    const n = Math.min(count, pool.length);
    for (let i = 0; i < n; i++) {
      result.push(pool[i]);
    }
    return result;
  }

  // Helper: choose up to "count" cells with the constraint
  // that no two chosen cells share the same row or column.
  // If strict placement is impossible, we relax to "unique cell only".
  function pickGuardSpawnsInArea(allCells, count) {
    const result = [];
    if (!allCells || allCells.length === 0 || count <= 0) {
      return result;
    }

    // Fisher–Yates shuffle to randomize candidates
    const cells = allCells.slice();
    for (let i = cells.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = cells[i];
      cells[i] = cells[j];
      cells[j] = tmp;
    }

    function isOkStrict(cell) {
      // No same row, no same column among already chosen cells
      for (let i = 0; i < result.length; i++) {
        const p = result[i];
        if (p.col === cell.col) return false;
        if (p.row === cell.row) return false;
      }
      return true;
    }

    function isOkRelaxed(cell) {
      // Only avoid exact duplicates (same cell)
      for (let i = 0; i < result.length; i++) {
        const p = result[i];
        if (p.col === cell.col && p.row === cell.row) return false;
      }
      return true;
    }

    // First pass: try strict constraint
    for (let i = 0; i < cells.length && result.length < count; i++) {
      const c = cells[i];
      if (isOkStrict(c)) {
        result.push(c);
      }
    }

    // Second pass: relax constraint if we still don't have enough
    if (result.length < count) {
      for (let i = 0; i < cells.length && result.length < count; i++) {
        const c = cells[i];
        if (isOkRelaxed(c)) {
          result.push(c);
        }
      }
    }

    return result;
  }

  // --------------------------------------------------------------------
  // DUNGEON: spawn per room (per patch), default 2 guards per room.
  //
  // Rules:
  // - patrol rect is the room interior (when available), not just patch+margin;
  // - guards never spawn *inside* the commented patch block;
  // - we try to slightly shrink the patrol rect so they don't hug walls;
  // - spawn cells are chosen only from '.' floor tiles in that room.
  // --------------------------------------------------------------------
  if (layoutType === 'dungeon') {
    if (commentBlocksGlobal.length === 0) {
      console.warn('[patch_to_level] Dungeon layout but no patches; falling back to legacy guards.');
    } else {
      const defaultMargin = 2;
      const shrinkMargin = 1;

      // Remove cells that fall inside the commented patch rectangle.
      function filterCellsOutsidePatch(cells, patch) {
        if (!cells || !cells.length || !patch) return cells;

        const patchMinCol = patch.x;
        const patchMaxCol = patch.x + patch.w - 1;
        const patchMinRow = patch.y;
        const patchMaxRow = patch.y + patch.h - 1;

        return cells.filter((c) =>
          c.col < patchMinCol ||
          c.col > patchMaxCol ||
          c.row < patchMinRow ||
          c.row > patchMaxRow
        );
      }

      commentBlocksGlobal.forEach((b, patchIndex) => {
        // 1) Base patrol rectangle:
        //    - prefer the room interior we exported from buildDungeonLayout;
        //    - fall back to patch rect + small margin.
        let baseMinCol, baseMaxCol, baseMinRow, baseMaxRow;

        if (
          typeof b.roomMinCol === 'number' &&
          typeof b.roomMaxCol === 'number' &&
          typeof b.roomMinRow === 'number' &&
          typeof b.roomMaxRow === 'number'
        ) {
          baseMinCol = b.roomMinCol;
          baseMaxCol = b.roomMaxCol;
          baseMinRow = b.roomMinRow;
          baseMaxRow = b.roomMaxRow;
        } else {
          baseMinCol = Math.max(0, b.x - defaultMargin);
          baseMaxCol = Math.min(ROOM_W - 1, b.x + b.w - 1 + defaultMargin);
          baseMinRow = Math.max(0, b.y - defaultMargin);
          baseMaxRow = Math.min(ROOM_H - 1, b.y + b.h - 1 + defaultMargin);
        }

        // Collect all walkable cells ('.') in the base rect,
        // then remove those that are inside the patch frame.
        let baseCells = collectWalkableCells(
          baseMinCol,
          baseMaxCol,
          baseMinRow,
          baseMaxRow
        );
        baseCells = filterCellsOutsidePatch(baseCells, b);

        if (baseCells.length === 0) {
          console.warn(
            '[patch_to_level] WARNING (dungeon): no walkable cells around patch',
            b.id || patchIndex,
            '— guards will be skipped for this room.'
          );
          return;
        }

        // 2) Try to shrink the patrol rectangle by 1 cell on each side,
        //    so guards are less likely to get stuck hugging the walls.
        let minCol = baseMinCol;
        let maxCol = baseMaxCol;
        let minRow = baseMinRow;
        let maxRow = baseMaxRow;
        let walkableCells = baseCells;

        if (
          baseMaxCol - baseMinCol >= 2 * shrinkMargin + 1 &&
          baseMaxRow - baseMinRow >= 2 * shrinkMargin + 1
        ) {
          const tightMinCol = baseMinCol + shrinkMargin;
          const tightMaxCol = baseMaxCol - shrinkMargin;
          const tightMinRow = baseMinRow + shrinkMargin;
          const tightMaxRow = baseMaxRow - shrinkMargin;

          let tightCells = collectWalkableCells(
            tightMinCol,
            tightMaxCol,
            tightMinRow,
            tightMaxRow
          );
          tightCells = filterCellsOutsidePatch(tightCells, b);

          // Use the tighter rect only if it still has valid floor cells.
          if (tightCells.length > 0) {
            minCol = tightMinCol;
            maxCol = tightMaxCol;
            minRow = tightMinRow;
            maxRow = tightMaxRow;
            walkableCells = tightCells;
          }
        }

        const spawnCells = pickGuardSpawnsInArea(
          walkableCells,
          dungeonGuardsPerRoom
        );

        if (spawnCells.length === 0) {
          console.warn(
            '[patch_to_level] WARNING (dungeon): could not place guards for room',
            b.id || patchIndex,
            '— no valid spawn cells.'
          );
          return;
        }

        spawnCells.forEach((cell, i) => {
          const gid = `room_${patchIndex}_${i}`;
          guards.push({
            id: gid,
            patrolType: 'rect',
            startCol: cell.col,
            startRow: cell.row,
            rect: { minCol, maxCol, minRow, maxRow },
            fovProfile: 'A',
            behavior: 'chaser'
          });
        });
      });

      console.log(
        '[patch_to_level] Dungeon guards generated:',
        guards.length,
        '(per room =',
        dungeonGuardsPerRoom,
        ')'
      );
    }
  }

  // --------------------------------------------------------------------
  // DUNGEON: spawn per room (per patch), default 3 guards per room.
  //
  // Rules:
  // - patrol rect is the room interior (when available), not just patch+margin;
  // - guards spawn on '.' floor tiles only;
  // - pattern per room:
  //      * 2 guards prefer OUTSIDE the patch (room walkable area),
  //      * 1 guard prefers INSIDE the patch (walkable area inside the frame),
  //      * any extra guards (from GUARDS_PER_PATCH > 3) prefer OUTSIDE.
  // - If there are not enough cells in the preferred zone, we gracefully
  //   fall back to the other zone.
  // --------------------------------------------------------------------
  if (layoutType === 'dungeon') {
    if (commentBlocksGlobal.length === 0) {
      console.warn('[patch_to_level] Dungeon layout but no patches; falling back to legacy guards.');
    } else {
      const defaultMargin = 2;
      const shrinkMargin = 1;

      // Filter cells strictly OUTSIDE the commented patch rectangle.
      function filterCellsOutsidePatch(cells, patch) {
        if (!cells || !cells.length || !patch) return cells;

        const patchMinCol = patch.x;
        const patchMaxCol = patch.x + patch.w - 1;
        const patchMinRow = patch.y;
        const patchMaxRow = patch.y + patch.h - 1;

        return cells.filter((c) =>
          c.col < patchMinCol ||
          c.col > patchMaxCol ||
          c.row < patchMinRow ||
          c.row > patchMaxRow
        );
      }

      // Filter cells strictly INSIDE the commented patch rectangle.
      function filterCellsInsidePatch(cells, patch) {
        if (!cells || !cells.length || !patch) return [];

        const patchMinCol = patch.x;
        const patchMaxCol = patch.x + patch.w - 1;
        const patchMinRow = patch.y;
        const patchMaxRow = patch.y + patch.h - 1;

        return cells.filter((c) =>
          c.col >= patchMinCol &&
          c.col <= patchMaxCol &&
          c.row >= patchMinRow &&
          c.row <= patchMaxRow
        );
      }

      commentBlocksGlobal.forEach((b, patchIndex) => {
        // 1) Base patrol rectangle:
        //    - prefer the room interior we exported from buildDungeonLayout;
        //    - fall back to patch rect + small margin.
        let baseMinCol, baseMaxCol, baseMinRow, baseMaxRow;

        if (
          typeof b.roomMinCol === 'number' &&
          typeof b.roomMaxCol === 'number' &&
          typeof b.roomMinRow === 'number' &&
          typeof b.roomMaxRow === 'number'
        ) {
          baseMinCol = b.roomMinCol;
          baseMaxCol = b.roomMaxCol;
          baseMinRow = b.roomMinRow;
          baseMaxRow = b.roomMaxRow;
        } else {
          baseMinCol = Math.max(0, b.x - defaultMargin);
          baseMaxCol = Math.min(ROOM_W - 1, b.x + b.w - 1 + defaultMargin);
          baseMinRow = Math.max(0, b.y - defaultMargin);
          baseMaxRow = Math.min(ROOM_H - 1, b.y + b.h - 1 + defaultMargin);
        }

        // Collect all walkable cells ('.') in the base rect.
        let allWalkable = collectWalkableCells(
          baseMinCol,
          baseMaxCol,
          baseMinRow,
          baseMaxRow
        );

        if (allWalkable.length === 0) {
          console.warn(
            '[patch_to_level] WARNING (dungeon): no walkable cells around patch',
            b.id || patchIndex,
            '— guards will be skipped for this room.'
          );
          return;
        }

        // 2) Try to shrink the patrol rectangle by 1 cell on each side,
        //    so guards are less likely to get stuck hugging the walls.
        let minCol = baseMinCol;
        let maxCol = baseMaxCol;
        let minRow = baseMinRow;
        let maxRow = baseMaxRow;

        if (
          baseMaxCol - baseMinCol >= 2 * shrinkMargin + 1 &&
          baseMaxRow - baseMinRow >= 2 * shrinkMargin + 1
        ) {
          const tightMinCol = baseMinCol + shrinkMargin;
          const tightMaxCol = baseMaxCol - shrinkMargin;
          const tightMinRow = baseMinRow + shrinkMargin;
          const tightMaxRow = baseMaxRow - shrinkMargin;

          const tightCells = collectWalkableCells(
            tightMinCol,
            tightMaxCol,
            tightMinRow,
            tightMaxRow
          );

          // Use the tighter rect only if it still has valid floor cells.
          if (tightCells.length > 0) {
            minCol = tightMinCol;
            maxCol = tightMaxCol;
            minRow = tightMinRow;
            maxRow = tightMaxRow;
            allWalkable = tightCells;
          }
        }

        // Split walkable cells into OUTSIDE and INSIDE patch zones.
        const outsideCells = filterCellsOutsidePatch(allWalkable, b);
        const insideCells  = filterCellsInsidePatch(allWalkable, b);

        if (outsideCells.length === 0 && insideCells.length === 0) {
          console.warn(
            '[patch_to_level] WARNING (dungeon): no valid walkable cells in room',
            b.id || patchIndex,
            '— guards will be skipped for this room.'
          );
          return;
        }

        const totalGuards = dungeonGuardsPerRoom;
        if (totalGuards <= 0) {
          return;
        }

        // Desired zone pattern per room:
        //  - 1st guard  -> outside
        //  - 2nd guard  -> outside
        //  - 3rd guard  -> inside
        //  - 4th+ guard -> outside
        const desiredZones = [];
        if (totalGuards >= 1) desiredZones.push('outside');
        if (totalGuards >= 2) desiredZones.push('outside');
        if (totalGuards >= 3) desiredZones.push('inside');
        for (let i = 3; i < totalGuards; i++) {
          desiredZones.push('outside');
        }

        // Precompute randomized pools for each zone.
        // We use pickGuardSpawnsInArea with max count to:
        //  - randomize order,
        //  - avoid multiple guards sharing same row/column where possible.
        const outsidePool = (outsideCells.length > 0)
          ? pickGuardSpawnsInArea(outsideCells, outsideCells.length)
          : [];
        const insidePool = (insideCells.length > 0)
          ? pickGuardSpawnsInArea(insideCells, insideCells.length)
          : [];

        const spawnCells = [];

        // Assign guards according to desiredZones, with graceful fallback:
        // if preferred zone has no cells left, try the other zone.
        desiredZones.forEach((zone) => {
          if (zone === 'inside') {
            if (insidePool.length > 0) {
              spawnCells.push(insidePool.shift());
            } else if (outsidePool.length > 0) {
              spawnCells.push(outsidePool.shift());
            }
          } else {
            // zone == 'outside'
            if (outsidePool.length > 0) {
              spawnCells.push(outsidePool.shift());
            } else if (insidePool.length > 0) {
              spawnCells.push(insidePool.shift());
            }
          }
        });

        if (spawnCells.length === 0) {
          console.warn(
            '[patch_to_level] WARNING (dungeon): could not place guards for room',
            b.id || patchIndex,
            '— no valid spawn cells.'
          );
          return;
        }

        // Finally create guards with a single patrol rect = whole room interior.
        spawnCells.forEach((cell, i) => {
          const gid = `room_${patchIndex}_${i}`;
          guards.push({
            id: gid,
            patrolType: 'rect',
            startCol: cell.col,
            startRow: cell.row,
            rect: { minCol, maxCol, minRow, maxRow },
            fovProfile: 'A',
            behavior: 'chaser'
          });
        });
      });

      console.log(
        '[patch_to_level] Dungeon guards generated:',
        guards.length,
        '(per room =',
        dungeonGuardsPerRoom,
        ')'
      );
    }
  }

  // --------------------------------------------------------------------
  // ARENA (and rooms_line treated as arena-style):
  // spawn per quadrant: NW / NE / SW / SE.
  //
  // Partition strategy (disjoint rectangles, matching overlay.js):
  //   - NW: row < midRow, col < midCol
  //   - NE: row < midRow, col >= midCol
  //   - SW: row >= midRow, col < midCol
  //   - SE: row >= midRow, col >= midCol
  //
  // Default 3 guards per quadrant, never in "single-file" row/column if possible.
  // --------------------------------------------------------------------
  if (layoutType === 'arena') {
    if (!hasGrid) {
      console.warn('[patch_to_level] Arena layout but empty levelGrid; no guards generated.');
    } else {
      const h = gridH;
      const w = gridW;

      // Same split logic used by overlay.js for sectorAlerts / getSector().
      const midRow = Math.floor(h / 2);
      const midCol = Math.floor(w / 2);

      const sectors = {
        NW: { cells: [], minCol: w, maxCol: -1, minRow: h, maxRow: -1 },
        NE: { cells: [], minCol: w, maxCol: -1, minRow: h, maxRow: -1 },
        SW: { cells: [], minCol: w, maxCol: -1, minRow: h, maxRow: -1 },
        SE: { cells: [], minCol: w, maxCol: -1, minRow: h, maxRow: -1 }
      };

      // Assign every walkable cell ('.') to exactly one quadrant.
      for (let row = 0; row < h; row++) {
        for (let col = 0; col < w; col++) {
          if (levelGrid[row][col] !== '.') continue;

          let sectorName;
          if (row < midRow) {
            sectorName = (col < midCol) ? 'NW' : 'NE';
          } else {
            sectorName = (col < midCol) ? 'SW' : 'SE';
          }

          const s = sectors[sectorName];
          s.cells.push({ col, row });

          if (col < s.minCol) s.minCol = col;
          if (col > s.maxCol) s.maxCol = col;
          if (row < s.minRow) s.minRow = row;
          if (row > s.maxRow) s.maxRow = row;
        }
      }

      ['NW', 'NE', 'SW', 'SE'].forEach((name) => {
        const s = sectors[name];
        if (s.cells.length === 0) {
          console.warn(
            '[patch_to_level] Arena quadrant',
            name,
            'has no walkable cells; skipping guards for this quadrant.'
          );
          return;
        }

        // Safety: if min/max were never updated, skip this quadrant.
        if (s.minCol > s.maxCol || s.minRow > s.maxRow) {
          console.warn(
            '[patch_to_level] Arena quadrant',
            name,
            'has invalid bounds; skipping.'
          );
          return;
        }

        const spawnCells = pickGuardSpawnsInArea(s.cells, arenaGuardsPerSector);

        spawnCells.forEach((cell, i) => {
          const gid = `sec_${name}_${i}`;
          guards.push({
            id: gid,
            patrolType: 'rect',
            startCol: cell.col,
            startRow: cell.row,
            rect: {
              minCol: s.minCol,
              maxCol: s.maxCol,
              minRow: s.minRow,
              maxRow: s.maxRow
            },
            fovProfile: 'A',
            behavior: 'chaser'
          });
        });
      });

      console.log(
        '[patch_to_level] Arena guards generated:',
        guards.length,
        '(per quadrant =',
        arenaGuardsPerSector,
        ')'
      );
    }
  }

  // --------------------------------------------------------------------
  // Fallback: if for some reason we did not generate any guards at all,
  // keep the old static 3-guards config.
  // --------------------------------------------------------------------
  if (guards.length === 0) {
    guards.push(
      {
        id: 'g1',
        patrolType: 'rect',
        startCol: 12,
        startRow: 8,
        rect: { minCol: 8, maxCol: 20, minRow: 6, maxRow: 12 },
        fovProfile: 'A',
        behavior: 'chaser'
      },
      {
        id: 'g2',
        patrolType: 'rect',
        startCol: 40,
        startRow: 12,
        rect: { minCol: 36, maxCol: 50, minRow: 10, maxRow: 18 },
        fovProfile: 'A',
        behavior: 'chaser'
      },
      {
        id: 'g3',
        patrolType: 'rect',
        startCol: 25,
        startRow: 20,
        rect: { minCol: 22, maxCol: 32, minRow: 18, maxRow: 24 },
        fovProfile: 'A',
        behavior: 'chaser'
      }
    );

    console.log(
      '[patch_to_level] Using legacy static guards as fallback:',
      guards.length
    );
  }

  // Liberation triggers: one per commented patch (frame), same as before.
  const liberationTriggers = commentBlocksGlobal.map((b, idx) => {
    const x = b.x;
    const y = b.y;
    const w = b.w;
    const h = b.h;

    const corners = [
      { col: x,         row: y },
      { col: x + w - 1, row: y },
      { col: x,         row: y + h - 1 },
      { col: x + w - 1, row: y + h - 1 }
    ];

    return {
      id: b.id || `patch_${idx}`,
      type: 'fourCorners',
      corners,
      targetBlock: {
        x,
        y,
        w,
        h
      }
    };
  });

  // --------------------------------------------------------------------
  // PICKUPS: random ammo / medikit on walkable '.' cells in the whole map
  // --------------------------------------------------------------------
  if (hasGrid) {
    const allWalkable = collectWalkableCells(0, gridW - 1, 0, gridH - 1);

    if (allWalkable.length === 0) {
      console.warn('[patch_to_level] No walkable cells, pickups will be empty.');
    } else {
      // First pick ammo cells
      const ammoCells = pickRandomCells(allWalkable, AMMO_PICKUP_COUNT);

      // Remove ammo cells from the pool when picking medikits
      const usedKeys = new Set(
        ammoCells.map((c) => `${c.col},${c.row}`)
      );

      const remaining = allWalkable.filter(
        (c) => !usedKeys.has(`${c.col},${c.row}`)
      );

      const medCells = pickRandomCells(remaining, MEDIKIT_PICKUP_COUNT);

      ammoCells.forEach((pos) => {
        pickups.push({
          type: 'ammo',
          col: pos.col,
          row: pos.row
        });
      });

      medCells.forEach((pos) => {
        pickups.push({
          type: 'medikit',
          col: pos.col,
          row: pos.row
        });
      });
    }
  }

  return {
    guards,
    fovProfiles,
    liberationTriggers,
    playerSpawn: playerSpawn || null,
    layoutType,
    pickups
  };
}

// ----- Layout: arena --------------------------------------------------
//
// Keep cluster as-is, just center it into ROOM_W x ROOM_H.

function buildArenaLayout(fullGrid) {
  const {
    clusterGrid,
    clusterWidth,
    clusterHeight,
    blocks
  } = prepareCommentedCluster(fullGrid);

  const originX = Math.max(0, Math.floor((ROOM_W - clusterWidth) / 2));
  const originY = Math.max(0, Math.floor((ROOM_H - clusterHeight) / 2));

  if (originX + clusterWidth > ROOM_W || originY + clusterHeight > ROOM_H) {
    console.warn(
      '[patch_to_level] WARNING: cluster (',
      clusterWidth, 'x', clusterHeight,
      ') does not fully fit in room (',
      ROOM_W, 'x', ROOM_H,
      ') at origin (', originX, ',', originY, '). It will be clipped.'
    );
  }

  const orcaGrid = buildLevelGrid(ROOM_W, ROOM_H, clusterGrid, originX, originY);

  const commentBlocksGlobal = blocks.map((b, idx) => ({
    id: `patch_${idx}`,
    x: originX + b.x,
    y: originY + b.y,
    w: b.w,
    h: b.h
  }));

  return { orcaGrid, commentBlocksGlobal };
}

// ----- Layout: rooms_line ---------------------------------------------

function buildRoomsLineLayout(fullGrid) {
  const {
    clusterGrid,
    clusterWidth,
    clusterHeight,
    blocks
  } = prepareCommentedCluster(fullGrid);

  if (blocks.length === 0) {
    throw new Error('buildRoomsLineLayout: no patches found.');
  }

  // Step 1: build a room for each patch
  const patchRooms = blocks.map((b, idx) => {
    const sub = sliceGrid(
      clusterGrid,
      b.x,
      b.y,
      b.x + b.w - 1,
      b.y + b.h - 1
    );
    const patchGrid = sub.grid;
    const pw = sub.width;
    const ph = sub.height;

    // Room dimensions from patch size + margins
    const innerW = pw + ROOM_MARGIN_X * 2;
    const innerH = ph + ROOM_MARGIN_Y * 2;
    const roomW = innerW + 2; // walls left/right
    const roomH = innerH + 2; // walls top/bottom

    // Room grid: start fully WALL_CHAR (walls)
    const roomGrid = [];
    for (let ry = 0; ry < roomH; ry++) {
      const row = new Array(roomW).fill(WALL_CHAR);
      roomGrid.push(row);
    }

    // Carve interior (not including outer walls) as '.'
    for (let ry = 1; ry < roomH - 1; ry++) {
      for (let rx = 1; rx < roomW - 1; rx++) {
        roomGrid[ry][rx] = '.';
      }
    }

    // Position patch inside the room, with margins
    const patchOffsetX = 1 + ROOM_MARGIN_X;
    const patchOffsetY = 1 + ROOM_MARGIN_Y;

    for (let py = 0; py < ph; py++) {
      for (let px = 0; px < pw; px++) {
        const gx = patchOffsetX + px;
        const gy = patchOffsetY + py;
        roomGrid[gy][gx] = patchGrid[py][px];
      }
    }

    return {
      id: `patch_${idx}`,
      patchWidth: pw,
      patchHeight: ph,
      blockLocal: b,
      roomW,
      roomH,
      roomGrid,
      patchOffsetX,
      patchOffsetY
    };
  });

  // Step 2: compute global packing (horizontal line of rooms)
  let totalContentWidth = 0;
  let maxRoomHeight = 0;

  patchRooms.forEach((r, idx) => {
    totalContentWidth += r.roomW;
    if (idx < patchRooms.length - 1) {
      totalContentWidth += ROOM_GAP_COLS;
    }
    if (r.roomH > maxRoomHeight) {
      maxRoomHeight = r.roomH;
    }
  });

  if (totalContentWidth > ROOM_W) {
    console.warn(
      '[patch_to_level] WARNING: rooms_line layout total width (',
      totalContentWidth,
      ') exceeds ROOM_W =',
      ROOM_W,
      ' -> layout will be clipped horizontally.'
    );
  }

  const neededHeight = maxRoomHeight + 3; // rooms + corridor band (3 rows)
  if (neededHeight > ROOM_H) {
    console.warn(
      '[patch_to_level] WARNING: rooms_line layout total height (',
      neededHeight,
      ') exceeds ROOM_H =',
      ROOM_H,
      ' -> layout may be clipped vertically.'
    );
  }

  const roomsTop = Math.max(0, Math.floor((ROOM_H - neededHeight) / 2));
  // Corridor floor row: just below the tallest room, plus one spacer row
  let corridorY = roomsTop + maxRoomHeight + 1;
  if (corridorY >= ROOM_H - 1) {
    corridorY = ROOM_H - 2;
  }
  const corridorTopWall    = corridorY - 1;
  const corridorBottomWall = corridorY + 1;

  // Final global grid: start as all '.'
  const finalGrid = [];
  for (let y = 0; y < ROOM_H; y++) {
    const row = new Array(ROOM_W).fill('.');
    finalGrid.push(row);
  }

  // Place rooms from left to right
  let currentX = Math.max(0, Math.floor((ROOM_W - totalContentWidth) / 2));
  let firstRoomX = currentX;
  let lastRoomRight = currentX;

  const roomPlacements = [];

  patchRooms.forEach((r) => {
    const roomX = currentX;
    const roomY = roomsTop;

    // Blit room grid into final grid
    for (let ry = 0; ry < r.roomH; ry++) {
      const gy = roomY + ry;
      if (gy < 0 || gy >= ROOM_H) continue;
      for (let rx = 0; rx < r.roomW; rx++) {
        const gx = roomX + rx;
        if (gx < 0 || gx >= ROOM_W) continue;
        const ch = r.roomGrid[ry][rx];
        finalGrid[gy][gx] = ch;
      }
    }

    roomPlacements.push({
      ...r,
      roomX,
      roomY
    });

    lastRoomRight = roomX + r.roomW - 1;
    currentX += r.roomW + ROOM_GAP_COLS;
  });

  const corridorStartX = firstRoomX;
  const corridorEndX   = lastRoomRight;

  // Step 3: build corridor band (top and bottom walls around corridorY)
  for (let x = corridorStartX; x <= corridorEndX; x++) {
    if (corridorTopWall >= 0 && corridorTopWall < ROOM_H) {
      if (finalGrid[corridorTopWall][x] === '.') {
        finalGrid[corridorTopWall][x] = WALL_CHAR;
      }
    }
    if (corridorBottomWall >= 0 && corridorBottomWall < ROOM_H) {
      if (finalGrid[corridorBottomWall][x] === '.') {
        finalGrid[corridorBottomWall][x] = WALL_CHAR;
      }
    }
    // corridorY row itself remains '.' as walkable floor
  }

  const commentBlocksGlobal = [];

  // Step 4: connect each room to the corridor with a vertical shaft
  roomPlacements.forEach((r) => {
    // Comment block (patch frame) position in global coordinates
    const blockX = r.roomX + r.patchOffsetX;
    const blockY = r.roomY + r.patchOffsetY;

    commentBlocksGlobal.push({
      id: r.id,
      x: blockX,
      y: blockY,
      w: r.patchWidth,
      h: r.patchHeight
    });

    // Choose a door column roughly at the center of the patch area
    const patchCenterLocal = Math.floor(r.patchWidth / 2);
    let doorCol = r.roomX + r.patchOffsetX + patchCenterLocal;

    const interiorMinCol = r.roomX + 1;
    const interiorMaxCol = r.roomX + r.roomW - 2;

    if (doorCol < interiorMinCol) doorCol = interiorMinCol;
    if (doorCol > interiorMaxCol) doorCol = interiorMaxCol;

    // Door row: last interior row in the room
    let doorRow = r.roomY + r.roomH - 2;
    if (doorRow < 0) doorRow = 0;
    if (doorRow >= ROOM_H) doorRow = ROOM_H - 1;

    // Ensure interior cell is walkable
    finalGrid[doorRow][doorCol] = '.';

    // Build vertical shaft from doorRow down (or up) to corridorY
    const step = corridorY > doorRow ? 1 : -1;
    for (let y = doorRow + step; ; y += step) {
      if (y < 0 || y >= ROOM_H) break;
      finalGrid[y][doorCol] = '.';
      if (y === corridorY) break;
    }
  });

  const orcaGrid = finalGrid.map((row) => row.join('')).join('\n') + '\n';
  return { orcaGrid, commentBlocksGlobal };
}

// ----- Layout: dungeon ------------------------------------------------

function rectsOverlap(a, b) {
  return !(
    a.x + a.w <= b.x ||
    b.x + b.w <= a.x ||
    a.y + a.h <= b.y ||
    b.y + b.h <= a.y
  );
}

function randInt(min, max) {
  if (max < min) return min;
  return min + Math.floor(Math.random() * (max - min + 1));
}

// Carve a horizontal corridor centered on centerY, from x1 to x2,
// with a given vertical thickness "width".
function carveHorizontalCorridor(grid, centerY, x1, x2, width) {
  const h = grid.length;
  const w = grid[0].length;

  const startX = Math.max(0, Math.min(x1, x2));
  const endX   = Math.min(w - 1, Math.max(x1, x2));

  const halfBelow = Math.floor((width - 1) / 2);
  const halfAbove = width - 1 - halfBelow;

  const yStart = Math.max(0, centerY - halfBelow);
  const yEnd   = Math.min(h - 1, centerY + halfAbove);

  for (let y = yStart; y <= yEnd; y++) {
    for (let x = startX; x <= endX; x++) {
      grid[y][x] = '.';
    }
  }
}

// Carve a vertical corridor centered on centerX, from y1 to y2,
// with a given horizontal thickness "width".
function carveVerticalCorridor(grid, centerX, y1, y2, width) {
  const h = grid.length;
  const w = grid[0].length;

  const startY = Math.max(0, Math.min(y1, y2));
  const endY   = Math.min(h - 1, Math.max(y1, y2));

  const halfLeft  = Math.floor((width - 1) / 2);
  const halfRight = width - 1 - halfLeft;

  const xStart = Math.max(0, centerX - halfLeft);
  const xEnd   = Math.min(w - 1, centerX + halfRight);

  for (let y = startY; y <= endY; y++) {
    for (let x = xStart; x <= xEnd; x++) {
      grid[y][x] = '.';
    }
  }
}

function buildDungeonLayout(fullGrid) {
  const {
    clusterGrid,
    clusterWidth,
    clusterHeight,
    blocks
  } = prepareCommentedCluster(fullGrid);

  if (blocks.length === 0) {
    throw new Error('buildDungeonLayout: no patches found.');
  }

  // Extract patches as independent blocks
  const patchDescs = blocks.map((b, idx) => {
    const sub = sliceGrid(
      clusterGrid,
      b.x,
      b.y,
      b.x + b.w - 1,
      b.y + b.h - 1
    );
    return {
      id: `patch_${idx}`,
      patchWidth: sub.width,
      patchHeight: sub.height,
      patchGrid: sub.grid
    };
  });

  // --------------------------------------------------------------
  // Adaptive tuning of room margins and corridor thickness
  // --------------------------------------------------------------
  const totalMapArea = ROOM_W * ROOM_H;

  // Approximate "ideal" area if every room used MAX margins.
  let idealArea = 0;
  patchDescs.forEach((p) => {
    const pw = p.patchWidth;
    const ph = p.patchHeight;

    const innerW = pw + ROOM_MARGIN_X_MAX * 2;
    const innerH = ph + ROOM_MARGIN_Y_MAX * 2;
    const fullW = innerW + 2; // + walls
    const fullH = innerH + 2;

    idealArea += fullW * fullH;
  });

  const targetFillFraction = DUNGEON_TARGET_FILL;
  let areaScale = 1.0;

  // If ideal area exceeds the target fraction of the map,
  // shrink margins / corridor widths proportionally.
  if (idealArea > 0 && idealArea > totalMapArea * targetFillFraction) {
    areaScale = (totalMapArea * targetFillFraction) / idealArea;
    // Do not shrink below 10% of the configured margin range
    if (areaScale < 0.1) {
      areaScale = 0.1;
    }
  }

  const marginXRange = Math.max(0, ROOM_MARGIN_X_MAX - ROOM_MARGIN_X_MIN);
  const marginYRange = Math.max(0, ROOM_MARGIN_Y_MAX - ROOM_MARGIN_Y_MIN);

  const ADAPTIVE_MARGIN_X_MAX =
    ROOM_MARGIN_X_MIN + Math.round(marginXRange * areaScale);
  const ADAPTIVE_MARGIN_Y_MAX =
    ROOM_MARGIN_Y_MIN + Math.round(marginYRange * areaScale);

  const corridorWidthRange = Math.max(0, CORRIDOR_WIDTH_MAX - CORRIDOR_WIDTH_MIN);
  const ADAPTIVE_CORRIDOR_WIDTH_MAX =
    CORRIDOR_WIDTH_MIN + Math.round(corridorWidthRange * areaScale);

  console.log(
    '[patch_to_level] Dungeon adaptive scale:',
    'patchCount =', patchDescs.length,
    'idealArea =', idealArea,
    'mapArea =', totalMapArea,
    'areaScale =', areaScale.toFixed(3),
    'marginXMaxUsed =', ADAPTIVE_MARGIN_X_MAX,
    'marginYMaxUsed =', ADAPTIVE_MARGIN_Y_MAX,
    'corridorWidthMaxUsed =', ADAPTIVE_CORRIDOR_WIDTH_MAX
  );


  // Final grid: initially full of walls
  const finalGrid = [];
  for (let y = 0; y < ROOM_H; y++) {
    const row = new Array(ROOM_W).fill(WALL_CHAR);
    finalGrid.push(row);
  }

  const placedRooms = [];
  const roomRects = [];

  // Place rooms like a simple random-dungeon algorithm,
  // but with variable margins per room and HARD no-overlap.
  patchDescs.forEach((p) => {
    const pw = p.patchWidth;
    const ph = p.patchHeight;

    // Random margins around patch (adaptive max)
    const marginX = randInt(ROOM_MARGIN_X_MIN, ADAPTIVE_MARGIN_X_MAX);
    const marginY = randInt(ROOM_MARGIN_Y_MIN, ADAPTIVE_MARGIN_Y_MAX);


    const innerW = pw + marginX * 2;
    const innerH = ph + marginY * 2;

    const fullW = innerW + 2; // + walls
    const fullH = innerH + 2;

    let rectX = 0;
    let rectY = 0;

    const maxRectX = Math.max(0, ROOM_W - fullW);
    const maxRectY = Math.max(0, ROOM_H - fullH);

    let placed = false;

    if (maxRectX < 0 || maxRectY < 0) {
      // Room larger than map: we accept clipping, but still avoid crashing.
      console.warn(
        '[patch_to_level] Dungeon: room for',
        p.id,
        'bigger than map, clipping at (0,0).'
      );
      rectX = 0;
      rectY = 0;
      placed = true;
    } else {
      // 1) Random attempts for variety
      let attempts = 0;
      const MAX_RANDOM_ATTEMPTS = 100;

      while (attempts < MAX_RANDOM_ATTEMPTS && !placed) {
        const candidate = {
          x: randInt(0, maxRectX),
          y: randInt(0, maxRectY),
          w: fullW,
          h: fullH
        };
        const overlap = roomRects.some((rr) => rectsOverlap(rr, candidate));
        if (!overlap) {
          rectX = candidate.x;
          rectY = candidate.y;
          placed = true;
          break;
        }
        attempts++;
      }

      // 2) Deterministic scan: guarantee non-overlap if it exists
      if (!placed) {
        outerScan:
        for (let y = 0; y <= maxRectY; y++) {
          for (let x = 0; x <= maxRectX; x++) {
            const candidate = { x, y, w: fullW, h: fullH };
            const overlap = roomRects.some((rr) => rectsOverlap(rr, candidate));
            if (!overlap) {
              rectX = x;
              rectY = y;
              placed = true;
              break outerScan;
            }
          }
        }
      }

      // 3) Se ancora non c'è spazio, falliamo con errore esplicito
      if (!placed) {
        throw new Error(
          '[patch_to_level] Dungeon: could not place room for ' +
          p.id +
          ' without overlap. Increase ROOM_W/ROOM_H or reduce number/size of patches.'
        );
      }
    }

    const floorX = rectX + 1;
    const floorY = rectY + 1;

    // Dig interior floor
    for (let y = floorY; y < floorY + innerH; y++) {
      if (y < 0 || y >= ROOM_H) continue;
      for (let x = floorX; x < floorX + innerW; x++) {
        if (x < 0 || x >= ROOM_W) continue;
        finalGrid[y][x] = '.';
      }
    }

    const centerX = floorX + Math.floor(innerW / 2);
    const centerY = floorY + Math.floor(innerH / 2);

    const patchOffsetX = floorX + marginX;
    const patchOffsetY = floorY + marginY;

    const roomInfo = {
      ...p,
      innerW,
      innerH,
      fullW,
      fullH,
      rectX,
      rectY,
      floorX,
      floorY,
      centerX,
      centerY,
      patchOffsetX,
      patchOffsetY
    };

    placedRooms.push(roomInfo);
    roomRects.push({ x: rectX, y: rectY, w: fullW, h: fullH });
  });


  // Connect rooms with L-shaped corridors of variable thickness
  for (let i = 0; i < placedRooms.length - 1; i++) {
    const r1 = placedRooms[i];
    const r2 = placedRooms[i + 1];

    const x1 = r1.centerX;
    const y1 = r1.centerY;
    const x2 = r2.centerX;
    const y2 = r2.centerY;

    const corridorWidthH = randInt(CORRIDOR_WIDTH_MIN, ADAPTIVE_CORRIDOR_WIDTH_MAX);
    const corridorWidthV = randInt(CORRIDOR_WIDTH_MIN, ADAPTIVE_CORRIDOR_WIDTH_MAX);


    // Horizontal segment
    carveHorizontalCorridor(finalGrid, y1, x1, x2, corridorWidthH);
    // Vertical segment
    carveVerticalCorridor(finalGrid, x2, y1, y2, corridorWidthV);
  }

    // Insert patch grids into their rooms
  const commentBlocksGlobal = [];

  placedRooms.forEach((r) => {
    const pw = r.patchWidth;
    const ph = r.patchHeight;

    // Copy patch glyphs into the room interior.
    for (let py = 0; py < ph; py++) {
      const gy = r.patchOffsetY + py;
      if (gy < 0 || gy >= ROOM_H) continue;
      for (let px = 0; px < pw; px++) {
        const gx = r.patchOffsetX + px;
        if (gx < 0 || gx >= ROOM_W) continue;
        finalGrid[gy][gx] = r.patchGrid[py][px];
      }
    }

    // Room interior rectangle (only '.' floor area).
    // We export it so that JSON generation can:
    // - spawn guards inside the actual room,
    // - use the room interior as patrol rect base.
    const roomMinCol = r.floorX;
    const roomMaxCol = r.floorX + r.innerW - 1;
    const roomMinRow = r.floorY;
    const roomMaxRow = r.floorY + r.innerH - 1;

    commentBlocksGlobal.push({
      id: r.id,
      x: r.patchOffsetX,
      y: r.patchOffsetY,
      w: r.patchWidth,
      h: r.patchHeight,
      roomMinCol,
      roomMaxCol,
      roomMinRow,
      roomMaxRow
    });
  });

  const orcaGrid = finalGrid.map((row) => row.join('')).join('\n') + '\n';
  return { orcaGrid, commentBlocksGlobal };
}



// ----- Main -----------------------------------------------------------

try {
  const rawLines = loadRawLines(inputPath);
  const { grid: fullGrid } = normalizeGrid(rawLines);

  let layoutResult;

  if (layout === 'rooms_line') {
    console.log('[patch_to_level] Using layout: rooms_line');
    layoutResult = buildRoomsLineLayout(fullGrid);
  } else if (layout === 'dungeon') {
    console.log('[patch_to_level] Using layout: dungeon');
    // Usa il tuo generatore dungeon esistente.
    layoutResult = buildDungeonLayout(fullGrid);
  } else {
    console.log('[patch_to_level] Using layout: arena');
    layoutResult = buildArenaLayout(fullGrid);
  }

  let orcaGrid = layoutResult.orcaGrid;
  const commentBlocksGlobal = layoutResult.commentBlocksGlobal || [];
  let playerSpawn = layoutResult.playerSpawn || null;

  // Solo per il layout dungeon: aggiungi una piccola stanza di spawn
  // dedicata, collegata al dungeon con un corridoio 1-cella.
  if (layout === 'dungeon') {
    const spawnResult = injectPlayerSpawnRoomIntoDungeon(orcaGrid);
    orcaGrid = spawnResult.orcaGrid;
    playerSpawn = spawnResult.playerSpawn;
  }

  // Converto l'ORCA finale in griglia per sapere dove sono i muri/floor.
  const levelGridInfo = stringToGrid(orcaGrid);
  const levelGrid = levelGridInfo.grid;

    const jsonConfig = createLevelJson(commentBlocksGlobal, playerSpawn, levelGrid, layout);

  // layoutType is already set inside createLevelJson, but we keep this
  // for clarity and to override if needed.
  const layoutType =
    (layout === 'dungeon')
      ? 'dungeon'
      : 'arena';

  jsonConfig.layoutType = layoutType;


  fs.writeFileSync(outOrcaPath, orcaGrid, 'utf8');
  fs.writeFileSync(outJsonPath, JSON.stringify(jsonConfig, null, 2), 'utf8');

  console.log('[patch_to_level] Done.');
  console.log('  ORCA level :', outOrcaPath);
  console.log('  JSON config:', outJsonPath);
  console.log('  Detected patches:', commentBlocksGlobal.length);
  console.log('  Layout:', layout, 'GUARDS_PER_PATCH:', GUARDS_PER_PATCH);
  console.log('  layoutType exported for overlay:', layoutType);
  if (playerSpawn) {
    console.log(
      '  Player spawn:',
      'col =', playerSpawn.col,
      'row =', playerSpawn.row
    );
  }
    const totalPickups = Array.isArray(jsonConfig.pickups) ? jsonConfig.pickups.length : 0;
  const ammoCount = jsonConfig.pickups
    ? jsonConfig.pickups.filter((p) => p.type === 'ammo').length
    : 0;
  const medCount = jsonConfig.pickups
    ? jsonConfig.pickups.filter((p) => p.type === 'medikit').length
    : 0;

  console.log(
    '  Pickups requested: ammo =', AMMO_PICKUP_COUNT,
    ', medikit =', MEDIKIT_PICKUP_COUNT
  );
  console.log(
    '  Pickups generated:',
    totalPickups,
    '(ammo =', ammoCount,
    ', medikit =', medCount, ')'
  );

} catch (err) {
  console.error('[patch_to_level] Error:', err.message);
  process.exit(1);
}

