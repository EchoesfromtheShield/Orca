// Orca Stealth Wrapper - overlay 1:1 + collision debug (WASD)

(function () {
  'use strict';

  function log() {
    console.log('[overlay]', ...arguments);
  }

  let overlayDiv = null;
  let playerDiv = null;

  let gridCols = 80;
  let gridRows = 40;

  let cellW = 0;
  let cellH = 0;

  let playerCol = 0;
  let playerRow = 0;

  // --------------------------------------------------
  // Helpers base
  // --------------------------------------------------

  function getOrcaCanvas() {
    return document.querySelector('canvas');
  }

  function readGridSizeFromOrca() {
    const client = window.orcaClient;
    if (!client || !client.orca) {
      log('No orcaClient.orca yet, fallback 80x40.');
      gridCols = 80;
      gridRows = 40;
      return;
    }

    const ow = (typeof client.orca.w === 'number') ? client.orca.w : 80;
    const oh = (typeof client.orca.h === 'number') ? client.orca.h : 40;

    gridCols = ow;
    gridRows = oh;

    log('Grid size from orcaClient.orca:', gridCols + 'x' + gridRows);
  }

  function ensureOverlayElements() {
    if (overlayDiv) return;

    overlayDiv = document.createElement('div');
    overlayDiv.id = 'orca-stealth-overlay';
    overlayDiv.style.position = 'absolute';
    overlayDiv.style.pointerEvents = 'none';
    overlayDiv.style.zIndex = '9999';
    // DEBUG: velo verde
    overlayDiv.style.background = 'rgba(0, 255, 0, 0.12)';

    playerDiv = document.createElement('div');
    playerDiv.id = 'orca-stealth-player';
    playerDiv.style.position = 'absolute';
    playerDiv.style.boxSizing = 'border-box';
    playerDiv.style.background = 'red';
    playerDiv.style.border = '1px solid white';

    overlayDiv.appendChild(playerDiv);
    document.body.appendChild(overlayDiv);

    log('Overlay DOM created.');
  }

  // --------------------------------------------------
  // Lettura dei glyph da Orca
  // --------------------------------------------------

  function getOrcaGlyph(col, row) {
    const client = window.orcaClient;
    if (!client || !client.orca) {
      log('getOrcaGlyph: no client.orca, returning "."');
      return '.';
    }
    const orca = client.orca;
    if (typeof orca.glyphAt !== 'function') {
      log('getOrcaGlyph: orca.glyphAt is not a function, orca =', orca);
      return '.';
    }

    if (col < 0 || row < 0 || col >= gridCols || row >= gridRows) {
      return '.';
    }

    const g = orca.glyphAt(col, row);
    return g;
  }

  function isWalkable(col, row) {
    const g = getOrcaGlyph(col, row);
    // Logghiamo sempre per capire cosa sta succedendo
    log('isWalkable? col=', col, 'row=', row, 'glyph=', JSON.stringify(g));
    // Per v0: solo '.' = vuoto
    return g === '.';
  }

  // --------------------------------------------------
  // Geometria 1:1 (come nella versione che matcha perfettamente)
  // --------------------------------------------------

  function syncGeometry() {
    const canvas = getOrcaCanvas();
    if (!canvas) {
      log('syncGeometry: no canvas');
      return;
    }
    if (!overlayDiv || !playerDiv) {
      log('syncGeometry: missing overlayDiv/playerDiv');
      return;
    }

    const rect = canvas.getBoundingClientRect();

    // Aggancia l’overlay sopra il canvas
    overlayDiv.style.left   = (rect.left + window.scrollX) + 'px';
    overlayDiv.style.top    = (rect.top  + window.scrollY) + 'px';
    overlayDiv.style.width  = rect.width  + 'px';
    overlayDiv.style.height = rect.height + 'px';

    // Dimensioni logiche della griglia
    readGridSizeFromOrca();

    const cssW = rect.width;
    const cssH = rect.height;

    // X: tutta la larghezza
    cellW = cssW / gridCols;

    // Y: Orca gonfia ogni riga di 1/5 (tile.h + tile.h/5)
    // -> glyph-step = tile.h = rowFull * (5/6)
    const rowFull = cssH / gridRows;
    cellH = rowFull * (5 / 6);

    // Clamp player in-bounds
    if (playerCol >= gridCols) playerCol = gridCols - 1;
    if (playerRow >= gridRows) playerRow = gridRows - 1;
    if (playerCol < 0) playerCol = 0;
    if (playerRow < 0) playerRow = 0;

    updatePlayerPosition();

    log('Geometry synced:', {
      cssW,
      cssH,
      gridCols,
      gridRows,
      cellW,
      cellH
    });
  }

  function updatePlayerPosition() {
    if (!playerDiv) return;

    const x = playerCol * cellW;
    const y = playerRow * cellH;

    playerDiv.style.transform = `translate(${x}px, ${y}px)`;
    playerDiv.style.width  = cellW + 'px';
    playerDiv.style.height = cellH + 'px';
  }

  function clampPlayer() {
    if (playerCol < 0) playerCol = 0;
    if (playerRow < 0) playerRow = 0;
    if (playerCol > gridCols - 1) playerCol = gridCols - 1;
    if (playerRow > gridRows - 1) playerRow = gridRows - 1;
  }

  // --------------------------------------------------
  // Input
  // --------------------------------------------------

  function onKeyDown(ev) {
    const key = ev.key.toLowerCase();
    if (key !== 'w' && key !== 'a' && key !== 's' && key !== 'd') return;

    // WASD solo per fantasmino
    ev.preventDefault();

    let targetCol = playerCol;
    let targetRow = playerRow;

    if (key === 'w') targetRow -= 1;
    if (key === 's') targetRow += 1;
    if (key === 'a') targetCol -= 1;
    if (key === 'd') targetCol += 1;

    // Clamp target
    if (targetCol < 0) targetCol = 0;
    if (targetRow < 0) targetRow = 0;
    if (targetCol > gridCols - 1) targetCol = gridCols - 1;
    if (targetRow > gridRows - 1) targetRow = gridRows - 1;

    const walkable = isWalkable(targetCol, targetRow);

    if (!walkable) {
      log('MOVE BLOCKED at', targetCol, targetRow, 'glyph=', JSON.stringify(getOrcaGlyph(targetCol, targetRow)));
      return;
    }

    playerCol = targetCol;
    playerRow = targetRow;
    clampPlayer();
    updatePlayerPosition();

    log('player moved to', playerCol, playerRow);
  }

  // --------------------------------------------------
  // Init
  // --------------------------------------------------

  function initOverlay() {
    log('initOverlay start');

    ensureOverlayElements();
    syncGeometry();

    window.addEventListener('resize', syncGeometry);
    window.addEventListener('keydown', onKeyDown);

    log('overlay initialized.');
  }

  window.addEventListener('load', () => {
    // piccolo delay per dare tempo a orcaClient di popolarsi
    setTimeout(initOverlay, 300);
  });
})();
