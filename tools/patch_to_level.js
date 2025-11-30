#!/usr/bin/env node

// Simple CLI:
//   node tools/patch_to_level.js input.orca levels/generated-level.orca generated-level.json
//
// input.orca:
//   - can be a small exported selection from ORCA
//   - OR a full ORCA grid export (any size, with the patch somewhere inside)
// The script will auto-detect the bounding box of non-dot glyphs and treat that as the patch.

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

// ----- Helpers --------------------------------------------------------

// Load an ORCA file (full grid or selection) and extract the tight bounding
// rectangle around all glyphs != '.'. That rectangle is considered the patch.
function loadPatchOrca(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  let lines = raw.split(/\r?\n/);

  // Drop leading/trailing completely empty lines (only whitespace).
  while (lines.length > 0 && lines[0].trim() === '') lines.shift();
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();

  if (lines.length === 0) {
    throw new Error('Input patch is empty (no lines).');
  }

  // Normalize to a rectangular grid with '.' padding on the right.
  const width = Math.max(...lines.map((l) => l.length));
  const grid = lines.map((l) => l.padEnd(width, '.').split(''));

  // Find bounding box of all glyphs that are not '.'
  let minX = width;
  let maxX = -1;
  let minY = grid.length;
  let maxY = -1;

  for (let y = 0; y < grid.length; y++) {
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
    throw new Error('No non-dot glyphs found in patch; file only contains ".".');
  }

  const patchWidth = maxX - minX + 1;
  const patchHeight = maxY - minY + 1;
  const patchLines = [];

  for (let y = minY; y <= maxY; y++) {
    let row = '';
    for (let x = minX; x <= maxX; x++) {
      row += grid[y][x];
    }
    patchLines.push(row);
  }

  return {
    width: patchWidth,
    height: patchHeight,
    lines: patchLines
  };
}

// Wrap the patch in a commented frame using '#' and '.'
// (used only when the input patch is NOT already framed).
function wrapPatchAsCommentBlock(patch) {
  const pw = patch.width;
  const ph = patch.height;
  const topBottom = '#' + '.'.repeat(pw) + '#';

  const lines = [];
  lines.push(topBottom);
  for (const line of patch.lines) {
    lines.push('#' + line + '#');
  }
  lines.push(topBottom);

  return {
    width: pw + 2,
    height: ph + 2,
    lines
  };
}

// Detect if the patch is already framed with '#' on all four edges.
// If yes, we keep it as-is; if not, we wrap it.
function maybeWrapPatchAsCommentBlock(patch) {
  const { width, height, lines } = patch;

  if (height < 2 || width < 2) {
    return wrapPatchAsCommentBlock(patch);
  }

  const top = lines[0];
  const bottom = lines[height - 1];

  // Simple check: corners are '#'
  const cornersAreHash =
    top[0] === '#' &&
    top[width - 1] === '#' &&
    bottom[0] === '#' &&
    bottom[width - 1] === '#';

  if (!cornersAreHash) {
    return wrapPatchAsCommentBlock(patch);
  }

  // Optional stricter check: left/right borders are '#' on every row
  const leftRightAreHash = lines.every((row) => row[0] === '#' && row[width - 1] === '#');

  if (!leftRightAreHash) {
    return wrapPatchAsCommentBlock(patch);
  }

  // Looks like a framed patch already, do not add another frame.
  return patch;
}

// Build a full ORCA grid and insert the commented patch at (ox, oy)
function buildLevelGrid(roomW, roomH, commentedPatch, ox, oy) {
  // Initialize grid with dots
  const grid = [];
  for (let y = 0; y < roomH; y++) {
    const row = new Array(roomW).fill('.');
    grid.push(row);
  }

  // Blit the commented patch into the grid
  for (let py = 0; py < commentedPatch.height; py++) {
    const gy = oy + py;
    if (gy < 0 || gy >= roomH) continue;

    const srcLine = commentedPatch.lines[py];
    for (let px = 0; px < commentedPatch.width; px++) {
      const gx = ox + px;
      if (gx < 0 || gx >= roomW) continue;
      const ch = srcLine[px] || '.';
      grid[gy][gx] = ch;
    }
  }

  return grid.map((row) => row.join('')).join('\n') + '\n';
}

// Create a basic JSON config compatible with the current overlay
function createLevelJson(commentedPatch, ox, oy) {
  const cw = commentedPatch.width;
  const ch = commentedPatch.height;

  const corners = [
    { col: ox,          row: oy },
    { col: ox + cw - 1, row: oy },
    { col: ox,          row: oy + ch - 1 },
    { col: ox + cw - 1, row: oy + ch - 1 }
  ];

  return {
    guards: [
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
    ],
    fovProfiles: {
      A: {
        depth: 9,
        widths: [1, 1, 3, 3, 3, 5, 5, 5, 7]
      }
    },
    liberationTriggers: [
      {
        id: 'main_patch',
        type: 'fourCorners',
        corners,
        targetBlock: {
          x: ox,
          y: oy,
          w: cw,
          h: ch
        }
      }
    ]
  };
}

// ----- Main -----------------------------------------------------------

try {
  const patch = loadPatchOrca(inputPath);

  // If the patch already has a '#' frame, keep it.
  // Otherwise, wrap it in a '#' frame so it is commented.
  const commented = maybeWrapPatchAsCommentBlock(patch);

  // For now we pick a fixed room size and fixed origin for the patch.
  const ROOM_W   = 80;
  const ROOM_H   = 40;
  const ORIGIN_X = 16;
  const ORIGIN_Y = 24;

  // Optional: warn if commented patch does not fit entirely in the room
  if (ORIGIN_X + commented.width > ROOM_W || ORIGIN_Y + commented.height > ROOM_H) {
    console.warn(
      '[patch_to_level] WARNING: commented patch (',
      commented.width, 'x', commented.height,
      ') does not fully fit in room (',
      ROOM_W, 'x', ROOM_H,
      ') at origin (', ORIGIN_X, ',', ORIGIN_Y, '). It will be clipped.'
    );
  }

  const orcaGrid   = buildLevelGrid(ROOM_W, ROOM_H, commented, ORIGIN_X, ORIGIN_Y);
  const jsonConfig = createLevelJson(commented, ORIGIN_X, ORIGIN_Y);

  fs.writeFileSync(outOrcaPath, orcaGrid, 'utf8');
  fs.writeFileSync(outJsonPath, JSON.stringify(jsonConfig, null, 2), 'utf8');

  console.log('[patch_to_level] Done.');
  console.log('  ORCA level :', outOrcaPath);
  console.log('  JSON config:', outJsonPath);
} catch (err) {
  console.error('[patch_to_level] Error:', err.message);
  process.exit(1);
}

