#!/usr/bin/env node

// Simple CLI:
//   node tools/patch_to_level.js input.orca levels/generated-level.orca generated-level.json
//
// input.orca:
//   - can be a small exported selection from ORCA
//   - OR a full ORCA grid export containing one or more *commented* patches
//
// HOW PATCHES ARE DETECTED (IMPORTANT):
// - Each unlockable patch must be surrounded by two vertical rails of '#':
//     #....................#
//     #....patch code......#
//     #....patch code......#
//     #....................#
// - On each row, *per patch*, '#' must appear in LEFT/RIGHT pairs.
//   Example with 2 patches on the same row:
//     #.....#..........#....#
//     ^  ^        ^    ^
//     |  |        |    |
//     patch A     patch B
//   The script pairs indices (0,1) -> first patch, (2,3) -> second patch.
// - Different patches CAN share rows (same y) as long as their
//   left/right rails are at different columns.
// - Inside the patch area, avoid additional '#' characters that are
//   not part of the left/right rails, otherwise they may be misread
//   as extra rails.
// - If NO '#' rails are found at all, the script will:
//     * auto-wrap the entire non-empty area in a single comment block
//     * treat that as ONE patch.
//
// OUTPUT:
// - generated-level.orca : an ROOM_W x ROOM_H ORCA grid (by default 80x40)
//                          with all commented patches centered as a single
//                          "cluster".
// - generated-level.json : level config for overlay.js,
//                          with one liberationTrigger per patch block.

const fs = require('fs');
const path = require('path');

// ----- CLI args -------------------------------------------------------

if (process.argv.length < 5) {
  console.error('Usage: node patch_to_level.js <input.orca> <output.orca> <output.json>');
  process.exit(1);
}

const inputPath   = process.argv[2];
const outOrcaPath = process.argv[3];
const outJsonPath = process.argv[4];

// Room size can be overridden via environment variables, e.g.
//   ROOM_W=100 ROOM_H=40 node ...
const ROOM_W = parseInt(process.env.ROOM_W, 10) || 80;
const ROOM_H = parseInt(process.env.ROOM_H, 10) || 40;

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
// New strategy (supports multiple patches sharing rows):
//   - For each row, collect ALL x where char == '#'.
//   - Interpret them as LEFT/RIGHT pairs: (x0,x1), (x2,x3), ...
//     -> each pair is one horizontal segment of a patch on that row.
//   - Group segments by (xLeft,xRight) across all rows.
//   - For each pair (xLeft,xRight), split its row list into contiguous
//     vertical ranges; each range is a distinct comment block.
//
// Assumptions:
//   - For each patch row, the first '#' of the patch is its left wall,
//     the next '#' is its right wall, and so on for multiple patches.
//   - Inside the patch, there are no extra '#' characters.

function findCommentBlocks(clusterGrid) {
  const height = clusterGrid.length;
  const width = clusterGrid[0].length;

  // Map key "xLeft,xRight" -> { xLeft, xRight, rows: [y...] }
  const pairMap = new Map();

  for (let y = 0; y < height; y++) {
    const row = clusterGrid[y];
    const hashXs = [];
    for (let x = 0; x < width; x++) {
      if (row[x] === '#') {
        hashXs.push(x);
      }
    }

    if (hashXs.length < 2) {
      continue;
    }

    if (hashXs.length % 2 !== 0) {
      console.warn(
        '[patch_to_level] WARNING: row',
        y,
        'has an odd number of "#" (',
        hashXs.length,
        '). Last one will be ignored.'
      );
    }

    // Pair indices: (0,1), (2,3), ...
    for (let i = 0; i + 1 < hashXs.length; i += 2) {
      const xLeft = hashXs[i];
      const xRight = hashXs[i + 1];
      if (xRight <= xLeft) {
        continue;
      }

      const key = xLeft + ',' + xRight;
      let entry = pairMap.get(key);
      if (!entry) {
        entry = { xLeft, xRight, rows: [] };
        pairMap.set(key, entry);
      }
      entry.rows.push(y);
    }
  }

  const blocks = [];

  // For each vertical pair of rails, split into contiguous row-ranges.
  for (const entry of pairMap.values()) {
    const rows = entry.rows.slice().sort((a, b) => a - b);
    if (rows.length === 0) continue;

    let startIdx = 0;
    while (startIdx < rows.length) {
      let endIdx = startIdx;
      while (
        endIdx + 1 < rows.length &&
        rows[endIdx + 1] === rows[endIdx] + 1
      ) {
        endIdx++;
      }

      const yStart = rows[startIdx];
      const yEnd = rows[endIdx];

      const w = entry.xRight - entry.xLeft + 1;
      const h = yEnd - yStart + 1;

      blocks.push({
        x: entry.xLeft,
        y: yStart,
        w,
        h
      });

      startIdx = endIdx + 1;
    }
  }

  // Stable ordering: top-to-bottom, then left-to-right.
  blocks.sort((a, b) => {
    if (a.y !== b.y) return a.y - b.y;
    return a.x - b.x;
  });

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

// Build a full ORCA grid and insert the cluster (which may contain multiple
// comment blocks) at (originX, originY).
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

// commentBlocksGlobal: array of { id, x, y, w, h } in ROOM coordinates.
function createLevelJson(commentBlocksGlobal) {
  // Basic guards and FOV profile, same as previous prototype.
  // This can later be parameterized or replaced by templates.
  const guards = [
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
  ];

  const fovProfiles = {
    A: {
      depth: 9,
      widths: [1, 1, 3, 3, 3, 5, 5, 5, 7]
    }
  };

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
      id: `patch_${idx}`,
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

// ----- Main -----------------------------------------------------------

try {
  const rawLines = loadRawLines(inputPath);
  const { grid: fullGrid } = normalizeGrid(rawLines);

  // Compute cluster around all non-dot glyphs, ensure comment-blocks exist.
  const {
    clusterGrid,
    clusterWidth,
    clusterHeight,
    blocks
  } = prepareCommentedCluster(fullGrid);

  // Compute centered origin within ROOM_W x ROOM_H.
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

  // Map local block coordinates to global room coordinates.
  const commentBlocksGlobal = blocks.map((b, idx) => ({
    id: `patch_${idx}`,
    x: originX + b.x,
    y: originY + b.y,
    w: b.w,
    h: b.h
  }));

  const orcaGrid   = buildLevelGrid(ROOM_W, ROOM_H, clusterGrid, originX, originY);
  const jsonConfig = createLevelJson(commentBlocksGlobal);

  fs.writeFileSync(outOrcaPath, orcaGrid, 'utf8');
  fs.writeFileSync(outJsonPath, JSON.stringify(jsonConfig, null, 2), 'utf8');

  console.log('[patch_to_level] Done.');
  console.log('  ORCA level :', outOrcaPath);
  console.log('  JSON config:', outJsonPath);
  console.log('  Detected comment blocks:', commentBlocksGlobal.length);
} catch (err) {
  console.error('[patch_to_level] Error:', err.message);
  process.exit(1);
}


