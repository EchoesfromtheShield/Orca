// Orca Stealth Wrapper - overlay 1:1 with Orca grid
// Modes:
//   EDIT -> Orca receives keyboard normally
//   GAME -> WASD control the player, Orca only receives Space for the clock
//
// Player: yellow triangle oriented in the direction of the last movement.
// Guards: array of guards, rectangular patrol, cone-shaped FOV (9 cells).
//
// Guard states:
//   state: "patrol" | "alert_chaser" | "stunned"
//   behavior: "chaser"
//
// Sector alert logic:
//   - sectors: NW / NE / SW / SE (based on static split grid center).
//   - each sector has: state: "idle" | "tracking"
//     * "tracking": at least one guard saw the player recently, or is seeing him now.
//     * while any guard in the sector sees the player, the sector target == player's current position.
//     * when all guards in the sector lose sight, they still know the absolute player position
//       for ALERT_MEMORY_TICKS, chasing him even out of FOV.
//     * when the timer expires, sector goes back to "idle" and guards return to PATROL.
//
// ALERT behavior for guards:
//   - if sector is "tracking":
//       * guards in that sector go into "alert_chaser".
//       * if a guard currently has the player in FOV:
//           - it stops rushing closer,
//           - orients towards the player,
//           - if possible, does very small local moves to gain line-of-shot,
//           - and shoots when line-of-shot is clear.
//       * if a guard does NOT see the player but sector is tracking:
//           - it chases towards a "preferred shooting slot" around the player
//             (N/E/S/W ring) using BFS pathfinding,
//             trying to avoid overlapping with other guards.
//   - when sector leaves "tracking" (timer expired), guards revert to PATROL.
//
// Collisions player <-> guard on the same cell:
//   - if the player steps into the guard from directly behind -> stealth takedown (guard stunned)
//   - in all other cases -> the player takes damage
//
// In ALERT, guards try to keep shooting distance and do not intentionally step onto the player cell.

(function () {
  'use strict';

  const DEBUG = false;

  // --------------------------------------------------
  // Tuning handles
  // --------------------------------------------------

  const WORLD_TICK_MS = 250;          // global tick speed

  // Guard movement speed (cells per tick)
  const PATROL_STEPS_PER_TICK = 1;    // patrol speed
  const ALERT_STEPS_PER_TICK  = 2;    // alert / chasing speed

  // Bullets
  const BULLET_STEPS_PER_TICK       = 1;  // cells per tick
  const GUARD_FIRE_COOLDOWN_TICKS   = 4;  // ticks between shots (~1s at 250ms)

  // Alert / memory (how long sectors remember player absolute position after losing sight)
  const ALERT_MEMORY_TICKS          = 12; // ~3s at 250ms

  function log() {
    if (!DEBUG) return;
    console.log('[overlay]', ...arguments);
  }

  // --------------------------------------------------
  // Level config (minimal sandbox for guards) + hook for external generator
  // --------------------------------------------------

  const defaultLevelConfig = {
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
      // Profile A: depth 9, widths 1,1,3,3,3,5,5,5,7
      A: {
        depth: 9,
        widths: [1, 1, 3, 3, 3, 5, 5, 5, 7]
      }
    },
    // First liberation trigger: same four-corners test we already use
    liberationTriggers: [
      {
        id: 'main_patch',
        type: 'fourCorners',
        corners: [
          { col: 16, row: 24 },
          { col: 38, row: 24 },
          { col: 16, row: 35 },
          { col: 38, row: 35 }
        ],
        targetBlock: {
          x: 16,
          y: 24,
          w: 23,
          h: 12
        }
      }
    ],
    playerSpawn: null
  };

  // Shallow merge of defaults with an optional external config.
  // Intended shape of external config (window.orcaStealthLevelConfig or JSON):
  // {
  //   guards: [...],
  //   fovProfiles: { ... },
  //   liberationTriggers: [...]
  // }
    function mergeLevelConfig(baseCfg, externalCfg) {
    if (!externalCfg || typeof externalCfg !== 'object') {
      return baseCfg;
    }

    return {
      guards: Array.isArray(externalCfg.guards)
        ? externalCfg.guards
        : baseCfg.guards,

      fovProfiles: Object.assign(
        {},
        baseCfg.fovProfiles || {},
        externalCfg.fovProfiles || {}
      ),

      liberationTriggers: Array.isArray(externalCfg.liberationTriggers)
        ? externalCfg.liberationTriggers
        : (baseCfg.liberationTriggers || []),

      playerSpawn: externalCfg.playerSpawn || baseCfg.playerSpawn || null
    };
  }


  // Mutable current level config (starts from defaults, can be updated later).
  let levelConfig = mergeLevelConfig(
    defaultLevelConfig,
    window.orcaStealthLevelConfig || null
  );

  // Mutable liberation triggers derived from current config.
  let liberationTriggers = Array.isArray(levelConfig.liberationTriggers)
    ? levelConfig.liberationTriggers
    : [];

  // Optional URL for auto-loading an external JSON level description.
  // Put generated-level.json next to index.html / overlay.js, or change the path.
  const LEVEL_JSON_URL = 'generated-level.json';

    function applyExternalLevelConfig(externalCfg) {
    const merged = mergeLevelConfig(defaultLevelConfig, externalCfg);
    levelConfig = merged;
    liberationTriggers = Array.isArray(merged.liberationTriggers)
      ? merged.liberationTriggers
      : [];

    // If the level config provides an explicit player spawn, use it.
    if (
      merged.playerSpawn &&
      typeof merged.playerSpawn.col === 'number' &&
      typeof merged.playerSpawn.row === 'number'
    ) {
      playerCol = merged.playerSpawn.col;
      playerRow = merged.playerSpawn.row;
    }

    console.log('[overlay] Level config updated from external config:', merged);

    // Rebuild guards and patch markers according to the new config.
    initGuardsFromConfig();
    initPatchMarkersDom();
    syncGeometry();
  }


  function loadExternalLevelConfig() {
    // 1) If something already wrote window.orcaStealthLevelConfig (via <script>),
    // use that and skip JSON fetch.
    if (window.orcaStealthLevelConfig) {
      console.log('[overlay] Found window.orcaStealthLevelConfig, using it.');
      applyExternalLevelConfig(window.orcaStealthLevelConfig);
      return;
    }

    // 2) Try to fetch JSON. This is best-effort: if it fails we just keep defaults.
    if (!window.fetch) {
      console.warn('[overlay] fetch() not available, using default levelConfig.');
      return;
    }

    fetch(LEVEL_JSON_URL, { cache: 'no-store' })
      .then((resp) => {
        if (!resp.ok) {
          throw new Error('HTTP ' + resp.status);
        }
        return resp.json();
      })
      .then((json) => {
        console.log('[overlay] Loaded external level config from JSON:', json);
        applyExternalLevelConfig(json);
      })
      .catch((err) => {
        console.warn('[overlay] Could not load ' + LEVEL_JSON_URL + ':', err);
      });
  }


  // --------------------------------------------------
  // Overlay state
  // --------------------------------------------------

  // 'edit' | 'game'
  let mode = 'edit';

  let overlayDiv = null;
  let guardsContainer = null;
  let fovContainer = null;
  let bulletsContainer = null;

  // Player
  let playerDiv = null;
  let playerInner = null;
  let playerCol = 0;
  let playerRow = 0;
  let prevPlayerCol = 0;
  let prevPlayerRow = 0;
  // 'up' | 'down' | 'left' | 'right'
  let playerDir = 'up';

  // Player HP
  let playerHPMax = 3;
  let playerHP = playerHPMax;
  let playerHitCooldown = 0; // invulnerability ticks after being hit

  // Guards
  let guards = [];
  let guardTimer = null;
  let globalAlertLevel = 0; // 0 = no guard sees the player, 1 = at least one guard sees him

  // Bullets
  let bullets = [];

  // Grid / geometry
  let gridCols = 80;
  let gridRows = 40;

  let cellW = 0;
  let cellH = 0;

  // Sectors (quadrants, static map split)
  let midCol = 0;
  let midRow = 0;

  // Sector alert states:
  //   state: "idle" | "tracking"
  //   targetCol/Row: last known player position (for debug / possible future use)
  //   timer: memory countdown
  const sectorAlerts = {
    NW: { state: 'idle', targetCol: null, targetRow: null, timer: 0 },
    NE: { state: 'idle', targetCol: null, targetRow: null, timer: 0 },
    SW: { state: 'idle', targetCol: null, targetRow: null, timer: 0 },
    SE: { state: 'idle', targetCol: null, targetRow: null, timer: 0 }
  };

  // --------------------------------------------------
  // Patch zones / liberation (4-corners test, data-driven)
  // --------------------------------------------------

  // Legacy rectangle kept as fallback in case a trigger has no explicit targetBlock.
  const PATCH_RECT = {
    x: 16,
    y: 24,
    w: 23, // 38 - 16 + 1
    h: 12  // 35 - 24 + 1
  };

  // Patch content that will be injected when a trigger is fully activated.
  // For now we keep the same hardcoded demo block.
  const PATCH_UNLOCK_BLOCK =
    '.\n' +
    '.D4.\n' +
    '.*.aC2.H.\n' +
    '.:71Czz.111GS.\n' +
    '.\n' +
    '.S2I3.\n' +
    '.13TFbC.\n' +
    '.2Xb.\n' +
    '.b.\n' +
    '.\n' +
    '.:61bzz.\n' +
    '.';
  
  // Transform a commented block (with a rectangular '#' frame)
  // into an uncommented one, keeping the same width/height.
  // Assumes patch_to_level.js produced a frame like:
  //   first/last row: "#.....#"
  //   middle rows   : "#<code...>#"
  function transformCommentedBlockForLiberation(blockStr) {
    if (!blockStr || typeof blockStr !== 'string') {
      return null;
    }

    const lines = blockStr.split(/\r?\n/);
    if (lines.length === 0) {
      return null;
    }

    const h = lines.length;
    const outLines = [];

    for (let y = 0; y < h; y++) {
      const line = lines[y] || '';

      // First and last row: horizontal frame only -> turn everything into dots.
      if (y === 0 || y === h - 1) {
        outLines.push('.'.repeat(line.length));
        continue;
      }

      // Middle rows: remove only the vertical frame on the sides,
      // keep the inner code exactly as it is.
      if (line.length >= 2 && line[0] === '#' && line[line.length - 1] === '#') {
        const middle = line.substring(1, line.length - 1);
        outLines.push('.' + middle + '.');
      } else {
        // Not a framed row, keep as is.
        outLines.push(line);
      }
    }

    return outLines.join('\n');
  }
  

  // Triggers loaded from levelConfig (usually provided by the generator).
  let patchMarkersContainer = null;
  let patchMarkers = []; // { triggerId, triggerIndex, cornerIndex, col, row, active, el }
  // NOTE: we no longer use a global "patchLiberated" flag.
  // Each trigger can be completed independently based on its own markers.


  // --------------------------------------------------
  // Basic helpers
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

  function getSector(col, row) {
    if (row < midRow) {
      return col < midCol ? 'NW' : 'NE';
    } else {
      return col < midCol ? 'SW' : 'SE';
    }
  }

  // --------------------------------------------------
  // Overlay DOM creation
  // --------------------------------------------------

  function ensureOverlayElements() {
    if (overlayDiv) return;

    overlayDiv = document.createElement('div');
    overlayDiv.id = 'orca-stealth-overlay';
    overlayDiv.style.position = 'absolute';
    overlayDiv.style.pointerEvents = 'none';
    overlayDiv.style.zIndex = '9999';
    overlayDiv.style.background = 'rgba(0, 128, 128, 0.06)';

    // FOV container (under guards and player)
    fovContainer = document.createElement('div');
    fovContainer.id = 'orca-stealth-fov';
    fovContainer.style.position = 'absolute';
    fovContainer.style.left = '0';
    fovContainer.style.top = '0';
    fovContainer.style.width = '100%';
    fovContainer.style.height = '100%';
    fovContainer.style.pointerEvents = 'none';
    overlayDiv.appendChild(fovContainer);

    // Guards container
    guardsContainer = document.createElement('div');
    guardsContainer.id = 'orca-stealth-guards';
    guardsContainer.style.position = 'absolute';
    guardsContainer.style.left = '0';
    guardsContainer.style.top = '0';
    guardsContainer.style.width = '100%';
    guardsContainer.style.height = '100%';
    guardsContainer.style.pointerEvents = 'none';
    overlayDiv.appendChild(guardsContainer);

    // Bullets container (above guards, below player)
    bulletsContainer = document.createElement('div');
    bulletsContainer.id = 'orca-stealth-bullets';
    bulletsContainer.style.position = 'absolute';
    bulletsContainer.style.left = '0';
    bulletsContainer.style.top = '0';
    bulletsContainer.style.width = '100%';
    bulletsContainer.style.height = '100%';
    bulletsContainer.style.pointerEvents = 'none';
    overlayDiv.appendChild(bulletsContainer);

    // Patch liberation markers (above bullets, below player)
    patchMarkersContainer = document.createElement('div');
    patchMarkersContainer.id = 'orca-stealth-patch-markers';
    patchMarkersContainer.style.position = 'absolute';
    patchMarkersContainer.style.left = '0';
    patchMarkersContainer.style.top = '0';
    patchMarkersContainer.style.width = '100%';
    patchMarkersContainer.style.height = '100%';
    patchMarkersContainer.style.pointerEvents = 'none';
    overlayDiv.appendChild(patchMarkersContainer);

    // PLAYER ------------------------------------------------------
    playerDiv = document.createElement('div');
    playerDiv.id = 'orca-stealth-player';
    playerDiv.style.position = 'absolute';
    playerDiv.style.boxSizing = 'border-box';
    playerDiv.style.background = 'transparent';
    playerDiv.style.border = 'none';

    playerInner = document.createElement('div');
    playerInner.id = 'orca-stealth-player-inner';
    playerInner.style.position = 'absolute';
    playerInner.style.left = '0';
    playerInner.style.top = '0';
    playerInner.style.width = '100%';
    playerInner.style.height = '100%';
    playerInner.style.background = 'yellow';
    playerInner.style.clipPath = 'polygon(50% 12%, 14% 88%, 86% 88%)';
    playerInner.style.transformOrigin = '50% 50%';

    playerDiv.appendChild(playerInner);
    overlayDiv.appendChild(playerDiv);

    // HUD (bottom-right)
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
    updatePlayerDirectionVisual();
    initPatchMarkersDom();

    log('Overlay DOM created.');

  }

  function anySectorTracking() {
    return (
      sectorAlerts.NW.state === 'tracking' ||
      sectorAlerts.NE.state === 'tracking' ||
      sectorAlerts.SW.state === 'tracking' ||
      sectorAlerts.SE.state === 'tracking'
    );
  }

  function updateModeVisual() {
  if (!overlayDiv) return;
  const hud = document.getElementById('orca-stealth-hud');

  const inAlert = (globalAlertLevel > 0) || anySectorTracking();

  if (mode === 'edit') {
    overlayDiv.style.background = 'rgba(0, 128, 128, 0.03)';
    if (hud) {
      hud.textContent = '[MODE: EDIT] HP ' + playerHP + '/' + playerHPMax;
      hud.style.color = '#ffffff';
    }
  } else {
    const alertText = inAlert ? 'ALERT' : 'STEALTH';
    if (inAlert) {
      overlayDiv.style.background = 'rgba(255, 64, 64, 0.14)';
    } else {
      overlayDiv.style.background = 'rgba(0, 128, 128, 0.10)';
    }
    if (hud) {
      hud.textContent =
        '[MODE: GAME] HP ' +
        playerHP +
        '/' +
        playerHPMax +
        '  [' +
        alertText +
        ']  (F1: toggle, Arrows: move, Space: Orca clock)';
      hud.style.color = '#ffffff';
    }
  }

  // Re-position HUD after any change
  updateHudLayout();
}

// Position HUD in the bottom band of Orca, slightly to the right
// of the built-in Orca status text.
function updateHudLayout() {
  const hud = document.getElementById('orca-stealth-hud');
  if (!hud || !overlayDiv) return;
  if (cellW <= 0 || cellH <= 0) return;

  // Choose an anchor column to the right of Orca's own HUD text.
  // 0.5 ~ middle of the grid; 0.6 pushes it a bit further right.
  const anchorCol = Math.floor(gridCols * 0.55);
  const anchorRow = gridRows - 1; // bottom row

  const x = anchorCol * cellW;
  const y = anchorRow * cellH;

  hud.style.left = x + 'px';
  hud.style.top = (y + cellH * 0.15) + 'px'; // small offset inside the band
  hud.style.right = 'auto';
  hud.style.bottom = 'auto';
}


  function toggleMode() {
    mode = (mode === 'edit') ? 'game' : 'edit';
    updateModeVisual();
    renderGuardFov();
    console.log('[overlay] Mode changed to', mode.toUpperCase());
  }

    // --------------------------------------------------
  // Guards initialization from levelConfig
  // --------------------------------------------------
  function initGuardsFromConfig() {
    guards = [];
    if (!guardsContainer) return;

    // Clear previous guards DOM (for when we reload a levelConfig).
    while (guardsContainer.firstChild) {
      guardsContainer.removeChild(guardsContainer.firstChild);
    }

    const defs = levelConfig.guards || [];

    defs.forEach((cfg, index) => {
      // Outer guard element, positioned by updateGuardPosition()
      const gEl = document.createElement('div');
      gEl.className = 'orca-stealth-guard';
      gEl.dataset.guardId = cfg.id || ('guard_' + index);
      gEl.style.position = 'absolute';
      gEl.style.left = '0';
      gEl.style.top = '0';
      gEl.style.pointerEvents = 'none';

      // Inner container, fills the guard cell
      const inner = document.createElement('div');
      inner.className = 'orca-stealth-guard-inner';
      inner.style.position = 'absolute';
      inner.style.left = '0';
      inner.style.top = '0';
      inner.style.width = '100%';
      inner.style.height = '100%';
      inner.style.pointerEvents = 'none';

      // Red dot sprite in the center of the cell
      const sprite = document.createElement('div');
      sprite.className = 'orca-stealth-guard-sprite';
      sprite.style.position = 'absolute';
      sprite.style.left = '50%';
      sprite.style.top = '50%';
      sprite.style.width = '50%';
      sprite.style.height = '50%';
      sprite.style.transform = 'translate(-50%, -50%)';
      sprite.style.borderRadius = '50%';
      sprite.style.background = '#ff5555';
      sprite.style.boxSizing = 'border-box';
      sprite.style.border = '1px solid #ffcccc';
      sprite.style.pointerEvents = 'none';
      inner.appendChild(sprite);

      // Optional per-guard FOV overlay (not used yet, kept for future use)
      const fovOverlay = document.createElement('div');
      fovOverlay.className = 'orca-stealth-guard-fov';
      fovOverlay.style.position = 'absolute';
      fovOverlay.style.left = '0';
      fovOverlay.style.top = '0';
      fovOverlay.style.width = '100%';
      fovOverlay.style.height = '100%';
      fovOverlay.style.pointerEvents = 'none';
      inner.appendChild(fovOverlay);

      gEl.appendChild(inner);
      guardsContainer.appendChild(gEl);

      const rect = cfg.rect || {};
      const guard = {
        id: cfg.id || ('guard_' + index),
        patrolType: cfg.patrolType || 'rect',
        behavior: cfg.behavior || 'chaser',
        col: cfg.startCol || 0,
        row: cfg.startRow || 0,
        dirX: 1,
        dirY: 0,
        minCol: rect.minCol != null ? rect.minCol : 0,
        maxCol: rect.maxCol != null ? rect.maxCol : Math.max(0, gridCols - 1),
        minRow: rect.minRow != null ? rect.minRow : 0,
        maxRow: rect.maxRow != null ? rect.maxRow : Math.max(0, gridRows - 1),
        fovProfileId: cfg.fovProfile || 'A',
        el: gEl,
        inner,
        sprite,
        lookPhase: 0,
        lookTick: 0,
        fovCells: [],
        seenPlayer: false,
        wasSeeingPlayer: false,
        state: 'patrol',
        lastSeenPlayerCol: null,
        lastSeenPlayerRow: null,
        alertTimer: 0,
        path: null,
        pathTargetCol: null,
        pathTargetRow: null,
        neutralized: false,
        stunTicks: 0,
        shootCooldown: 0
      };

      guards.push(guard);
    });

    log('Guards initialized from config:', guards.length);
  }


  // --------------------------------------------------
  // Reading glyphs from Orca
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
      console.log(
        '[overlay] isWalkable?',
        'col=',
        col,
        'row=',
        row,
        'glyph=',
        JSON.stringify(g),
        '->',
        walkable
      );
    }
    return walkable;
  }

  // --------------------------------------------------
  // Spawn helpers: keep entities off walls
  // --------------------------------------------------

  // BFS search for nearest walkable cell starting from (startCol, startRow).
  // Returns { col, row } or null if none found.
  function findNearestWalkableCell(startCol, startRow) {
    const client = window.orcaClient;
    if (!client || !client.orca) {
      // Orca not ready yet, do nothing special.
      return null;
    }

    const width = gridCols;
    const height = gridRows;

    function idx(c, r) {
      return r * width + c;
    }

    const visited = new Array(width * height).fill(false);
    const queue = [];

    function enqueue(c, r) {
      if (c < 0 || r < 0 || c >= width || r >= height) return;
      const i = idx(c, r);
      if (visited[i]) return;
      visited[i] = true;
      queue.push({ col: c, row: r });
    }

    enqueue(startCol, startRow);

    while (queue.length > 0) {
      const cur = queue.shift();
      const c = cur.col;
      const r = cur.row;

      if (isWalkable(c, r)) {
        return { col: c, row: r };
      }

      // 4-neighborhood
      enqueue(c + 1, r);
      enqueue(c - 1, r);
      enqueue(c, r + 1);
      enqueue(c, r - 1);
    }

    return null;
  }

  function ensurePlayerOnWalkableCell() {
    const res = findNearestWalkableCell(playerCol, playerRow);
    if (res) {
      playerCol = res.col;
      playerRow = res.row;
    }
  }

  function ensureGuardsOnWalkableCells() {
    guards.forEach((g) => {
      const res = findNearestWalkableCell(g.col, g.row);
      if (res) {
        g.col = res.col;
        g.row = res.row;
      }
    });
  }


  // --------------------------------------------------
  // Geometry 1:1 with Orca
  // --------------------------------------------------

  function syncGeometry() {
    const canvas = getOrcaCanvas();
    if (!canvas || !overlayDiv || !playerDiv) {
      log('syncGeometry: missing canvas/overlay/player.');
      return;
    }

    const rect = canvas.getBoundingClientRect();

    overlayDiv.style.left = (rect.left + window.scrollX) + 'px';
    overlayDiv.style.top = (rect.top + window.scrollY) + 'px';
    overlayDiv.style.width = rect.width + 'px';
    overlayDiv.style.height = rect.height + 'px';

    readGridSizeFromOrca();

    const cssW = rect.width;
    const cssH = rect.height;

    cellW = cssW / gridCols;

    // Same vertical proportion Orca uses: tile height plus extra line for UI
    const rowFull = cssH / gridRows;
    cellH = rowFull * (5 / 6);

    midCol = Math.floor(gridCols / 2);
    midRow = Math.floor(gridRows / 2);

        if (playerCol >= gridCols) playerCol = gridCols - 1;
    if (playerRow >= gridRows) playerRow = gridRows - 1;
    if (playerCol < 0) playerCol = 0;
    if (playerRow < 0) playerRow = 0;

    clampGuards();

    // Make sure player and guards do not start inside walls.
    ensurePlayerOnWalkableCell();
    ensureGuardsOnWalkableCells();

    updatePlayerPosition();
    updatePlayerDirectionVisual();
    guards.forEach(updateGuardPosition);
    updateAllBulletsPosition();
    updatePatchMarkersPosition();

    // only FOV, no alert memory
    updateAllFovAndAlert(false);



    // Re-position HUD according to new canvas size / grid
    updateHudLayout();

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

    playerDiv.style.transform = 'translate(' + x + 'px, ' + y + 'px)';
    playerDiv.style.width = cellW + 'px';
    playerDiv.style.height = cellH + 'px';
  }

  function updatePlayerDirectionVisual() {
    if (!playerInner) return;

    let angle = 0;
    if (playerDir === 'up') angle = 0;
    else if (playerDir === 'right') angle = 90;
    else if (playerDir === 'down') angle = 180;
    else if (playerDir === 'left') angle = 270;

    playerInner.style.transform = 'rotate(' + angle + 'deg)';
  }

  function clampPlayer() {
    if (playerCol < 0) playerCol = 0;
    if (playerRow < 0) playerRow = 0;
    if (playerCol > gridCols - 1) playerCol = gridCols - 1;
    if (playerRow > gridRows - 1) playerRow = gridRows - 1;
  }

  function clampGuard(guard) {
    if (guard.col < 0) guard.col = 0;
    if (guard.row < 0) guard.row = 0;
    if (guard.col > gridCols - 1) guard.col = gridCols - 1;
    if (guard.row > gridRows - 1) guard.row = 0 + (gridRows - 1);
  }

  function clampGuards() {
    guards.forEach(clampGuard);
  }

  // --------------------------------------------------
  // Guard occupancy helper (no overlapping)
  // --------------------------------------------------

  function isCellOccupiedByOtherGuard(col, row, selfGuard) {
    for (let i = 0; i < guards.length; i++) {
      const g = guards[i];
      if (g === selfGuard) continue;
      if (g.state === 'stunned') continue;
      if (g.col === col && g.row === row) {
        return true;
      }
    }
    return false;
  }

  // --------------------------------------------------
  // Pathfinding (BFS) for chasers
  // --------------------------------------------------

  function computeBFSPath(fromCol, fromRow, toCol, toRow) {
    const width = gridCols;
    const height = gridRows;

    if (fromCol === toCol && fromRow === toRow) {
      return [{ col: fromCol, row: fromRow }];
    }

    const idx = (c, r) => r * width + c;
    const startIndex = idx(fromCol, fromRow);
    const targetIndex = idx(toCol, toRow);

    const visited = new Array(width * height).fill(false);
    const prev = new Array(width * height).fill(-1);

    const queue = [];
    queue.push(startIndex);
    visited[startIndex] = true;

    const dirs = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1]
    ];

    while (queue.length > 0) {
      const current = queue.shift();
      if (current === targetIndex) break;

      const cx = current % width;
      const cy = (current - cx) / width;

      for (let i = 0; i < dirs.length; i++) {
        const nx = cx + dirs[i][0];
        const ny = cy + dirs[i][1];

        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;

        const ni = idx(nx, ny);
        if (visited[ni]) continue;

        // Can walk only on '.' or on the exact target cell
        if (!isWalkable(nx, ny) && !(nx === toCol && ny === toRow)) continue;

        visited[ni] = true;
        prev[ni] = current;
        queue.push(ni);
      }
    }

    if (!visited[targetIndex]) {
      return null;
    }

    const path = [];
    let cur = targetIndex;
    while (cur !== -1) {
      const cx = cur % width;
      const cy = (cur - cx) / width;
      path.push({ col: cx, row: cy });
      cur = prev[cur];
    }

    path.reverse();
    return path;
  }

  function ensureGuardPath(guard, targetCol, targetRow) {
    if (
      guard.path &&
      guard.pathTargetCol === targetCol &&
      guard.pathTargetRow === targetRow &&
      guard.path.length > 1
    ) {
      return;
    }

    const path = computeBFSPath(guard.col, guard.row, targetCol, targetRow);
    if (!path || path.length <= 1) {
      guard.path = null;
      guard.pathTargetCol = null;
      guard.pathTargetRow = null;
      return;
    }

    guard.path = path;
    guard.pathTargetCol = targetCol;
    guard.pathTargetRow = targetRow;
  }

  function stepGuardAlongPath(guard) {
    if (!guard.path || guard.path.length <= 1) {
      return false;
    }

    let idxCurrent = guard.path.findIndex(
      (p) => p.col === guard.col && p.row === guard.row
    );

    if (idxCurrent === -1) {
      idxCurrent = 0;
    }

    const nextIndex = idxCurrent + 1;
    if (nextIndex >= guard.path.length) {
      return false;
    }

    const next = guard.path[nextIndex];

    // Do not step onto player cell in alert
    if (next.col === playerCol && next.row === playerRow) {
      return false;
    }

    // No overlapping with other guards
    if (isCellOccupiedByOtherGuard(next.col, next.row, guard)) {
      return false;
    }

    const oldCol = guard.col;
    const oldRow = guard.row;

    guard.col = next.col;
    guard.row = next.row;

    guard.dirX = guard.col - oldCol;
    guard.dirY = guard.row - oldRow;

    if (nextIndex === guard.path.length - 1) {
      guard.path = null;
      guard.pathTargetCol = null;
      guard.pathTargetRow = null;
    }

    clampGuard(guard);
    updateGuardPosition(guard);
    return true;
  }

  // --------------------------------------------------
  // Guard positioning
  // --------------------------------------------------

  function updateGuardPosition(guard) {
    if (!guard.el) return;

    const gx = guard.col * cellW;
    const gy = guard.row * cellH;

    guard.el.style.transform = 'translate(' + gx + 'px, ' + gy + 'px)';
    guard.el.style.width = cellW + 'px';
    guard.el.style.height = cellH + 'px';
    guard.el.style.opacity = guard.state === 'stunned' ? '0.25' : '1.0';
  }

  // --------------------------------------------------
  // Bullet logic (ranged attacks from guards)
  // --------------------------------------------------

  function updateBulletPosition(bullet) {
    if (!bullet.el) return;
    const bw = cellW * 0.3;
    const bh = cellH * 0.3;
    const x = bullet.col * cellW + (cellW - bw) / 2;
    const y = bullet.row * cellH + (cellH - bh) / 2;

    bullet.el.style.width = bw + 'px';
    bullet.el.style.height = bh + 'px';
    bullet.el.style.transform = 'translate(' + x + 'px, ' + y + 'px)';
  }

  function updateAllBulletsPosition() {
    bullets.forEach(updateBulletPosition);
  }

  function hasLineOfShot(guard, targetCol, targetRow) {
    const dx = targetCol - guard.col;
    const dy = targetRow - guard.row;

    // Must be aligned on row or column
    if ((dx === 0 && dy === 0) || (dx !== 0 && dy !== 0)) {
      return false;
    }

    const stepX = dx === 0 ? 0 : (dx > 0 ? 1 : -1);
    const stepY = dy === 0 ? 0 : (dy > 0 ? 1 : -1);

    let c = guard.col + stepX;
    let r = guard.row + stepY;

    while (c !== targetCol || r !== targetRow) {
      if (!isWalkable(c, r)) {
        return false;
      }
      c += stepX;
      r += stepY;
    }

    return true;
  }

  function spawnBulletFromGuard(guard, targetCol, targetRow) {
    if (!bulletsContainer) return;
    if (guard.state === 'stunned') return;

    const dx = targetCol - guard.col;
    const dy = targetRow - guard.row;

    if ((dx === 0 && dy === 0) || (dx !== 0 && dy !== 0)) {
      return;
    }

    const stepX = dx === 0 ? 0 : (dx > 0 ? 1 : -1);
    const stepY = dy === 0 ? 0 : (dy > 0 ? 1 : -1);

    const startCol = guard.col + stepX;
    const startRow = guard.row + stepY;

    if (
      startCol < 0 ||
      startRow < 0 ||
      startCol >= gridCols ||
      startRow >= gridRows
    ) {
      return;
    }

    if (!isWalkable(startCol, startRow)) {
      return;
    }

    const bulletEl = document.createElement('div');
    bulletEl.className = 'orca-stealth-bullet';
    bulletEl.style.position = 'absolute';
    bulletEl.style.background = '#ffcc00';
    bulletEl.style.borderRadius = '50%';
    bulletEl.style.pointerEvents = 'none';

    bulletsContainer.appendChild(bulletEl);

    const bullet = {
      col: startCol,
      row: startRow,
      dx: stepX,
      dy: stepY,
      el: bulletEl,
      alive: true,
      fromGuardId: guard.id || 'guard'
    };

    bullets.push(bullet);
    updateBulletPosition(bullet);

    guard.shootCooldown = GUARD_FIRE_COOLDOWN_TICKS;

    console.log('[overlay] GUARD', guard.id, 'shoots.');
  }

  function stepBullets() {
    if (!bulletsContainer || bullets.length === 0) return;

    const survivors = [];

    for (let i = 0; i < bullets.length; i++) {
      const b = bullets[i];
      if (!b.alive || !b.el) {
        if (b.el && b.el.parentNode) {
          b.el.parentNode.removeChild(b.el);
        }
        continue;
      }

      let alive = true;

      for (let step = 0; step < BULLET_STEPS_PER_TICK && alive; step++) {
        const nextCol = b.col + b.dx;
        const nextRow = b.row + b.dy;

        // Out of bounds
        if (
          nextCol < 0 ||
          nextRow < 0 ||
          nextCol >= gridCols ||
          nextRow >= gridRows
        ) {
          if (b.el.parentNode) {
            b.el.parentNode.removeChild(b.el);
          }
          alive = false;
          break;
        }

        // Player hit
        if (nextCol === playerCol && nextRow === playerRow) {
          applyPlayerHit({ id: 'bullet:' + (b.fromGuardId || 'guard') });
          if (b.el.parentNode) {
            b.el.parentNode.removeChild(b.el);
          }
          alive = false;
          break;
        }

        // Wall / Orca code hit
        if (!isWalkable(nextCol, nextRow)) {
          if (b.el.parentNode) {
            b.el.parentNode.removeChild(b.el);
          }
          alive = false;
          break;
        }

        // Move bullet forward
        b.col = nextCol;
        b.row = nextRow;
      }

      if (alive) {
        updateBulletPosition(b);
        survivors.push(b);
      }
    }

    bullets = survivors;
  }

  // --------------------------------------------------
  // Patch liberation markers + ORCA injection
  // --------------------------------------------------

  function initPatchMarkersDom() {
    if (!patchMarkersContainer) return;

    // Clear previous markers if any
    patchMarkersContainer.innerHTML = '';
    patchMarkers = [];

    if (!liberationTriggers || liberationTriggers.length === 0) {
      return;
    }

    liberationTriggers.forEach((trigger, triggerIndex) => {
      if (!trigger || trigger.type !== 'fourCorners') {
        return;
      }

      const corners = Array.isArray(trigger.corners) ? trigger.corners : [];
      corners.forEach((corner, cornerIndex) => {
        const col = corner.col;
        const row = corner.row;

        if (typeof col !== 'number' || typeof row !== 'number') {
          return;
        }

        const el = document.createElement('div');
        el.className = 'orca-stealth-patch-marker';
        el.style.position = 'absolute';
        el.style.boxSizing = 'border-box';
        el.style.display = 'flex';
        el.style.alignItems = 'center';
        el.style.justifyContent = 'center';
        el.style.fontFamily = 'monospace';
        el.style.fontSize = '12px';
        el.style.fontWeight = 'bold';
        el.style.color = '#ff5555'; // red
        el.textContent = 'X';

        patchMarkersContainer.appendChild(el);

        patchMarkers.push({
          triggerId: trigger.id || ('trigger_' + triggerIndex),
          triggerIndex,
          cornerIndex,
          col,
          row,
          active: false,
          el
        });
      });
    });

    updatePatchMarkersPosition();
  }

  function updatePatchMarkersPosition() {
    if (!patchMarkers || patchMarkers.length === 0) return;
    if (!patchMarkersContainer) return;

    patchMarkers.forEach((m) => {
      if (!m.el) return;
      const x = m.col * cellW;
      const y = m.row * cellH;
      m.el.style.width = cellW + 'px';
      m.el.style.height = cellH + 'px';
      m.el.style.transform = 'translate(' + x + 'px, ' + y + 'px)';
    });
  }

  function isAdjacentToMarker(marker) {
    const dx = Math.abs(playerCol - marker.col);
    const dy = Math.abs(playerRow - marker.row);
    // Cardinal adjacency or same cell
    return (dx + dy === 1) || (dx === 0 && dy === 0);
  }

    function tryActivateNearbyMarker() {
    if (!patchMarkers || patchMarkers.length === 0) return;

    let activatedMarker = null;

    // Activate at most one marker per key press
    for (let i = 0; i < patchMarkers.length; i++) {
      const m = patchMarkers[i];
      if (m.active) continue;
      if (!isAdjacentToMarker(m)) continue;

      m.active = true;
      if (m.el) {
        m.el.textContent = 'O';
        m.el.style.color = '#55ff55'; // green
      }

      activatedMarker = m;
      console.log(
        '[overlay] Patch marker',
        m.triggerId + ':' + m.cornerIndex,
        'activated.'
      );
      break;
    }

    if (!activatedMarker) {
      return;
    }

    const triggerIndex = activatedMarker.triggerIndex;
    const trigger = liberationTriggers[triggerIndex];
    if (!trigger) {
      return;
    }

    // Check if all markers of this trigger are now active.
    // This is per-trigger: completing one ritual does not affect the others.
    const markersForTrigger = patchMarkers.filter(
      (m) => m.triggerIndex === triggerIndex
    );
    const allActiveForTrigger =
      markersForTrigger.length > 0 &&
      markersForTrigger.every((m) => m.active);

    if (allActiveForTrigger) {
      liberatePatchInOrca(trigger);
    }
  }


  function liberatePatchInOrca(trigger) {
    const client = window.orcaClient;
    if (!client || !client.orca) {
      console.warn(
        '[overlay] Cannot liberate patch: orcaClient.orca not available'
      );
      return;
    }

    const orca = client.orca;

    // Use trigger.targetBlock if provided, otherwise fall back to PATCH_RECT.
    const rect = (trigger && trigger.targetBlock) ? trigger.targetBlock : PATCH_RECT;
    const w = rect.w || PATCH_RECT.w;
    const h = rect.h || PATCH_RECT.h;

    let commentedBlock = null;
    let unlockedBlock = null;

    // Try to read the commented block currently present in Orca.
    if (typeof orca.getBlock === 'function') {
      try {
        commentedBlock = orca.getBlock(rect.x, rect.y, w, h);
      } catch (e) {
        console.warn(
          '[overlay] getBlock failed while liberating patch, using fallback block:',
          e
        );
      }
    }

    if (commentedBlock) {
      unlockedBlock = transformCommentedBlockForLiberation(commentedBlock);
    }

    // Fallback: if for some reason we did not obtain a block, keep
    // using the old static demo block.
    if (!unlockedBlock) {
      console.warn(
        '[overlay] No commented block found at rect, using static PATCH_UNLOCK_BLOCK.'
      );
      unlockedBlock = PATCH_UNLOCK_BLOCK;
    }

        orca.writeBlock(rect.x, rect.y, unlockedBlock);

    console.log(
      '[overlay] Patch liberated for trigger',
      trigger && trigger.id ? trigger.id : '(no-id)',
      'at rect',
      rect
    );

  }



  function shootingTickForGuard(guard) {
    if (mode !== 'game') return;
    if (guard.state !== 'alert_chaser') return;
    if (guard.state === 'stunned') return;

    if (guard.shootCooldown > 0) {
      guard.shootCooldown--;
      return;
    }

    // Only shoot if currently seeing the player
    if (!guard.seenPlayer) {
      return;
    }

    const realTargetCol = playerCol;
    const realTargetRow = playerRow;

    if (!hasLineOfShot(guard, realTargetCol, realTargetRow)) {
      return;
    }

    spawnBulletFromGuard(guard, realTargetCol, realTargetRow);
  }

  // --------------------------------------------------
  // FOV for guards
  // --------------------------------------------------

  function getFovProfile(guard) {
    const profiles = levelConfig.fovProfiles || {};
    const id = guard.fovProfileId || 'A';
    return profiles[id] || profiles['A'];
  }

  function getLookMode(guard) {
    const phase = guard.lookPhase || 0;
    if (phase === 1) return 'positive';
    if (phase === 3) return 'negative';
    return 'center';
  }

  function computeGuardFovCellsForGuard(guard) {
    const cells = [];

    if (guard.state === 'stunned') {
      return cells;
    }

    if (guard.col < 0 || guard.col >= gridCols || guard.row < 0 || guard.row >= gridRows) {
      return cells;
    }

    const profile = getFovProfile(guard) || {};
    const widths = profile.widths || [1, 1, 3, 3, 3, 5, 5, 5, 7];
    const maxDist = Math.min(profile.depth || widths.length, widths.length);

    const dx = guard.dirX;
    const dy = guard.dirY;
    const lookMode = getLookMode(guard);

    for (let d = 1; d <= maxDist; d++) {
      const w = widths[d - 1];
      const half = (w - 1) / 2;

      if (dx !== 0 && dy === 0) {
        // Horizontal guard (right/left)
        const forwardCol = guard.col + dx * d;
        if (forwardCol < 0 || forwardCol >= gridCols) break;

        const baseRow = guard.row;
        let startRow, endRow;

        if (lookMode === 'center') {
          startRow = baseRow - half;
          endRow = baseRow + half;
        } else if (lookMode === 'positive') {
          // Looking "down" (south): flat on the north side
          startRow = baseRow;
          endRow = baseRow + (w - 1);
        } else {
          // Looking "up" (north): flat on the south side
          startRow = baseRow - (w - 1);
          endRow = baseRow;
        }

        if (startRow > endRow) {
          const tmp = startRow;
          startRow = endRow;
          endRow = tmp;
        }

        if (endRow < 0 || startRow > gridRows - 1) continue;
        if (startRow < 0) startRow = 0;
        if (endRow > gridRows - 1) endRow = gridRows - 1;

        for (let ry = startRow; ry <= endRow; ry++) {
          cells.push({ col: forwardCol, row: ry });
        }

      } else if (dy !== 0 && dx === 0) {
        // Vertical guard (up/down)
        const forwardRow = guard.row + dy * d;
        if (forwardRow < 0 || forwardRow >= gridRows) break;

        const baseCol = guard.col;
        let startCol, endCol;

        if (lookMode === 'center') {
          startCol = baseCol - half;
          endCol = baseCol + half;
        } else if (lookMode === 'positive') {
          // Looking "right" (east): flat on the west side
          startCol = baseCol;
          endCol = baseCol + (w - 1);
        } else {
          // Looking "left" (west): flat on the east side
          startCol = baseCol - (w - 1);
          endCol = baseCol;
        }

        if (startCol > endCol) {
          const tmp = startCol;
          startCol = endCol;
          endCol = tmp;
        }

        if (endCol < 0 || startCol > gridCols - 1) continue;
        if (startCol < 0) startCol = 0;
        if (endCol > gridCols - 1) endCol = gridCols - 1;

        for (let cx = startCol; cx <= endCol; cx++) {
          cells.push({ col: cx, row: forwardRow });
        }
      }
    }

    return cells;
  }

  function renderGuardFov() {
    if (!fovContainer) return;

    while (fovContainer.firstChild) {
      fovContainer.removeChild(fovContainer.firstChild);
    }

    if (mode !== 'game') return;

    const baseAlpha = (globalAlertLevel > 0 || anySectorTracking()) ? 0.35 : 0.20;

    guards.forEach((guard) => {
      if (guard.state === 'stunned') return;
      const color = guard.seenPlayer
        ? 'rgba(255, 64, 64, ' + baseAlpha + ')'
        : 'rgba(255, 0, 0, ' + baseAlpha + ')';

      guard.fovCells.forEach((cell) => {
        const cellDiv = document.createElement('div');
        cellDiv.style.position = 'absolute';
        cellDiv.style.left = (cell.col * cellW) + 'px';
        cellDiv.style.top = (cell.row * cellH) + 'px';
        cellDiv.style.width = cellW + 'px';
        cellDiv.style.height = cellH + 'px';
        cellDiv.style.background = color;
        fovContainer.appendChild(cellDiv);
      });
    });
  }

  function handleGuardSpotsPlayer(guard) {
    console.log(
      '[overlay] GUARD',
      guard.id,
      'spots player at',
      playerCol,
      playerRow
    );
  }

    function updateAllFovAndAlert(manageMemory) {
    manageMemory = !!manageMemory;

    let anySeen = false;
    const sectorSaw = { NW: false, NE: false, SW: false, SE: false };

    guards.forEach((guard) => {
      if (guard.state === 'stunned') {
        guard.fovCells = [];
        guard.wasSeeingPlayer = guard.seenPlayer;
        guard.seenPlayer = false;
        return;
      }

      guard.fovCells = computeGuardFovCellsForGuard(guard);
      const prevSeen = guard.seenPlayer;
      const nextSeen = guard.fovCells.some(
        (c) => c.col === playerCol && c.row === playerRow
      );

      guard.wasSeeingPlayer = prevSeen;
      guard.seenPlayer = nextSeen;

      if (nextSeen) {
        anySeen = true;
        guard.lastSeenPlayerCol = playerCol;
        guard.lastSeenPlayerRow = playerRow;
        const s = getSector(guard.col, guard.row);
        sectorSaw[s] = true;
      }

      if (!prevSeen && nextSeen) {
        handleGuardSpotsPlayer(guard);
      }
    });

    if (manageMemory) {
      // Aggiorna gli stati di settore con memoria a 3s
      ['NW', 'NE', 'SW', 'SE'].forEach((name) => {
        const sa = sectorAlerts[name];

        if (sectorSaw[name]) {
          // Qualcuna vede il player ORA in questo settore
          sa.state = 'tracking';
          sa.targetCol = playerCol;
          sa.targetRow = playerRow;
          sa.timer = ALERT_MEMORY_TICKS;
        } else if (sa.state === 'tracking') {
          // Nessuno lo vede adesso, ma il settore era in tracking
          if (sa.timer > 0) {
            sa.timer--;
            if (sa.timer > 0) {
              // Memoria: per tutta la durata, conosciamo ancora la posizione assoluta
              sa.targetCol = playerCol;
              sa.targetRow = playerRow;
            } else {
              sa.state = 'idle';
              sa.targetCol = null;
              sa.targetRow = null;
            }
          } else {
            sa.state = 'idle';
            sa.targetCol = null;
            sa.targetRow = null;
          }
        }
      });

      // Alert globale: attivo se qualcuno vede OR se almeno un settore è in tracking (memoria)
      const trackingNow =
        sectorAlerts.NW.state === 'tracking' ||
        sectorAlerts.NE.state === 'tracking' ||
        sectorAlerts.SW.state === 'tracking' ||
        sectorAlerts.SE.state === 'tracking';

      globalAlertLevel = (anySeen || trackingNow) ? 1 : 0;

      // Allinea stati delle guardie al loro settore
      guards.forEach((g) => {
        if (g.state === 'stunned') return;
        const s = getSector(g.col, g.row);
        const sa = sectorAlerts[s];

        if (sa.state === 'tracking') {
          g.state = 'alert_chaser';
        } else {
          // Settore tornato idle: la guardia torna a PATROL quando non ha più target diretto
          if (g.state === 'alert_chaser' && !g.seenPlayer) {
            g.state = 'patrol';
            g.path = null;
            g.pathTargetCol = null;
            g.pathTargetRow = null;
          }
        }
      });

      updateModeVisual();
    }

    // FOV sempre ridisegnati (forme e colori)
    renderGuardFov();
  }


  // --------------------------------------------------
  // Guard look direction oscillation & aiming
  // --------------------------------------------------

  function updateGuardLookDirection(guard) {
    guard.lookTick = (guard.lookTick || 0) + 1;

    // Change every 4 steps for smoother wobble
    if (guard.lookTick % 4 !== 0) {
      return;
    }

    // 0 -> center
    // 1 -> positive
    // 2 -> center
    // 3 -> negative
    guard.lookPhase = ((guard.lookPhase || 0) + 1) % 4;
  }

  function aimGuardAtTarget(guard, targetCol, targetRow) {
    const dx = targetCol - guard.col;
    const dy = targetRow - guard.row;

    if (dx === 0 && dy === 0) {
      return;
    }

    if (Math.abs(dx) >= Math.abs(dy)) {
      guard.dirX = dx > 0 ? 1 : -1;
      guard.dirY = 0;
    } else {
      guard.dirX = 0;
      guard.dirY = dy > 0 ? 1 : -1;
    }
  }

  // --------------------------------------------------
  // Rectangular patrol
  // --------------------------------------------------

  function withinGuardRect(guard, col, row) {
    return (
      col >= guard.minCol &&
      col <= guard.maxCol &&
      row >= guard.minRow &&
      row <= guard.maxRow
    );
  }

  function rotateGuardDirClockwise(guard) {
    const dx = guard.dirX;
    const dy = guard.dirY;
    // (1,0) -> (0,1) -> (-1,0) -> (0,-1) -> ...
    if (dx === 1 && dy === 0) {
      guard.dirX = 0; guard.dirY = 1;
    } else if (dx === 0 && dy === 1) {
      guard.dirX = -1; guard.dirY = 0;
    } else if (dx === -1 && dy === 0) {
      guard.dirX = 0; guard.dirY = -1;
    } else if (dx === 0 && dy === -1) {
      guard.dirX = 1; guard.dirY = 0;
    } else {
      guard.dirX = 1;
      guard.dirY = 0;
    }
  }

  function stepGuardPatrol(guard) {
    // If guard is outside its patrol rect, move back towards it
    if (!withinGuardRect(guard, guard.col, guard.row)) {
      let targetCol = guard.col;
      let targetRow = guard.row;

      if (guard.col < guard.minCol) targetCol = guard.col + 1;
      else if (guard.col > guard.maxCol) targetCol = guard.col - 1;

      if (guard.row < guard.minRow) targetRow = guard.row + 1;
      else if (guard.row > guard.maxRow) targetRow = guard.row - 1;

      const stepX = targetCol - guard.col;
      const stepY = targetRow - guard.row;

      let nextCol = guard.col;
      let nextRow = guard.row;

      if (stepX !== 0 && isWalkable(guard.col + Math.sign(stepX), guard.row) &&
          !isCellOccupiedByOtherGuard(guard.col + Math.sign(stepX), guard.row, guard)) {
        nextCol = guard.col + Math.sign(stepX);
        nextRow = guard.row;
      } else if (stepY !== 0 && isWalkable(guard.col, guard.row + Math.sign(stepY)) &&
                 !isCellOccupiedByOtherGuard(guard.col, guard.row + Math.sign(stepY), guard)) {
        nextCol = guard.col;
        nextRow = guard.row + Math.sign(stepY);
      }

      guard.col = nextCol;
      guard.row = nextRow;
      clampGuard(guard);
      updateGuardPosition(guard);
      updateGuardLookDirection(guard);
      return;
    }

    // Normal rectangular patrol inside rect
    let nextCol = guard.col + guard.dirX;
    let nextRow = guard.row + guard.dirY;

    // If it leaves its rectangle, rotate and retry
    if (!withinGuardRect(guard, nextCol, nextRow)) {
      rotateGuardDirClockwise(guard);
      nextCol = guard.col + guard.dirX;
      nextRow = guard.row + guard.dirY;

      if (!withinGuardRect(guard, nextCol, nextRow)) {
        updateGuardLookDirection(guard);
        updateGuardPosition(guard);
        return;
      }
    }

    // If it hits Orca code or another guard, try to rotate to go around it
    if (!isWalkable(nextCol, nextRow) ||
        isCellOccupiedByOtherGuard(nextCol, nextRow, guard)) {
      rotateGuardDirClockwise(guard);
      nextCol = guard.col + guard.dirX;
      nextRow = guard.row + guard.dirY;

      if (!withinGuardRect(guard, nextCol, nextRow) ||
          !isWalkable(nextCol, nextRow) ||
          isCellOccupiedByOtherGuard(nextCol, nextRow, guard)) {
        updateGuardLookDirection(guard);
        updateGuardPosition(guard);
        return;
      }
    }

    guard.col = nextCol;
    guard.row = nextRow;
    clampGuard(guard);

    updateGuardLookDirection(guard);
    updateGuardPosition(guard);
  }

  // --------------------------------------------------
  // Preferred alert targets (cardinal "slots" around player)
  // --------------------------------------------------

  function getSectorGuards(sectorName) {
    return guards.filter((g) => {
      if (g.state === 'stunned') return false;
      const s = getSector(g.col, g.row);
      return s === sectorName;
    });
  }
  
    // --------------------------------------------------
  // Assegnazione slot cardinali per l'accerchiamento
  // --------------------------------------------------
  function assignSectorCardinals() {
    const sectors = { NW: [], NE: [], SW: [], SE: [] };

    guards.forEach((g) => {
      if (g.state === 'stunned') {
        g.preferredCardinal = null;
        return;
      }
      const s = getSector(g.col, g.row);
      if (!sectors[s]) sectors[s] = [];
      sectors[s].push(g);
    });

    const dirs = ['N', 'E', 'S', 'W'];

    ['NW', 'NE', 'SW', 'SE'].forEach((name) => {
      const list = sectors[name] || [];
      for (let i = 0; i < list.length; i++) {
        const g = list[i];
        g.preferredCardinal = dirs[i % dirs.length];
      }
    });
  }

    function computePreferredAlertTarget(guard) {
    const sectorName = getSector(guard.col, guard.row);
    const sa = sectorAlerts[sectorName];
    if (!sa || sa.state !== 'tracking') {
      // Nessun alert attivo per il settore: resta dove sei
      return { col: guard.col, row: guard.row };
    }

    // Posizione assoluta del player mentre il settore è in tracking
    const px = playerCol;
    const py = playerRow;

    // Slot cardinale assegnato in assignSectorCardinals()
    const slotDir = guard.preferredCardinal || 'N';

    const maxR = 6;
    for (let r = 2; r <= maxR; r++) {
      let cx = px;
      let cy = py;

      if (slotDir === 'N') {
        cy = py - r;
      } else if (slotDir === 'S') {
        cy = py + r;
      } else if (slotDir === 'W') {
        cx = px - r;
      } else {
        // 'E' o fallback
        cx = px + r;
      }

      if (cx < 0 || cy < 0 || cx >= gridCols || cy >= gridRows) continue;
      if (!isWalkable(cx, cy)) continue;
      if (cx === px && cy === py) continue; // non puntare la cella del player

      return { col: cx, row: cy };
    }

    // Fallback: piccolo anello attorno al player
    for (let r = 1; r <= maxR; r++) {
      const candidates = [
        { col: px + r, row: py },
        { col: px - r, row: py },
        { col: px, row: py + r },
        { col: px, row: py - r }
      ];
      for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i];
        if (c.col < 0 || c.row < 0 || c.col >= gridCols || c.row >= gridRows) continue;
        if (!isWalkable(c.col, c.row)) continue;
        if (c.col === px && c.row === py) continue;
        return c;
      }
    }

    // Ultima risorsa: vai proprio verso il player
    return { col: px, row: py };
  }


  // --------------------------------------------------
  // Alert / chasing behavior (uses BFS towards preferred target)
  // --------------------------------------------------

  function stepGuardAlert(guard) {
    if (guard.state === 'stunned') return;

    const sectorName = getSector(guard.col, guard.row);
    const sa = sectorAlerts[sectorName];

    if (!sa || sa.state !== 'tracking') {
      // Sector not in alert: back to patrol
      guard.state = 'patrol';
      guard.path = null;
      guard.pathTargetCol = null;
      guard.pathTargetRow = null;
      updateGuardPosition(guard);
      return;
    }

    // If this guard currently sees the real player, stop rushing closer:
    // just orient, and if needed, try a very small local reposition
    // to get line-of-shot.
    if (guard.seenPlayer) {
      const tx = playerCol;
      const ty = playerRow;

      aimGuardAtTarget(guard, tx, ty);

      // Already have line-of-shot -> stand and shoot from here
      if (hasLineOfShot(guard, tx, ty)) {
        updateGuardLookDirection(guard);
        updateGuardPosition(guard);
        return;
      }

      // Try tiny local moves (4-neighborhood) to gain line-of-shot
      const localDirs = [
        { dx: 1, dy: 0 },
        { dx: -1, dy: 0 },
        { dx: 0, dy: 1 },
        { dx: 0, dy: -1 }
      ];

      for (let i = 0; i < localDirs.length; i++) {
        const d = localDirs[i];
        const nc = guard.col + d.dx;
        const nr = guard.row + d.dy;

        if (nc < 0 || nr < 0 || nc >= gridCols || nr >= gridRows) continue;
        if (nc === playerCol && nr === playerRow) continue;
        if (!isWalkable(nc, nr)) continue;
        if (isCellOccupiedByOtherGuard(nc, nr, guard)) continue;

        const tmp = { col: nc, row: nr };
        if (!hasLineOfShot(tmp, tx, ty)) continue;

        guard.col = nc;
        guard.row = nr;
        aimGuardAtTarget(guard, tx, ty);
        clampGuard(guard);
        updateGuardPosition(guard);
        updateGuardLookDirection(guard);
        return;
      }

      // Cannot improve, stay still and keep looking
      updateGuardLookDirection(guard);
      updateGuardPosition(guard);
      return;
    }

    // Guard does NOT currently see the player but sector is tracking:
    // chase towards a preferred cardinal shooting slot around the player.
    const preferred = computePreferredAlertTarget(guard);
    const targetCol = preferred.col;
    const targetRow = preferred.row;

    aimGuardAtTarget(guard, playerCol, playerRow);

    ensureGuardPath(guard, targetCol, targetRow);

    if (!guard.path) {
      // Cannot find path: just look around in place
      updateGuardLookDirection(guard);
      updateGuardPosition(guard);
      return;
    }

    const moved = stepGuardAlongPath(guard);
    if (!moved) {
      updateGuardLookDirection(guard);
      updateGuardPosition(guard);
      return;
    }

    updateGuardLookDirection(guard);
  }

  function stepGuard(guard) {
    // STUNNED state
    if (guard.state === 'stunned') {
      if (guard.stunTicks > 0) {
        guard.stunTicks--;
        return;
      } else {
        // Wake up and go back to PATROL
        guard.state = 'patrol';
        guard.neutralized = false;
        guard.stunTicks = 0;
        if (guard.el) guard.el.style.opacity = '1.0';
        return;
      }
    }

    // ALERT_CHASER state: faster movement (multiple steps per tick)
    if (guard.state === 'alert_chaser') {
      for (let i = 0; i < ALERT_STEPS_PER_TICK; i++) {
        stepGuardAlert(guard);
        if (guard.state !== 'alert_chaser') {
          break;
        }
      }
      return;
    }

    // Default: PATROL
    for (let i = 0; i < PATROL_STEPS_PER_TICK; i++) {
      stepGuardPatrol(guard);
    }
  }

  // --------------------------------------------------
  // Collisions & damage
  // --------------------------------------------------

  function neutralizeGuard(guard) {
    if (guard.state === 'stunned') return;
    guard.state = 'stunned';
    guard.neutralized = true;
    guard.stunTicks = 12; // 12 ticks * 250ms ≈ 3s
    guard.path = null;
    guard.pathTargetCol = null;
    guard.pathTargetRow = null;
    guard.seenPlayer = false;
    guard.wasSeeingPlayer = false;
    guard.fovCells = [];
    if (guard.el) {
      guard.el.style.opacity = '0.25';
    }
    console.log('[overlay] GUARD STUNNED by player (3s):', guard.id);
  }

  function applyPlayerHit(source) {
    if (playerHitCooldown > 0) {
      return;
    }

    playerHP--;
    if (playerHP < 0) playerHP = 0;
    const srcId = source && source.id ? source.id : 'unknown';
    console.log(
      '[overlay] PLAYER HIT by',
      srcId,
      'HP:',
      playerHP,
      '/',
      playerHPMax
    );

    // Small cooldown to avoid taking damage every single tick
    playerHitCooldown = 4; // ~1s of invulnerability at 250ms per tick

    // Update HUD
    updateModeVisual();

    // Flash red
    if (overlayDiv) {
      overlayDiv.style.background = 'rgba(255, 0, 0, 0.35)';
      setTimeout(() => {
        updateModeVisual();
      }, 150);
    }

    if (playerHP <= 0) {
      console.log('[overlay] PLAYER DEAD (restart logic not implemented yet)');
      // TODO: reset level / respawn
    }
  }

  function isPlayerBehindGuard(guard) {
    const dx = guard.dirX;
    const dy = guard.dirY;

    if (dx === 0 && dy === 0) return false;

    const backCol = guard.col - dx;
    const backRow = guard.row - dy;

    return (
      playerCol === guard.col &&
      playerRow === guard.row &&
      prevPlayerCol === backCol &&
      prevPlayerRow === backRow
    );
  }

  function checkGuardPlayerCollisions() {
    guards.forEach((guard) => {
      if (guard.state === 'stunned') return;
      if (guard.col === playerCol && guard.row === playerRow) {
        if (isPlayerBehindGuard(guard)) {
          // Stealth takedown from behind
          neutralizeGuard(guard);
          updateAllFovAndAlert();
        } else {
          // All other collisions: player takes damage
          applyPlayerHit(guard);
        }
      }
    });
  }

  // --------------------------------------------------
  // Guards tick
  // --------------------------------------------------

    function stepAllGuards() {
    if (mode !== 'game') return;

    // Cooldown danno al player
    if (playerHitCooldown > 0) {
      playerHitCooldown--;
    }

    // Assegna slot cardinali per settore (N/E/S/W) una volta per tick
    assignSectorCardinals();

    // 1) Tick di "percezione": aggiorna FOV + stati di alert + memoria 3s
    updateAllFovAndAlert(true);

    // 2) Movimento guardie (patrol / alert / stunned)
    guards.forEach(stepGuard);

    // 3) Ricalcola solo le forme dei FOV dopo il movimento (senza toccare timer)
    updateAllFovAndAlert(false);

    // 4) Attacchi a distanza
    guards.forEach(shootingTickForGuard);

    // 5) Movimento proiettili
    stepBullets();

    // 6) Collisioni corpo a corpo (stealth / danno)
    checkGuardPlayerCollisions();
  }


  // --------------------------------------------------
  // Player movement
  // --------------------------------------------------

  function tryMovePlayer(dCol, dRow, newDir) {
    prevPlayerCol = playerCol;
    prevPlayerRow = playerRow;

    let targetCol = playerCol + dCol;
    let targetRow = playerRow + dRow;

    if (targetCol < 0) targetCol = 0;
    if (targetRow < 0) targetRow = 0;
    if (targetCol > gridCols - 1) targetCol = gridCols - 1;
    if (targetRow > gridRows - 1) targetRow = gridRows - 1;

    if (!isWalkable(targetCol, targetRow)) {
      if (DEBUG) {
        console.log(
          '[overlay] MOVE BLOCKED at',
          targetCol,
          targetRow,
          'glyph=',
          JSON.stringify(getOrcaGlyph(targetCol, targetRow))
        );
      }
      return;
    }

    playerCol = targetCol;
    playerRow = targetRow;
    playerDir = newDir;

        clampPlayer();
    updatePlayerPosition();
    updatePlayerDirectionVisual();
    // update only FOV, alert and guard reactions will be done in the main tick
    updateAllFovAndAlert(false);
    checkGuardPlayerCollisions();


    log('player moved to', playerCol, playerRow, 'dir=', playerDir);
  }

  // --------------------------------------------------
  // Keyboard input
  // --------------------------------------------------

    function onKeyDown(ev) {
    const key = ev.key;

    // Toggle mode (F1)
    if (key === 'F1') {
      ev.preventDefault();
      ev.stopPropagation();
      toggleMode();
      return;
    }

    // EDIT mode: let Orca handle everything
    if (mode === 'edit') {
      return;
    }

    // GAME mode
    if (key === ' ') {
      // Space goes to Orca (clock)
      if (DEBUG) {
        console.log('[overlay] Space in GAME mode: letting it pass to Orca.');
      }
      return;
    }

    // Block everything else, except arrows and A
    ev.preventDefault();
    ev.stopPropagation();

    if (key === 'ArrowUp') {
      tryMovePlayer(0, -1, 'up');
    } else if (key === 'ArrowDown') {
      tryMovePlayer(0, 1, 'down');
    } else if (key === 'ArrowLeft') {
      tryMovePlayer(-1, 0, 'left');
    } else if (key === 'ArrowRight') {
      tryMovePlayer(1, 0, 'right');
    } else if (key === 'a' || key === 'A') {
      // Interaction key: try to activate a nearby marker
      tryActivateNearbyMarker();
    } else {
      if (DEBUG) {
        console.log(
          '[overlay] Key blocked in GAME mode (not arrows, not Space/A):',
          key
        );
      }
      return;
    }
  }



  // --------------------------------------------------
  // Init
  // --------------------------------------------------

    function initOverlay() {
    log('initOverlay start');

    ensureOverlayElements();
    initGuardsFromConfig();
    syncGeometry();

    window.addEventListener('resize', syncGeometry);
    window.addEventListener('keydown', onKeyDown, true);

    guardTimer = window.setInterval(stepAllGuards, WORLD_TICK_MS);

    // Try to load external level configuration (window.orcaStealthLevelConfig or JSON).
    loadExternalLevelConfig();

    log('overlay initialized.');
    console.log('[overlay] Start in EDIT mode. Press F1 to switch to GAME mode.');
  }

  window.addEventListener('load', () => {
    setTimeout(initOverlay, 300);
  });
})();

