#!/usr/bin/env node
/**
 * Minimal UI server for patch_to_level.js
 *
 * Serves tools/patch_to_level_ui.html and exposes:
 *  - POST /api/upload   (body: raw file bytes, header x-filename)
 *  - POST /api/detect   (body: { filePath })
 *  - POST /api/export   (body: { filePath, patchRituals[], settings })
 *
 * Start: node tools/patch_to_level_ui_server.js
 * Open  : http://localhost:4321/tools/patch_to_level_ui.html
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const PORT = 4321;
const PROJECT_ROOT = path.resolve(__dirname, '..');
const UI_PATH = path.join(__dirname, 'patch_to_level_ui.html');
const UPLOAD_DIR = path.join(__dirname, 'uploads');

function ensureUploadDir() {
  if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  }
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Helpers to detect patches (mirrors patch_to_level logic)
function loadRawLines(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  let lines = raw.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  if (lines.length === 0) throw new Error('Input ORCA file is empty.');
  return lines;
}

function normalizeGrid(lines) {
  const width = Math.max(...lines.map((l) => l.length));
  const grid = lines.map((l) => l.padEnd(width, '.').split(''));
  return { width, height: lines.length, grid };
}

function findNonDotBoundingBox(grid) {
  const height = grid.length;
  const width = grid[0].length;
  let minX = width, maxX = -1, minY = height, maxY = -1;
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
  if (maxX === -1) throw new Error('Input ORCA file contains only dots.');
  return { minX, minY, maxX, maxY };
}

function sliceGrid(grid, minX, minY, maxX, maxY) {
  const out = [];
  for (let y = minY; y <= maxY; y++) {
    const row = [];
    for (let x = minX; x <= maxX; x++) row.push(grid[y][x]);
    out.push(row);
  }
  return { width: maxX - minX + 1, height: maxY - minY + 1, grid: out };
}

function wrapGridWithCommentFrame(cluster) {
  const h = cluster.length;
  const w = cluster[0].length;
  const newGrid = [];
  const topRow = ['#', ...Array(w).fill('.'), '#'];
  newGrid.push(topRow);
  for (let y = 0; y < h; y++) newGrid.push(['#', ...cluster[y], '#']);
  newGrid.push([...topRow]);
  return newGrid;
}

function findCommentBlocks(clusterGrid) {
  const height = clusterGrid.length;
  const width = clusterGrid[0].length;
  const blocks = [];
  const active = new Map(); // key xL:xR -> { x, yStart, yEnd, w }

  for (let y = 0; y < height; y++) {
    const row = clusterGrid[y];
    const rails = [];
    for (let x = 0; x < width; x++) if (row[x] === '#') rails.push(x);

    const rowPairs = [];
    for (let i = 0; i + 1 < rails.length; i += 2) {
      rowPairs.push({ xL: rails[i], xR: rails[i + 1] });
    }

    const seen = new Set();
    rowPairs.forEach((p) => {
      const key = `${p.xL}:${p.xR}`;
      seen.add(key);
      const existing = active.get(key);
      if (existing) {
        existing.yEnd = y;
      } else {
        active.set(key, { x: p.xL, yStart: y, yEnd: y, w: p.xR - p.xL + 1 });
      }
    });

    for (const [key, blk] of active.entries()) {
      if (!seen.has(key)) {
        const h = blk.yEnd - blk.yStart + 1;
        if (blk.w >= 3 && h >= 3) {
          blocks.push({ x: blk.x, y: blk.yStart, w: blk.w, h });
        }
        active.delete(key);
      }
    }
  }

  for (const [key, blk] of active.entries()) {
    const h = blk.yEnd - blk.yStart + 1;
    if (blk.w >= 3 && h >= 3) {
      blocks.push({ x: blk.x, y: blk.yStart, w: blk.w, h });
    }
  }
  return blocks;
}

function detectPatchCount(filePath) {
  const { grid } = normalizeGrid(loadRawLines(filePath));
  const { minX, minY, maxX, maxY } = findNonDotBoundingBox(grid);
  let clusterGrid = sliceGrid(grid, minX, minY, maxX, maxY).grid;
  let blocks = findCommentBlocks(clusterGrid);
  if (blocks.length === 0) {
    clusterGrid = wrapGridWithCommentFrame(clusterGrid);
    blocks = findCommentBlocks(clusterGrid);
  }
  return blocks.length;
}

function mapRitualLabel(val) {
  switch ((val || '').toLowerCase()) {
    case 'fourcorners':
    case '4 corners':
    case 'four corners':
      return 'fourCorners';
    case 'getthekey':
    case 'get the key':
    case 'getkey':
      return 'getKey';
    case 'destroytarget':
    case 'destroy target':
      return 'destroyTarget';
    case 'pressuretiles':
    case 'pressure tiles':
      return 'pressure_tiles';
    default:
      return 'fourCorners';
  }
}

function runPatchToLevel(options, cb) {
  const {
    inputPath,
    layout = 'arena',
    guards = 3,
    ammo = 3,
    medikits = 2,
    bait = 3,
    ritualType = 'fourCorners'
  } = options;

  const baseName = path.basename(inputPath, path.extname(inputPath));
  // Keep outputs in the upload dir for easy access
  const outOrca = path.join(UPLOAD_DIR, `${baseName}_metalgear.orca`);
  const outJson = path.join(PROJECT_ROOT, 'generated-level.json');

  const args = [
    path.join('tools', 'patch_to_level.js'),
    inputPath,
    outOrca,
    outJson,
    layout,
    String(guards),
    'y', // wall char default
    String(ammo),
    String(medikits),
    String(bait),
    '', // ritualId
    ritualType,
    '0',
    '4'
  ];

  const child = spawn(process.execPath, args, {
    cwd: PROJECT_ROOT,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d.toString(); });
  child.stderr.on('data', (d) => { stderr += d.toString(); });

  child.on('error', (err) => cb(err));

  child.on('close', (code) => {
    if (code !== 0) {
      cb(new Error(stderr || `patch_to_level exited with ${code}`));
    } else {
      cb(null, { outOrca, outJson, stdout, stderr });
    }
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET') {
    if (req.url === '/' || req.url === '/tools/patch_to_level_ui.html') {
      return fs.createReadStream(UI_PATH).pipe(res);
    }
    // Static fallback
    const filePath = path.join(PROJECT_ROOT, req.url.replace(/^\//, ''));
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      return fs.createReadStream(filePath).pipe(res);
    }
    res.writeHead(404);
    return res.end('Not found');
  }

  if (req.method === 'POST' && req.url === '/api/upload') {
    try {
      ensureUploadDir();
      const buf = await readBody(req);
      const name = req.headers['x-filename'] || 'upload.orca';
      const safeName = name.replace(/[^a-zA-Z0-9_.-]/g, '_');
      const destPath = path.join(UPLOAD_DIR, safeName);
      fs.writeFileSync(destPath, buf);
      return sendJson(res, 200, { path: destPath });
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  }

  if (req.method === 'POST' && req.url === '/api/detect') {
    try {
      const body = JSON.parse((await readBody(req)).toString() || '{}');
      if (!body.filePath) {
        return sendJson(res, 400, { error: 'filePath required' });
      }
      const count = detectPatchCount(body.filePath);
      return sendJson(res, 200, { patchCount: count });
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  }

  if (req.method === 'POST' && req.url === '/api/export') {
    try {
      const body = JSON.parse((await readBody(req)).toString() || '{}');
      const { filePath, patchRituals = [], settings = {} } = body;
      if (!filePath) return sendJson(res, 400, { error: 'filePath required' });
      if (!fs.existsSync(filePath)) {
        return sendJson(res, 400, { error: 'filePath not found on server' });
      }

      let responded = false;
      const safeSend = (status, obj) => {
        if (responded || res.writableEnded) return;
        responded = true;
        return sendJson(res, status, obj);
      };

      const ritualType = mapRitualLabel(patchRituals[0] || 'fourCorners');
      runPatchToLevel({
        inputPath: filePath,
        layout: (settings.layout || 'arena').toLowerCase(),
        guards: settings.guards || 3,
        ammo: settings.ammo || 3,
        medikits: settings.medikits || 2,
        bait: settings.bait || 3,
        ritualType
      }, (err, out) => {
        if (err) return safeSend(500, { error: err.message });
        return safeSend(200, out);
      });
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`[patch_to_level_ui_server] Listening on http://localhost:${PORT}/tools/patch_to_level_ui.html`);
});
