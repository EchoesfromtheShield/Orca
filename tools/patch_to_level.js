#!/usr/bin/env node

// Simple CLI:
//   node tools/patch_to_level.js input.orca levels/generated-level.orca generated-level.json [layout] [guardsPerPatch]
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
//    - Each patch (comment block) is extracted as its own patch grid.
//    - For each patch we build a rectangular "room" with walls in 'y':
//        - outer border: 'y' (non-walkable walls in the game)
//        - interior: '.' (walkable floor)
//        - patch (with its '#' frame) embedded inside, with margins
//    - Rooms are placed in a horizontal line, with a configurable gap.
//    - Below the rooms we create a corridor band:
//        - center row: '.' (walkable corridor)
//        - row above and below: 'y' (corridor walls)
//    - Each room is connected to the corridor by a vertical shaft of '.'.
//
// Room size is automatically adapted to patch size:
//   innerW = patchWidth  + 2 * ROOM_MARGIN_X
//   innerH = patchHeight + 2 * ROOM_MARGIN_Y
//   roomW  = innerW + 2  (walls)
//   roomH  = innerH + 2  (walls)
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
  console.error('Usage: node patch_to_level.js <input.orca> <output.orca> <output.json> [layout] [guardsPerPatch]');
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

// Room size can be overridden via environment variables, e.g.
//   ROOM_W=100 ROOM_H=40 node ...
const ROOM_W = parseInt(process.env.ROOM_W, 10) || 80;
const ROOM_H = parseInt(process.env.ROOM_H, 10) || 40;

// Margins for "rooms_line" layout (can be overridden via env)
const ROOM_MARGIN_X   = parseInt(process.env.ROOM_MARGIN_X, 10) || 2;
const ROOM_MARGIN_Y   = parseInt(process.env.ROOM_MARGIN_Y, 10) || 1;
const ROOM_GAP_COLS   = parseInt(process.env.ROOM_GAP_COLS, 10) || 4;

// Sanitize layout
if (layout !== 'arena' && layout !== 'rooms_line') {
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

// ----- JSON config generation -----------------------------------------
//
// commentBlocksGlobal: array of { id, x, y, w, h } in ROOM coordinates.

function createLevelJson(commentBlocksGlobal) {
  const fovProfiles = {
    A: {
      depth: 9,
      widths: [1, 1, 3, 3, 3, 5, 5, 5, 7]
    }
  };

  const guards = [];

  if (GUARDS_PER_PATCH > 0 && commentBlocksGlobal.length > 0) {
    // Data-driven guards around each patch
    const margin = 2;

    commentBlocksGlobal.forEach((b, patchIndex) => {
      const minCol = Math.max(0, b.x - margin);
      const maxCol = Math.min(ROOM_W - 1, b.x + b.w - 1 + margin);
      const minRow = Math.max(0, b.y - margin);
      const maxRow = Math.min(ROOM_H - 1, b.y + b.h - 1 + margin);

      const rectWidth  = Math.max(1, maxCol - minCol + 1);
      const rectHeight = Math.max(1, maxRow - minRow + 1);

      for (let i = 0; i < GUARDS_PER_PATCH; i++) {
        const gid = `g_${patchIndex}_${i}`;

        // Simple spread of starting positions inside the rect
        const offX = i % rectWidth;
        const offY = Math.floor(i / rectWidth) % rectHeight;
        const startCol = minCol + offX;
        const startRow = minRow + offY;

        guards.push({
          id: gid,
          patrolType: 'rect',
          startCol,
          startRow,
          rect: { minCol, maxCol, minRow, maxRow },
          fovProfile: 'A',
          behavior: 'chaser'
        });
      }
    });

    console.log(
      '[patch_to_level] Guards generated from patches:',
      guards.length,
      '(per patch =',
      GUARDS_PER_PATCH,
      ')'
    );
  } else {
    // Legacy static 3-guard config (fallback)
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
      '[patch_to_level] Using legacy static guards (GUARDS_PER_PATCH=0 or no patches):',
      guards.length
    );
  }

  // One liberation trigger per comment block, all using "fourCorners" for now.
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

  return {
    guards,
    fovProfiles,
    liberationTriggers
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
//
// For each patch (comment block), build a "room" with walls = 'y',
// interior = '.', and the patch embedded inside with margins.
// Rooms are placed in a horizontal line, spaced by ROOM_GAP_COLS.
// Below the rooms we create a corridor band (walls + floor) and connect
// each room with a vertical shaft of '.'.

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

    // Room grid: start fully 'y' (walls)
    const roomGrid = [];
    for (let ry = 0; ry < roomH; ry++) {
      const row = new Array(roomW).fill('y');
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
        finalGrid[corridorTopWall][x] = 'y';
      }
    }
    if (corridorBottomWall >= 0 && corridorBottomWall < ROOM_H) {
      if (finalGrid[corridorBottomWall][x] === '.') {
        finalGrid[corridorBottomWall][x] = 'y';
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

// ----- Main -----------------------------------------------------------

try {
  const rawLines = loadRawLines(inputPath);
  const { grid: fullGrid } = normalizeGrid(rawLines);

  let layoutResult;

  if (layout === 'rooms_line') {
    console.log('[patch_to_level] Using layout: rooms_line');
    layoutResult = buildRoomsLineLayout(fullGrid);
  } else {
    console.log('[patch_to_level] Using layout: arena');
    layoutResult = buildArenaLayout(fullGrid);
  }

  const orcaGrid   = layoutResult.orcaGrid;
  const commentBlocksGlobal = layoutResult.commentBlocksGlobal;

  const jsonConfig = createLevelJson(commentBlocksGlobal);

  fs.writeFileSync(outOrcaPath, orcaGrid, 'utf8');
  fs.writeFileSync(outJsonPath, JSON.stringify(jsonConfig, null, 2), 'utf8');

  console.log('[patch_to_level] Done.');
  console.log('  ORCA level :', outOrcaPath);
  console.log('  JSON config:', outJsonPath);
  console.log('  Detected patches:', commentBlocksGlobal.length);
  console.log('  Layout:', layout, 'GUARDS_PER_PATCH:', GUARDS_PER_PATCH);
} catch (err) {
  console.error('[patch_to_level] Error:', err.message);
  process.exit(1);
}
