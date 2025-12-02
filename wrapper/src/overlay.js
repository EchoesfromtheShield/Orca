// Orca Stealth Wrapper - overlay 1:1 with Orca grid
// Modes:
//   EDIT -> Orca receives keyboard normally
//   GAME -> WASD control the player, Orca only receives Space for the clock
//
// Player: yellow triangle oriented in the direction of the last movement.
// Guards: array of guards, rectangular patrol, cone-shaped FOV (9 cells).
//
// Guard states:
//   state: "patrol" | "alert_chaser" | "return_to_patrol" | "stunned"
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
  const BULLET_STEPS_PER_TICK       = 4;  // cells per tick
  const GUARD_FIRE_COOLDOWN_TICKS   = 2;  // ticks between shots (~1s at 250ms)

  // Player ranged weapon
  const PLAYER_BULLET_RANGE_CELLS   = 7;  // max distance (in cells) for player bullets
  const PLAYER_INITIAL_AMMO         = 6;  // initial ammo for player

  const PLAYER_SHOOT_KEYS          = ['s', 'S']; // keys that fire the player weapon

  // Guard HP
  const GUARD_MAX_HP                = 2;  // guard max hit points


  // Alert / memory (how long sectors remember player absolute position after losing sight)
  const ALERT_MEMORY_TICKS          = 12; // ~3s at 250ms

 // Guard FOV mode di base:
  //  - "wobble": guards sweep their view left/right (testa che oscilla)
  //  - "fixed":  FOV sempre centrato nella direzione di movimento
  const GUARD_FOV_MODE = 'wobble'; // default globale se non arriva layout dal JSON

  // Flag runtime: può essere modificato per layout (arena vs dungeon).
  // - true  -> FOV wobble (rotazione testa)
  // - false -> FOV fisso (solo 'center')
  let GUARD_FOV_WOBBLE_ENABLED = (GUARD_FOV_MODE === 'wobble');



  function log() {
    if (!DEBUG) return;
    console.log('[overlay]', ...arguments);
  }

  // --------------------------------------------------
  // Level config (minimal sandbox for guards) + hook for external generator
  // --------------------------------------------------

    const defaultLevelConfig = {
    // High-level layout type:
    // "arena"   -> arena-style behavior (sector-based alert, wobbling FOV, etc.)
    // "dungeon" -> dungeon-style behavior (room-based alert, fixed FOV, etc.)
    layoutType: 'arena',

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

      playerSpawn: externalCfg.playerSpawn || baseCfg.playerSpawn || null,

      // New: carry high-level layout type from JSON
      layoutType: externalCfg.layoutType || baseCfg.layoutType || 'arena'
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
    // Force a new spawn-adjustment pass for this level
    guardSpawnsInitialized = false;


    // If the level config provides an explicit player spawn, use it.
    if (
      merged.playerSpawn &&
      typeof merged.playerSpawn.col === 'number' &&
      typeof merged.playerSpawn.row === 'number'
    ) {
      playerCol = merged.playerSpawn.col;
      playerRow = merged.playerSpawn.row;
    }

    // Decide behavior based on layoutType
    const layoutType = merged.layoutType || 'arena';

    // In dungeon: fixed FOV (no wobble).
    // In arena: wobbling FOV.
    if (layoutType === 'dungeon') {
      GUARD_FOV_WOBBLE_ENABLED = false;
    } else {
      GUARD_FOV_WOBBLE_ENABLED = true;
    }

    console.log(
      '[overlay] Level config updated from external config:',
      merged,
      'layoutType =',
      layoutType,
      'FOV wobble =',
      GUARD_FOV_WOBBLE_ENABLED ? 'ON' : 'OFF'
    );

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

  // Player ammo
  let playerAmmoMax = PLAYER_INITIAL_AMMO;
  let playerAmmo = PLAYER_INITIAL_AMMO;


    // Guards
  let guards = [];
  let guardTimer = null;
  let globalAlertLevel = 0; // 0 = no guard sees the player, 1 = at least one guard sees him

  // Track if we already ran the spawn-adjustment pass for the current levelConfig
  let guardSpawnsInitialized = false;


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
      hud.textContent =
        '[MODE: EDIT] HP ' +
        playerHP +
        '/' +
        playerHPMax +
        '  AMMO ' +
        playerAmmo +
        '/' +
        playerAmmoMax;
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
        '  AMMO ' +
        playerAmmo +
        '/' +
        playerAmmoMax +
        '  [' +
        alertText +
        ']  (F1: toggle, Arrows: move, S: shoot, Space: Orca clock)';
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
      sprite.style.width = '65%';   // slightly bigger
      sprite.style.height = '65%';  // slightly bigger
      sprite.style.transform = 'translate(-50%, -50%)';
      sprite.style.borderRadius = '50%';
      sprite.style.boxSizing = 'border-box';
      sprite.style.border = '2px solid #ff7777';
      sprite.style.background = '#ff3333';
      sprite.style.pointerEvents = 'none';
      sprite.style.overflow = 'hidden'; // needed for half-fill effect
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

        // Current position
        col: cfg.startCol || 0,
        row: cfg.startRow || 0,

        // "Home" position used when returning to patrol after alert
        homeCol: cfg.startCol || 0,
        homeRow: cfg.startRow || 0,

        // Patrol rectangle
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

        // Look / FOV
        lookPhase: 0,
        lookTick: 0,
        fovCells: [],
        seenPlayer: false,
        wasSeeingPlayer: false,

        // FSM / alert
        state: 'patrol',
        lastSeenPlayerCol: null,
        lastSeenPlayerRow: null,
        alertTimer: 0,

        // Pathfinding
        path: null,
        pathTargetCol: null,
        pathTargetRow: null,

        // Movement history for anti-stuck logic
        lastPositions: [],
        stuckCounter: 0,

        // Stun / combat
        neutralized: false,
        stunTicks: 0,
        shootCooldown: 0,

        // HP
        maxHP: GUARD_MAX_HP,
        hp: GUARD_MAX_HP,
        dead: false
      };

      guards.push(guard);
      updateGuardSpriteAppearance(guard);

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
      if (g.state === 'dead') {
        return;
      }

      // If the guard is already on a walkable cell, do nothing
      if (isWalkable(g.col, g.row)) {
        return;
      }


      const res = findNearestWalkableCell(g.col, g.row);
      if (res) {
        g.col = res.col;
        g.row = res.row;
        clampGuard(g);
        updateGuardPosition(g);
        log(
          '[overlay] Guard',
          g.id,
          'snapped from wall to nearest walkable at',
          g.col,
          g.row
        );
      }
    });
  }

    // --------------------------------------------------
  // Spawn adjustment per layout (arena vs dungeon)
  // --------------------------------------------------

  // Utility: shuffle array in-place
  function shuffleArray(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
    }
  }

  // Compute all walkable candidate cells inside a rect, with optional inner margin
  function buildWalkableCandidatesInRect(minCol, maxCol, minRow, maxRow, innerMargin) {
    const margin = innerMargin || 0;

    let c0 = Math.max(minCol + margin, 0);
    let c1 = Math.min(maxCol - margin, gridCols - 1);
    let r0 = Math.max(minRow + margin, 0);
    let r1 = Math.min(maxRow - margin, gridRows - 1);

    if (c0 > c1 || r0 > r1) {
      // Margin too aggressive, fallback to no margin
      c0 = Math.max(minCol, 0);
      c1 = Math.min(maxCol, gridCols - 1);
      r0 = Math.max(minRow, 0);
      r1 = Math.min(maxRow, gridRows - 1);
    }

    const out = [];
    for (let c = c0; c <= c1; c++) {
      for (let r = r0; r <= r1; r++) {
        if (!isWalkable(c, r)) continue;
        out.push({ col: c, row: r });
      }
    }
    return out;
  }

  function adjustGuardSpawnsByLayout() {
    if (!guards || guards.length === 0) return;

    const layoutType =
      (levelConfig && levelConfig.layoutType) ? levelConfig.layoutType : 'arena';

    if (layoutType === 'dungeon') {
      adjustDungeonGuardSpawns();
    } else {
      adjustArenaGuardSpawns();
    }
  }

  // DUNGEON: group guards by patrol rect ("room") and assign
  // spawn positions on walkable cells inside the room, avoiding
  // same row / same column within the same room.
  function adjustDungeonGuardSpawns() {
    if (!guards || guards.length === 0) return;

    // Group guards by their patrol rect (approx. "room")
    const rooms = {};
    guards.forEach((g) => {
      const key =
        g.minCol + ',' + g.maxCol + ',' + g.minRow + ',' + g.maxRow;
      if (!rooms[key]) {
        rooms[key] = {
          minCol: g.minCol,
          maxCol: g.maxCol,
          minRow: g.minRow,
          maxRow: g.maxRow,
          guards: []
        };
      }
      rooms[key].guards.push(g);
    });

    Object.keys(rooms).forEach((key) => {
      const room = rooms[key];
      const list = room.guards;
      if (!list || list.length === 0) return;

      // Prefer cells not glued to the walls: margin=1
      let candidates = buildWalkableCandidatesInRect(
        room.minCol,
        room.maxCol,
        room.minRow,
        room.maxRow,
        1
      );

      if (candidates.length === 0) {
        // If the room is very cramped, fallback to any walkable cell in the rect
        candidates = buildWalkableCandidatesInRect(
          room.minCol,
          room.maxCol,
          room.minRow,
          room.maxRow,
          0
        );
      }

      if (candidates.length === 0) {
        // No usable cells: keep existing positions
        list.forEach((g) => {
          g.homeCol = g.col;
          g.homeRow = g.row;
          clampGuard(g);
          updateGuardPosition(g);
        });
        return;
      }

      shuffleArray(candidates);

      const occupiedRows = new Set();
      const occupiedCols = new Set();
      const takenCells = new Set();

      list.forEach((g) => {
        let chosen = null;

        // First pass: require unique row and unique column within the room
        for (let i = 0; i < candidates.length; i++) {
          const cell = candidates[i];
          const keyCell = cell.col + ',' + cell.row;
          if (takenCells.has(keyCell)) continue;
          if (occupiedRows.has(cell.row)) continue;
          if (occupiedCols.has(cell.col)) continue;
          chosen = cell;
          break;
        }

        // Second pass: relax to "not both row and column already used"
        if (!chosen) {
          for (let i = 0; i < candidates.length; i++) {
            const cell = candidates[i];
            const keyCell = cell.col + ',' + cell.row;
            if (takenCells.has(keyCell)) continue;
            if (occupiedRows.has(cell.row) && occupiedCols.has(cell.col)) continue;
            chosen = cell;
            break;
          }
        }

        if (!chosen) {
          // Last resort: just pick the first candidate
          chosen = candidates[0];
        }

        const keyCell = chosen.col + ',' + chosen.row;
        takenCells.add(keyCell);
        occupiedRows.add(chosen.row);
        occupiedCols.add(chosen.col);

        g.col = chosen.col;
        g.row = chosen.row;
        g.homeCol = g.col;
        g.homeRow = g.row;

        clampGuard(g);
        updateGuardPosition(g);
      });
    });
  }

    // ARENA: shrink patrol rects away from map borders based on FOV width,
  // then reassign spawn positions per sector (NW/NE/SW/SE) on walkable cells,
  // avoiding same row / same column per sector.
  function adjustArenaGuardSpawns() {
    if (!guards || guards.length === 0) return;

    // 1) Shrink patrol rects away from borders using FOV max width as margin
    guards.forEach((g) => {
      const profile = getFovProfile(g) || {};
      const widths = profile.widths || [1];
      let maxW = 1;
      for (let i = 0; i < widths.length; i++) {
        if (widths[i] > maxW) maxW = widths[i];
      }
      const margin = Math.floor(maxW / 2);

      // Keep original rect in case shrink completely collapses it
      const orig = {
        minCol: g.minCol,
        maxCol: g.maxCol,
        minRow: g.minRow,
        maxRow: g.maxRow
      };

      let minCol = Math.max(g.minCol, margin);
      let maxCol = Math.min(g.maxCol, gridCols - 1 - margin);
      let minRow = Math.max(g.minRow, margin);
      let maxRow = Math.min(g.maxRow, gridRows - 1 - margin);

      if (minCol > maxCol || minRow > maxRow) {
        // If shrink kills the rect, fallback to original
        minCol = orig.minCol;
        maxCol = orig.maxCol;
        minRow = orig.minRow;
        maxRow = orig.maxRow;
      }

      g.minCol = minCol;
      g.maxCol = maxCol;
      g.minRow = minRow;
      g.maxRow = maxRow;

      // Clamp current position inside rect
      if (g.col < g.minCol) g.col = g.minCol;
      if (g.col > g.maxCol) g.col = g.maxCol;
      if (g.row < g.minRow) g.row = g.minRow;
      if (g.row > g.maxRow) g.row = g.maxRow;

      g.homeCol = g.col;
      g.homeRow = g.row;
    });

    // 2) Reassign spawn positions per sector, avoiding "fila indiana"
    const sectorGroups = { NW: [], NE: [], SW: [], SE: [] };

    guards.forEach((g) => {
      const s = getSector(g.col, g.row);
      if (!sectorGroups[s]) sectorGroups[s] = [];
      sectorGroups[s].push(g);
    });

    ['NW', 'NE', 'SW', 'SE'].forEach((name) => {
      const list = sectorGroups[name];
      if (!list || list.length === 0) return;

      const occupiedRows = new Set();
      const occupiedCols = new Set();
      const takenCells = new Set();

      list.forEach((g) => {
        const candidates = [];

        // Only consider walkable cells inside the guard rect and within this sector
        for (let c = g.minCol; c <= g.maxCol; c++) {
          for (let r = g.minRow; r <= g.maxRow; r++) {
            if (c < 0 || r < 0 || c >= gridCols || r >= gridRows) continue;
            if (!isWalkable(c, r)) continue;
            if (getSector(c, r) !== name) continue;
            candidates.push({ col: c, row: r });
          }
        }

        if (candidates.length === 0) {
          // No good candidate for this guard: keep current (already clamped)
          const keyCell = g.col + ',' + g.row;
          takenCells.add(keyCell);
          occupiedRows.add(g.row);
          occupiedCols.add(g.col);
          g.homeCol = g.col;
          g.homeRow = g.row;
          clampGuard(g);
          updateGuardPosition(g);
          return;
        }

        shuffleArray(candidates);

        let chosen = null;

        // First pass: require unique row and column in this sector
        for (let i = 0; i < candidates.length; i++) {
          const cell = candidates[i];
          const k = cell.col + ',' + cell.row;
          if (takenCells.has(k)) continue;
          if (occupiedRows.has(cell.row)) continue;
          if (occupiedCols.has(cell.col)) continue;
          chosen = cell;
          break;
        }

        // Second pass: relax to "not both row and column already used"
        if (!chosen) {
          for (let i = 0; i < candidates.length; i++) {
            const cell = candidates[i];
            const k = cell.col + ',' + cell.row;
            if (takenCells.has(k)) continue;
            if (occupiedRows.has(cell.row) && occupiedCols.has(cell.col)) continue;
            chosen = cell;
            break;
          }
        }

        if (!chosen) {
          chosen = candidates[0];
        }

        const k = chosen.col + ',' + chosen.row;
        takenCells.add(k);
        occupiedRows.add(chosen.row);
        occupiedCols.add(chosen.col);

        g.col = chosen.col;
        g.row = chosen.row;
        g.homeCol = g.col;
        g.homeRow = g.row;

        clampGuard(g);
        updateGuardPosition(g);
      });
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

    // Spawn adjustment: run once per levelConfig (reset in applyExternalLevelConfig)
    if (!guardSpawnsInitialized) {
      adjustGuardSpawnsByLayout();
      guardSpawnsInitialized = true;
    }

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
      if (g.state === 'stunned' || g.state === 'dead') continue;
      if (g.col === col && g.row === row) {
        return true;
      }
    }
    return false;
  }

  // Find guard at given cell (ignoring dead guards if needed)
  function findGuardAtCell(col, row) {
    for (let i = 0; i < guards.length; i++) {
      const g = guards[i];
      if (g.state === 'dead') continue;
      if (g.col === col && g.row === row) {
        return g;
      }
    }
    return null;
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
      // No usable path: clear and report failure
      guard.path = null;
      guard.pathTargetCol = null;
      guard.pathTargetRow = null;
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
      // We are already at the end of the path
      guard.path = null;
      guard.pathTargetCol = null;
      guard.pathTargetRow = null;
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
      // Reached final target: clear path
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

    if (guard.state === 'stunned') {
      guard.el.style.opacity = '0.25';
    } else if (guard.state === 'dead') {
      guard.el.style.opacity = '0.9';
    } else {
      guard.el.style.opacity = '1.0';
    }
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
      ownerType: 'guard',
      fromGuardId: guard.id || 'guard',
      rangeLeft: null // unlimited, stops only on wall / edge / player
    };


    bullets.push(bullet);
    updateBulletPosition(bullet);

    guard.shootCooldown = GUARD_FIRE_COOLDOWN_TICKS;

    console.log('[overlay] GUARD', guard.id, 'shoots.');
  }

  function spawnBulletFromPlayer() {
    if (!bulletsContainer) return;

    // No ammo, no shot
    if (playerAmmo <= 0) {
      console.log('[overlay] PLAYER tried to shoot but has no ammo.');
      return;
    }

    // Direction from playerDir
    let dx = 0;
    let dy = 0;
    if (playerDir === 'up') {
      dy = -1;
    } else if (playerDir === 'down') {
      dy = 1;
    } else if (playerDir === 'left') {
      dx = -1;
    } else if (playerDir === 'right') {
      dx = 1;
    }

    // If no valid facing direction, do nothing
    if (dx === 0 && dy === 0) {
      return;
    }

    const startCol = playerCol + dx;
    const startRow = playerRow + dy;

    // Out of bounds
    if (
      startCol < 0 ||
      startRow < 0 ||
      startCol >= gridCols ||
      startRow >= gridRows
    ) {
      return;
    }

    // Cannot shoot directly into non-walkable cell
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
      dx: dx,
      dy: dy,
      el: bulletEl,
      alive: true,
      ownerType: 'player',
      fromGuardId: null,
      rangeLeft: PLAYER_BULLET_RANGE_CELLS // limited range
    };

    bullets.push(bullet);
    updateBulletPosition(bullet);

    // Consume ammo and update HUD
    playerAmmo--;
    if (playerAmmo < 0) playerAmmo = 0;
    updateModeVisual();

    console.log(
      '[overlay] PLAYER shoots. Ammo:',
      playerAmmo,
      '/',
      playerAmmoMax
    );
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

        // Player hit (only for guard bullets)
        if (
          b.ownerType === 'guard' &&
          nextCol === playerCol &&
          nextRow === playerRow
        ) {
          applyPlayerHit({ id: 'bullet:' + (b.fromGuardId || 'guard') });
          if (b.el.parentNode) {
            b.el.parentNode.removeChild(b.el);
          }
          alive = false;
          break;
        }

        // Guard hit (only for player bullets)
        if (b.ownerType === 'player') {
          const hitGuard = findGuardAtCell(nextCol, nextRow);
          if (hitGuard) {
            applyGuardHit(hitGuard, b);
            if (b.el.parentNode) {
              b.el.parentNode.removeChild(b.el);
            }
            alive = false;
            break;
          }
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

        // Range handling for bullets that have it
        if (typeof b.rangeLeft === 'number') {
          b.rangeLeft--;
          if (b.rangeLeft <= 0) {
            if (b.el.parentNode) {
              b.el.parentNode.removeChild(b.el);
            }
            alive = false;
            break;
          }
        }
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
        el.style.color = '#df0a0aff'; // red
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
    if (guard.state === 'stunned' || guard.state === 'dead') return;


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

  // Line-of-sight for FOV: returns true only if all cells
  // between (fromCol,fromRow) and (toCol,toRow) are walkable.
  // We skip the starting cell (guard position) and require
  // every intermediate + target cell to be walkable.
  function hasLineOfSightForFov(fromCol, fromRow, toCol, toRow) {
    let x0 = fromCol;
    let y0 = fromRow;
    const x1 = toCol;
    const y1 = toRow;

    const dx = Math.abs(x1 - x0);
    const dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;

    let err = dx - dy;
    let firstStep = true;

    while (true) {
      // Skip the starting cell (guard position), test everything else
      if (!firstStep) {
        if (!isWalkable(x0, y0)) {
          return false;
        }
      } else {
        firstStep = false;
      }

      // Reached destination
      if (x0 === x1 && y0 === y1) {
        break;
      }

      const e2 = 2 * err;
      if (e2 > -dy) {
        err -= dy;
        x0 += sx;
      }
      if (e2 < dx) {
        err += dx;
        y0 += sy;
      }
    }

    return true;
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
    // Se il wobble è disabilitato (es. layout "dungeon"), FOV sempre centrato.
    if (!GUARD_FOV_WOBBLE_ENABLED) {
      return 'center';
    }

    // Comportamento "wobble": testa che oscilla fra center / positive / negative
    const phase = guard.lookPhase || 0;
    if (phase === 1) return 'positive';
    if (phase === 3) return 'negative';
    return 'center';
  }



    function computeGuardFovCellsForGuard(guard) {
    const result = [];

    // Stunned or dead guards have no FOV
    if (guard.state === 'stunned' || guard.state === 'dead') {
      return result;
    }


    // Guard must be on-grid
    if (
      guard.col < 0 || guard.col >= gridCols ||
      guard.row < 0 || guard.row >= gridRows
    ) {
      return result;
    }

    const profile = getFovProfile(guard) || {};
    const widths = profile.widths || [1, 1, 3, 3, 3, 5, 5, 5, 7];
    const maxDist = Math.min(profile.depth || widths.length, widths.length);

    const dx = guard.dirX;
    const dy = guard.dirY;

    // If guard has no facing direction, no FOV
    if (dx === 0 && dy === 0) {
      return result;
    }

    const lookMode = getLookMode(guard);
    const candidates = [];

    // --------------------------------------------------
    // Horizontal facing (dx != 0, dy == 0)
    // --------------------------------------------------
    if (dx !== 0 && dy === 0) {
      for (let d = 1; d <= maxDist; d++) {
        const forwardCol = guard.col + dx * d;
        if (forwardCol < 0 || forwardCol >= gridCols) {
          break;
        }

        const baseRow = guard.row;
        const w = widths[d - 1];
        const half = (w - 1) / 2;

        let startRow, endRow;

        if (lookMode === 'center') {
          // Symmetric cone
          startRow = baseRow - half;
          endRow   = baseRow + half;
        } else if (lookMode === 'positive') {
          // Tilted "down" (south): flat on the north side
          startRow = baseRow;
          endRow   = baseRow + (w - 1);
        } else {
          // "negative": tilted "up" (north): flat on the south side
          startRow = baseRow - (w - 1);
          endRow   = baseRow;
        }

        if (startRow > endRow) {
          const tmp = startRow;
          startRow = endRow;
          endRow   = tmp;
        }

        if (endRow < 0 || startRow > gridRows - 1) {
          continue;
        }

        if (startRow < 0) startRow = 0;
        if (endRow   > gridRows - 1) endRow = gridRows - 1;

        for (let ry = startRow; ry <= endRow; ry++) {
          candidates.push({ col: forwardCol, row: ry });
        }
      }
    }

    // --------------------------------------------------
    // Vertical facing (dy != 0, dx == 0)
    // --------------------------------------------------
    else if (dy !== 0 && dx === 0) {
      for (let d = 1; d <= maxDist; d++) {
        const forwardRow = guard.row + dy * d;
        if (forwardRow < 0 || forwardRow >= gridRows) {
          break;
        }

        const baseCol = guard.col;
        const w = widths[d - 1];
        const half = (w - 1) / 2;

        let startCol, endCol;

        if (lookMode === 'center') {
          // Symmetric cone
          startCol = baseCol - half;
          endCol   = baseCol + half;
        } else if (lookMode === 'positive') {
          // Tilted "right" (east): flat on the west side
          startCol = baseCol;
          endCol   = baseCol + (w - 1);
        } else {
          // "negative": tilted "left" (west): flat on the east side
          startCol = baseCol - (w - 1);
          endCol   = baseCol;
        }

        if (startCol > endCol) {
          const tmp = startCol;
          startCol = endCol;
          endCol   = tmp;
        }

        if (endCol < 0 || startCol > gridCols - 1) {
          continue;
        }

        if (startCol < 0) startCol = 0;
        if (endCol   > gridCols - 1) endCol = gridCols - 1;

        for (let cx = startCol; cx <= endCol; cx++) {
          candidates.push({ col: cx, row: forwardRow });
        }
      }
    }

    // --------------------------------------------------
    // Filter: bounds, walkable, LOS, dedupe
    // --------------------------------------------------
    const seen = new Set();

    for (let i = 0; i < candidates.length; i++) {
      const cell = candidates[i];
      const c = cell.col;
      const r = cell.row;

      if (c < 0 || r < 0 || c >= gridCols || r >= gridRows) {
        continue;
      }

      const key = c + ':' + r;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);

      // Do not draw FOV on non-walkable cells (walls, Orca code)
      if (!isWalkable(c, r)) {
        continue;
      }

      // Check line-of-sight from guard to this cell:
      // if any non-walkable cell lies in between, this cell is occluded.
      if (!hasLineOfSightForFov(guard.col, guard.row, c, r)) {
        continue;
      }

      result.push({ col: c, row: r });
    }

    return result;
  }

  function renderGuardFov() {
    if (!fovContainer) return;

    while (fovContainer.firstChild) {
      fovContainer.removeChild(fovContainer.firstChild);
    }

    if (mode !== 'game') return;

    const baseAlpha = (globalAlertLevel > 0 || anySectorTracking()) ? 0.35 : 0.20;

    guards.forEach((guard) => {
      if (guard.state === 'stunned' || guard.state === 'dead') return;

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
      if (guard.state === 'stunned' || guard.state === 'dead') {
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
        if (g.state === 'stunned' || g.state === 'dead') return;


        const s = getSector(g.col, g.row);
        const sa = sectorAlerts[s];

        if (sa.state === 'tracking') {
          // Sector currently tracking: guard is in full alert / chasing mode
          g.state = 'alert_chaser';
        } else {
          // Sector is idle: if guard was in alert and no longer sees the player,
          // switch to "return_to_patrol" so it can go back to its home cell via BFS.
          if (g.state === 'alert_chaser' && !g.seenPlayer) {
            g.state = 'return_to_patrol';
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
      if (g.state === 'stunned' || g.state === 'dead') return false;
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
      if (g.state === 'stunned' || g.state === 'dead') {
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

    function stepGuardReturnToPatrol(guard) {
    // If no valid home is defined, fall back to patrol
    if (typeof guard.homeCol !== 'number' || typeof guard.homeRow !== 'number') {
      guard.state = 'patrol';
      guard.path = null;
      guard.pathTargetCol = null;
      guard.pathTargetRow = null;
      return;
    }

    // If close enough to home, resume patrol
    const dxHome = guard.homeCol - guard.col;
    const dyHome = guard.homeRow - guard.row;
    if (Math.abs(dxHome) + Math.abs(dyHome) <= 1) {
      guard.state = 'patrol';
      guard.path = null;
      guard.pathTargetCol = null;
      guard.pathTargetRow = null;
      return;
    }

    // Face home (only for visuals / FOV orientation)
    aimGuardAtTarget(guard, guard.homeCol, guard.homeRow);

    // Path back to home
    ensureGuardPath(guard, guard.homeCol, guard.homeRow);

    if (!guard.path) {
      // No path found: avoid being stuck forever, just go back to patrol
      guard.state = 'patrol';
      return;
    }

    const moved = stepGuardAlongPath(guard);
    if (!moved) {
      // If we cannot move along the path this tick, do nothing.
      // Anti-stuck logic on movement history will eventually reset the path.
      updateGuardPosition(guard);
    }
  }

    function registerGuardMovementHistory(guard) {
    // Initialize storage
    if (!guard.lastPositions) {
      guard.lastPositions = [];
    }

    // Append current position (we also want duplicates to detect "standing still")
    guard.lastPositions.push({ col: guard.col, row: guard.row });
    if (guard.lastPositions.length > 4) {
      guard.lastPositions.shift();
    }

    if (guard.lastPositions.length < 4) {
      guard.stuckCounter = 0;
      return;
    }

    const p0 = guard.lastPositions[0];
    const p1 = guard.lastPositions[1];
    const p2 = guard.lastPositions[2];
    const p3 = guard.lastPositions[3];

    const same = (a, b) => a.col === b.col && a.row === b.row;

    // A-B-A-B oscillation
    const oscillation =
      same(p0, p2) &&
      same(p1, p3) &&
      !same(p0, p1);

    // Fully stuck in one cell
    const fullyStuck =
      same(p0, p1) &&
      same(p1, p2) &&
      same(p2, p3);

    if (oscillation || fullyStuck) {
      guard.stuckCounter = (guard.stuckCounter || 0) + 1;
    } else {
      guard.stuckCounter = 0;
    }

    if (guard.stuckCounter >= 2) {
      // Guard considered stuck: reset path
      guard.path = null;
      guard.pathTargetCol = null;
      guard.pathTargetRow = null;

      // Only shuffle preferred cardinal if this guard is actually chasing
      if (guard.state === 'alert_chaser') {
        const dirs = ['N', 'E', 'S', 'W'];
        guard.preferredCardinal = dirs[Math.floor(Math.random() * dirs.length)];
      }

      guard.stuckCounter = 0;
    }
  }

  function stepGuard(guard) {
    // DEAD state: no movement, no behavior
    if (guard.state === 'dead') {
      return;
    }

    // STUNNED state
    if (guard.state === 'stunned') {

      if (guard.stunTicks > 0) {
        guard.stunTicks--;
      } else {
        // Wake up and go back to PATROL
        guard.state = 'patrol';
        guard.neutralized = false;
        guard.stunTicks = 0;
        if (guard.el) guard.el.style.opacity = '1.0';
      }
      // Even if stunned, keep history updated (mostly harmless)
      registerGuardMovementHistory(guard);
      return;
    }

    // ALERT_CHASER state: faster movement (multiple steps per tick)
    if (guard.state === 'alert_chaser') {
      for (let i = 0; i < ALERT_STEPS_PER_TICK; i++) {
        stepGuardAlert(guard);
        if (guard.state !== 'alert_chaser') {
          break;
        }
      }
      registerGuardMovementHistory(guard);
      return;
    }

    // RETURN_TO_PATROL: go back "home" using BFS, then resume patrol
    if (guard.state === 'return_to_patrol') {
      stepGuardReturnToPatrol(guard);
      registerGuardMovementHistory(guard);
      return;
    }

    // Default: PATROL
    for (let i = 0; i < PATROL_STEPS_PER_TICK; i++) {
      stepGuardPatrol(guard);
    }
    registerGuardMovementHistory(guard);
  }
  
  // Update guard sprite appearance based on HP / dead state
  function updateGuardSpriteAppearance(guard) {
    if (!guard || !guard.sprite) return;

    const sprite = guard.sprite;

    // Base style (size & border are fixed)
    sprite.style.borderRadius = '50%';
    sprite.style.boxSizing = 'border-box';
    sprite.style.overflow = 'hidden';

    // Dead: outline only
    if (guard.state === 'dead' || guard.dead || guard.hp <= 0) {
      sprite.style.background = 'transparent';
      sprite.style.border = '2px solid #df0a0aff';
      return;
    }

    // Alive: decide full vs half fill based on HP
    if (guard.hp >= guard.maxHP) {
      // Full HP: solid bright red circle
      sprite.style.background = '#df0a0aff';
      sprite.style.border = '2px solid #df0a0aff';
    } else {
      // Wounded: half filled (top half red, bottom empty)
      sprite.style.background =
        'linear-gradient(to bottom, #df0a0aff 50%, rgba(0,0,0,0) 50%)';
      sprite.style.border = '2px solid #df0a0aff';
    }
  }

  // --------------------------------------------------
  // Collisions & damage
  // --------------------------------------------------

  function killGuard(guard) {
    if (!guard || guard.state === 'dead') return;

    guard.state = 'dead';
    guard.dead = true;
    guard.hp = 0;
    guard.neutralized = true;
    guard.stunTicks = 0;
    guard.path = null;
    guard.pathTargetCol = null;
    guard.pathTargetRow = null;
    guard.seenPlayer = false;
    guard.wasSeeingPlayer = false;
    guard.fovCells = [];

    if (guard.el) {
      guard.el.style.opacity = '0.9';
    }

    updateGuardSpriteAppearance(guard);
    console.log('[overlay] GUARD KILLED by player:', guard.id);
  }

  function applyGuardHit(guard, sourceBullet) {
    if (!guard || guard.state === 'dead') return;

    guard.hp--;
    if (guard.hp <= 0) {
      killGuard(guard);
    } else {
      updateGuardSpriteAppearance(guard);
      console.log(
        '[overlay] GUARD HIT by player bullet. HP:',
        guard.hp,
        '/',
        guard.maxHP
      );
    }
  }

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
    updateGuardSpriteAppearance(guard);
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
      if (guard.state === 'stunned' || guard.state === 'dead') return;
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

    // Hard safety: make sure guards are never stuck inside walls.
    // If a guard starts in a non-walkable cell (e.g. dungeon generator edge cases),
    // we snap it once per tick to the nearest walkable cell.
    ensureGuardsOnWalkableCells();

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
    } else if (PLAYER_SHOOT_KEYS.indexOf(key) !== -1) {
      // Player shoots in the facing direction
      spawnBulletFromPlayer();
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

