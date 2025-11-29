// Orca Stealth Wrapper - overlay 1:1 Orca grid
// Modes: EDIT (Orca controlla i tasti), GAME (overlay controlla WASD, Orca read-only tranne Space)

(function () {
  'use strict';

  const DEBUG = false; // true per log verbosi

  function log() {
    if (!DEBUG) return;
    console.log('[overlay]', ...arguments);
  }

  // 'edit' | 'game'
  let mode = 'edit';

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
    overlayDiv.style.background = 'rgba(0, 255, 0, 0.10)';

    playerDiv = document.createElement('div');
    playerDiv.id = 'orca-stealth-player';
    playerDiv.style.position = 'absolute';
    playerDiv.style.boxSizing = 'border-box';
    playerDiv.style.background = 'red';
    playerDiv.style.border = '1px solid white';

    overlayDiv.appendChild(playerDiv);

    // Piccolo HUD di stato in basso a destra
    const hud = document.createElement('div');
    hud.id = 'orca-stealth-hud';
    hud.style.position = 'absolute';
    hud.style.right = '4px';
    hud.style.bottom = '4px';
    hud.style.padding = '2px 4px';
    hud.style.fontFamily = 'monospace';
    hud.style.fontSize = '10px';
    hud.style.background = 'rgba(0, 0, 0, 0.6)';
    hud.style.color = '#fff';
    hud.style.pointerEvents = 'none';
    hud.style.opacity = '0.8';
    overlayDiv.appendChild(hud);

    document.body.appendChild(overlayDiv);

    updateModeVisual();

    log('Overlay DOM created.');
  }

  function updateModeVisual() {
    if (!overlayDiv) return;
    const hud = document.getElementById('orca-stealth-hud');

    if (mode === 'edit') {
      overlayDiv.style.background = 'rgba(0, 255, 0, 0.05)'; // velo quasi invisibile
      if (hud) {
        hud.textContent = '[MODE: EDIT] (Orca controls keyboard)';
      }
    } else {
      overlayDiv.style.background = 'rgba(0, 255, 0, 0.18)'; // piu\' visibile
      if (hud) {
        hud.textContent = '[MODE: GAME] (WASD = player, Space = Orca clock)';
      }
    }
  }

  function toggleMode() {
    mode = (mode === 'edit') ? 'game' : 'edit';
    updateModeVisual();
    console.log('[overlay] Mode changed to', mode.toUpperCase());
  }

  // --------------------------------------------------
  // Lettura glyph da Orca
  // --------------------------------------------------

  function getOrcaGlyph(col, row) {
    const client = window.orcaClient;
    if (!client || !client.orca || typeof client.orca.glyphAt !== 'function') {
      return '.';
    }

    if (col < 0 || row < 0 || col >= gridCols || row >= gridRows) {
      return '.';
    }

    return client.orca.glyphAt(col, row);
  }

  function isWalkable(col, row) {
    const g = getOrcaGlyph(col, row);
    const walkable = (g === '.');
    if (DEBUG) {
      console.log('[overlay] isWalkable?', 'col=', col, 'row=', row, 'glyph=', JSON.stringify(g), '->', walkable);
    }
    return walkable;
  }

  // --------------------------------------------------
  // Geometria 1:1 con Orca
  // --------------------------------------------------

  function syncGeometry() {
    const canvas = getOrcaCanvas();
    if (!canvas || !overlayDiv || !playerDiv) {
      log('syncGeometry: missing canvas/overlay/player.');
      return;
    }

    const rect = canvas.getBoundingClientRect();

    overlayDiv.style.left   = (rect.left + window.scrollX) + 'px';
    overlayDiv.style.top    = (rect.top  + window.scrollY) + 'px';
    overlayDiv.style.width  = rect.width  + 'px';
    overlayDiv.style.height = rect.height + 'px';

    readGridSizeFromOrca();

    const cssW = rect.width;
    const cssH = rect.height;

    cellW = cssW / gridCols;

    const rowFull = cssH / gridRows;
    cellH = rowFull * (5 / 6); // copiato dalla matematica Orca

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
    const key = ev.key;

    // 1) Toggle mode (F1) - sempre catturato
    if (key === 'F1') {
      ev.preventDefault();
      ev.stopPropagation();
      toggleMode();
      return;
    }

    // 2) EDIT mode: non tocchiamo nulla
    if (mode === 'edit') {
      return;
    }

    // Da qui in avanti: mode === 'game'

    // 3) Space: lasciamo passare la barra spaziatrice a Orca (clock start/stop)
    if (key === ' ') {
      // niente preventDefault, niente stopPropagation
      if (DEBUG) {
        console.log('[overlay] Space in GAME mode: letting it pass to Orca.');
      }
      return;
    }

    // 4) Tutti gli altri tasti in GAME mode NON devono arrivare a Orca
    ev.preventDefault();
    ev.stopPropagation();

    const lower = key.toLowerCase();

    // Se non e' WASD, non facciamo nulla a livello di gioco (ma lo abbiamo bloccato per Orca)
    if (lower !== 'w' && lower !== 'a' && lower !== 's' && lower !== 'd') {
      if (DEBUG) {
        console.log('[overlay] Key blocked in GAME mode (not WASD, not Space):', key);
      }
      return;
    }

    // WASD = movimento del player
    let targetCol = playerCol;
    let targetRow = playerRow;

    if (lower === 'w') targetRow -= 1;
    if (lower === 's') targetRow += 1;
    if (lower === 'a') targetCol -= 1;
    if (lower === 'd') targetCol += 1;

    if (targetCol < 0) targetCol = 0;
    if (targetRow < 0) targetRow = 0;
    if (targetCol > gridCols - 1) targetCol = gridCols - 1;
    if (targetRow > gridRows - 1) targetRow = gridRows - 1;

    if (!isWalkable(targetCol, targetRow)) {
      if (DEBUG) {
        console.log('[overlay] MOVE BLOCKED at', targetCol, targetRow, 'glyph=', JSON.stringify(getOrcaGlyph(targetCol, targetRow)));
      }
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

    // Importante: capture = true, cosi' intercettiamo PRIMA di Orca
    window.addEventListener('keydown', onKeyDown, true);

    log('overlay initialized.');
    console.log('[overlay] Start in EDIT mode. Press F1 to switch to GAME mode.');
  }

  window.addEventListener('load', () => {
    setTimeout(initOverlay, 300);
  });
})();
