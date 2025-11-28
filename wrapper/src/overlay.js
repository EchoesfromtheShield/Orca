// Orca Stealth Wrapper - overlay 1:1 Orca grid (WASD)

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

    const ow = typeof client.orca.w === 'number' ? client.orca.w : 80;
    const oh = typeof client.orca.h === 'number' ? client.orca.h : 40;

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
    // DEBUG: velo verde, poi lo metteremo a 'transparent'
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

  function syncGeometry() {
    const canvas = getOrcaCanvas();
    if (!canvas || !overlayDiv || !playerDiv) {
      log('syncGeometry: missing canvas/overlay/player.');
      return;
    }

    const rect = canvas.getBoundingClientRect();

    // 1. Aggancia l’overlay esattamente sopra il canvas di Orca (CSS space)
    overlayDiv.style.left   = (rect.left + window.scrollX) + 'px';
    overlayDiv.style.top    = (rect.top  + window.scrollY) + 'px';
    overlayDiv.style.width  = rect.width  + 'px';
    overlayDiv.style.height = rect.height + 'px';

    // 2. Legge la griglia reale da orcaClient.orca (program width/height)
    readGridSizeFromOrca();

    const cssW = rect.width;
    const cssH = rect.height;

    // 3. Lato X: Orca usa tutta la larghezza → 1 col = width / gridCols
    cellW = cssW / gridCols;

    // 4. Lato Y: Orca usa SOLO 5/6 dell’altezza per il codice
    // perché in resize: style.height = (tile.h + tile.h/5)*orca.h
    // mentre i glyph vengono disegnati a step di tile.h.
    // Quindi rowHeightGlyph = totalHeight/rows * (5/6).
    const rowFull = cssH / gridRows; // include quello spazio extra
    cellH = rowFull * (5 / 6);

    // Non ricentriamo il player ogni volta, ma lo clampiamo
    if (playerCol >= gridCols) playerCol = gridCols - 1;
    if (playerRow >= gridRows) playerRow = gridRows - 1;
    if (playerCol < 0) playerCol = 0;
    if (playerRow < 0) playerRow = 0;

    updatePlayerPosition();

    log('Geometry synced:', {
      rectLeft: rect.left,
      rectTop: rect.top,
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

  function onKeyDown(ev) {
    const key = ev.key.toLowerCase();
    if (key !== 'w' && key !== 'a' && key !== 's' && key !== 'd') return;

    // WASD solo per il fantasmino
    ev.preventDefault();

    if (key === 'w') playerRow -= 1;
    if (key === 's') playerRow += 1;
    if (key === 'a') playerCol -= 1;
    if (key === 'd') playerCol += 1;

    clampPlayer();
    updatePlayerPosition();
    log('player moved to', playerCol, playerRow);
  }

  function initOverlay() {
    log('initOverlay start');
    ensureOverlayElements();
    syncGeometry();

    window.addEventListener('resize', syncGeometry);
    window.addEventListener('keydown', onKeyDown);

    log('overlay initialized.');
  }

  // Aspettiamo che Orca abbia fatto il suo client
  window.addEventListener('load', () => {
    // piccolo delay per dare tempo a orcaClient di apparire
    setTimeout(initOverlay, 300);
  });
})();
