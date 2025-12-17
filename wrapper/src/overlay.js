// Orca Stealth Wrapper - overlay 1:1 with Orca grid
// Modes:
//   EDIT -> Orca receives keyboard normally
//   GAME -> ARROWS control the player, Orca only receives Space for the clock
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

  // Extra speed multiplier when a guard spots a dead guard ("corpse alert")
  const CORPSE_ALERT_SPEED_MULT = 1.5; // +50% speed, tweak here
  // Temporary speed multiplier for alerts triggered by hits / stunned-ally sighting
  const TEMP_ALERT_SPEED_MULT   = 1.5; // +50% speed while that alert is active
  const GUARD_ANIM_MIN_STEP_MS = 40;   // min ms per sub-step when animating fast moves

  // Bullets
  const BULLET_STEPS_PER_TICK       = 4;  // cells per tick
  const GUARD_FIRE_COOLDOWN_TICKS   = 2;  // ticks between shots (~1s at 250ms)
  // Grenades
  const GRENADE_STEPS_PER_TICK      = 2;  // half speed of bullets
  const GRENADE_RANGE_CELLS         = 5;  // explode after travelling this many cells
  const GRENADE_COLOR               = '#ff5533';
  const GRENADE_BLINK_TICKS         = 6;  // duration of explosion flash
  const GRENADE_FUSE_TICKS          = Math.ceil((3000) / WORLD_TICK_MS); // 3s fuse when stopped

  // Pickup blink tuning (ammo & medikit)
  const PICKUP_BLINK_DURATION_SEC = 0.35; // faster blink; tune as you like

  // Player ranged weapon
  const PLAYER_BULLET_RANGE_CELLS   = 9;  // max distance (in cells) for player bullets
  const PLAYER_INITIAL_AMMO         = 6;  // initial ammo for player
  const PLAYER_GRENADE_MAX          = 3;  // placeholder grenade capacity

  // Player corpse-drag speed (1 = normal speed, 0.33 = 33% of normal)
  const PLAYER_DRAG_SPEED_MULT      = 0.33;

  // Pickup spawn handles (random pickups on walkable ground)
  const INITIAL_MEDIKIT_PICKUPS     = 2;  // number of medikit pickups to spawn
  const INITIAL_AMMO_PICKUPS        = 3;  // number of ammo pickups to spawn
  const INITIAL_BAIT_PICKUPS        = 3;  // NEW: legacy default number of bait pickups
  const INITIAL_RIFLE_PICKUPS       = 0;  // rifle charges pickup (legacy default: none)
  const INITIAL_SHIELD_PICKUPS      = 0;  // shield charges pickup (legacy default: none)
  const INITIAL_GRENADE_PICKUPS     = 0;  // grenade pickups (placeholder mechanics)

  // Player shoot keys
  const PLAYER_SHOOT_KEYS           = ['s', 'S']; // keys that fire the player weapon

  // NEW: Bait tuning
  const BAIT_MAX_HP                 = 4;  // bait hit points (tunable)
  const PLAYER_BAIT_MAX             = 3;  // max baits that player can carry (tunable)
  const PLAYER_RIFLE_MAX            = 3;  // max rifle charges player can carry
  const RIFLE_FOV_WIDTHS            = [
    1, 1, // first 2 cells depth -> width 1
    3, 3, 3, 3, 3, 3, 3, 3, // next 8 cells depth -> width 3
    5, 5, 5, 5, 5, 5 // last 6 cells depth -> width 5
  ];
  const RIFLE_FOV_DEPTH             = RIFLE_FOV_WIDTHS.length; // 16
  const RIFLE_SHOT_DAMAGE           = 2;   // HP removed per rifle shot
  const RIFLE_BEAM_DURATION_MS      = 900;
  const RIFLE_BEAM_DURATION_TICKS   = Math.ceil(
    (RIFLE_BEAM_DURATION_MS) / WORLD_TICK_MS
  );
  const SHIELD_MAX                   = 3;
  const SHIELD_DURATION_SECONDS      = 6;
  const SHIELD_DURATION_TICKS        = Math.ceil(
    (SHIELD_DURATION_SECONDS * 1000) / WORLD_TICK_MS
  );
  const SHIELD_BLINK_TICKS           = 6; // quick flash when consumed/timeout
  const BASIC_LOOT_CHANCE            = 0.5; // 50% drop chance for basic loot
  const SPECIAL_LOOT_CHANCE          = 0.3; // 30% drop chance for special loot
  const EQUIPMENT_ITEMS             = [
    { id: 'bait', label: 'BAIT' },
    { id: 'shield', label: 'SHIELD' },
    { id: 'grenade', label: 'GRENADE' },
    { id: 'rifle', label: 'RIFLE' }
  ];

  // Guard HP
  const GUARD_MAX_HP                = 2;  // guard max hit points

  // Four-corners reset on alert (seconds)
  const FOUR_CORNERS_RESET_SECONDS  = 5;
  const FOUR_CORNERS_RESET_TICKS    = Math.ceil(
    (FOUR_CORNERS_RESET_SECONDS * 1000) / WORLD_TICK_MS
  );

  // Pressure tiles ritual: time required to apply pressure (in ticks)
  const PRESSURE_APPLY_SECONDS      = 4;
  const PRESSURE_APPLY_TICKS        = Math.ceil(
    (PRESSURE_APPLY_SECONDS * 1000) / WORLD_TICK_MS
  );


  // Alert / memory (how long sectors remember player absolute position after losing sight)
  const ALERT_MEMORY_TICKS          = 6; // ~1.5s at 250ms

  // Alert target behaviour:
  //  - 'realtime': during memory, sectors/rooms track the live player position
  //  - 'last_seen': during memory, they chase the last seen position only
  const ALERT_TARGET_MODE           = 'last_seen'; // <- switch to 'realtime' to test


  // "Observing" behaviour: guard stops and rotates FOV to cover 360°
  const OBSERVE_MIN_INTERVAL_TICKS     = 32;  // after ~8s of patrol we start considering observing
  const OBSERVE_FORCED_INTERVAL_TICKS  = 96;  // after ~24s we force at least one observing
  const OBSERVE_DURATION_TICKS         = 8;   // observing phase length (~2s)

  // "Patrol deviation": guard leaves the rectangle for a short excursion and then comes back
  const PATROL_DEV_MIN_INTERVAL_TICKS     = 40;   // ~10s before we start considering a deviation
  const PATROL_DEV_FORCED_INTERVAL_TICKS  = 120;  // ~30s -> guaranteed deviation
  const PATROL_DEV_MAX_RADIUS_CELLS       = 4;    // how deep inside the rect the guard can go
  const PATROL_DEV_OUT_STEPS_MAX          = 4;    // max steps going away from the perimeter
  const PATROL_DEV_BACK_STEPS_MAX         = 4;    // max steps to return to the perimeter

// Anti-stuck: after being stuck/oscillating for a long time, a guard
// will try hard to reset its position inside the patrol rect.
  const GUARD_TRY_HARD_STUCK_TICKS = 48; // ~12s at 250ms/tick

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
    playerSpawn: null,
        // NEW: default pickups (empty, everything will come from JSON)
    pickups: []
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

      // NEW: pickups (ammo / medikit) described in JSON
      pickups: Array.isArray(externalCfg.pickups)
        ? externalCfg.pickups
        : (baseCfg.pickups || []),

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

  // --------------------------------------------------
  // Liberation triggers helpers (center cell, key carriers)
  // --------------------------------------------------

  // Centro approssimato della patch, usato per associare stanza/settore
  function getTriggerCenterCell(trigger) {
    if (!trigger) return null;

    if (
      trigger.targetBlock &&
      typeof trigger.targetBlock.x === 'number' &&
      typeof trigger.targetBlock.y === 'number' &&
      typeof trigger.targetBlock.w === 'number' &&
      typeof trigger.targetBlock.h === 'number'
    ) {
      const x = trigger.targetBlock.x;
      const y = trigger.targetBlock.y;
      const w = trigger.targetBlock.w;
      const h = trigger.targetBlock.h;
      return {
        col: x + Math.floor(w / 2),
        row: y + Math.floor(h / 2)
      };
    }

    const corners = Array.isArray(trigger.corners) ? trigger.corners : [];
    if (!corners.length) return null;

    let minCol = Infinity;
    let maxCol = -Infinity;
    let minRow = Infinity;
    let maxRow = -Infinity;

    corners.forEach((c) => {
      if (typeof c.col === 'number') {
        if (c.col < minCol) minCol = c.col;
        if (c.col > maxCol) maxCol = c.col;
      }
      if (typeof c.row === 'number') {
        if (c.row < minRow) minRow = c.row;
        if (c.row > maxRow) maxRow = c.row;
      }
    });

    if (!isFinite(minCol) || !isFinite(minRow)) return null;

    return {
      col: minCol + Math.floor((maxCol - minCol) / 2),
      row: minRow + Math.floor((maxRow - minRow) / 2)
    };
  }

  // Assegna una guardia "key carrier" per ogni ritual getKey.
  // DUNGEON: guardia la cui patrol rect contiene il centro della patch.
  // ARENA: guardia nello stesso settore del centro patch.
  function assignKeyCarriersIfNeeded() {
    if (!liberationTriggers || !liberationTriggers.length) return;
    if (!guards || !guards.length) return;

    const layoutType = getLayoutType();

    liberationTriggers.forEach((trigger, triggerIndex) => {
      const st = triggerRuntimeState[triggerIndex];
      if (!st || st.ritual !== 'getKey') return;

      // Già assegnata per questo trigger
      if (st.keyCarrierGuardId) return;

      const center = getTriggerCenterCell(trigger);
      if (!center) return;

      const candidates = [];

      if (layoutType === 'dungeon') {
        guards.forEach((g) => {
          if (g.state === 'dead') return;
          if (withinGuardRect(g, center.col, center.row)) {
            candidates.push(g);
          }
        });
      } else {
        const triggerSector = getSector(center.col, center.row);
        guards.forEach((g) => {
          if (g.state === 'dead') return;
          const s = getSector(g.col, g.row);
          if (s === triggerSector) {
            candidates.push(g);
          }
        });
      }

      if (!candidates.length) {
        console.warn(
          '[overlay] No eligible guards found for getKey trigger',
          trigger.id || triggerIndex
        );
        return;
      }

      const chosen =
        candidates[Math.floor(Math.random() * candidates.length)];

      st.keyCarrierGuardId = chosen.id || ('guard_' + triggerIndex);
      chosen.keyForTriggerIndex = triggerIndex;

      console.log(
        '[overlay] Guard',
        chosen.id,
        'selected as KEY carrier for trigger',
        trigger.id || triggerIndex
      );
    });
  }


  // NEW: runtime state per singolo liberation trigger
  // ritual: "fourCorners" | "destroyTarget" | "getKey"
  // lockCornerIndex: indice nel vettore corners[] per il lucchetto "K" (solo getKey)
  // destroyTarget: riferimento all'oggetto bersaglio (solo destroyTarget)
  let triggerRuntimeState = [];

  // Ritorna il tipo di ritual associato a un trigger.
  // Atteso dal JSON:
  //   - { type: "fourCorners", ... }
  //   - { type: "destroyTarget", destroyTarget: { col, row, hp }, ... }
  //   - { type: "getKey", keyCornerIndex: 0, ... }
  function getTriggerRitualType(trigger) {
    if (!trigger) return 'fourCorners';
    if (trigger.ritual) return trigger.ritual;
    if (trigger.type === 'destroyTarget') return 'destroyTarget';
    if (trigger.type === 'getKey') return 'getKey';
    if (trigger.type === 'pressure_tiles' || trigger.ritual === 'pressure_tiles') {
      return 'pressure_tiles';
    }
    return 'fourCorners';
  }

  function rebuildTriggerRuntimeState() {
    triggerRuntimeState = [];
    if (!liberationTriggers || liberationTriggers.length === 0) return;

    liberationTriggers.forEach((trigger, index) => {
      const ritual = getTriggerRitualType(trigger);
      const st = {
        ritual,
        completed: false,
        keyOwned: false,
        keyDropped: false,
        keyCarrierGuardId: null,
        lockCornerIndex: null,
        destroyTarget: null
      };

      // Per getKey: quale corner di corners[] è il lucchetto con la "K"
      if (ritual === 'getKey') {
        if (typeof trigger.keyCornerIndex === 'number') {
          st.lockCornerIndex = trigger.keyCornerIndex;
        } else {
          // fallback: primo corner
          st.lockCornerIndex = 0;
        }
      }

      triggerRuntimeState[index] = st;
    });
  }

  // Bootstrap iniziale (defaultLevelConfig)
  rebuildTriggerRuntimeState();


  // Optional URL for auto-loading an external JSON level description.
  // Put generated-level.json next to index.html / overlay.js, or change the path.
  const LEVEL_JSON_URL = 'generated-level.json';

  function applyExternalLevelConfig(externalCfg) {
    const merged = mergeLevelConfig(defaultLevelConfig, externalCfg);
    levelConfig = merged;

    liberationTriggers = Array.isArray(merged.liberationTriggers)
      ? merged.liberationTriggers
      : [];

    // NEW: ricostruisci lo stato runtime dei ritual (fourCorners / getKey / destroyTarget)
    rebuildTriggerRuntimeState();

    // Force a new spawn-adjustment pass for this level
    guardSpawnsInitialized = false;
    allPatchesUnlocked = false;
    guardsFrozen = false;
    patchResetCountdowns = {};
    selectedEquipmentIndex = 0;
    playerShields = 0;
    playerGrenades = 0;
    playerLastExplosionDamageTick = -1000;
    shieldActive = false;
    shieldTicks = 0;
    shieldBlinkTicks = 0;
    playerRifles = 0;
    rifleAimActive = false;
    rifleAimFovCells = [];
    rifleAimTargetGuardId = null;
    rifleAimAnchorCol = null;
    rifleAimAnchorRow = null;
    rifleAimAnchorDir = null;
    rifleAimCandidates = [];
    clearRifleBeams();
    clearGrenadesAndFx();
    setPlayerColor('yellow');
    if (allPatchesUnlockedDiv) {
      allPatchesUnlockedDiv.style.display = 'none';
    }


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

    // Reset room alerts and sector alerts for the new level
    for (const k in roomAlerts) {
      if (Object.prototype.hasOwnProperty.call(roomAlerts, k)) {
        delete roomAlerts[k];
      }
    }

   sectorAlerts.NW.state = 'idle';
    sectorAlerts.NE.state = 'idle';
    sectorAlerts.SW.state = 'idle';
    sectorAlerts.SE.state = 'idle';

    sectorAlerts.NW.timer =
      sectorAlerts.NE.timer =
      sectorAlerts.SW.timer =
      sectorAlerts.SE.timer = 0;

    sectorAlerts.NW.targetCol =
      sectorAlerts.NE.targetCol =
      sectorAlerts.SW.targetCol =
      sectorAlerts.SE.targetCol = null;

    sectorAlerts.NW.targetRow =
      sectorAlerts.NE.targetRow =
      sectorAlerts.SW.targetRow =
      sectorAlerts.SE.targetRow = null;

    sectorAlerts.NW.seeingNow =
      sectorAlerts.NE.seeingNow =
      sectorAlerts.SW.seeingNow =
      sectorAlerts.SE.seeingNow = false;

    sectorAlerts.NW.source =
      sectorAlerts.NE.source =
      sectorAlerts.SW.source =
      sectorAlerts.SE.source = null;

    sectorAlerts.NW.sourceBaitId =
      sectorAlerts.NE.sourceBaitId =
      sectorAlerts.SW.sourceBaitId =
      sectorAlerts.SE.sourceBaitId = null;

    sectorAlerts.NW.corpseBoost =
      sectorAlerts.NE.corpseBoost =
      sectorAlerts.SW.corpseBoost =
      sectorAlerts.SE.corpseBoost = 1.0;
    sectorAlerts.NW.tempBoost =
      sectorAlerts.NE.tempBoost =
      sectorAlerts.SW.tempBoost =
      sectorAlerts.SE.tempBoost = 1.0;


    // --- PICKUPS FIX ---

    // Remove any pickups that were spawned before (random defaults, etc.)
    clearAllPickups();
    clearAllBaits();


    // Mark pickups as already handled for this level:
    // syncGeometry() will NOT call spawnInitialPickupsRandom().
    pickupsInitialized = true;

    // Rebuild guards and patch markers according to the new config.
    initGuardsFromConfig();
    initPatchMarkersDom();

    // Spawn pickups from JSON-driven config (levelConfig.pickups).
    spawnPickupsFromConfig();

    // Re-sync geometry (positions, FOV, snapping pickups to walkable, etc.)
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

  // Global game over flag
  // When true, the world simulation is frozen and input is ignored in GAME mode
  let isGameOver = false;
  let allPatchesUnlocked = false;
  let guardsFrozen = false;
  let patchResetCountdowns = {}; // triggerIndex -> ticks left for fourCorners reset

  let overlayDiv = null;
  let allPatchesUnlockedDiv = null;
  let alertAreasContainer = null;
  let guardsContainer = null;
  let fovContainer = null;
  let bulletsContainer = null;
  let grenadeFxContainer = null;

  // Big centered GAME OVER overlay
  let gameOverDiv = null;
  function setPlayerColor(color) {
    if (!playerInner) return;
    playerInner.style.background = color;
  }

  function updatePlayerSpriteFill() {
    if (!playerInner) return;
    // Base color is yellow; shield logic will override per tick
    playerInner.style.background = 'yellow';
  }


// Player
  let playerDiv = null;
  let playerInner = null;
  let playerCol = 0;
  let playerRow = 0;
  let playerLastExplosionDamageTick = -1000;
  let prevPlayerCol = 0;
  let prevPlayerRow = 0;
  // 'up' | 'down' | 'left' | 'right'
  let playerDir = 'up';
  let playerDraggingCorpse = false;
  let playerDraggedGuard = null;
  let playerDragKeyHeld = false;
  let playerMoveCooldownTicks = 0;
  let shieldActive = false;
  let shieldTicks = 0;
  let shieldBlinkTicks = 0;

  // Player HP
  let playerHPMax = 5;
  let playerHP = playerHPMax;
  let playerHitCooldown = 0; // invulnerability ticks after being hit

  // Player blink (during invulnerability)
  let playerBlinkVisible = true; // true = visible, false = hidden


  // Player ammo
  let playerAmmoMax = PLAYER_INITIAL_AMMO;
  let playerAmmo = PLAYER_INITIAL_AMMO;

  // Player baits inventory
  let playerBaits = 0; // number of baits currently carried
  let playerRifles = 0; // number of rifle charges currently carried
  let playerShields = 0; // number of shield charges currently carried
  let playerGrenades = 0; // number of grenades carried (placeholder)
  let selectedEquipmentIndex = 0; // 0 = BAIT, cycles with R

  // Guards
  let guards = [];
  let guardTimer = null;
  let globalAlertLevel = 0; // 0 = no guard sees the player, 1 = at least one guard sees him
  // Monotonic world tick counter (used by patrol extra behaviours)
  let worldTick = 0;


  // Track if we already ran the spawn-adjustment pass for the current levelConfig
  let guardSpawnsInitialized = false;


  // Bullets
  let bullets = [];
  // Grenades (player throwable)
  let grenades = [];
  let grenadeExplosions = [];


  // Pickups (ammo / medikit / bait pickups)
  let pickupsContainer = null;
  let pickups = [];
  let pickupsInitialized = false;
  let pickupsBlinkTick = 0;

  // Placed baits on the map
  let baitsContainer = null;
  let baits = [];
  let nextBaitId = 1;

  // Rifle aim / beams
  let rifleFxContainer = null;
  let rifleAimActive = false;
  let rifleAimFovCells = [];
  let rifleAimTargetGuardId = null;
  let rifleAimAnchorCol = null;
  let rifleAimAnchorRow = null;
  let rifleAimAnchorDir = null;
  let rifleAimCandidates = [];
  let rifleBeams = []; // { el, ttl }

  // NEW: destroy-targets associated with liberation triggers
  // Each entry: { triggerIndex, col, row, hp, maxHP, el, outer, inner, dot, alive }
  let destroyTargets = [];

  // NEW: pressure tiles (pressure_tiles ritual)
  // Each entry: { triggerIndex, col, row, el, outer, inner, applied, holdTicks }
  let pressureTiles = [];


  // Grid / geometry
  let gridCols = 120;
  let gridRows = 40;


  let cellW = 0;
  let cellH = 0;

  // Sectors (quadrants, static map split)
  let midCol = 0;
  let midRow = 0;

  // Sector alert states:
  //   state: "idle" | "tracking"
  //   targetCol/Row: last known player position (for memory)
  //   timer: memory countdown
  //   seeingNow: true if at least one guard in this sector sees the player this tick
   const sectorAlerts = {
    NW: {
      state: 'idle',
      targetCol: null,
      targetRow: null,
      timer: 0,
      seeingNow: false,
      source: null,
      sourceBaitId: null,
      // Permanent speed boost multiplier for this sector when a corpse is spotted
      corpseBoost: 1.0,
      // Temporary speed boost while alert is active (hit/stunned sightings)
      tempBoost: 1.0
    },
    NE: {
      state: 'idle',
      targetCol: null,
      targetRow: null,
      timer: 0,
      seeingNow: false,
      source: null,
      sourceBaitId: null,
      corpseBoost: 1.0,
      tempBoost: 1.0
    },
    SW: {
      state: 'idle',
      targetCol: null,
      targetRow: null,
      timer: 0,
      seeingNow: false,
      source: null,
      sourceBaitId: null,
      corpseBoost: 1.0,
      tempBoost: 1.0
    },
    SE: {
      state: 'idle',
      targetCol: null,
      targetRow: null,
      timer: 0,
      seeingNow: false,
      source: null,
      sourceBaitId: null,
      corpseBoost: 1.0,
      tempBoost: 1.0
    }
  };

  // Room-based alert states (used only in dungeon layout).
  // Key format: "minCol,maxCol,minRow,maxRow"
  // Each entry:
  //   state: "idle" | "tracking"
  //   targetCol/Row: last known target position
  //   source: "player" | "bait" | null
  //   sourceBaitId: id of bait if source === "bait"
  const roomAlerts = {};


  // Layout helpers
  function getLayoutType() {
    return (levelConfig && levelConfig.layoutType) ? levelConfig.layoutType : 'arena';
  }

  function isDungeonLayout() {
    return getLayoutType() === 'dungeon';
  }

  // Compute a stable "room key" for a guard based on its patrol rectangle
  function getGuardRoomKey(guard) {
    if (!guard) return null;
    return (
      guard.minCol + ',' +
      guard.maxCol + ',' +
      guard.minRow + ',' +
      guard.maxRow
    );
  }

  // Ensure a roomAlerts entry exists with default fields
  function ensureRoomAlertEntry(key) {
    if (!key) return null;
    if (!roomAlerts[key]) {
      roomAlerts[key] = {
        state: 'idle',
        targetCol: null,
        targetRow: null,
        timer: 0,
        seeingNow: false,
        source: null,
        sourceBaitId: null,
        corpseBoost: 1.0,
        tempBoost: 1.0
      };
    }
    return roomAlerts[key];
  }


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

    // Global CSS for pickup blinking (ammo & medikit)
    let existingStyle = document.getElementById('orca-stealth-style');
    if (!existingStyle) {
            existingStyle = document.createElement('style');
      existingStyle.id = 'orca-stealth-style';
      existingStyle.type = 'text/css';
      existingStyle.textContent = `
@keyframes orcaPickupBlink {
  0%   { opacity: 1; }
  50%  { opacity: 0.15; }
  100% { opacity: 1; }
}
.orca-stealth-pickup {
  animation-name: orcaPickupBlink;
  animation-timing-function: linear;
  animation-iteration-count: infinite;
}

@keyframes orcaBaitSpin {
  0%   { transform: translate(-50%, -50%) rotate(0deg); }
  100% { transform: translate(-50%, -50%) rotate(360deg); }
}
.orca-stealth-bait-spin {
  animation-name: orcaBaitSpin;
  animation-duration: 0.8s;
  animation-timing-function: linear;
  animation-iteration-count: infinite;
}

/* NEW: aura for placed bait (bigger triangle, opposite rotation + pulse) */
@keyframes orcaBaitAura {
  0% {
    transform: translate(-50%, -50%) scale(0.95) rotate(0deg);
    opacity: 0;
  }
  35% {
    transform: translate(-50%, -50%) scale(1.05) rotate(-140deg);
    opacity: 0.9;
  }
  100% {
    transform: translate(-50%, -50%) scale(0.95) rotate(-360deg);
    opacity: 0;
  }
}
.orca-stealth-bait-aura {
  animation-name: orcaBaitAura;
  animation-duration: 1.4s;
  animation-timing-function: ease-in-out;
  animation-iteration-count: infinite;
}

@keyframes orcaPressureBlink {
  0%   { opacity: 1; }
  50%  { opacity: 0.35; }
  100% { opacity: 1; }
}
.orca-stealth-pressure-blink {
  animation-name: orcaPressureBlink;
  animation-duration: 0.6s;
  animation-timing-function: ease-in-out;
  animation-iteration-count: infinite;
}

@keyframes orcaCornerBlinkFast {
  0%   { opacity: 1; }
  50%  { opacity: 0.25; }
  100% { opacity: 1; }
}
.orca-stealth-corner-blink-fast {
  animation-name: orcaCornerBlinkFast;
  animation-duration: 0.35s;
  animation-timing-function: linear;
  animation-iteration-count: infinite;
}

@keyframes orcaRifleBeamBlink {
  0%   { opacity: 1; }
  50%  { opacity: 0.12; }
  100% { opacity: 1; }
}
.orca-stealth-rifle-beam {
  position: absolute;
  left: 0;
  top: 0;
  height: 1px;
  pointer-events: none;
  animation-name: orcaRifleBeamBlink;
  animation-duration: 0.18s;
  animation-iteration-count: infinite;
  animation-timing-function: linear;
}
.orca-stealth-rifle-beam .beam-center {
  position: absolute;
  height: 100%;
  background: #00d8ff;
  left: 12%;
  right: 12%;
}
.orca-stealth-rifle-beam .beam-dash {
  position: absolute;
  height: 100%;
  top: 0;
  background: repeating-linear-gradient(
    to right,
    #00d8ff 0%,
    #00d8ff 8%,
    transparent 14%,
    transparent 22%,
    #00d8ff 28%,
    #00d8ff 34%,
    transparent 40%,
    transparent 48%,
    #00d8ff 54%,
    #00d8ff 60%,
    transparent 66%,
    transparent 74%,
    #00d8ff 80%,
    #00d8ff 86%,
    transparent 92%,
    transparent 100%
  );
}
.orca-stealth-rifle-beam .beam-left {
  left: 0;
  width: 12%;
}
.orca-stealth-rifle-beam .beam-right {
  right: 0;
  width: 12%;
}

.orca-stealth-rifle-cross {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 75%;
  height: 75%;
  transform: translate(-50%, -50%);
  pointer-events: none;
}
.orca-stealth-rifle-cross .h,
.orca-stealth-rifle-cross .v {
  position: absolute;
  background: #00d8ff;
  opacity: 0.95;
}
.orca-stealth-rifle-cross .h {
  top: 50%;
  left: 0;
  width: 100%;
  height: 16%;
  transform: translateY(-50%);
}
.orca-stealth-rifle-cross .v {
  left: 50%;
  top: 0;
  width: 16%;
  height: 100%;
  transform: translateX(-50%);
}

      `;
      document.head.appendChild(existingStyle);
    }

    // Alert areas container (red tinted rectangles per room/sector)
    alertAreasContainer = document.createElement('div');
    alertAreasContainer.id = 'orca-stealth-alert-areas';
    alertAreasContainer.style.position = 'absolute';
    alertAreasContainer.style.left = '0';
    alertAreasContainer.style.top = '0';
    alertAreasContainer.style.width = '100%';
    alertAreasContainer.style.height = '100%';
    alertAreasContainer.style.pointerEvents = 'none';
    overlayDiv.appendChild(alertAreasContainer);

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

    // Grenade FX container (explosions)
    grenadeFxContainer = document.createElement('div');
    grenadeFxContainer.id = 'orca-stealth-grenades';
    grenadeFxContainer.style.position = 'absolute';
    grenadeFxContainer.style.left = '0';
    grenadeFxContainer.style.top = '0';
    grenadeFxContainer.style.width = '100%';
    grenadeFxContainer.style.height = '100%';
    grenadeFxContainer.style.pointerEvents = 'none';
    overlayDiv.appendChild(grenadeFxContainer);

    // Pickups container (above bullets, below patch markers/player)
    pickupsContainer = document.createElement('div');
    pickupsContainer.id = 'orca-stealth-pickups';
    pickupsContainer.style.position = 'absolute';
    pickupsContainer.style.left = '0';
    pickupsContainer.style.top = '0';
    pickupsContainer.style.width = '100%';
    pickupsContainer.style.height = '100%';
    pickupsContainer.style.pointerEvents = 'none';
    overlayDiv.appendChild(pickupsContainer);

    // Placed baits container (above pickups, below patch markers/player)
    baitsContainer = document.createElement('div');
    baitsContainer.id = 'orca-stealth-baits';
    baitsContainer.style.position = 'absolute';
    baitsContainer.style.left = '0';
    baitsContainer.style.top = '0';
    baitsContainer.style.width = '100%';
    baitsContainer.style.height = '100%';
    baitsContainer.style.pointerEvents = 'none';
    overlayDiv.appendChild(baitsContainer);


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

    // Rifle FX container (beam + aim overlay, above patch markers, below player)
    rifleFxContainer = document.createElement('div');
    rifleFxContainer.id = 'orca-stealth-rifle-fx';
    rifleFxContainer.style.position = 'absolute';
    rifleFxContainer.style.left = '0';
    rifleFxContainer.style.top = '0';
    rifleFxContainer.style.width = '100%';
    rifleFxContainer.style.height = '100%';
    rifleFxContainer.style.pointerEvents = 'none';
    overlayDiv.appendChild(rifleFxContainer);

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
    playerInner.style.boxSizing = 'border-box';
    playerInner.style.clipPath = 'polygon(50% 12%, 14% 88%, 86% 88%)';
    playerInner.style.transformOrigin = '50% 50%';

    playerDiv.appendChild(playerInner);
    overlayDiv.appendChild(playerDiv);
    updatePlayerSpriteFill();

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

    // GAME OVER overlay centered on screen
    gameOverDiv = document.createElement('div');
    gameOverDiv.id = 'orca-stealth-gameover';
    gameOverDiv.style.position = 'absolute';
    gameOverDiv.style.left = '0';
    gameOverDiv.style.top = '0';
    gameOverDiv.style.width = '100%';
    gameOverDiv.style.height = '100%';
    gameOverDiv.style.display = 'none'; // shown only when isGameOver = true
    gameOverDiv.style.alignItems = 'center';
    gameOverDiv.style.justifyContent = 'center';
    gameOverDiv.style.pointerEvents = 'none';
    gameOverDiv.style.fontFamily = 'monospace';
    gameOverDiv.style.fontSize = '48px';
    gameOverDiv.style.fontWeight = 'bold';
    gameOverDiv.style.color = '#ff3333';
    gameOverDiv.style.textShadow = '0 0 12px rgba(0,0,0,0.9)';
    gameOverDiv.style.background = 'transparent';

    const gameOverLabel = document.createElement('div');
    gameOverLabel.textContent = 'GAME OVER';
    gameOverDiv.appendChild(gameOverLabel);

    overlayDiv.appendChild(gameOverDiv);

    // ALL PATCHES UNLOCKED overlay
    allPatchesUnlockedDiv = document.createElement('div');
    allPatchesUnlockedDiv.id = 'orca-stealth-all-unlocked';
    allPatchesUnlockedDiv.style.position = 'absolute';
    allPatchesUnlockedDiv.style.left = '0';
    allPatchesUnlockedDiv.style.top = '0';
    allPatchesUnlockedDiv.style.width = '100%';
    allPatchesUnlockedDiv.style.height = '100%';
    allPatchesUnlockedDiv.style.display = 'none';
    allPatchesUnlockedDiv.style.alignItems = 'center';
    allPatchesUnlockedDiv.style.justifyContent = 'center';
    allPatchesUnlockedDiv.style.pointerEvents = 'none';
    allPatchesUnlockedDiv.style.fontFamily = 'monospace';
    allPatchesUnlockedDiv.style.fontSize = '42px';
    allPatchesUnlockedDiv.style.fontWeight = 'bold';
    allPatchesUnlockedDiv.style.color = '#72dec2';
    allPatchesUnlockedDiv.style.textShadow = '0 0 12px rgba(0,0,0,0.7)';
    allPatchesUnlockedDiv.style.background = 'transparent';
    allPatchesUnlockedDiv.style.zIndex = '5';

    const allUnlockedLabel = document.createElement('div');
    allUnlockedLabel.textContent = 'ALL PATCHES UNLOCKED';
    allPatchesUnlockedDiv.appendChild(allUnlockedLabel);

    overlayDiv.appendChild(allPatchesUnlockedDiv);

    document.body.appendChild(overlayDiv);

    updateModeVisual();

    updatePlayerDirectionVisual();
    initPatchMarkersDom();

    log('Overlay DOM created.');

  }

  function anySectorTracking() {
    // In dungeon layout, we use room-based alerts instead of quadrants.
    if (isDungeonLayout()) {
      for (const key in roomAlerts) {
        const ra = roomAlerts[key];
        if (ra && ra.state === 'tracking') {
          return true;
        }
      }
      return false;
    }

    // Arena layout: keep the old sector logic.
    return (
      sectorAlerts.NW.state === 'tracking' ||
      sectorAlerts.NE.state === 'tracking' ||
      sectorAlerts.SW.state === 'tracking' ||
      sectorAlerts.SE.state === 'tracking'
    );
  }

  function getSelectedEquipmentId() {
    const eq = EQUIPMENT_ITEMS[selectedEquipmentIndex];
    return eq ? eq.id : 'bait';
  }

  function getSelectedEquipment() {
    return EQUIPMENT_ITEMS[selectedEquipmentIndex] || EQUIPMENT_ITEMS[0];
  }

  function cycleSelectedEquipment() {
    selectedEquipmentIndex =
      (selectedEquipmentIndex + 1) % Math.max(1, EQUIPMENT_ITEMS.length);
    updateModeVisual();
  }

  function renderEquipmentHudLine() {
    const selectedId = getSelectedEquipmentId();
    const parts = EQUIPMENT_ITEMS.map((item) => {
      const isSelected = item.id === selectedId;
      const styles = [];

      if (isSelected) {
        styles.push('font-weight: bold');
        if (item.id === 'bait') {
          styles.push('color: yellow');
        } else if (item.id === 'shield') {
          styles.push('color: #ff00ff');
        } else if (item.id === 'rifle') {
          styles.push('color: #00d8ff');
        } else if (item.id === 'grenade') {
          styles.push('color: #ff5533');
        }
      }

      if (item.id === 'bait') {
        const available = playerBaits > 0;
        styles.push('opacity: ' + (available ? '1' : '0.35'));
        const styleAttr = styles.length ? ` style="${styles.join(';')}"` : '';
        return `<span${styleAttr}>${item.label} ${playerBaits}/${PLAYER_BAIT_MAX}</span>`;
      } else if (item.id === 'shield') {
        const available = playerShields > 0;
        styles.push('opacity: ' + (available ? '1' : '0.35'));
        const styleAttr = styles.length ? ` style="${styles.join(';')}"` : '';
        return `<span${styleAttr}>${item.label} ${playerShields}/${SHIELD_MAX}</span>`;
      } else if (item.id === 'rifle') {
        const available = playerRifles > 0;
        styles.push('opacity: ' + (available ? '1' : '0.35'));
        const styleAttr = styles.length ? ` style="${styles.join(';')}"` : '';
        return `<span${styleAttr}>${item.label} ${playerRifles}/${PLAYER_RIFLE_MAX}</span>`;
      } else if (item.id === 'grenade') {
        const available = playerGrenades > 0;
        styles.push('opacity: ' + (available ? '1' : '0.35'));
        const styleAttr = styles.length ? ` style="${styles.join(';')}"` : '';
        return `<span${styleAttr}>${item.label} ${playerGrenades}/${PLAYER_GRENADE_MAX}</span>`;
      }

      const styleAttr = styles.length ? ` style="${styles.join(';')}"` : '';
      return `<span${styleAttr}>${item.label}</span>`;
    });

    return `<div>${parts.join('&nbsp;&nbsp;')}</div>`;
  }

  function updateModeVisual() {
    if (!overlayDiv) return;
    const hud = document.getElementById('orca-stealth-hud');
    updatePlayerSpriteFill();
    if (shieldActive) {
      setPlayerColor('#ff00ff');
    } else if (shieldBlinkTicks <= 0) {
      setPlayerColor('yellow');
    }

    // GAME OVER overrides normal Edit/Game visuals
    if (isGameOver) {
      overlayDiv.style.background = 'rgba(0, 0, 0, 0.85)';

      if (hud) {
        const line =
          'GAME OVER  HP ' +
          playerHP +
          '/' +
          playerHPMax +
          '  AMMO ' +
          playerAmmo +
          '/' +
          playerAmmoMax +
          '  (F1: back to EDIT / tweak ORCA)';
        hud.innerHTML = `<div>${line}</div>${renderEquipmentHudLine()}`;
        hud.style.color = '#ff4444';
      }

      if (gameOverDiv) {
        gameOverDiv.style.display = 'flex';
      }

      // Clear local alert areas when game is over
      clearAlertAreas();

      // Re-position HUD after any change
      updateHudLayout();
      return;
    }


    // Hide GAME OVER overlay in normal play/edit
    if (gameOverDiv) {
      gameOverDiv.style.display = 'none';
    }

    const inAlert = (globalAlertLevel > 0) || anySectorTracking();

    if (mode === 'edit') {
      overlayDiv.style.background = 'rgba(0, 128, 128, 0.03)';
      if (hud) {
        const line =
          '[MODE: EDIT] HP ' +
          playerHP +
          '/' +
          playerHPMax +
          '  AMMO ' +
          playerAmmo +
          '/' +
          playerAmmoMax +
          '  (F1: play, GAME: Arrows move, S: shoot, F: cycle equip, D: use equip)';
        hud.innerHTML = `<div>${line}</div>${renderEquipmentHudLine()}`;
        hud.style.color = '#ffffff';
      }
    } else {

      const alertText = inAlert ? 'ALERT' : 'STEALTH';

      // Base background stays neutral; red tint is now drawn per room/sector
      overlayDiv.style.background = 'rgba(0, 128, 128, 0.10)';

      if (hud) {
        const line =
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
          ']  (F1: toggle, Arrows: move, S: shoot, F: cycle equip, D: use equip, Space: Orca clock)';
        hud.innerHTML = `<div>${line}</div>${renderEquipmentHudLine()}`;
        hud.style.color = '#ffffff';
      }

    }

    // Re-position HUD after any change
    updateHudLayout();

    // Re-render alert areas for current alert state
    renderAlertAreas();

    // Keep final overlay visible if all patches unlocked
    if (allPatchesUnlockedDiv) {
      allPatchesUnlockedDiv.style.display = allPatchesUnlocked ? 'flex' : 'none';
    }
  }

  function clearAlertAreas() {
    if (!alertAreasContainer) return;
    while (alertAreasContainer.firstChild) {
      alertAreasContainer.removeChild(alertAreasContainer.firstChild);
    }
  }

  function createAlertAreaRect(minCol, maxCol, minRow, maxRow) {
    if (!alertAreasContainer) return;
    if (cellW <= 0 || cellH <= 0) return;

    const div = document.createElement('div');
    div.style.position = 'absolute';
    div.style.left = (minCol * cellW) + 'px';
    div.style.top = (minRow * cellH) + 'px';
    div.style.width = ((maxCol - minCol + 1) * cellW) + 'px';
    div.style.height = ((maxRow - minRow + 1) * cellH) + 'px';
    // Same tint as previous full-grid alert background
    div.style.background = 'rgba(255, 64, 64, 0.14)';
    div.style.pointerEvents = 'none';

    alertAreasContainer.appendChild(div);
  }

  // Draw red tinted overlay only on alert rooms/sectors
  function renderAlertAreas() {
    if (!alertAreasContainer) return;

    clearAlertAreas();

    if (mode !== 'game') return;
    if (cellW <= 0 || cellH <= 0) return;

    const layoutType = getLayoutType();

    if (layoutType === 'dungeon') {
      // Rooms: keys "minCol,maxCol,minRow,maxRow"
      for (const key in roomAlerts) {
        const ra = roomAlerts[key];
        if (!ra || ra.state !== 'tracking') continue;

        const parts = key.split(',');
        if (parts.length !== 4) continue;

        const minCol = parseInt(parts[0], 10);
        const maxCol = parseInt(parts[1], 10);
        const minRow = parseInt(parts[2], 10);
        const maxRow = parseInt(parts[3], 10);

        if (!isFinite(minCol) || !isFinite(maxCol) ||
            !isFinite(minRow) || !isFinite(maxRow)) {
          continue;
        }

        createAlertAreaRect(minCol, maxCol, minRow, maxRow);
      }
    } else {
      // Arena: static quadrants based on midCol/midRow
      const sectorRects = {
        NW: { minCol: 0,       maxCol: midCol - 1,    minRow: 0,        maxRow: midRow - 1 },
        NE: { minCol: midCol,  maxCol: gridCols - 1,  minRow: 0,        maxRow: midRow - 1 },
        SW: { minCol: 0,       maxCol: midCol - 1,    minRow: midRow,   maxRow: gridRows - 1 },
        SE: { minCol: midCol,  maxCol: gridCols - 1,  minRow: midRow,   maxRow: gridRows - 1 }
      };

      ['NW', 'NE', 'SW', 'SE'].forEach((name) => {
        const sa = sectorAlerts[name];
        if (!sa || sa.state !== 'tracking') return;

        const rect = sectorRects[name];
        if (!rect) return;

        createAlertAreaRect(rect.minCol, rect.maxCol, rect.minRow, rect.maxRow);
      });
    }
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
      gEl.style.zIndex = '1'; // keep guards/corpses above pressure tiles
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
        seenBait: false,
        wasSeeingBait: false,
        seenBaitId: null,


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

        // Patrol behaviour (direction and extra patterns)
        // true  = patrol rectangle clockwise
        // false = patrol rectangle counterclockwise
        patrolClockwise:
          (typeof cfg.patrolClockwise === 'boolean')
            ? cfg.patrolClockwise
            : (Math.random() < 0.5),
        lastPatrolTick: -1,

        // Observing behaviour (guard stops and rotates on the spot)
        observingTicksLeft: 0,
        ticksSinceLastObserve: 0,
        lastObserveCol: null,
        lastObserveRow: null,

        // Rectangle deviation behaviour (short excursion inside the same room)
        deviationActive: false,
        deviationPhase: null,          // "out" | "return"
        deviationOutStepsLeft: 0,
        deviationBackStepsLeft: 0,
        ticksSinceLastDeviation: 0,
        lastDeviationCol: null,
        lastDeviationRow: null,

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
    let walkable = (g === '.');

    // NEW: celle con destroy-target vivo NON sono walkable
    if (walkable && findDestroyTargetAtCell(col, row)) {
      walkable = false;
    }

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
    ensurePickupsOnWalkableCells();

    updatePlayerPosition();
    updatePlayerDirectionVisual();
    guards.forEach(updateGuardPosition);
    updateAllBulletsPosition();
    updateAllPickupsPosition();
    updateAllBaitsPosition();
    updatePatchMarkersPosition();
    updateAllDestroyTargetsPosition();
    updateAllPressureTilesPosition();
    ensurePressureTilesValid();

    // only FOV, no alert memory
    updateAllFovAndAlert(false);

    // Redraw local alert areas with new geometry
    renderAlertAreas();

    // Re-position HUD according to new canvas size / grid
    updateHudLayout();


    // Spawn adjustment: run once per levelConfig (reset in applyExternalLevelConfig)
    if (!guardSpawnsInitialized) {
      adjustGuardSpawnsByLayout();
      guardSpawnsInitialized = true;
    }

    // NEW: dopo che le guardie hanno la posizione definitiva, assegna i key carrier
    assignKeyCarriersIfNeeded();

    // Initial random pickups: run once per levelConfig / overlay
    if (!pickupsInitialized) {
      spawnInitialPickupsRandom();
    }

    if (allPatchesUnlockedDiv) {
      allPatchesUnlockedDiv.style.display = allPatchesUnlocked ? 'flex' : 'none';
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

  function updatePlayerBlink() {
    if (!playerInner) return;

    if (playerHitCooldown > 0) {
      // Toggle visibility each tick to create a blink effect
      playerBlinkVisible = !playerBlinkVisible;
      playerInner.style.opacity = playerBlinkVisible ? '1.0' : '0.2';
    } else {
      // Ensure fully visible when not in invulnerability
      playerBlinkVisible = true;
      playerInner.style.opacity = '1.0';
    }
  }

  function updateShieldState() {
    if (shieldActive) {
      shieldTicks--;
      setPlayerColor('#ff00ff');
      if (shieldTicks <= 0) {
        shieldActive = false;
        shieldBlinkTicks = SHIELD_BLINK_TICKS;
      }
      return;
    }

    if (shieldBlinkTicks > 0) {
      shieldBlinkTicks--;
      const flashOn = (shieldBlinkTicks % 2 === 0);
      setPlayerColor(flashOn ? '#ff00ff' : 'yellow');
      if (shieldBlinkTicks <= 0) {
        setPlayerColor('yellow');
      }
      return;
    }

    // Default color when no shield effects
    setPlayerColor('yellow');
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

  // Find a *dead* guard at given cell (used for corpse-alert logic)
  function findDeadGuardAtCell(col, row) {
    for (let i = 0; i < guards.length; i++) {
      const g = guards[i];
      if (g.state !== 'dead') continue;
      if (g.col === col && g.row === row) {
        return g;
      }
    }
    return null;
  }

  // Find a stunned (but alive) guard at given cell
  function findStunnedGuardAtCell(col, row) {
    for (let i = 0; i < guards.length; i++) {
      const g = guards[i];
      if (g.state !== 'stunned') continue;
      if (g.col === col && g.row === row) {
        return g;
      }
    }
    return null;
  }

    // Returns the permanent speed multiplier for a guard based on
  // room (dungeon) or sector (arena) corpse-alert state.
  function getGuardSpeedMultiplier(guard) {
    const layoutType = getLayoutType();
    let mult = 1.0;

    if (layoutType === 'dungeon') {
      const key = getGuardRoomKey(guard);
      const ra = key ? roomAlerts[key] : null;
      if (ra && ra.state === 'tracking' && typeof ra.tempBoost === 'number') {
        mult *= ra.tempBoost;
      }
      if (ra && typeof ra.corpseBoost === 'number') {
        mult *= ra.corpseBoost;
      }
    } else {
      const s = getSector(guard.col, guard.row);
      const sa = sectorAlerts[s];
      if (sa && sa.state === 'tracking' && typeof sa.tempBoost === 'number') {
        mult *= sa.tempBoost;
      }
      if (sa && typeof sa.corpseBoost === 'number') {
        mult *= sa.corpseBoost;
      }
    }

    return mult;
  }

  // Returns how many grid steps this guard should perform in this world tick.
  // Callers should use this instead of the static PATROL/ALERT constants so
  // corpse-based speed boosts take effect.
  function getGuardStepsPerTick(guard) {
    const isAlert =
      guard.state === 'alert_chaser' ||
      guard.state === 'return_to_patrol';

    const baseSteps = isAlert ? ALERT_STEPS_PER_TICK : PATROL_STEPS_PER_TICK;
    const mult = getGuardSpeedMultiplier(guard);

    const steps = Math.max(1, Math.round(baseSteps * mult));
    return steps;
  }



  function findPickupAtCell(col, row) {
    for (let i = 0; i < pickups.length; i++) {
      const p = pickups[i];
      if (p.col === col && p.row === row && !p.collected) {
        return p;
      }
    }
    return null;
  }

  function findPlacedBaitAtCell(col, row) {
    for (let i = 0; i < baits.length; i++) {
      const b = baits[i];
      if (!b.alive) continue;
      if (b.col === col && b.row === row) {
        return b;
      }
    }
    return null;
  }

  function findAdjacentFreeCell(baseCol, baseRow) {
    const offsets = [
      { dx: 1, dy: 0 },
      { dx: -1, dy: 0 },
      { dx: 0, dy: 1 },
      { dx: 0, dy: -1 },
      { dx: 1, dy: 1 },
      { dx: 1, dy: -1 },
      { dx: -1, dy: 1 },
      { dx: -1, dy: -1 }
    ];
    // Shuffle offsets to randomize placement
    for (let i = offsets.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = offsets[i];
      offsets[i] = offsets[j];
      offsets[j] = tmp;
    }
    for (let i = 0; i < offsets.length; i++) {
      const col = baseCol + offsets[i].dx;
      const row = baseRow + offsets[i].dy;
      if (col < 0 || row < 0 || col >= gridCols || row >= gridRows) continue;
      if (isCellFreeForPickup(col, row)) {
        return { col, row };
      }
    }
    return null;
  }

  function getBaitById(id) {
    for (let i = 0; i < baits.length; i++) {
      if (baits[i].id === id) return baits[i];
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

  // Record every cell crossed in this world tick so we can animate
  // multi-step movement instead of "teleporting" several cells at once.
  function recordGuardStepForAnimation(guard) {
    if (!guard || guard.state === 'dead' || guard.renderTrailTick !== worldTick || !guard.renderTrail) {
      return;
    }

    const last = guard.renderTrail[guard.renderTrail.length - 1];
    if (last && last.col === guard.col && last.row === guard.row) {
      return;
    }

    guard.renderTrail.push({ col: guard.col, row: guard.row });
  }

  // Prepare per-guard render trails at the start of each world tick.
  function beginGuardStepAnimationRecording() {
    guards.forEach((g) => {
      if (!g || g.state === 'dead') {
        g.renderTrailTick = null;
        g.renderTrail = null;
        if (g.activeRenderAnimation && typeof g.activeRenderAnimation.cancel === 'function') {
          g.activeRenderAnimation.cancel();
          g.activeRenderAnimation = null;
        }
        return;
      }
      if (g.activeRenderAnimation && typeof g.activeRenderAnimation.cancel === 'function') {
        g.activeRenderAnimation.cancel();
        g.activeRenderAnimation = null;
      }
      g.renderTrailTick = worldTick;
      g.renderTrail = [{ col: g.col, row: g.row }];
    });
  }

  // After simulation for the tick is done, animate guards through each
  // visited cell so high speed looks like actual stepping, not a teleport.
  function flushGuardStepAnimations() {
    guards.forEach((guard) => {
      if (
        !guard ||
        guard.state === 'dead' ||
        guard.renderTrailTick !== worldTick ||
        !guard.renderTrail ||
        guard.renderTrail.length < 2 ||
        !guard.el
      ) {
        return;
      }

      const steps = guard.renderTrail.length - 1;
      const stepDuration =
        Math.max(GUARD_ANIM_MIN_STEP_MS, Math.floor(WORLD_TICK_MS / Math.max(steps, 1)));
      const duration = stepDuration * steps;

      const keyframes = guard.renderTrail.map((p) => ({
        transform: 'translate(' + (p.col * cellW) + 'px, ' + (p.row * cellH) + 'px)'
      }));

      if (guard.activeRenderAnimation && typeof guard.activeRenderAnimation.cancel === 'function') {
        guard.activeRenderAnimation.cancel();
      }

      // Keep size in sync with grid even while animating.
      guard.el.style.width = cellW + 'px';
      guard.el.style.height = cellH + 'px';

      // Force start of the trail, then animate through all waypoints.
      guard.el.style.transform = keyframes[0].transform;
      if (typeof guard.el.animate !== 'function') {
        // Fallback: snap to final position if WA API is unavailable.
        guard.el.style.transform = keyframes[keyframes.length - 1].transform;
        return;
      }

      const animation = guard.el.animate(keyframes, {
        duration,
        easing: 'linear',
        fill: 'forwards'
      });
      guard.activeRenderAnimation = animation;
    });
  }

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

    recordGuardStepForAnimation(guard);
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

  // --------------------------------------------------
  // Grenade logic (player throwable)
  // --------------------------------------------------

  function updateGrenadePosition(grenade) {
    if (!grenade.el) return;
    const bw = cellW * 0.35;
    const bh = cellH * 0.35;
    const x = grenade.col * cellW + (cellW - bw) / 2;
    const y = grenade.row * cellH + (cellH - bh) / 2;
    grenade.el.style.width = bw + 'px';
    grenade.el.style.height = bh + 'px';
    grenade.el.style.background = GRENADE_COLOR;
    grenade.el.style.transform = 'translate(' + x + 'px, ' + y + 'px)';
  }

  function launchGrenadeFromPlayer() {
    if (!bulletsContainer) return;

    let dx = 0;
    let dy = 0;
    if (playerDir === 'up') dy = -1;
    else if (playerDir === 'down') dy = 1;
    else if (playerDir === 'left') dx = -1;
    else if (playerDir === 'right') dx = 1;

    if (dx === 0 && dy === 0) return;

    const startCol = playerCol + dx;
    const startRow = playerRow + dy;
    if (
      startCol < 0 ||
      startRow < 0 ||
      startCol >= gridCols ||
      startRow >= gridRows
    ) {
      return;
    }

    const grenadeEl = document.createElement('div');
    grenadeEl.className = 'orca-stealth-grenade';
    grenadeEl.style.position = 'absolute';
    grenadeEl.style.borderRadius = '50%';
    grenadeEl.style.pointerEvents = 'none';
    bulletsContainer.appendChild(grenadeEl);

    const grenade = {
      col: startCol,
      row: startRow,
      dx,
      dy,
      el: grenadeEl,
      alive: true,
      rangeLeft: GRENADE_RANGE_CELLS,
      state: 'moving',
      fuseTicks: 0
    };
    grenades.push(grenade);
    updateGrenadePosition(grenade);

    playerGrenades--;
    if (playerGrenades < 0) playerGrenades = 0;
    updateModeVisual();
  }

  function applyGrenadeDamageAt(col, row) {
    // Damage guards (1 HP) in this cell
    for (let i = 0; i < guards.length; i++) {
      const g = guards[i];
      if (!g || g.state === 'dead') continue;
      if (g.col === col && g.row === row) {
        // Avoid multiple hits in the same world tick from the same/overlapping blast
        if (g.lastExplosionDamageTick === worldTick) continue;
        g.lastExplosionDamageTick = worldTick;
        triggerTemporaryAlertForGuard(g, 'hit', col, row);
        g.hp = Math.max(0, (g.hp || g.maxHP) - 1);
        if (g.hp <= 0) {
          killGuard(g);
        } else {
          updateGuardSpriteAppearance(g);
        }
      }
    }

    // Damage player if on this cell
    if (playerCol === col && playerRow === row) {
      if (playerLastExplosionDamageTick !== worldTick) {
        playerLastExplosionDamageTick = worldTick;
        applyPlayerHit({ id: 'grenade' });
      }
    }
  }

  function createGrenadeExplosionFx(cells) {
    if (!grenadeFxContainer) return;
    const elements = [];
    cells.forEach((cell) => {
      const fx = document.createElement('div');
      fx.style.position = 'absolute';
      fx.style.pointerEvents = 'none';
      const bw = cellW * 0.30;
      const bh = cellH * 0.30;
      const x = cell.col * cellW + (cellW - bw) / 2;
      const y = cell.row * cellH + (cellH - bh) / 2;
      fx.style.width = bw + 'px';
      fx.style.height = bh + 'px';
      fx.style.transform = 'translate(' + x + 'px, ' + y + 'px)';
      fx.style.background = GRENADE_COLOR;
      fx.style.borderRadius = '40%';
      fx.style.opacity = Math.random() > 0.5 ? '1' : '0.2';
      grenadeFxContainer.appendChild(fx);
      elements.push({
        el: fx,
        col: cell.col,
        row: cell.row
      });
    });
    grenadeExplosions.push({
      elements,
      ttl: GRENADE_BLINK_TICKS
    });
  }

  function triggerGrenadeExplosion(grenade, atCol, atRow) {
    if (!grenade) return;
    grenade.alive = false;
    if (grenade.el && grenade.el.parentNode) {
      grenade.el.parentNode.removeChild(grenade.el);
    }

    const damageCells = [];
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const c = atCol + dx;
        const r = atRow + dy;
        if (c < 0 || r < 0 || c >= gridCols || r >= gridRows) continue;
        if (!isWalkable(c, r)) continue;
        damageCells.push({ col: c, row: r });
      }
    }

    damageCells.forEach((cell) => applyGrenadeDamageAt(cell.col, cell.row));
    createGrenadeExplosionFx(damageCells);
  }

  function stepGrenades() {
    if (!grenades || grenades.length === 0) return;

    const survivors = [];
    for (let i = 0; i < grenades.length; i++) {
      const g = grenades[i];
      if (!g || !g.alive) continue;

      // Waiting fuse (stopped)
      if (g.state === 'fuse') {
        g.fuseTicks--;
        if (g.fuseTicks <= 0) {
          triggerGrenadeExplosion(g, g.col, g.row);
          continue;
        }
        updateGrenadePosition(g);
        survivors.push(g);
        continue;
      }

      let alive = true;
      for (let step = 0; step < GRENADE_STEPS_PER_TICK && alive; step++) {
        if (g.rangeLeft <= 0) {
          g.state = 'fuse';
          g.fuseTicks = GRENADE_FUSE_TICKS;
          updateGrenadePosition(g);
          survivors.push(g);
          alive = false;
          break;
        }

        const nextCol = g.col + g.dx;
        const nextRow = g.row + g.dy;

        // Out of bounds -> explode in current cell
        if (nextCol < 0 || nextRow < 0 || nextCol >= gridCols || nextRow >= gridRows) {
          triggerGrenadeExplosion(g, g.col, g.row);
          alive = false;
          break;
        }

        // If hitting a guard or wall -> explode at next cell
        const hitGuard = findGuardAtCell(nextCol, nextRow);
        if (hitGuard && hitGuard.state !== 'dead') {
          g.col = nextCol;
          g.row = nextRow;
          triggerGrenadeExplosion(g, g.col, g.row);
          alive = false;
          break;
        }
        if (!isWalkable(nextCol, nextRow)) {
          g.col = nextCol;
          g.row = nextRow;
          triggerGrenadeExplosion(g, g.col, g.row);
          alive = false;
          break;
        }

        // Move forward
        g.col = nextCol;
        g.row = nextRow;
        g.rangeLeft--;

        // If max distance reached after moving, stop and arm fuse
        if (g.rangeLeft <= 0) {
          g.state = 'fuse';
          g.fuseTicks = GRENADE_FUSE_TICKS;
          updateGrenadePosition(g);
          survivors.push(g);
          alive = false;
          break;
        }
      }

      if (alive && g.state !== 'fuse') {
        updateGrenadePosition(g);
        survivors.push(g);
      }
    }

    grenades = survivors;
  }

  function updateGrenadeExplosions() {
    if (!grenadeExplosions || grenadeExplosions.length === 0) return;
    const survivors = [];
    grenadeExplosions.forEach((fx) => {
      fx.ttl--;
      if (fx.ttl <= 0) {
        fx.elements.forEach((el) => {
          if (el && el.el && el.el.parentNode) el.el.parentNode.removeChild(el.el);
        });
        return;
      }
      fx.elements.forEach((item) => {
        if (!item || !item.el) return;
        const opacity = Math.random() > 0.5 ? '1' : '0.1';
        item.el.style.opacity = opacity;
        // Damage guards currently on this explosion cell (once per tick)
        const hitGuard = findGuardAtCell(item.col, item.row);
        if (hitGuard && hitGuard.state !== 'dead') {
          applyGrenadeDamageAt(item.col, item.row);
        }
      });
      survivors.push(fx);
    });
    grenadeExplosions = survivors;
  }

  function clearGrenadesAndFx() {
    if (grenades && grenades.length) {
      grenades.forEach((g) => {
        if (g && g.el && g.el.parentNode) {
          g.el.parentNode.removeChild(g.el);
        }
      });
    }
    grenades = [];
    if (grenadeExplosions && grenadeExplosions.length) {
      grenadeExplosions.forEach((fx) => {
        if (fx && Array.isArray(fx.elements)) {
          fx.elements.forEach((el) => {
            if (el && el.parentNode) el.parentNode.removeChild(el);
          });
        }
      });
    }
    grenadeExplosions = [];
    if (grenadeFxContainer) {
      while (grenadeFxContainer.firstChild) {
        grenadeFxContainer.removeChild(grenadeFxContainer.firstChild);
      }
    }
  }


  function updatePickupPosition(pickup) {
    if (!pickup.el) return;
    const x = pickup.col * cellW;
    const y = pickup.row * cellH;
    pickup.el.style.width = cellW + 'px';
    pickup.el.style.height = cellH + 'px';
    pickup.el.style.transform = 'translate(' + x + 'px, ' + y + 'px)';
  }

  function updateAllPickupsPosition() {
    pickups.forEach(updatePickupPosition);
  }
  
  function updateBaitPosition(bait) {
    if (!bait.el) return;
    const x = bait.col * cellW;
    const y = bait.row * cellH;
    bait.el.style.width = cellW + 'px';
    bait.el.style.height = cellH + 'px';
    bait.el.style.transform = 'translate(' + x + 'px, ' + y + 'px)';
  }

  function updateAllBaitsPosition() {
    baits.forEach(updateBaitPosition);
  }


  // Create a pickup DOM element at (col,row)
  function createPickup(type, col, row, extra) {
    if (!pickupsContainer) return null;

    const cell = document.createElement('div');
    cell.className = 'orca-stealth-pickup';
    cell.style.position = 'absolute';
    cell.style.pointerEvents = 'none';

    // Inner element for shape
    const inner = document.createElement('div');
    inner.style.position = 'absolute';
    inner.style.left = '25%';
    inner.style.top = '25%';
    inner.style.width = '30%';
    inner.style.height = '30%';
    inner.style.pointerEvents = 'none';

    if (type === 'ammo') {
      // Yellow bullet-like dot
      inner.style.borderRadius = '50%';
      inner.style.background = '#ffcc00';
    } else if (type === 'medikit') {
      // Green cross made of two bars
      inner.style.background = 'transparent';

      const barV = document.createElement('div');
      barV.style.position = 'absolute';
      barV.style.left = '50%';
      barV.style.top = '50%';
      barV.style.width = '35%';
      barV.style.height = '100%';
      barV.style.transform = 'translate(-50%, -50%)';
      barV.style.background = '#00ff55';

      const barH = document.createElement('div');
      barH.style.position = 'absolute';
      barH.style.left = '50%';
      barH.style.top = '50%';
      barH.style.width = '100%';
      barH.style.height = '35%';
      barH.style.transform = 'translate(-50%, -50%)';
      barH.style.background = '#00ff55';

      inner.appendChild(barV);
      inner.appendChild(barH);
    } else if (type === 'bait') {
      // Equilateral yellow triangle (pickup version)
      inner.style.left = '50%';
      inner.style.top = '50%';
      inner.style.width = '70%';
    inner.style.height = '70%';
    inner.style.transform = 'translate(-50%, -50%)';
    inner.style.background = 'yellow';
    // Upright equilateral triangle (apex up, base down)
    inner.style.clipPath = 'polygon(50% 6%, 8% 94%, 92% 94%)';
    } else if (type === 'shield') {
      // Small fuchsia diamond
      inner.style.left = '50%';
      inner.style.top = '50%';
      inner.style.width = '60%';
      inner.style.height = '60%';
      inner.style.transform = 'translate(-50%, -50%)';
      inner.style.background = '#ff00ff';
      inner.style.clipPath = 'polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%)';
    } else if (type === 'grenade') {
      // Small orange square
      inner.style.left = '50%';
      inner.style.top = '50%';
      inner.style.width = '50%';
      inner.style.height = '50%';
      inner.style.transform = 'translate(-50%, -50%)';
      inner.style.background = '#ff5533';
    } else if (type === 'key') {
      // NEW: blinking white "K" (no background)
      inner.style.left = '50%';
      inner.style.top = '50%';
      inner.style.width = '70%';
      inner.style.height = '70%';
      inner.style.transform = 'translate(-50%, -50%)';
      inner.style.background = 'transparent';

      const label = document.createElement('div');
      label.textContent = 'K';
      label.style.position = 'absolute';
      label.style.left = '50%';
      label.style.top = '50%';
      label.style.transform = 'translate(-50%, -50%)';
      label.style.fontFamily = 'monospace';
      label.style.fontSize = '80%';
      label.style.fontWeight = 'bold';
      label.style.color = '#ffffff';

      inner.appendChild(label);
    } else if (type === 'rifle') {
      // Hollow electric-blue circle with inner cross
      inner.style.left = '50%';
      inner.style.top = '50%';
      inner.style.width = '50%';
      inner.style.height = '50%';
      inner.style.transform = 'translate(-50%, -50%)';
      inner.style.borderRadius = '50%';
      inner.style.border = '2px solid #00d8ff';
      inner.style.background = 'transparent';

      const crossH = document.createElement('div');
      crossH.style.position = 'absolute';
      crossH.style.left = '0';
      crossH.style.top = '50%';
      crossH.style.width = '100%';
      crossH.style.height = '18%';
      crossH.style.transform = 'translateY(-50%)';
      crossH.style.background = '#00d8ff';

      const crossV = document.createElement('div');
      crossV.style.position = 'absolute';
      crossV.style.left = '50%';
      crossV.style.top = '0';
      crossV.style.width = '18%';
      crossV.style.height = '100%';
      crossV.style.transform = 'translateX(-50%)';
      crossV.style.background = '#00d8ff';

      inner.appendChild(crossH);
      inner.appendChild(crossV);
    }

    cell.appendChild(inner);
    pickupsContainer.appendChild(cell);

    // Async blinking for this pickup instance
    applyPickupBlink(cell);

    const pickup = {
      type,
      col,
      row,
      el: cell,
      inner,
      collected: false,
      keyTriggerIndex:
        extra && typeof extra.keyTriggerIndex === 'number'
          ? extra.keyTriggerIndex
          : null
    };

    pickups.push(pickup);
    updatePickupPosition(pickup);

    return pickup;
  }


    // Remove all existing pickups from DOM and array
  function clearAllPickups() {
    if (pickupsContainer) {
      while (pickupsContainer.firstChild) {
        pickupsContainer.removeChild(pickupsContainer.firstChild);
      }
    }
    pickups = [];
  }

    function clearAllBaits() {
    if (baitsContainer) {
      while (baitsContainer.firstChild) {
        baitsContainer.removeChild(baitsContainer.firstChild);
      }
    }
    baits = [];
  }

  // Force pickups to spawn only on walkable cells; if needed, snap to nearest walkable.
  function ensurePickupsOnWalkableCells() {
    pickups.forEach((p) => {
      if (p.col == null || p.row == null) return;

      if (isWalkable(p.col, p.row)) {
        // Already good
        updatePickupPosition(p);
        return;
      }

      const res = findNearestWalkableCell(p.col, p.row);
      if (res) {
        p.col = res.col;
        p.row = res.row;
        updatePickupPosition(p);
      } else {
        // No valid cell found: remove pickup from the map
        p.collected = true;
        if (p.el && p.el.parentNode) {
          p.el.parentNode.removeChild(p.el);
        }
      }
    });
  }

  // Spawn pickups from data-driven levelConfig.pickups
  function spawnPickupsFromConfig() {
    clearAllPickups();

    const defs = (levelConfig && Array.isArray(levelConfig.pickups))
      ? levelConfig.pickups
      : [];

    defs.forEach((def) => {
      if (!def) return;

      let type = 'ammo';
      if (def.type === 'medikit') type = 'medikit';
      else if (def.type === 'ammo') type = 'ammo';
      else if (def.type === 'bait') type = 'bait';
      else if (def.type === 'rifle') type = 'rifle';
      else if (def.type === 'shield') type = 'shield';
      else if (def.type === 'grenade') type = 'grenade';

      let col = typeof def.col === 'number' ? def.col : null;
      let row = typeof def.row === 'number' ? def.row : null;
      if (col == null || row == null) return;

      // If the cell is not walkable (e.g. wall or Orca code),
      // snap to nearest walkable cell.
      if (!isWalkable(col, row)) {
        const res = findNearestWalkableCell(col, row);
        if (!res) {
          return; // give up on this pickup
        }
        col = res.col;
        row = res.row;
      }

      createPickup(type, col, row);
    });

    // Extra safety
    ensurePickupsOnWalkableCells();
  }

  function isCellFreeForPickup(col, row) {
    // Must be walkable
    if (!isWalkable(col, row)) return false;

    // Do not overlap player
    if (col === playerCol && row === playerRow) return false;

    // Do not overlap guards (any state)
    const g = findGuardAtCell(col, row);
    if (g) return false;

    // Do not overlap another pickup
    if (findPickupAtCell(col, row)) return false;

    // Do not overlap a placed bait
    if (findPlacedBaitAtCell(col, row)) return false;

    return true;
  }


  function spawnInitialPickupsRandom() {
    if (pickupsInitialized) return;
    pickupsInitialized = true;

    if (!pickupsContainer) return;

    // Helper: place N pickups of given type
    function placePickups(type, count) {
      const maxAttempts = 2000;
      let placed = 0;
      let attempts = 0;

      while (placed < count && attempts < maxAttempts) {
        attempts++;
        const col = Math.floor(Math.random() * gridCols);
        const row = Math.floor(Math.random() * gridRows);

        if (!isCellFreeForPickup(col, row)) continue;

        createPickup(type, col, row);
        placed++;
      }

      if (placed < count) {
        console.log(
          '[overlay] Only placed',
          placed,
          'of',
          count,
          'pickups for type',
          type
        );
      }
    }

    placePickups('medikit', INITIAL_MEDIKIT_PICKUPS);
    placePickups('ammo', INITIAL_AMMO_PICKUPS);
    placePickups('bait', INITIAL_BAIT_PICKUPS);
    placePickups('rifle', INITIAL_RIFLE_PICKUPS);
    placePickups('shield', INITIAL_SHIELD_PICKUPS);
    placePickups('grenade', INITIAL_GRENADE_PICKUPS);

    console.log(
      '[overlay] Initial pickups spawned:',
      INITIAL_MEDIKIT_PICKUPS,
      'medikits,',
      INITIAL_AMMO_PICKUPS,
      'ammo,',
      INITIAL_BAIT_PICKUPS,
      'bait,',
      INITIAL_RIFLE_PICKUPS,
      'rifle,',
      INITIAL_SHIELD_PICKUPS,
      'shield,',
      INITIAL_GRENADE_PICKUPS,
      'grenade.'
    );

  }

  function applyPickupBlink(el) {
    // Each pickup has its own phase so blinking is asynchronous
    const dur = PICKUP_BLINK_DURATION_SEC;
    el.style.animationDuration = dur + 's';
    el.style.animationDelay = (Math.random() * dur).toFixed(3) + 's';
  }

  function updatePickupsBlink() {
    pickupsBlinkTick++;
    // Toggle every few ticks (approx ~1s at 250ms)
    const phaseOn = (pickupsBlinkTick % 8) < 1;
    const opacity = phaseOn ? 1.0 : 0.35;

    pickups.forEach((p) => {
      if (!p.el || p.collected) return;
      p.el.style.opacity = opacity;
    });
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

    // Cannot shoot directly into non-walkable cell,
    // EXCEPT if it's a destroy-target cell (we want to hit it).
    if (!isWalkable(startCol, startRow) && !findDestroyTargetAtCell(startCol, startRow)) {
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

    function processCollision(bullet, col, row) {
      // Out of bounds
      if (col < 0 || row < 0 || col >= gridCols || row >= gridRows) {
        return false;
      }

      // Bait hit
      const hitBait = findPlacedBaitAtCell(col, row);
      if (hitBait) {
        applyBaitHit(hitBait);
        return false;
      }

      // Destroy-target (player bullets only)
      if (bullet.ownerType === 'player') {
        const hitTarget = findDestroyTargetAtCell(col, row);
        if (hitTarget) {
          applyDestroyTargetHit(hitTarget);
          return false;
        }
      }

      // Player hit (guard bullet)
      if (bullet.ownerType === 'guard' && col === playerCol && row === playerRow) {
        applyPlayerHit({ id: 'bullet:' + (bullet.fromGuardId || 'guard') });
        return false;
      }

      // Guard hit (player bullet)
      if (bullet.ownerType === 'player') {
        const hitGuard = findGuardAtCell(col, row);
        if (hitGuard) {
          applyGuardHit(hitGuard, bullet);
          return false;
        }
      }

      // Wall / Orca code
      if (!isWalkable(col, row)) {
        return false;
      }

      return true;
    }

    for (let i = 0; i < bullets.length; i++) {
      const b = bullets[i];
      if (!b.alive || !b.el) {
        if (b.el && b.el.parentNode) {
          b.el.parentNode.removeChild(b.el);
        }
        continue;
      }

      let alive = true;

      // Process collision on current cell (important when spawning adjacent)
      if (!processCollision(b, b.col, b.row)) {
        if (b.el.parentNode) {
          b.el.parentNode.removeChild(b.el);
        }
        alive = false;
      }

      // Each bullet can advance up to BULLET_STEPS_PER_TICK cells per world tick
      for (let step = 0; step < BULLET_STEPS_PER_TICK && alive; step++) {
        const nextCol = b.col + b.dx;
        const nextRow = b.row + b.dy;

        if (!processCollision(b, nextCol, nextRow)) {
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
// Baits (placed decoys)
// --------------------------------------------------

function createPlacedBait(col, row) {
  if (!baitsContainer) return null;

  const cell = document.createElement('div');
  cell.style.position = 'absolute';
  cell.style.pointerEvents = 'none';

  // INNER: solid equilateral triangle that spins clockwise
  const inner = document.createElement('div');
  inner.className = 'orca-stealth-bait-spin';
  inner.style.position = 'absolute';
  inner.style.left = '50%';
  inner.style.top = '50%';

  // Inner triangle clearly smaller than the cell
  inner.style.width = '55%';
  inner.style.height = '55%';
  inner.style.transform = 'translate(-50%, -50%)';
  inner.style.transformOrigin = '50% 50%';
  inner.style.background = 'yellow';

  // Upright equilateral triangle (approx. 60° angles)
  inner.style.clipPath = 'polygon(50% 21%, 10% 90%, 90% 90%)';


  // AURA: true triangular outline using inline SVG
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const aura = document.createElementNS(SVG_NS, 'svg');
  aura.setAttribute('class', 'orca-stealth-bait-aura');
  aura.setAttribute('viewBox', '0 0 100 100');

  aura.style.position = 'absolute';
  aura.style.left = '50%';
  aura.style.top = '50%';

  // Bigger than the cell so it clearly invades neighbouring cells
  aura.style.width = '190%';
  aura.style.height = '190%';
  aura.style.transform = 'translate(-50%, -50%)';
  aura.style.transformOrigin = '50% 50%';
  aura.style.pointerEvents = 'none';

  // Polygon: perfect triangle, stroke only, no fill
  const poly = document.createElementNS(SVG_NS, 'polygon');
  poly.setAttribute('points', '50,5 5,95 95,95');
  poly.setAttribute('fill', 'none');
  poly.setAttribute('stroke', 'yellow');
  poly.setAttribute('stroke-width', '3');

  aura.appendChild(poly);

  // Start invisible if you fade it in via CSS animation
  aura.style.opacity = '0.0';

  // Draw order: aura behind, solid bait on top
  cell.appendChild(aura);
  cell.appendChild(inner);
  baitsContainer.appendChild(cell);

  const bait = {
    id: nextBaitId++,
    col,
    row,
    hp: BAIT_MAX_HP,
    alive: true,
    el: cell,
    inner,
    aura
  };

  baits.push(bait);
  updateBaitPosition(bait);

  console.log('[overlay] BAIT placed at', col, row, 'id=', bait.id);

  return bait;
}


  function killBait(bait) {
    if (!bait || !bait.alive) return;
    bait.alive = false;
    if (bait.el && bait.el.parentNode) {
      bait.el.parentNode.removeChild(bait.el);
    }
    console.log('[overlay] BAIT destroyed at', bait.col, bait.row, 'id=', bait.id);
    clearBaitAlertsForBait(bait.id);
  }

  function applyBaitHit(bait) {
    if (!bait || !bait.alive) return;
    bait.hp--;
    if (bait.hp <= 0) {
      killBait(bait);
    } else {
      if (bait.el) {
        bait.el.style.opacity = '0.4';
        setTimeout(() => {
          if (bait.alive && bait.el) {
            bait.el.style.opacity = '1.0';
          }
        }, 120);
      }
    }
  }

  function clearBaitAlertsForBait(baitId) {
    // Arena: sector-based alerts
    ['NW', 'NE', 'SW', 'SE'].forEach((name) => {
      const sa = sectorAlerts[name];
      if (!sa) return;
      if (sa.source === 'bait' && sa.sourceBaitId === baitId) {
        sa.state = 'idle';
        sa.targetCol = null;
        sa.targetRow = null;
        sa.timer = 0;
        sa.seeingNow = false;
        sa.source = null;
        sa.sourceBaitId = null;
        sa.tempBoost = 1.0;
      }
    });

    // Dungeon: room-based alerts
    for (const key in roomAlerts) {
      const ra = roomAlerts[key];
      if (!ra) continue;
      if (ra.source === 'bait' && ra.sourceBaitId === baitId) {
        ra.state = 'idle';
        ra.targetCol = null;
        ra.targetRow = null;
        ra.timer = 0;
        ra.seeingNow = false;
        ra.source = null;
        ra.sourceBaitId = null;
      }
    }

    // Any guard still in alert with no active tracking goes back to patrol/return
    guards.forEach((g) => {
      if (g.state !== 'alert_chaser') return;

      const layoutType = getLayoutType();
      if (layoutType === 'dungeon') {
        const key = getGuardRoomKey(g);
        const ra = roomAlerts[key];
        if (!ra || ra.state !== 'tracking') {
          g.state = 'return_to_patrol';
          g.path = null;
          g.pathTargetCol = null;
          g.pathTargetRow = null;
        }
      } else {
        const s = getSector(g.col, g.row);
        const sa = sectorAlerts[s];
        if (!sa || sa.state !== 'tracking') {
          g.state = 'return_to_patrol';
          g.path = null;
          g.pathTargetCol = null;
          g.pathTargetRow = null;
        }
      }
    });

    updateModeVisual();
  }



  // --------------------------------------------------
  // Patch liberation markers + ORCA injection
  // --------------------------------------------------
  // NEW: create a "destroy the target" object for a trigger
  function createDestroyTargetForTrigger(triggerIndex, col, row, maxHP) {
    if (!patchMarkersContainer) return null;

    const cell = document.createElement('div');
    cell.className = 'orca-stealth-destroy-target';
    cell.style.position = 'absolute';
    cell.style.boxSizing = 'border-box';
    cell.style.zIndex = '2'; // keep destroy-target marker above guards/pressure tiles
    cell.style.pointerEvents = 'none';

    // Outer circle
    const outer = document.createElement('div');
    outer.style.position = 'absolute';
    outer.style.left = '50%';
    outer.style.top = '50%';
    outer.style.width = '72%';
    outer.style.height = '72%';
    outer.style.transform = 'translate(-50%, -50%)';
    outer.style.borderRadius = '50%';
    outer.style.border = '2px solid #ffffff';
    outer.style.boxSizing = 'border-box';

    // Inner circle
    const inner = document.createElement('div');
    inner.style.position = 'absolute';
    inner.style.left = '50%';
    inner.style.top = '50%';
    inner.style.width = '46%';
    inner.style.height = '46%';
    inner.style.transform = 'translate(-50%, -50%)';
    inner.style.borderRadius = '50%';
    inner.style.border = '2px solid #ffffff';
    inner.style.boxSizing = 'border-box';

    // Central dot
    const dot = document.createElement('div');
    dot.style.position = 'absolute';
    dot.style.left = '50%';
    dot.style.top = '50%';
    dot.style.width = '18%';
    dot.style.height = '18%';
    dot.style.transform = 'translate(-50%, -50%)';
    dot.style.borderRadius = '50%';
    dot.style.background = '#ffffff';

    inner.appendChild(dot);
    outer.appendChild(inner);
    cell.appendChild(outer);
    patchMarkersContainer.appendChild(cell);

    const target = {
      triggerIndex,
      col,
      row,
      hp: maxHP,
      maxHP,
      el: cell,
      outer,
      inner,
      dot,
      alive: true
    };

    destroyTargets.push(target);

    const st = triggerRuntimeState[triggerIndex];
    if (st) {
      st.destroyTarget = target;
    }

    updateDestroyTargetPosition(target);

    console.log(
      '[overlay] Destroy-target created for trigger',
      liberationTriggers[triggerIndex] &&
        (liberationTriggers[triggerIndex].id || triggerIndex),
      'at',
      col,
      row,
      'HP=',
      maxHP
    );

    return target;
  }

  function updateDestroyTargetPosition(target) {
    if (!target || !target.el) return;
    const x = target.col * cellW;
    const y = target.row * cellH;
    target.el.style.width = cellW + 'px';
    target.el.style.height = cellH + 'px';
    target.el.style.transform = 'translate(' + x + 'px, ' + y + 'px)';
  }

  function updateAllDestroyTargetsPosition() {
    destroyTargets.forEach(updateDestroyTargetPosition);
  }

  function findDestroyTargetAtCell(col, row) {
    for (let i = 0; i < destroyTargets.length; i++) {
      const t = destroyTargets[i];
      if (!t || !t.alive) continue;
      if (t.col === col && t.row === row) {
        return t;
      }
    }
    return null;
  }

  function applyDestroyTargetHit(target) {
    if (!target || !target.alive) return;

    target.hp--;

    // Small visual feedback on hit
    if (target.outer) {
      target.outer.style.borderColor = '#ffdd55';
      setTimeout(() => {
        if (!target.alive) return;
        target.outer.style.borderColor = '#ffffff';
      }, 120);
    }

    if (target.hp <= 0) {
      killDestroyTarget(target);
    }
  }

  function killDestroyTarget(target) {
    if (!target || !target.alive) return;
    target.alive = false;

    if (target.el && target.el.parentNode) {
      target.el.parentNode.removeChild(target.el);
    }

    console.log(
      '[overlay] Destroy-target destroyed for trigger index',
      target.triggerIndex
    );

    completeLiberationTrigger(target.triggerIndex);
  }

  // --------------------------------------------------
  // Pressure tiles (pressure_tiles ritual)
  // --------------------------------------------------

  function hasWalkableNeighbor(col, row) {
    const dirs = [
      { dx: 1, dy: 0 },
      { dx: -1, dy: 0 },
      { dx: 0, dy: 1 },
      { dx: 0, dy: -1 }
    ];

    for (let i = 0; i < dirs.length; i++) {
      const nx = col + dirs[i].dx;
      const ny = row + dirs[i].dy;
      if (nx < 0 || ny < 0 || nx >= gridCols || ny >= gridRows) continue;
      if (isWalkable(nx, ny)) {
        return true;
      }
    }
    return false;
  }

  function collectPressureTileCandidates(trigger) {
    if (!trigger || !trigger.targetBlock) return [];
    const rect = trigger.targetBlock;
    const candidates = [];

    // Try to read the block directly from Orca to inspect the real glyphs.
    let blockLines = null;
    try {
      const client = window.orcaClient;
      if (
        client &&
        client.orca &&
        typeof client.orca.getBlock === 'function'
      ) {
        const raw = client.orca.getBlock(rect.x, rect.y, rect.w, rect.h);
        if (typeof raw === 'string') {
          blockLines = raw.split(/\r?\n/);
        }
      }
    } catch (e) {
      // best-effort; fall back to glyphAt below
    }

    // Skip the perimeter of the patch (comment frame) and keep only clear floor cells '.'
    const minCol = rect.x + 1;
    const maxCol = rect.x + rect.w - 2;
    const minRow = rect.y + 1;
    const maxRow = rect.y + rect.h - 2;

    for (let row = minRow; row <= maxRow; row++) {
      const localY = row - rect.y;
      for (let col = minCol; col <= maxCol; col++) {
        const localX = col - rect.x;
        let glyph = getOrcaGlyph(col, row);

        if (blockLines && blockLines[localY]) {
          const line = blockLines[localY];
          if (localX >= 0 && localX < line.length) {
            glyph = line[localX];
          }
        }

        if (glyph !== '.') continue;
        if (!isWalkable(col, row)) continue;
        if (!hasWalkableNeighbor(col, row)) continue;
        candidates.push({ col, row });
      }
    }
    return candidates;
  }

  function createPressureTile(triggerIndex, col, row) {
    if (!patchMarkersContainer) return null;

    const cell = document.createElement('div');
    cell.className = 'orca-stealth-pressure';
    cell.style.position = 'absolute';
    cell.style.boxSizing = 'border-box';
    cell.style.background = '#000000';
    cell.style.zIndex = '0'; // keep below guards/corpses and markers
    cell.style.pointerEvents = 'none';

    const outer = document.createElement('div');
    outer.style.position = 'absolute';
    outer.style.left = '50%';
    outer.style.top = '50%';
    outer.style.width = '78%';
    outer.style.height = '78%';
    outer.style.transform = 'translate(-50%, -50%)';
    outer.style.border = '2px solid #ffffff';
    outer.style.boxSizing = 'border-box';

    const inner = document.createElement('div');
    inner.style.position = 'absolute';
    inner.style.left = '50%';
    inner.style.top = '50%';
    inner.style.width = '46%';
    inner.style.height = '46%';
    inner.style.transform = 'translate(-50%, -50%)';
    inner.style.border = '2px solid #ffffff';
    inner.style.boxSizing = 'border-box';

    outer.appendChild(inner);
    cell.appendChild(outer);
    patchMarkersContainer.appendChild(cell);

    const tile = {
      triggerIndex,
      col,
      row,
      el: cell,
      outer,
      inner,
      applied: false,
      holdTicks: 0
    };

    pressureTiles.push(tile);
    updatePressureTilePosition(tile);

    return tile;
  }

  function createPressureTilesForTrigger(triggerIndex, trigger) {
    const candidates = collectPressureTileCandidates(trigger);
    if (!candidates.length) {
      console.warn(
        '[overlay] pressure_tiles: no walkable cells inside patch for trigger',
        trigger && (trigger.id || triggerIndex)
      );
      return;
    }

    shuffleArray(candidates);

    const desiredCount = 2 + Math.floor(Math.random() * 2); // 2 or 3
    const count = Math.min(desiredCount, candidates.length);

    for (let i = 0; i < count; i++) {
      const c = candidates[i];
      createPressureTile(triggerIndex, c.col, c.row);
    }

    if (count < desiredCount) {
      console.warn(
        '[overlay] pressure_tiles: only',
        count,
        'tile(s) placed (requested',
        desiredCount,
        ') for trigger',
        trigger && (trigger.id || triggerIndex)
      );
    }
  }

  function updatePressureTilePosition(tile) {
    if (!tile || !tile.el) return;
    const x = tile.col * cellW;
    const y = tile.row * cellH;
    tile.el.style.width = cellW + 'px';
    tile.el.style.height = cellH + 'px';
    tile.el.style.transform = 'translate(' + x + 'px, ' + y + 'px)';
  }

  function updateAllPressureTilesPosition() {
    if (!pressureTiles || !pressureTiles.length) return;
    pressureTiles.forEach(updatePressureTilePosition);
  }

  function updatePressureTileVisual(tile) {
    if (!tile || !tile.outer || !tile.inner) return;
    if (tile.applied) {
      tile.outer.classList.add('orca-stealth-pressure-blink');
      tile.inner.classList.add('orca-stealth-pressure-blink');
    } else {
      tile.outer.classList.remove('orca-stealth-pressure-blink');
      tile.inner.classList.remove('orca-stealth-pressure-blink');
    }
  }

  function isPressureTileOccupied(tile) {
    if (!tile) return false;

    if (playerCol === tile.col && playerRow === tile.row) {
      return true;
    }

    // Guard alive on tile
    const guardHere = guards.some(
      (g) => g.col === tile.col && g.row === tile.row && g.state !== 'dead'
    );
    if (guardHere) return true;

    // Corpse on tile
    const corpse = findDeadGuardAtCell(tile.col, tile.row);
    if (corpse) return true;

    return false;
  }

  function updatePressureTilesState() {
    if (!pressureTiles || !pressureTiles.length) return;

    ensurePressureTilesValid();
    if (!pressureTiles || !pressureTiles.length) return;

    const triggersNeedingCheck = new Set();

    pressureTiles.forEach((tile) => {
      const st = triggerRuntimeState[tile.triggerIndex];
      if (st && st.completed) {
        tile.applied = true;
        tile.holdTicks = PRESSURE_APPLY_TICKS;
        updatePressureTileVisual(tile);
        return;
      }

      const occupied = isPressureTileOccupied(tile);
      if (occupied) {
        tile.holdTicks++;
        if (tile.holdTicks >= PRESSURE_APPLY_TICKS) {
          if (!tile.applied) {
            tile.applied = true;
          }
        }
      } else {
        tile.holdTicks = 0;
        tile.applied = false;
      }

      updatePressureTileVisual(tile);
      triggersNeedingCheck.add(tile.triggerIndex);
    });

    triggersNeedingCheck.forEach((idx) => {
      const st = triggerRuntimeState[idx];
      if (st && st.completed) return;
      const tiles = pressureTiles.filter((t) => t.triggerIndex === idx);
      if (!tiles.length) return;
      const allApplied = tiles.every((t) => t.applied);
      if (allApplied) {
        completeLiberationTrigger(idx);
      }
    });
  }

  function removePressureTilesForTrigger(triggerIndex) {
    if (!pressureTiles || !pressureTiles.length) return;
    const survivors = [];
    pressureTiles.forEach((t) => {
      if (t.triggerIndex === triggerIndex) {
        if (t.el && t.el.parentNode) {
          t.el.parentNode.removeChild(t.el);
        }
      } else {
        survivors.push(t);
      }
    });
    pressureTiles = survivors;
  }

  function ensurePressureTilesValid() {
    if (!pressureTiles || !pressureTiles.length) return;

    const invalidTriggers = new Set();
    pressureTiles.forEach((t) => {
      const glyph = getOrcaGlyph(t.col, t.row);
      if (glyph !== '.' || !isWalkable(t.col, t.row)) {
        invalidTriggers.add(t.triggerIndex);
      }
    });

    if (!invalidTriggers.size) return;

    invalidTriggers.forEach((idx) => {
      removePressureTilesForTrigger(idx);
      const trigger = liberationTriggers[idx];
      const st = triggerRuntimeState[idx];
      if (trigger && st && !st.completed) {
        createPressureTilesForTrigger(idx, trigger);
      }
    });

    updateAllPressureTilesPosition();
  }

  function initPatchMarkersDom() {
    if (!patchMarkersContainer) return;

    // Clear previous markers/targets
    patchMarkersContainer.innerHTML = '';
    patchMarkers = [];
    destroyTargets = [];
    pressureTiles = [];
    patchResetCountdowns = {};

    if (!liberationTriggers || liberationTriggers.length === 0) {
      return;
    }

    liberationTriggers.forEach((trigger, triggerIndex) => {
      if (!trigger) return;

      const st = triggerRuntimeState[triggerIndex];
      const ritual = (st && st.ritual) || getTriggerRitualType(trigger);

      const corners = Array.isArray(trigger.corners) ? trigger.corners : [];
      let lockCornerIndex = null;
      if (ritual === 'getKey' && st) {
        lockCornerIndex = st.lockCornerIndex != null ? st.lockCornerIndex : 0;
      }

      // --- Corners (visivi) per tutti i ritual ---

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
        el.style.pointerEvents = 'none';
        el.style.zIndex = '2'; // above guards/corpses and pressure tiles

        const inner = document.createElement('div');
        inner.className = 'orca-stealth-patch-marker-inner';
        inner.style.position = 'absolute';
        inner.style.left = '25%';
        inner.style.top = '25%';
        inner.style.width = '50%';
        inner.style.height = '50%';
        inner.style.boxSizing = 'border-box';

        const isKeyLock =
          ritual === 'getKey' && lockCornerIndex === cornerIndex;

        if (isKeyLock) {
          // Lucchetto: quadrato bianco con "K" nera
          inner.style.background = '#ffffff';
          inner.style.border = 'none';

          const label = document.createElement('div');
          label.textContent = 'K';
          label.style.position = 'absolute';
          label.style.left = '50%';
          label.style.top = '50%';
          label.style.transform = 'translate(-50%, -50%)';
          label.style.fontFamily = 'monospace';
          label.style.fontSize = '65%';
          label.style.fontWeight = 'bold';
          label.style.color = '#000000';
          inner.appendChild(label);
        } else {
          // Corner normale: quadratino bianco pieno
          inner.style.background = '#ffffff';
          inner.style.border = 'none';
        }

        el.appendChild(inner);
        patchMarkersContainer.appendChild(el);

        patchMarkers.push({
          triggerId: trigger.id || ('trigger_' + triggerIndex),
          triggerIndex,
          cornerIndex,
          col,
          row,
          active: false,
          el,
          inner,
          ritualType: ritual,
          isKeyLock
        });
      });

      // --- Destroy-target ritual: crea il bersaglio circolare ---

      if (ritual === 'destroyTarget') {
        const cfg = trigger.destroyTarget || {};
        let tCol = null;
        let tRow = null;
        let hp = 4;

        if (typeof cfg.col === 'number') tCol = cfg.col;
        if (typeof cfg.row === 'number') tRow = cfg.row;
        if (typeof cfg.hp === 'number' && cfg.hp > 0) hp = cfg.hp;

        if (tCol != null && tRow != null) {
          createDestroyTargetForTrigger(triggerIndex, tCol, tRow, hp);
        } else {
          console.warn(
            '[overlay] destroyTarget trigger',
            trigger.id || triggerIndex,
            'is missing destroyTarget.col/row'
          );
        }
      } else if (ritual === 'pressure_tiles') {
        createPressureTilesForTrigger(triggerIndex, trigger);
      }
    });

    updatePatchMarkersPosition();
    updateAllDestroyTargetsPosition();
    updateAllPressureTilesPosition();
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

    // 1) Se c'è un key-lock vicino, lo preferiamo (getKey)
    let candidate = null;

    for (let i = 0; i < patchMarkers.length; i++) {
      const m = patchMarkers[i];
      if (!isAdjacentToMarker(m)) continue;

      const st = triggerRuntimeState[m.triggerIndex];
      const ritual = st ? st.ritual : m.ritualType || getTriggerRitualType(liberationTriggers[m.triggerIndex]);

      if (ritual === 'getKey' && m.isKeyLock) {
        candidate = m;
        break;
      }
    }

    // 2) Altrimenti, qualunque marker vicino (fourCorners classico)
    if (!candidate) {
      for (let i = 0; i < patchMarkers.length; i++) {
        const m = patchMarkers[i];
        if (!isAdjacentToMarker(m)) continue;
        candidate = m;
        break;
      }
    }

    if (!candidate) return;

    const triggerIndex = candidate.triggerIndex;
    const trigger = liberationTriggers[triggerIndex];
    if (!trigger) return;

    const st = triggerRuntimeState[triggerIndex];
    const ritual = st ? st.ritual : getTriggerRitualType(trigger);

    if (st && st.completed) {
      // Già sbloccata
      return;
    }

    // --- Ritual: DESTROY TARGET ---
    // Non sblocca con l'azione sui marker: serve eliminare il bersaglio.
    if (ritual === 'destroyTarget') {
      console.log(
        '[overlay] Destroy-target ritual: action on marker ignored for trigger',
        trigger.id || triggerIndex
      );
      return;
    }

    // --- Ritual: PRESSURE TILES ---
    if (ritual === 'pressure_tiles') {
      console.log(
        '[overlay] pressure_tiles ritual: marker interaction ignored for trigger',
        trigger.id || triggerIndex
      );
      return;
    }

    // --- Ritual: GET THE KEY ---
    if (ritual === 'getKey') {
      if (!st || !st.keyOwned) {
        console.log(
          '[overlay] Player tried to unlock patch',
          trigger.id || triggerIndex,
          'but has no key yet.'
        );
        return;
      }

      // Visual: lucchetto diventa outline, "K" bianca
      if (candidate.inner) {
        candidate.inner.style.background = 'transparent';
        candidate.inner.style.border = '2px solid #ffffff';

        const label = candidate.inner.querySelector('div');
        if (label) {
          label.style.color = '#ffffff';
        }
      }

      st.keyOwned = false;
      st.keyDropped = true;
      completeLiberationTrigger(triggerIndex);
      return;
    }

    // --- Ritual: FOUR CORNERS (default) ---
    if (candidate.active) {
      return;
    }

    candidate.active = true;

    // Switch visual from filled white square to hollow white square
    if (candidate.inner) {
      candidate.inner.style.background = 'transparent'; // no fill
      candidate.inner.style.border = '2px solid #ffffff'; // white outline
    }

    console.log(
      '[overlay] Patch marker',
      candidate.triggerId + ':' + candidate.cornerIndex,
      'activated.'
    );

    const markersForTrigger = patchMarkers.filter(
      (m) => m.triggerIndex === triggerIndex
    );
    const allActiveForTrigger =
      markersForTrigger.length > 0 &&
      markersForTrigger.every((m) => m.active);

    if (allActiveForTrigger) {
      completeLiberationTrigger(triggerIndex);
    }
  }

  // -----------------------------
  // Four-corners reset on alert
  // -----------------------------
  function maybeStartFourCornersResetOnAlert() {
    // Alert active?
    const alertActive = anySectorTracking() || (globalAlertLevel > 0);
    if (!alertActive) return;
    if (!patchMarkers || !patchMarkers.length) return;

    liberationTriggers.forEach((trigger, idx) => {
      if (!trigger) return;
      const st = triggerRuntimeState[idx];
      if (st && st.completed) return;
      const ritual = getTriggerRitualType(trigger);
      if (ritual !== 'fourCorners') return;
      if (patchResetCountdowns[idx] != null) return;

      const markers = getMarkersForTrigger(idx);
      if (!markers.length) return;
      const activeCount = markers.filter((m) => m.active).length;
      if (activeCount > 0 && activeCount < markers.length) {
        patchResetCountdowns[idx] = FOUR_CORNERS_RESET_TICKS;
        setCornerBlink(idx, true);
      }
    });
  }

  function updateFourCornersResetCountdowns() {
    const keys = Object.keys(patchResetCountdowns);
    if (!keys.length) return;

    keys.forEach((k) => {
      const idx = parseInt(k, 10);
      const st = triggerRuntimeState[idx];
      if (st && st.completed) {
        setCornerBlink(idx, false);
        delete patchResetCountdowns[idx];
        return;
      }

      const markers = getMarkersForTrigger(idx);
      if (!markers.length || markers.every((m) => !m.active)) {
        setCornerBlink(idx, false);
        delete patchResetCountdowns[idx];
        return;
      }

      // Ensure any newly activated corner blinks
      setCornerBlink(idx, true);

      patchResetCountdowns[idx] = patchResetCountdowns[idx] - 1;
      if (patchResetCountdowns[idx] <= 0) {
        setCornerBlink(idx, false);
        resetFourCornersMarkers(idx);
      }
    });
  }

  function getMarkersForTrigger(triggerIndex) {
    return patchMarkers.filter((m) => m.triggerIndex === triggerIndex);
  }

  function setCornerBlink(triggerIndex, enabled) {
    const markers = getMarkersForTrigger(triggerIndex);
    markers.forEach((m) => {
      if (!m.active || !m.inner) return;
      if (enabled) {
        m.inner.classList.add('orca-stealth-corner-blink-fast');
      } else {
        m.inner.classList.remove('orca-stealth-corner-blink-fast');
      }
    });
  }

  function resetFourCornersMarkers(triggerIndex) {
    const markers = getMarkersForTrigger(triggerIndex);
    markers.forEach((m) => {
      m.active = false;
      if (m.inner) {
        m.inner.classList.remove('orca-stealth-corner-blink-fast');
        m.inner.style.background = '#ffffff';
        m.inner.style.border = 'none';
      }
    });
    delete patchResetCountdowns[triggerIndex];
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

  // NEW: wrapper che marca un trigger come completato e pulisce i suoi elementi
  function completeLiberationTrigger(triggerIndex) {
    if (
      !liberationTriggers ||
      triggerIndex == null ||
      triggerIndex < 0 ||
      triggerIndex >= liberationTriggers.length
    ) {
      return;
    }

    const trigger = liberationTriggers[triggerIndex];
    if (!trigger) return;

    const st = triggerRuntimeState[triggerIndex];
    if (st && st.completed) {
      return;
    }

    // Scrivi la patch in ORCA
    liberatePatchInOrca(trigger);

    if (st) {
      st.completed = true;
      st.keyOwned = false;
    }

    // Rimuovi eventuali destroy-target associati
    if (destroyTargets && destroyTargets.length) {
      destroyTargets.forEach((t) => {
        if (!t) return;
        if (t.triggerIndex === triggerIndex) {
          t.alive = false;
          if (t.el && t.el.parentNode) {
            t.el.parentNode.removeChild(t.el);
          }
        }
      });
    }

    // Trasforma tutti i marker di questa patch in quadrati hollow
    patchMarkers.forEach((m) => {
      if (m.triggerIndex !== triggerIndex) return;
      m.active = true;
      if (!m.inner) return;

      m.inner.style.background = 'transparent';
      m.inner.style.border = '2px solid #ffffff';

      if (m.isKeyLock) {
        const label = m.inner.querySelector('div');
        if (label) {
          label.style.color = '#ffffff';
        }
      }
    });

    // Lock pressure tiles of this trigger in applied state (visual only)
    if (pressureTiles && pressureTiles.length) {
      pressureTiles.forEach((t) => {
        if (t.triggerIndex !== triggerIndex) return;
        t.applied = true;
        t.holdTicks = PRESSURE_APPLY_TICKS;
        updatePressureTileVisual(t);
      });
    }

    // Clear pending countdown for fourCorners (if any)
    if (patchResetCountdowns[triggerIndex] != null) {
      setCornerBlink(triggerIndex, false);
      delete patchResetCountdowns[triggerIndex];
    }

    console.log(
      '[overlay] Liberation trigger completed:',
      trigger.id || ('index ' + triggerIndex)
    );

    // If all triggers are now completed, freeze guards and show overlay
    const allCompleted = triggerRuntimeState.every((s) => s && s.completed);
    if (allCompleted) {
      allPatchesUnlocked = true;
      guardsFrozen = true;
      if (allPatchesUnlockedDiv) {
        allPatchesUnlockedDiv.style.display = 'flex';
      }
      // Remove any guard bullets in flight
      if (bullets && bullets.length) {
        const survivors = [];
        bullets.forEach((b) => {
          if (b.ownerType === 'guard') {
            if (b.el && b.el.parentNode) {
              b.el.parentNode.removeChild(b.el);
            }
          } else {
            survivors.push(b);
          }
        });
        bullets = survivors;
      }
    }
  }


  function shootingTickForGuard(guard) {
    if (mode !== 'game') return;
    if (guard.state !== 'alert_chaser') return;
    if (guard.state === 'stunned' || guard.state === 'dead') return;

    if (guard.shootCooldown > 0) {
      guard.shootCooldown--;
      return;
    }

    // Decide current target: player has priority, then bait
    let targetCol = null;
    let targetRow = null;

    if (guard.seenPlayer) {
      targetCol = playerCol;
      targetRow = playerRow;
    } else if (guard.seenBait && guard.seenBaitId != null) {
      const bait = getBaitById(guard.seenBaitId);
      if (!bait || !bait.alive) {
        return;
      }
      targetCol = bait.col;
      targetRow = bait.row;
    } else {
      return;
    }

    if (!hasLineOfShot(guard, targetCol, targetRow)) {
      return;
    }

    spawnBulletFromGuard(guard, targetCol, targetRow);
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

      const isTrackingTarget = guard.seenPlayer || guard.seenBait;
      const color = isTrackingTarget
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

    // Rifle AIM FOV (yellow), drawn above guard FOV
    if (rifleAimActive && rifleAimFovCells && rifleAimFovCells.length) {
    const rifleColor = 'rgba(0, 216, 255, 0.25)';
      rifleAimFovCells.forEach((cell) => {
        const cellDiv = document.createElement('div');
        cellDiv.style.position = 'absolute';
        cellDiv.style.left = (cell.col * cellW) + 'px';
        cellDiv.style.top = (cell.row * cellH) + 'px';
        cellDiv.style.width = cellW + 'px';
        cellDiv.style.height = cellH + 'px';
        cellDiv.style.background = rifleColor;
        fovContainer.appendChild(cellDiv);
      });
    }
  }

  // --------------------------------------------------
  // Rifle AIM (FOV, targeting, beam)
  // --------------------------------------------------

  function clearRifleBeams() {
    if (rifleFxContainer) {
      while (rifleFxContainer.firstChild) {
        rifleFxContainer.removeChild(rifleFxContainer.firstChild);
      }
    }
    rifleBeams = [];
  }

  function updateRifleBeams() {
    if (!rifleBeams || rifleBeams.length === 0) return;
    for (let i = rifleBeams.length - 1; i >= 0; i--) {
      const b = rifleBeams[i];
      b.ttl = (b.ttl || 0) - 1;
      if (b.ttl <= 0 || !b.el || !b.el.parentNode) {
        if (b.el && b.el.parentNode) {
          b.el.parentNode.removeChild(b.el);
        }
        rifleBeams.splice(i, 1);
      }
    }
  }

  function setGuardRifleTarget(guard, active) {
    if (!guard || !guard.inner) return;
    let cross = guard.rifleCross;
    if (active) {
      if (!cross) {
        cross = document.createElement('div');
        cross.className = 'orca-stealth-rifle-cross';
        const h = document.createElement('div');
        h.className = 'h';
        const v = document.createElement('div');
        v.className = 'v';
        cross.appendChild(h);
        cross.appendChild(v);
        guard.inner.appendChild(cross);
        guard.rifleCross = cross;
      }
      cross.style.display = 'block';
    } else if (cross) {
      cross.style.display = 'none';
    }
  }

  function clearRifleTargets() {
    guards.forEach((g) => setGuardRifleTarget(g, false));
  }

  function computeRifleFovCells() {
    const result = [];
    if (cellW <= 0 || cellH <= 0) return result;

    let dx = 0;
    let dy = 0;
    if (playerDir === 'up') dy = -1;
    else if (playerDir === 'down') dy = 1;
    else if (playerDir === 'left') dx = -1;
    else if (playerDir === 'right') dx = 1;

    if (dx === 0 && dy === 0) return result;

    const candidates = [];

    if (dx !== 0) {
      for (let d = 1; d <= RIFLE_FOV_DEPTH; d++) {
        const forwardCol = playerCol + dx * d;
        if (forwardCol < 0 || forwardCol >= gridCols) break;

        const w = RIFLE_FOV_WIDTHS[d - 1] || 1;
        const half = (w - 1) / 2;
        let startRow = playerRow - half;
        let endRow = playerRow + half;

        if (startRow > endRow) {
          const tmp = startRow;
          startRow = endRow;
          endRow = tmp;
        }

        if (endRow < 0 || startRow > gridRows - 1) {
          continue;
        }

        if (startRow < 0) startRow = 0;
        if (endRow > gridRows - 1) endRow = gridRows - 1;

        for (let ry = startRow; ry <= endRow; ry++) {
          candidates.push({ col: forwardCol, row: ry });
        }
      }
    } else if (dy !== 0) {
      for (let d = 1; d <= RIFLE_FOV_DEPTH; d++) {
        const forwardRow = playerRow + dy * d;
        if (forwardRow < 0 || forwardRow >= gridRows) break;

        const w = RIFLE_FOV_WIDTHS[d - 1] || 1;
        const half = (w - 1) / 2;
        let startCol = playerCol - half;
        let endCol = playerCol + half;

        if (startCol > endCol) {
          const tmp = startCol;
          startCol = endCol;
          endCol = tmp;
        }

        if (endCol < 0 || startCol > gridCols - 1) {
          continue;
        }

        if (startCol < 0) startCol = 0;
        if (endCol > gridCols - 1) endCol = gridCols - 1;

        for (let cx = startCol; cx <= endCol; cx++) {
          candidates.push({ col: cx, row: forwardRow });
        }
      }
    }

    const seen = new Set();
    for (let i = 0; i < candidates.length; i++) {
      const cell = candidates[i];
      const c = cell.col;
      const r = cell.row;
      if (c < 0 || r < 0 || c >= gridCols || r >= gridRows) continue;
      const key = c + ':' + r;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!isWalkable(c, r)) continue;
      if (!hasLineOfSightForFov(playerCol, playerRow, c, r)) continue;
      result.push({ col: c, row: r });
    }

    return result;
  }

  function exitRifleAim(reason) {
    rifleAimActive = false;
    rifleAimFovCells = [];
    rifleAimTargetGuardId = null;
    rifleAimCandidates = [];
    rifleAimAnchorCol = null;
    rifleAimAnchorRow = null;
    rifleAimAnchorDir = null;
    clearRifleTargets();
    renderGuardFov();
    if (reason && DEBUG) {
      console.log('[overlay] Rifle AIM exit:', reason);
    }
  }

  function enterRifleAim() {
    if (playerRifles <= 0) {
      console.log('[overlay] PLAYER tried to AIM rifle without charges.');
      return;
    }
    rifleAimActive = true;
    rifleAimAnchorCol = playerCol;
    rifleAimAnchorRow = playerRow;
    rifleAimAnchorDir = playerDir;
    updateRifleAimState(true);
  }

  function updateRifleAimState(forceRetarget) {
    if (!rifleAimActive) return;

    // Auto-exit if player moved or lost ammo
    if (playerRifles <= 0) {
      exitRifleAim('no-rifle');
      return;
    }
    if (
      rifleAimAnchorDir != null &&
      rifleAimAnchorDir !== playerDir
    ) {
      exitRifleAim('direction-changed');
      return;
    }
    if (
      rifleAimAnchorCol != null &&
      (rifleAimAnchorCol !== playerCol || rifleAimAnchorRow !== playerRow)
    ) {
      exitRifleAim('player-moved');
      return;
    }

    rifleAimFovCells = computeRifleFovCells();

    const fovKeys = new Set(
      rifleAimFovCells.map((c) => c.col + ':' + c.row)
    );

    const candidates = [];
    guards.forEach((g) => {
      if (!g || g.state === 'dead') return;
      const key = g.col + ':' + g.row;
      if (fovKeys.has(key)) {
        candidates.push(g);
      }
    });

    rifleAimCandidates = candidates.map((g) => g.id || '');

    let targetGuard = null;
    if (rifleAimTargetGuardId) {
      targetGuard = candidates.find(
        (g) => (g.id || '') === rifleAimTargetGuardId
      );
    }
    if (!targetGuard && candidates.length) {
      if (forceRetarget) {
        targetGuard = candidates[0];
      } else {
        targetGuard = candidates[Math.floor(Math.random() * candidates.length)];
      }
    }

    rifleAimTargetGuardId = targetGuard ? (targetGuard.id || null) : null;

    guards.forEach((g) => {
      setGuardRifleTarget(g, rifleAimTargetGuardId === (g.id || null));
    });

    // Keep FOV rendering in sync
    renderGuardFov();
  }

  function cycleRifleTarget() {
    if (!rifleAimActive) return;
    if (!rifleAimCandidates || rifleAimCandidates.length === 0) return;
    const currentId = rifleAimTargetGuardId;
    let idx = rifleAimCandidates.indexOf(currentId);
    idx = (idx + 1) % rifleAimCandidates.length;
    rifleAimTargetGuardId = rifleAimCandidates[idx];
    guards.forEach((g) => {
      setGuardRifleTarget(g, rifleAimTargetGuardId === (g.id || null));
    });
  }

  function addRifleBeamEffect(fromCol, fromRow, toCol, toRow) {
    if (!rifleFxContainer || cellW <= 0 || cellH <= 0) return;

    const startX = (fromCol + 0.5) * cellW;
    const startY = (fromRow + 0.5) * cellH;
    const endX = (toCol + 0.5) * cellW;
    const endY = (toRow + 0.5) * cellH;

    const dx = endX - startX;
    const dy = endY - startY;
    const len = Math.max(2, Math.sqrt(dx * dx + dy * dy));
    const angleDeg = Math.atan2(dy, dx) * (180 / Math.PI);

    const line = document.createElement('div');
    line.className = 'orca-stealth-rifle-beam';
    line.style.width = len + 'px';
    line.style.height = Math.max(1, cellH * 0.06) + 'px';
    line.style.transformOrigin = '0 50%';
    line.style.transform =
      'translate(' + startX + 'px,' + startY + 'px) rotate(' + angleDeg + 'deg)';

    const center = document.createElement('div');
    center.className = 'beam-center';
    const left = document.createElement('div');
    left.className = 'beam-dash beam-left';
    const right = document.createElement('div');
    right.className = 'beam-dash beam-right';

    line.appendChild(center);
    line.appendChild(left);
    line.appendChild(right);

    rifleFxContainer.appendChild(line);
    rifleBeams.push({ el: line, ttl: RIFLE_BEAM_DURATION_TICKS });
  }

  function fireRifleShot() {
    if (!rifleAimActive) return;
    const target = guards.find(
      (g) => g && (g.id || '') === (rifleAimTargetGuardId || '') && g.state !== 'dead'
    );
    if (!target) {
      exitRifleAim('target-lost');
      return;
    }

    addRifleBeamEffect(playerCol, playerRow, target.col, target.row);

    target.hp = Math.max(0, (target.hp || GUARD_MAX_HP) - RIFLE_SHOT_DAMAGE);
    if (target.hp <= 0) {
      killGuard(target);
    } else {
      updateGuardSpriteAppearance(target);
    }

    playerRifles--;
    if (playerRifles < 0) playerRifles = 0;
    updateModeVisual();

    exitRifleAim('fired');
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
    const layoutType = getLayoutType();

    // Dungeon layout: use room-based alert logic
    if (layoutType === 'dungeon') {
      updateAllFovAndAlertDungeon(!!manageMemory);
      return;
    }

    // Arena layout: sector-based logic
    manageMemory = !!manageMemory;

    let anySeen = false;
    const sectorSawPlayer = { NW: false, NE: false, SW: false, SE: false };
    const sectorSawBait   = { NW: false, NE: false, SW: false, SE: false };
    const sectorTargetBait = { NW: null, NE: null, SW: null, SE: null };
    const sectorSawCorpse = { NW: false, NE: false, SW: false, SE: false };
    const sectorCorpseInfo = { NW: null, NE: null, SW: null, SE: null };
    const sectorSawStunned = { NW: false, NE: false, SW: false, SE: false };
    const sectorStunnedInfo = { NW: null, NE: null, SW: null, SE: null };


    guards.forEach((guard) => {
      if (guard.state === 'stunned' || guard.state === 'dead') {
        guard.fovCells = [];
        guard.wasSeeingPlayer = guard.seenPlayer;
        guard.wasSeeingBait = guard.seenBait;
        guard.seenPlayer = false;
        guard.seenBait = false;
        guard.seenBaitId = null;
        return;
      }

      guard.fovCells = computeGuardFovCellsForGuard(guard);

      const prevSeenPlayer = guard.seenPlayer;
      const prevSeenBait   = guard.seenBait;

      let nextSeenPlayer = false;
      let seenBaitObj = null;
      // Corpse detection is only meaningful while the guard is patrolling
      let seenCorpseCell = null;
      let seenStunnedCell = null;


      // Check player in FOV
      nextSeenPlayer = guard.fovCells.some(
        (c) => c.col === playerCol && c.row === playerRow
      );

      // If no player, check for any alive bait in FOV
      if (!nextSeenPlayer) {
        for (let i = 0; i < guard.fovCells.length; i++) {
          const cell = guard.fovCells[i];
          const bait = findPlacedBaitAtCell(cell.col, cell.row);
          if (bait && bait.alive) {
            seenBaitObj = bait;
            break;
          }
        }
      }

      // Check for any dead guard ("corpse") in FOV when this guard is patrolling
      if (guard.state === 'patrol') {
        for (let i = 0; i < guard.fovCells.length; i++) {
          const cell = guard.fovCells[i];
          const corpse = findDeadGuardAtCell(cell.col, cell.row);
          if (corpse) {
            // Remember the first corpse cell we see
            seenCorpseCell = { col: corpse.col, row: corpse.row };
            break;
          }
        }
      }

      // Stunned guard detection (alert trigger)
      for (let i = 0; i < guard.fovCells.length; i++) {
        const cell = guard.fovCells[i];
        const stunned = findStunnedGuardAtCell(cell.col, cell.row);
        if (stunned) {
          seenStunnedCell = { col: stunned.col, row: stunned.row };
          break;
        }
      }


      guard.wasSeeingPlayer = prevSeenPlayer;
      guard.wasSeeingBait = prevSeenBait;
      guard.seenPlayer = nextSeenPlayer;
      guard.seenBait = !!seenBaitObj;
      guard.seenBaitId = seenBaitObj ? seenBaitObj.id : null;

      if (nextSeenPlayer || guard.seenBait || !!seenCorpseCell || !!seenStunnedCell) {
        anySeen = true;
      }

      const s = getSector(guard.col, guard.row);

      if (nextSeenPlayer) {
        guard.lastSeenPlayerCol = playerCol;
        guard.lastSeenPlayerRow = playerRow;
        sectorSawPlayer[s] = true;
      } else if (guard.seenBait && seenBaitObj) {
        sectorSawBait[s] = true;
        if (!sectorTargetBait[s]) {
          sectorTargetBait[s] = {
            col: seenBaitObj.col,
            row: seenBaitObj.row,
            baitId: seenBaitObj.id
          };
        }
      }

      // Corpse sighting: mark this sector and remember one corpse position
      if (seenCorpseCell) {
        sectorSawCorpse[s] = true;
        if (!sectorCorpseInfo[s]) {
          sectorCorpseInfo[s] = {
            col: seenCorpseCell.col,
            row: seenCorpseCell.row
          };
        }
      }

      if (seenStunnedCell) {
        sectorSawStunned[s] = true;
        if (!sectorStunnedInfo[s]) {
          sectorStunnedInfo[s] = {
            col: seenStunnedCell.col,
            row: seenStunnedCell.row
          };
        }
      }


      if (!prevSeenPlayer && nextSeenPlayer) {
        handleGuardSpotsPlayer(guard);
      }
    });

    // Update "seeingNow" flag per sector (used by targeting logic)
    ['NW', 'NE', 'SW', 'SE'].forEach((name) => {
      const sa = sectorAlerts[name];
      if (!sa) return;
      sa.seeingNow =
        !!sectorSawPlayer[name] ||
        !!sectorSawBait[name] ||
        !!sectorSawCorpse[name] ||
        !!sectorSawStunned[name];
    });


    if (manageMemory) {
      // Update sector states with memory, for both player and bait
      ['NW', 'NE', 'SW', 'SE'].forEach((name) => {
        const sa = sectorAlerts[name];
        if (!sa) return;
        if (typeof sa.tempBoost !== 'number') {
          sa.tempBoost = 1.0;
        }

        const sawPlayer = !!sectorSawPlayer[name];
        const sawBait   = !!sectorSawBait[name];
        const sawStunned = !!sectorSawStunned[name];
        const sawCorpse = !!sectorSawCorpse[name];

        if (sawPlayer) {
          // Player has priority over everything
          sa.state = 'tracking';
          sa.targetCol = playerCol;
          sa.targetRow = playerRow;
          sa.timer = ALERT_MEMORY_TICKS;
          sa.source = 'player';
          sa.sourceBaitId = null;
        } else if (sawBait) {
          // Bait has priority over corpse
          sa.state = 'tracking';
          const info = sectorTargetBait[name];
          if (info) {
            sa.targetCol = info.col;
            sa.targetRow = info.row;
            sa.source = 'bait';
            sa.sourceBaitId = info.baitId;
          } else {
            sa.targetCol = null;
            sa.targetRow = null;
            sa.source = 'bait';
            sa.sourceBaitId = null;
          }
          sa.timer = ALERT_MEMORY_TICKS;
        } else if (sawStunned) {
          // Stunned-ally sighting: temporary alert with speed boost
          sa.state = 'tracking';
          const info = sectorStunnedInfo[name];
          if (info) {
            sa.targetCol = info.col;
            sa.targetRow = info.row;
          } else {
            sa.targetCol = null;
            sa.targetRow = null;
          }
          sa.source = 'stunned_guard';
          sa.sourceBaitId = null;
          sa.timer = ALERT_MEMORY_TICKS;
          if (typeof sa.tempBoost !== 'number') {
            sa.tempBoost = 1.0;
          }
          if (sa.tempBoost < TEMP_ALERT_SPEED_MULT) {
            sa.tempBoost = TEMP_ALERT_SPEED_MULT;
          }
        } else if (sawCorpse) {
          // Corpse sighting: trigger alert for this sector, with permanent speed boost
          sa.state = 'tracking';
          const info = sectorCorpseInfo[name];
          if (info) {
            sa.targetCol = info.col;
            sa.targetRow = info.row;
          } else {
            sa.targetCol = null;
            sa.targetRow = null;
          }
          sa.source = 'corpse';
          sa.sourceBaitId = null;
          // No memory timer for corpse-only alerts: timer stays 0 and sector will drop
          // back to idle when guards no longer see it.
          sa.timer = 0;

          // Apply permanent speed boost for all guards in this sector
          if (typeof sa.corpseBoost !== 'number' ||
              sa.corpseBoost < CORPSE_ALERT_SPEED_MULT) {
            sa.corpseBoost = CORPSE_ALERT_SPEED_MULT;
          }
        } else if (sa.state === 'tracking') {
          // Sector was tracking: decay memory (only for player/bait)
          if (sa.timer > 0) {
            sa.timer--;

            if (sa.timer > 0) {
              if (sa.source === 'player' && ALERT_TARGET_MODE === 'realtime') {
                sa.targetCol = playerCol;
                sa.targetRow = playerRow;
              }
              // For bait, keep last target; baits do not move.
            } else {
              sa.state = 'idle';
              sa.targetCol = null;
              sa.targetRow = null;
              sa.source = null;
              sa.sourceBaitId = null;
              sa.tempBoost = 1.0;
            }
          } else {
            sa.state = 'idle';
            sa.targetCol = null;
            sa.targetRow = null;
            sa.source = null;
            sa.sourceBaitId = null;
            sa.tempBoost = 1.0;
          }
        }
      });

      // Global alert: on if any guard sees player/bait OR at least one sector is tracking
      const trackingNow =
        sectorAlerts.NW.state === 'tracking' ||
        sectorAlerts.NE.state === 'tracking' ||
        sectorAlerts.SW.state === 'tracking' ||
        sectorAlerts.SE.state === 'tracking';

      globalAlertLevel = (anySeen || trackingNow) ? 1 : 0;

      // Align guard states with their sector
      guards.forEach((g) => {
        if (g.state === 'stunned' || g.state === 'dead') return;

        const s = getSector(g.col, g.row);
        const sa = sectorAlerts[s];

        if (sa && sa.state === 'tracking') {
          g.state = 'alert_chaser';
        } else {
          if (g.state === 'alert_chaser' && !g.seenPlayer && !g.seenBait) {
            g.state = 'return_to_patrol';
            g.path = null;
            g.pathTargetCol = null;
            g.pathTargetRow = null;
          }
        }
      });

      updateModeVisual();
    }

    // FOV always redrawn
    renderGuardFov();
    // Update red alert areas per sector/room
    renderAlertAreas();

  }


    // Dungeon: room-based alert logic.
    // Dungeon: room-based alert logic.
  function updateAllFovAndAlertDungeon(manageMemory) {
    manageMemory = !!manageMemory;

    let anySeen = false;
    const roomsSawPlayer = {};
    const roomsSawBait = {};
    const roomTargetBait = {};

    const roomsSawCorpse = {};
    const roomCorpseInfo = {};
    const roomsSawStunned = {};
    const roomStunnedInfo = {};


    guards.forEach((guard) => {
      if (guard.state === 'stunned' || guard.state === 'dead') {
        guard.fovCells = [];
        guard.wasSeeingPlayer = guard.seenPlayer;
        guard.wasSeeingBait = guard.seenBait;
        guard.seenPlayer = false;
        guard.seenBait = false;
        guard.seenBaitId = null;
        return;
      }

      guard.fovCells = computeGuardFovCellsForGuard(guard);

      const prevSeenPlayer = guard.seenPlayer;
      const prevSeenBait   = guard.seenBait;

      let nextSeenPlayer = false;
      let seenBaitObj = null;
      let seenCorpseCell = null;
      let seenStunnedCell = null;


      nextSeenPlayer = guard.fovCells.some(
        (c) => c.col === playerCol && c.row === playerRow
      );

      if (!nextSeenPlayer) {
        for (let i = 0; i < guard.fovCells.length; i++) {
          const cell = guard.fovCells[i];
          const bait = findPlacedBaitAtCell(cell.col, cell.row);
          if (bait && bait.alive) {
            seenBaitObj = bait;
            break;
          }
        }
      }

      // Check for any dead guard ("corpse") in FOV while this guard is patrolling
      if (guard.state === 'patrol') {
        for (let i = 0; i < guard.fovCells.length; i++) {
          const cell = guard.fovCells[i];
          const corpse = findDeadGuardAtCell(cell.col, cell.row);
          if (corpse) {
            seenCorpseCell = { col: corpse.col, row: corpse.row };
            break;
          }
        }
      }

      // Stunned guard detection (alert trigger)
      for (let i = 0; i < guard.fovCells.length; i++) {
        const cell = guard.fovCells[i];
        const stunned = findStunnedGuardAtCell(cell.col, cell.row);
        if (stunned) {
          seenStunnedCell = { col: stunned.col, row: stunned.row };
          break;
        }
      }


      guard.wasSeeingPlayer = prevSeenPlayer;
      guard.wasSeeingBait = prevSeenBait;
      guard.seenPlayer = nextSeenPlayer;
      guard.seenBait = !!seenBaitObj;
      guard.seenBaitId = seenBaitObj ? seenBaitObj.id : null;

      if (nextSeenPlayer || guard.seenBait || !!seenCorpseCell || !!seenStunnedCell) {
        anySeen = true;
      }

      const roomKey = getGuardRoomKey(guard);
      if (roomKey) {
        if (nextSeenPlayer) {
          roomsSawPlayer[roomKey] = true;
        } else if (guard.seenBait && seenBaitObj) {
          roomsSawBait[roomKey] = true;
          if (!roomTargetBait[roomKey]) {
            roomTargetBait[roomKey] = {
              col: seenBaitObj.col,
              row: seenBaitObj.row,
              baitId: seenBaitObj.id
            };
          }
        }

        if (seenCorpseCell) {
          roomsSawCorpse[roomKey] = true;
          if (!roomCorpseInfo[roomKey]) {
            roomCorpseInfo[roomKey] = {
              col: seenCorpseCell.col,
              row: seenCorpseCell.row
            };
          }
        }

        if (seenStunnedCell) {
          roomsSawStunned[roomKey] = true;
          if (!roomStunnedInfo[roomKey]) {
            roomStunnedInfo[roomKey] = {
              col: seenStunnedCell.col,
              row: seenStunnedCell.row
            };
          }
        }
      }

      if (!prevSeenPlayer && nextSeenPlayer) {
        handleGuardSpotsPlayer(guard);
      }
    });

    if (manageMemory) {
      // Ensure entries for rooms that saw something
      const allKeys = new Set([
        ...Object.keys(roomsSawPlayer),
        ...Object.keys(roomsSawBait),
        ...Object.keys(roomsSawCorpse),
        ...Object.keys(roomsSawStunned)
      ]);


      allKeys.forEach((key) => {
        ensureRoomAlertEntry(key);
      });


      // Update alert/memory state per room
      for (const key in roomAlerts) {
        const ra = roomAlerts[key];
        if (!ra) continue;
        if (typeof ra.tempBoost !== 'number') {
          ra.tempBoost = 1.0;
        }

        const sawPlayer = !!roomsSawPlayer[key];
        const sawBait   = !!roomsSawBait[key];
        const sawStunned = !!roomsSawStunned[key];
        const sawCorpse = !!roomsSawCorpse[key];

        ra.seeingNow = sawPlayer || sawBait || sawCorpse || sawStunned;

        if (sawPlayer) {
          ra.state = 'tracking';
          ra.targetCol = playerCol;
          ra.targetRow = playerRow;
          ra.timer = ALERT_MEMORY_TICKS;
          ra.source = 'player';
          ra.sourceBaitId = null;
        } else if (sawBait) {
          ra.state = 'tracking';
          const info = roomTargetBait[key];
          if (info) {
            ra.targetCol = info.col;
            ra.targetRow = info.row;
            ra.source = 'bait';
            ra.sourceBaitId = info.baitId;
          } else {
            ra.targetCol = null;
            ra.targetRow = null;
            ra.source = 'bait';
            ra.sourceBaitId = null;
          }
          ra.timer = ALERT_MEMORY_TICKS;
        } else if (sawStunned) {
          ra.state = 'tracking';
          const info = roomStunnedInfo[key];
          if (info) {
            ra.targetCol = info.col;
            ra.targetRow = info.row;
          } else {
            ra.targetCol = null;
            ra.targetRow = null;
          }
          ra.source = 'stunned_guard';
          ra.sourceBaitId = null;
          ra.timer = ALERT_MEMORY_TICKS;
          if (typeof ra.tempBoost !== 'number') {
            ra.tempBoost = 1.0;
          }
          if (ra.tempBoost < TEMP_ALERT_SPEED_MULT) {
            ra.tempBoost = TEMP_ALERT_SPEED_MULT;
          }
        } else if (sawCorpse) {
          // Corpse sighting: alert this room and give permanent speed boost
          ra.state = 'tracking';
          const info = roomCorpseInfo[key];
          if (info) {
            ra.targetCol = info.col;
            ra.targetRow = info.row;
          } else {
            ra.targetCol = null;
            ra.targetRow = null;
          }
          ra.source = 'corpse';
          ra.sourceBaitId = null;
          // No memory timer for corpse-only alerts
          ra.timer = 0;

          if (typeof ra.corpseBoost !== 'number' ||
              ra.corpseBoost < CORPSE_ALERT_SPEED_MULT) {
            ra.corpseBoost = CORPSE_ALERT_SPEED_MULT;
          }
        } else if (ra.state === 'tracking') {
          // Room was tracking: decay memory (only for player/bait)
          if (ra.timer > 0) {
            ra.timer--;
            if (ra.timer <= 0) {
              ra.state = 'idle';
              ra.targetCol = null;
              ra.targetRow = null;
              ra.timer = 0;
              ra.source = null;
              ra.sourceBaitId = null;
              ra.tempBoost = 1.0;
            }
          } else {
            ra.state = 'idle';
            ra.targetCol = null;
            ra.targetRow = null;
            ra.timer = 0;
            ra.source = null;
            ra.sourceBaitId = null;
            ra.tempBoost = 1.0;
          }
        }
      }

      // Global alert: on if any room is tracking or any guard sees player/bait
      let trackingNow = false;
      for (const key in roomAlerts) {
        const ra = roomAlerts[key];
        if (ra && ra.state === 'tracking') {
          trackingNow = true;
          break;
        }
      }

      globalAlertLevel = (anySeen || trackingNow) ? 1 : 0;

      // Align guard FSM with their room's alert state
      guards.forEach((g) => {
        if (g.state === 'stunned' || g.state === 'dead') return;

        const roomKey = getGuardRoomKey(g);
        const ra = roomAlerts[roomKey];

        if (ra && ra.state === 'tracking') {
          // Only guards whose room is in alert become (or stay) chasers
          g.state = 'alert_chaser';
        } else {
          // Room is idle: if guard was in alert and no longer sees player/bait, send it home
          if (g.state === 'alert_chaser' && !g.seenPlayer && !g.seenBait) {
            g.state = 'return_to_patrol';
            g.path = null;
            g.pathTargetCol = null;
            g.pathTargetRow = null;
          }
        }
      });

      updateModeVisual();
    }

    renderGuardFov();
    // Update red alert areas per room
    renderAlertAreas();

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
  // Patrol extra behaviours: observing & rectangle deviation
  // --------------------------------------------------

  // Observing: guard stays still and rotates FOV to cover 360°
  function stepGuardObserving(guard) {
    if (!guard || guard.observingTicksLeft == null || guard.observingTicksLeft <= 0) {
      return;
    }

    const total = OBSERVE_DURATION_TICKS;
    const remaining = guard.observingTicksLeft;
    const elapsed = total - remaining;

    // 4 cardinal slices: up, right, down, left
    const slices = 4;
    const sliceLen = Math.max(1, Math.floor(total / slices));
    const sliceIndex = Math.min(slices - 1, Math.floor(elapsed / sliceLen));

    if (sliceIndex === 0) {
      guard.dirX = 0; guard.dirY = -1; // up
    } else if (sliceIndex === 1) {
      guard.dirX = 1; guard.dirY = 0;  // right
    } else if (sliceIndex === 2) {
      guard.dirX = 0; guard.dirY = 1;  // down
    } else {
      guard.dirX = -1; guard.dirY = 0; // left
    }

    guard.observingTicksLeft--;
    clampGuard(guard);
    updateGuardPosition(guard);
  }

  // Decide if a guard should enter observing state this tick
  function maybeStartObserving(guard) {
    if (!guard) return false;
    if (guard.state !== 'patrol') return false;

    // Already in observing phase
    if (guard.observingTicksLeft && guard.observingTicksLeft > 0) {
      return false;
    }

    // Do not start observing while any alert / tracking is active
    if (globalAlertLevel > 0 || anySectorTracking()) {
      return false;
    }

    guard.ticksSinceLastObserve = (guard.ticksSinceLastObserve || 0) + 1;

    const t = guard.ticksSinceLastObserve;
    if (t < OBSERVE_MIN_INTERVAL_TICKS) {
      return false;
    }

    const force = t >= OBSERVE_FORCED_INTERVAL_TICKS;

    if (!force) {
      // Pseudo-random: small chance per tick once we are beyond the minimum interval
      const chance = 0.12; // 12%
      if (Math.random() >= chance) {
        return false;
      }
    }

    // Avoid always starting from the exact same patrol cell (unless forced)
    if (!force &&
        guard.lastObserveCol != null &&
        guard.lastObserveRow != null &&
        guard.col === guard.lastObserveCol &&
        guard.row === guard.lastObserveRow) {
      return false;
    }

    guard.observingTicksLeft = OBSERVE_DURATION_TICKS;
    guard.ticksSinceLastObserve = 0;
    guard.lastObserveCol = guard.col;
    guard.lastObserveRow = guard.row;
    guard.lookPhase = 0; // reset wobble phase so FOV is nicely centered

    return true;
  }

  // Distance from a cell to the patrol rectangle border (0 = on border)
  function distanceToPatrolRectBorder(guard, col, row) {
    const dLeft   = col - guard.minCol;
    const dRight  = guard.maxCol - col;
    const dTop    = row - guard.minRow;
    const dBottom = guard.maxRow - row;
    return Math.min(dLeft, dRight, dTop, dBottom);
  }

  // Single step for patrol deviation, either going "out" (inside the rect)
  // or "return" (back to the perimeter).
  function tryDeviationStep(guard, phase) {
    const dirs = [
      { dx:  1, dy:  0 },
      { dx: -1, dy:  0 },
      { dx:  0, dy:  1 },
      { dx:  0, dy: -1 }
    ];

    const currentDist = distanceToPatrolRectBorder(guard, guard.col, guard.row);
    const candidates = [];

    for (let i = 0; i < dirs.length; i++) {
      const d = dirs[i];
      const nc = guard.col + d.dx;
      const nr = guard.row + d.dy;

      if (!withinGuardRect(guard, nc, nr)) continue;
      if (!isWalkable(nc, nr)) continue;
      if (isCellOccupiedByOtherGuard(nc, nr, guard)) continue;

      const dist = distanceToPatrolRectBorder(guard, nc, nr);

      if (phase === 'out') {
        // Prefer steps that go deeper inside the rect (dist > currentDist)
        if (dist <= currentDist) continue;
        if (dist > PATROL_DEV_MAX_RADIUS_CELLS) continue;
        candidates.push({ col: nc, row: nr, dx: d.dx, dy: d.dy });
      } else {
        // Return phase: prefer steps that move closer to the border (dist < currentDist)
        if (dist >= currentDist) continue;
        candidates.push({ col: nc, row: nr, dx: d.dx, dy: d.dy });
      }
    }

    if (candidates.length === 0) {
      return false;
    }

    // Random pick among best candidates
    const choice = candidates[Math.floor(Math.random() * candidates.length)];
    guard.col = choice.col;
    guard.row = choice.row;
    guard.dirX = choice.dx;
    guard.dirY = choice.dy;
    clampGuard(guard);
    updateGuardPosition(guard);
    updateGuardLookDirection(guard);
    return true;
  }

  // Decide if we start a deviation this tick
  function maybeStartPatrolDeviation(guard) {
    if (!guard) return false;
    if (guard.state !== 'patrol') return false;

    // Only if the guard is actually inside its patrol rect
    if (!withinGuardRect(guard, guard.col, guard.row)) {
      return false;
    }

    // Do not deviate while alert is active
    if (globalAlertLevel > 0 || anySectorTracking()) {
      guard.deviationActive = false;
      return false;
    }

    // Already in a deviation
    if (guard.deviationActive) {
      return false;
    }

    guard.ticksSinceLastDeviation = (guard.ticksSinceLastDeviation || 0) + 1;

    const t = guard.ticksSinceLastDeviation;
    if (t < PATROL_DEV_MIN_INTERVAL_TICKS) {
      return false;
    }

    const force = t >= PATROL_DEV_FORCED_INTERVAL_TICKS;

    if (!force) {
      const chance = 0.10; // 10% per tick after minimum interval
      if (Math.random() >= chance) {
        return false;
      }
    }

    // Initialise deviation state
    guard.deviationActive = true;
    guard.deviationPhase = 'out';
    guard.deviationOutStepsLeft = PATROL_DEV_OUT_STEPS_MAX;
    guard.deviationBackStepsLeft = PATROL_DEV_BACK_STEPS_MAX;
    guard.ticksSinceLastDeviation = 0;
    guard.lastDeviationCol = guard.col;
    guard.lastDeviationRow = guard.row;

    return true;
  }

  // One tick of deviation behaviour (either going out or returning)
  function stepGuardPatrolDeviation(guard) {
    if (!guard.deviationActive) return;

    const dist = distanceToPatrolRectBorder(guard, guard.col, guard.row);

    if (guard.deviationPhase === 'out') {
      if (guard.deviationOutStepsLeft <= 0 || dist >= PATROL_DEV_MAX_RADIUS_CELLS) {
        guard.deviationPhase = 'return';
      } else {
        const moved = tryDeviationStep(guard, 'out');
        if (moved) {
          guard.deviationOutStepsLeft--;
          return;
        }
        // Could not move -> switch to return
        guard.deviationPhase = 'return';
      }
    }

    if (guard.deviationPhase === 'return') {
      if (dist <= 0 || guard.deviationBackStepsLeft <= 0) {
        // Back on border or out of budget: stop deviating
        guard.deviationActive = false;
        guard.deviationPhase = null;
        return;
      }

      const moved = tryDeviationStep(guard, 'return');
      if (moved) {
        guard.deviationBackStepsLeft--;
        return;
      }

      // If we cannot move, just stop deviating and go back to normal patrol
      guard.deviationActive = false;
      guard.deviationPhase = null;
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

    // Default: clockwise = true if not explicitly set to false
    const clockwise = (guard.patrolClockwise !== false);

    if (clockwise) {
      // Clockwise around the rectangle: E -> S -> W -> N -> E
      if (dx === 1 && dy === 0) {
        guard.dirX = 0; guard.dirY = 1;   // E -> S
      } else if (dx === 0 && dy === 1) {
        guard.dirX = -1; guard.dirY = 0;  // S -> W
      } else if (dx === -1 && dy === 0) {
        guard.dirX = 0; guard.dirY = -1;  // W -> N
      } else if (dx === 0 && dy === -1) {
        guard.dirX = 1; guard.dirY = 0;   // N -> E
      } else {
        guard.dirX = 1;
        guard.dirY = 0;
      }
    } else {
      // Counterclockwise: E -> N -> W -> S -> E
      if (dx === 1 && dy === 0) {
        guard.dirX = 0; guard.dirY = -1;  // E -> N
      } else if (dx === 0 && dy === -1) {
        guard.dirX = -1; guard.dirY = 0;  // N -> W
      } else if (dx === -1 && dy === 0) {
        guard.dirX = 0; guard.dirY = 1;   // W -> S
      } else if (dx === 0 && dy === 1) {
        guard.dirX = 1; guard.dirY = 0;   // S -> E
      } else {
        guard.dirX = 1;
        guard.dirY = 0;
      }
    }
  }

  function stepGuardPatrol(guard) {
    // If observing is in progress, guard stays still and rotates FOV
    if (guard.observingTicksLeft && guard.observingTicksLeft > 0) {
      stepGuardObserving(guard);
      return;
    }

    // Per-tick scheduling for extra patrol behaviours (only once per world tick)
    const firstCallThisTick = (guard.lastPatrolTick !== worldTick);
    if (firstCallThisTick) {
      guard.lastPatrolTick = worldTick;

      if (guard.state === 'patrol' && globalAlertLevel === 0 && !anySectorTracking()) {
        // 1) Try to enter observing
        if (maybeStartObserving(guard)) {
          stepGuardObserving(guard);
          return;
        }

        // 2) Try to start a rectangle deviation
        if (!guard.deviationActive && maybeStartPatrolDeviation(guard)) {
          // Perform the first deviation step immediately
          stepGuardPatrolDeviation(guard);
          return;
        }
      }
    }

    // If we are in deviation mode, follow deviation instead of the rectangle perimeter
    if (guard.deviationActive) {
      stepGuardPatrolDeviation(guard);
      return;
    }

    // --------------------------------------------------
    // Normal rectangular patrol (original behaviour)
    // --------------------------------------------------

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

      if (
        stepX !== 0 &&
        isWalkable(guard.col + Math.sign(stepX), guard.row) &&
        !isCellOccupiedByOtherGuard(
          guard.col + Math.sign(stepX),
          guard.row,
          guard
        )
      ) {
        nextCol = guard.col + Math.sign(stepX);
        nextRow = guard.row;
      } else if (
        stepY !== 0 &&
        isWalkable(guard.col, guard.row + Math.sign(stepY)) &&
        !isCellOccupiedByOtherGuard(
          guard.col,
          guard.row + Math.sign(stepY),
          guard
        )
      ) {
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

    // If it leaves its rectangle, rotate (cw or ccw) and retry
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
    if (
      !isWalkable(nextCol, nextRow) ||
      isCellOccupiedByOtherGuard(nextCol, nextRow, guard)
    ) {
      rotateGuardDirClockwise(guard);
      nextCol = guard.col + guard.dirX;
      nextRow = guard.row + guard.dirY;

      if (
        !withinGuardRect(guard, nextCol, nextRow) ||
        !isWalkable(nextCol, nextRow) ||
        isCellOccupiedByOtherGuard(nextCol, nextRow, guard)
      ) {
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
    const dirs = ['N', 'E', 'S', 'W'];
    const layoutType = getLayoutType();

    // Dungeon: group guards by patrol room (rect) instead of global sectors
    if (layoutType === 'dungeon') {
      const rooms = {};

      guards.forEach((g) => {
        if (g.state === 'stunned' || g.state === 'dead') {
          g.preferredCardinal = null;
          return;
        }

        const key = getGuardRoomKey(g) || 'default';
        if (!rooms[key]) rooms[key] = [];
        rooms[key].push(g);
      });

      for (const key in rooms) {
        const list = rooms[key];
        for (let i = 0; i < list.length; i++) {
          const g = list[i];
          g.preferredCardinal = dirs[i % dirs.length];
        }
      }

      return;
    }

    // Arena: original per-sector cardinal assignment
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

    ['NW', 'NE', 'SW', 'SE'].forEach((name) => {
      const list = sectors[name] || [];
      for (let i = 0; i < list.length; i++) {
        const g = list[i];
        g.preferredCardinal = dirs[i % dirs.length];
      }
    });
  }

  function computePreferredAlertTarget(guard) {
    const layoutType = getLayoutType();

    // Dungeon: room-based behaviour + optional last_seen targeting
    if (layoutType === 'dungeon') {
      const roomKey = getGuardRoomKey(guard);
      const ra = roomAlerts[roomKey];

      let px;
      let py;

      const hasStaticTarget =
        ra &&
        ra.state === 'tracking' &&
        (ra.source === 'bait' ||
         ra.source === 'corpse' ||
         ra.source === 'stunned_guard' ||
         ra.source === 'hit') &&
        typeof ra.targetCol === 'number' &&
        typeof ra.targetRow === 'number';

      if (hasStaticTarget) {
        // Chase the reported position (bait/corpse/stunned/hit event)
        px = ra.targetCol;
        py = ra.targetRow;
      } else {
        // Base target: live player position
        px = playerCol;
        py = playerRow;

        if (
          ALERT_TARGET_MODE === 'last_seen' &&
          ra &&
          ra.state === 'tracking' &&
          ra.source === 'player' &&
          ra.seeingNow !== true &&
          typeof ra.targetCol === 'number' &&
          typeof ra.targetRow === 'number'
        ) {
          px = ra.targetCol;
          py = ra.targetRow;
        }
      }


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
          // 'E' or fallback
          cx = px + r;
        }

        if (cx < 0 || cy < 0 || cx >= gridCols || cy >= gridRows) continue;
        if (!isWalkable(cx, cy)) continue;
        if (cx === px && cy === py) continue;

        return { col: cx, row: cy };
      }

      // Fallback: small ring around target position
      for (let r = 1; r <= maxR; r++) {
        const candidates = [
          { col: px + r, row: py },
          { col: px - r, row: py },
          { col: px,     row: py + r },
          { col: px,     row: py - r }
        ];
        for (let i = 0; i < candidates.length; i++) {
          const c = candidates[i];
          if (c.col < 0 || c.row < 0 || c.col >= gridCols || c.row >= gridRows) continue;
          if (!isWalkable(c.col, c.row)) continue;
          if (c.col === px && c.row === py) continue;
          return c;
        }
      }

      return { col: px, row: py };
    }

    // Arena: sector-based behaviour + optional last_seen targeting
    const sectorName = getSector(guard.col, guard.row);
    const sa = sectorAlerts[sectorName];
    if (!sa || sa.state !== 'tracking') {
      // No active alert for this sector: stay where you are
      return { col: guard.col, row: guard.row };
    }

    let px;
    let py;

    const hasStaticTarget =
      (sa.source === 'bait' ||
       sa.source === 'corpse' ||
       sa.source === 'stunned_guard' ||
       sa.source === 'hit') &&
      typeof sa.targetCol === 'number' &&
      typeof sa.targetRow === 'number';

    if (hasStaticTarget) {
      px = sa.targetCol;
      py = sa.targetRow;
    } else {
      // Base target: live player position
      px = playerCol;
      py = playerRow;

      // In 'last_seen' mode, if this sector is in memory (tracking but no one sees now),
      // use the stored last seen position instead (if available).
      if (
        ALERT_TARGET_MODE === 'last_seen' &&
        sa.seeingNow !== true &&
        typeof sa.targetCol === 'number' &&
        typeof sa.targetRow === 'number'
      ) {
        px = sa.targetCol;
        py = sa.targetRow;
      }
    }

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
        // 'E' or fallback
        cx = px + r;
      }

      if (cx < 0 || cy < 0 || cx >= gridCols || cy >= gridRows) continue;
      if (!isWalkable(cx, cy)) continue;
      if (cx === px && cy === py) continue;

      return { col: cx, row: cy };
    }

    for (let r = 1; r <= maxR; r++) {
      const candidates = [
        { col: px + r, row: py },
        { col: px - r, row: py },
        { col: px,     row: py + r },
        { col: px,     row: py - r }
      ];
      for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i];
        if (c.col < 0 || c.row < 0 || c.col >= gridCols || c.row >= gridRows) continue;
        if (!isWalkable(c.col, c.row)) continue;
        if (c.col === px && c.row === py) continue;
        return c;
      }
    }

    return { col: px, row: py };
  }


// --------------------------------------------------
// Alert / chasing behavior (uses BFS towards preferred target)
// --------------------------------------------------

function stepGuardAlert(guard) {
  if (guard.state === 'stunned') return;

  const layoutType = getLayoutType();

  // Arena: keep sector gate; Dungeon: FSM is driven by roomAlerts, so skip it.
  if (layoutType !== 'dungeon') {
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
  }

  // -------------------------------------------------------
  // 1) Decide current "focus target":
  //    - player has priority if visible
  //    - otherwise, if a bait is visible, treat it exactly
  //      like the player (same behaviour, same micro-moves).
  // -------------------------------------------------------
  let targetType = null;      // "player" | "bait" | null
  let tx = null;
  let ty = null;

  if (guard.seenPlayer) {
    // Player in FOV: highest priority
    targetType = 'player';
    tx = playerCol;
    ty = playerRow;
  } else if (guard.seenBait && guard.seenBaitId != null) {
    // No player, but a bait is in FOV: use that as focus
    const bait = getBaitById(guard.seenBaitId);
    if (bait && bait.alive) {
      targetType = 'bait';
      tx = bait.col;
      ty = bait.row;
    }
  }

  // -------------------------------------------------------
  // 2) If we see a focus target (player or bait),
  //    FIRST try local solution:
  //      - orient towards it
  //      - try tiny local moves to gain line-of-shot
  //    If that fails, we NOW FALL THROUGH to BFS chasing
  //    instead of freezing in place.
  // -------------------------------------------------------
  if (targetType) {
    // Aim at the current focus (player or bait)
    aimGuardAtTarget(guard, tx, ty);

    // Already have line-of-shot -> stand here and shoot
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

      // Do not intentionally step on the target cell itself
      // (works for both player and bait).
      if (nc === tx && nr === ty) continue;

      if (!isWalkable(nc, nr)) continue;
      if (isCellOccupiedByOtherGuard(nc, nr, guard)) continue;

      const tmp = { col: nc, row: nr };
      if (!hasLineOfShot(tmp, tx, ty)) continue;

      // This local step improves line-of-shot, take it
      guard.col = nc;
      guard.row = nr;
      aimGuardAtTarget(guard, tx, ty);
      clampGuard(guard);
      updateGuardPosition(guard);
      updateGuardLookDirection(guard);
      return;
    }

    // IMPORTANT CHANGE:
    // Old behaviour here was:
    //   "Cannot improve: stay still, keep looking at the target" + return;
    // That caused guards to freeze when the bait/player was visible
    // but unreachable from any adjacent tile.
    //
    // Now we DO NOT return here: we fall through to the BFS logic
    // below, so the guard can try to reposition more aggressively
    // (e.g., turning corners, navigating narrow corridors, etc.).
  }

  // -------------------------------------------------------
  // 3) We do NOT currently have a good shooting position:
  //    -> chase towards a preferred cardinal slot around
  //       the current alert target (player or bait), based
  //       on sector / room alert data.
  // -------------------------------------------------------
  const preferred = computePreferredAlertTarget(guard);
  const targetCol = preferred.col;
  const targetRow = preferred.row;

  // Face the current alert target slot
  // (in dungeon mode this comes from roomAlerts).
  aimGuardAtTarget(guard, targetCol, targetRow);

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
    if (!guard.lastPositions) {
      guard.lastPositions = [];
    }

    const currentPos = { col: guard.col, row: guard.row };

    // Track how many consecutive ticks we stayed on the same cell
    if (guard.lastPositions.length > 0) {
      const last = guard.lastPositions[guard.lastPositions.length - 1];
      if (last.col === currentPos.col && last.row === currentPos.row) {
        guard.stillTicks = (guard.stillTicks || 0) + 1;
      } else {
        guard.stillTicks = 0;
      }
    } else {
      guard.stillTicks = 0;
    }

    // Store a short history to detect A-B-A-B oscillation
    guard.lastPositions.push(currentPos);
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

    // We only want to apply the heavy "try hard" reset in dungeon layout,
    // and only when the guard is in a calm state (not actively chasing).
    const layoutType = getLayoutType();
    const isDungeon = (layoutType === 'dungeon');

    const isCalmState =
      guard.state === 'patrol' ||
      guard.state === 'return_to_patrol';

    const notEngaged =
      !guard.seenPlayer &&
      guard.shootCooldown === 0 &&
      guard.observingTicksLeft <= 0;

    const hasLongStill =
      typeof guard.stillTicks === 'number' &&
      guard.stillTicks >= GUARD_TRY_HARD_STUCK_TICKS;

    const hasOscillation =
      typeof guard.stuckCounter === 'number' &&
      guard.stuckCounter >= 4 &&
      guard.stillTicks >= (GUARD_TRY_HARD_STUCK_TICKS / 2);

    const shouldTryHard =
      isDungeon &&
      isCalmState &&
      notEngaged &&
      (hasLongStill || hasOscillation);

    if (shouldTryHard) {
      forceGuardTryHard(guard);
      // Counters are reset inside forceGuardTryHard, but we clear anyway for safety
      guard.stuckCounter = 0;
      guard.stillTicks = 0;
      guard.lastPositions = [];
    }
  }


  // Force a guard that is stuck for too long to "try hard":
  // teleport back to a safe walkable cell inside its patrol rect.
  function forceGuardTryHard(guard) {
    if (!guard) return;

    // Do not touch dead or stunned guards
    if (guard.state === 'dead' || guard.state === 'stunned') {
      return;
    }

    // If the guard is actually seeing the player while chasing, do not reset
    if (guard.state === 'alert_chaser' && guard.seenPlayer) {
      return;
    }

    // Determine the rectangle where we are allowed to place the guard
    let minCol = 0;
    let maxCol = gridCols - 1;
    let minRow = 0;
    let maxRow = gridRows - 1;

    if (guard.patrolType === 'rect') {
      minCol = guard.minCol;
      maxCol = guard.maxCol;
      minRow = guard.minRow;
      maxRow = guard.maxRow;
    }

    // Prefer cells slightly away from the walls (margin=1), fallback to full rect
    let candidates = buildWalkableCandidatesInRect(
      minCol,
      maxCol,
      minRow,
      maxRow,
      1
    );
    if (!candidates || candidates.length === 0) {
      candidates = buildWalkableCandidatesInRect(
        minCol,
        maxCol,
        minRow,
        maxRow,
        0
      );
    }
    if (!candidates || candidates.length === 0) {
      return; // nothing usable, give up
    }

    // Random choice among valid cells
    shuffleArray(candidates);
    const chosen = candidates[0];

    guard.col = chosen.col;
    guard.row = chosen.row;

    // Reset navigation / behaviours so they can start fresh
    guard.path = null;
    guard.pathTargetCol = null;
    guard.pathTargetRow = null;
    guard.deviationActive = false;
    guard.observingTicksLeft = 0;

    // Calm state after reset (unless the FSM decides otherwise later)
    if (
      guard.state !== 'alert_chaser' &&
      guard.state !== 'return_to_patrol'
    ) {
      guard.state = 'patrol';
    }

    guard.lastPositions = [];
    guard.stuckCounter = 0;
    guard.stillTicks = 0;

    clampGuard(guard);
    updateGuardPosition(guard);
    updateGuardLookDirection(guard);

    console.log(
      '[overlay] GUARD',
      guard.id,
      'try-hard reset to',
      guard.col,
      guard.row
    );
  }

  function stepGuard(guard) {
    // DEAD state: no movement, no behavior
    if (guard.state === 'dead') {
      return;
    }

    // STUNNED state
    if (guard.state === 'stunned') {
      // Cancel patrol extra behaviours while stunned
      guard.deviationActive = false;
      guard.observingTicksLeft = 0;

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
      // Any special patrol behaviour is cancelled while chasing
      guard.deviationActive = false;
      guard.observingTicksLeft = 0;

      const stepsThisTick = getGuardStepsPerTick(guard);
      for (let i = 0; i < stepsThisTick; i++) {
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
      // Stop any patrol-side behaviour while returning
      guard.deviationActive = false;
      guard.observingTicksLeft = 0;

      const stepsThisTick = getGuardStepsPerTick(guard);
      for (let i = 0; i < stepsThisTick; i++) {
        stepGuardReturnToPatrol(guard);
        if (guard.state !== 'return_to_patrol') {
          break;
        }
      }
      registerGuardMovementHistory(guard);
      return;
    }

    // Default: PATROL (including observing & deviation sub-behaviours)
    const stepsThisTick = getGuardStepsPerTick(guard);
    for (let i = 0; i < stepsThisTick; i++) {
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

    // Stop any ongoing movement animation and snap to logical position
    if (guard.activeRenderAnimation && typeof guard.activeRenderAnimation.cancel === 'function') {
      guard.activeRenderAnimation.cancel();
      guard.activeRenderAnimation = null;
    }
    updateGuardPosition(guard);

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
    guard.renderTrail = null;
    guard.renderTrailTick = null;

    if (guard.el) {
      guard.el.style.opacity = '0.9';
    }

    updateGuardSpriteAppearance(guard);
    console.log('[overlay] GUARD KILLED by player:', guard.id);

    // NEW: gestisci eventuale drop della KEY
    handleGuardDeathDrops(guard);
    spawnGuardLoot(guard);
  }


  function triggerTemporaryAlertForGuard(guard, source, targetCol, targetRow) {
    if (!guard) return;

    const layoutType = getLayoutType();
    const safeCol = (typeof targetCol === 'number') ? targetCol : null;
    const safeRow = (typeof targetRow === 'number') ? targetRow : null;

    if (layoutType === 'dungeon') {
      const roomKey = getGuardRoomKey(guard);
      const ra = ensureRoomAlertEntry(roomKey);
      if (ra) {
        if (ra.state !== 'tracking') {
          ra.state = 'tracking';
          ra.timer = ALERT_MEMORY_TICKS;
          ra.source = source;
          ra.sourceBaitId = null;
          ra.targetCol = safeCol;
          ra.targetRow = safeRow;
        } else if (
          ra.targetCol == null &&
          ra.targetRow == null &&
          safeCol != null &&
          safeRow != null
        ) {
          ra.targetCol = safeCol;
          ra.targetRow = safeRow;
        }
        if (typeof ra.tempBoost !== 'number') {
          ra.tempBoost = 1.0;
        }
        if (ra.tempBoost < TEMP_ALERT_SPEED_MULT) {
          ra.tempBoost = TEMP_ALERT_SPEED_MULT;
        }
      }
    } else {
      const sectorName = getSector(guard.col, guard.row);
      const sa = sectorAlerts[sectorName];
      if (sa) {
        if (sa.state !== 'tracking') {
          sa.state = 'tracking';
          sa.timer = ALERT_MEMORY_TICKS;
          sa.source = source;
          sa.sourceBaitId = null;
          sa.targetCol = safeCol;
          sa.targetRow = safeRow;
        } else if (
          sa.targetCol == null &&
          sa.targetRow == null &&
          safeCol != null &&
          safeRow != null
        ) {
          sa.targetCol = safeCol;
          sa.targetRow = safeRow;
        }
        if (typeof sa.tempBoost !== 'number') {
          sa.tempBoost = 1.0;
        }
        if (sa.tempBoost < TEMP_ALERT_SPEED_MULT) {
          sa.tempBoost = TEMP_ALERT_SPEED_MULT;
        }
      }
    }

    if (guard.state !== 'stunned') {
      guard.state = 'alert_chaser';
    }
  }


  function applyGuardHit(guard, sourceBullet) {
    if (!guard || guard.state === 'dead') return;

    // Turn toward the incoming shot direction
    if (sourceBullet && typeof sourceBullet.dx === 'number' && typeof sourceBullet.dy === 'number') {
      const dirX = -Math.sign(sourceBullet.dx);
      const dirY = -Math.sign(sourceBullet.dy);
      if (dirX !== 0 || dirY !== 0) {
        guard.dirX = dirX;
        guard.dirY = dirY;
        updateGuardLookDirection(guard);
      }
    }

    // Trigger alert + temporary speed boost for this area
    triggerTemporaryAlertForGuard(guard, 'hit', guard.col, guard.row);

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

    // NEW: handle key-drop on guard death (for getKey ritual)
  function handleGuardDeathDrops(guard) {
    if (!guard) return;

    const trigIndex =
      typeof guard.keyForTriggerIndex === 'number'
        ? guard.keyForTriggerIndex
        : null;

    if (
      trigIndex == null ||
      !triggerRuntimeState[trigIndex] ||
      triggerRuntimeState[trigIndex].completed ||
      triggerRuntimeState[trigIndex].keyDropped
    ) {
      return;
    }

    dropKeyForTrigger(guard, trigIndex);
  }

  function spawnGuardLoot(guard) {
    if (!guard) return;

    function trySpawn(type) {
      const pos = findAdjacentFreeCell(guard.col, guard.row);
      if (!pos) return;
      createPickup(type, pos.col, pos.row);
    }

    if (Math.random() < BASIC_LOOT_CHANCE) {
      const basicType = Math.random() < 0.5 ? 'ammo' : 'medikit';
      trySpawn(basicType);
    }

    if (Math.random() < SPECIAL_LOOT_CHANCE) {
      const specials = ['rifle', 'shield', 'bait', 'grenade'];
      const pick = specials[Math.floor(Math.random() * specials.length)];
      trySpawn(pick);
    }
  }

  function dropKeyForTrigger(guard, triggerIndex) {
    const state = triggerRuntimeState[triggerIndex];
    if (!state) return;

    const maxAttempts = 32;
    let dropCol = guard.col;
    let dropRow = guard.row;

    // Try neighbouring cells first
    const offsets = [
      { dx: 0, dy: -1 },
      { dx: 1, dy: 0 },
      { dx: 0, dy: 1 },
      { dx: -1, dy: 0 },
      { dx: 1, dy: -1 },
      { dx: 1, dy: 1 },
      { dx: -1, dy: 1 },
      { dx: -1, dy: -1 }
    ];

    let placed = false;
    for (let i = 0; i < offsets.length; i++) {
      const c = guard.col + offsets[i].dx;
      const r = guard.row + offsets[i].dy;
      if (c < 0 || r < 0 || c >= gridCols || r >= gridRows) continue;
      if (!isCellFreeForPickup(c, r)) continue;
      dropCol = c;
      dropRow = r;
      placed = true;
      break;
    }

    if (!placed) {
      // Last resort: stessa cella della guardia (morta = non blocca i pickup)
      dropCol = guard.col;
      dropRow = guard.row;
    }

    const pickup = createPickup('key', dropCol, dropRow, {
      keyTriggerIndex: triggerIndex
    });

    if (!pickup) return;

    state.keyDropped = true;

    console.log(
      '[overlay] KEY dropped for trigger',
      liberationTriggers[triggerIndex] &&
        (liberationTriggers[triggerIndex].id || triggerIndex),
      'by guard',
      guard.id,
      'at',
      dropCol,
      dropRow
    );
  }


  function applyPickupEffect(pickup) {
    if (!pickup) return false; // false = not consumed

    // NEW: KEY pickup (per ritual getKey)
    if (pickup.type === 'key') {
      const idx =
        typeof pickup.keyTriggerIndex === 'number'
          ? pickup.keyTriggerIndex
          : null;

      if (
        idx != null &&
        liberationTriggers &&
        liberationTriggers[idx]
      ) {
        const st = triggerRuntimeState[idx];
        if (st) {
          st.keyOwned = true;
        }
        console.log(
          '[overlay] PLAYER picked KEY for trigger',
          liberationTriggers[idx].id || idx
        );
      } else {
        console.log('[overlay] PLAYER picked generic KEY (no trigger bound).');
      }

      // La key viene sempre consumata quando raccolta
      updateModeVisual();
      return true;
    }

    if (pickup.type === 'medikit') {
      if (playerHP < playerHPMax) {
        playerHP++;
        if (playerHP > playerHPMax) playerHP = playerHPMax;
        console.log(
          '[overlay] PLAYER picked MEDIKIT. HP:',
          playerHP,
          '/',
          playerHPMax
        );
        updatePlayerSpriteFill();
        updateModeVisual();
        return true; // consumed
      } else {
        console.log(
          '[overlay] PLAYER picked MEDIKIT but is already at full HP.'
        );
        return false; // not consumed
      }
    } else if (pickup.type === 'ammo') {
      if (playerAmmo < playerAmmoMax) {
        playerAmmo++;
        if (playerAmmo > playerAmmoMax) playerAmmo = playerAmmoMax;
        console.log(
          '[overlay] PLAYER picked AMMO. AMMO:',
          playerAmmo,
          '/',
          playerAmmoMax
        );
        updatePlayerSpriteFill();
        updateModeVisual();
        return true;
      } else {
        console.log(
          '[overlay] PLAYER picked AMMO but is already at max ammo.'
        );
        return false;
      }
    } else if (pickup.type === 'bait') {
      if (playerBaits < PLAYER_BAIT_MAX) {
        playerBaits++;
        if (playerBaits > PLAYER_BAIT_MAX) playerBaits = PLAYER_BAIT_MAX;
        console.log(
          '[overlay] PLAYER picked BAIT. BAIT:',
          playerBaits,
          '/',
          PLAYER_BAIT_MAX
        );
        updatePlayerSpriteFill();
        updateModeVisual();
        return true;
      } else {
        console.log(
          '[overlay] PLAYER picked BAIT but is already at max bait.'
        );
        return false;
      }
    } else if (pickup.type === 'rifle') {
      if (playerRifles < PLAYER_RIFLE_MAX) {
        playerRifles++;
        if (playerRifles > PLAYER_RIFLE_MAX) playerRifles = PLAYER_RIFLE_MAX;
        console.log(
          '[overlay] PLAYER picked RIFLE charge. RIFLE:',
          playerRifles,
          '/',
          PLAYER_RIFLE_MAX
        );
        updateModeVisual();
        return true;
      } else {
        console.log(
          '[overlay] PLAYER picked RIFLE but is already at max charges.'
        );
        return false;
      }
    } else if (pickup.type === 'shield') {
      if (playerShields < SHIELD_MAX) {
        playerShields++;
        if (playerShields > SHIELD_MAX) playerShields = SHIELD_MAX;
        console.log(
          '[overlay] PLAYER picked SHIELD charge. SHIELD:',
          playerShields,
          '/',
          SHIELD_MAX
        );
        updateModeVisual();
        return true;
      } else {
        console.log(
          '[overlay] PLAYER picked SHIELD but is already at max charges.'
        );
        return false;
      }
    } else if (pickup.type === 'grenade') {
      if (playerGrenades < PLAYER_GRENADE_MAX) {
        playerGrenades++;
        if (playerGrenades > PLAYER_GRENADE_MAX) playerGrenades = PLAYER_GRENADE_MAX;
        console.log(
          '[overlay] PLAYER picked GRENADE. GRENADE:',
          playerGrenades,
          '/',
          PLAYER_GRENADE_MAX
        );
        updateModeVisual();
        return true;
      } else {
        console.log(
          '[overlay] PLAYER picked GRENADE but is already at max grenades.'
        );
        return false;
      }
    }

    return false;
  }


  function checkPickupCollisions() {
    for (let i = 0; i < pickups.length; i++) {
      const p = pickups[i];
      if (p.collected) continue;
      if (p.col === playerCol && p.row === playerRow) {
        const consumed = applyPickupEffect(p);
        if (consumed) {
          p.collected = true;
          if (p.el && p.el.parentNode) {
            p.el.parentNode.removeChild(p.el);
          }
        }
      }
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
    if (guard.activeRenderAnimation && typeof guard.activeRenderAnimation.cancel === 'function') {
      guard.activeRenderAnimation.cancel();
      guard.activeRenderAnimation = null;
    }
    guard.renderTrail = null;
    guard.renderTrailTick = null;
    updateGuardPosition(guard);
    if (guard.el) {
      guard.el.style.opacity = '0.25';
    }
    console.log('[overlay] GUARD STUNNED by player (3s):', guard.id);
    updateGuardSpriteAppearance(guard);
  }

  // Trigger GAME OVER: stop simulation and show overlay
  function triggerGameOver() {
    if (isGameOver) return;
    isGameOver = true;

    // Stop guards timer so world stops advancing
    if (guardTimer) {
      clearInterval(guardTimer);
      guardTimer = null;
    }
    exitRifleAim('game-over');
    clearRifleBeams();
    shieldActive = false;
    shieldTicks = 0;
    shieldBlinkTicks = 0;
    setPlayerColor('yellow');
    updatePlayerSpriteFill();

    if (gameOverDiv) {
      gameOverDiv.style.display = 'flex';
    }

    // Refresh HUD/background for game over state
    updateModeVisual();

    console.log('[overlay] GAME OVER triggered (player HP <= 0)');
  }


  function applyPlayerHit(source) {
    // Ignore extra hits once we are already in game over
    if (isGameOver) {
      return;
    }

    if (shieldActive) {
      shieldActive = false;
      shieldTicks = 0;
      shieldBlinkTicks = SHIELD_BLINK_TICKS;
      console.log('[overlay] SHIELD absorbed damage.');
      return;
    }

    if (playerHitCooldown > 0) {
      return;
    }

    playerHP--;
    if (playerHP < 0) playerHP = 0;
    updatePlayerSpriteFill();

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

    // If HP is now zero or below, trigger GAME OVER
    if (playerHP <= 0) {
      triggerGameOver();
      return;
    }

    // Normal damage feedback
    updateModeVisual();

    // Flash red briefly
    if (overlayDiv) {
      overlayDiv.style.background = 'rgba(255, 0, 0, 0.35)';
      setTimeout(() => {
        updateModeVisual();
      }, 150);
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

    // If game is over, world simulation is frozen
    if (isGameOver) return;

    // Freeze guards/actions after final unlock
    if (guardsFrozen) {
      // Still run minimal timers for blinking
      worldTick++;
      if (playerHitCooldown > 0) {
        playerHitCooldown--;
      }
      if (playerMoveCooldownTicks > 0) {
        playerMoveCooldownTicks--;
      }
      updatePickupsBlink();
      updateRifleBeams();
      updatePlayerBlink();
      updateShieldState();
      stepGrenades();
      updateGrenadeExplosions();
      return;
    }

    // Advance global world tick
    worldTick++;

    // Hard safety: make sure guards are never stuck inside walls.
    // If a guard starts in a non-walkable cell (e.g. dungeon generator edge cases),
    // we snap it once per tick to the nearest walkable cell.
    ensureGuardsOnWalkableCells();

    // Cooldown danno al player
    if (playerHitCooldown > 0) {
      playerHitCooldown--;
    }
    if (playerMoveCooldownTicks > 0) {
      playerMoveCooldownTicks--;
    }

    // If A is held and we are standing on a corpse, auto-start dragging
    if (playerDragKeyHeld && !playerDraggingCorpse) {
      tryStartDraggingCorpse();
    }

    // Assegna slot cardinali per settore (N/E/S/W) una volta per tick
    assignSectorCardinals();

    // 1) Tick di "percezione": aggiorna FOV + stati di alert + memoria 3s
    updateAllFovAndAlert(true);
    // Four-corners: if alert and partial progress, start reset countdown
    maybeStartFourCornersResetOnAlert();

    // 2) Movimento guardie (patrol / alert / stunned)
    beginGuardStepAnimationRecording();
    guards.forEach(stepGuard);

    // 3) Ricalcola solo le forme dei FOV dopo il movimento (senza toccare timer)
    updateAllFovAndAlert(false);

    // 3.5) Rifle aim tracking (FOV + target) after positions are updated
    updateRifleAimState(false);

    // 4) Attacchi a distanza
    guards.forEach(shootingTickForGuard);

    // 5) Animate multi-step guard movement for this tick
    flushGuardStepAnimations();

    // 5) Movimento proiettili
    stepBullets();
    stepGrenades();

    // 6) Collisioni corpo a corpo (stealth / danno)
    checkGuardPlayerCollisions();

    // 6.5) Rifle beams decay
    updateRifleBeams();
    updateGrenadeExplosions();

    // 7) Blink pickups
    updatePickupsBlink();

    // 8) Pressure tiles ritual handling
    updatePressureTilesState();

    // 9) Four-corners reset countdown (alert decay)
    updateFourCornersResetCountdowns();

    // 10) Player blink while invulnerable
    updatePlayerBlink();
    // 11) Shield timers / visuals
    updateShieldState();

  }


  // --------------------------------------------------
  // Player movement
  // --------------------------------------------------

  function getPlayerDragMoveCooldownTicks() {
    const mult = Math.max(PLAYER_DRAG_SPEED_MULT, 0.01);
    const slowdownTicks = Math.max(0, Math.round((1 / mult) - 1));
    return slowdownTicks;
  }

  function stopDraggingCorpse() {
    if (playerDraggedGuard) {
      playerDraggedGuard.draggedByPlayer = false;
    }
    playerDraggingCorpse = false;
    playerDraggedGuard = null;
    playerDragKeyHeld = false;
    playerMoveCooldownTicks = 0;
  }

  function tryStartDraggingCorpse() {
    if (playerDraggingCorpse) {
      return true;
    }

    let corpse = findDeadGuardAtCell(playerCol, playerRow);

    // If none underfoot, try snapping onto an adjacent corpse cell (cardinal)
    if (!corpse) {
      const offsets = [
        { dx: 1, dy: 0 },
        { dx: -1, dy: 0 },
        { dx: 0, dy: 1 },
        { dx: 0, dy: -1 }
      ];
      for (let i = 0; i < offsets.length; i++) {
        const nx = playerCol + offsets[i].dx;
        const ny = playerRow + offsets[i].dy;
        const c = findDeadGuardAtCell(nx, ny);
        if (c) {
          playerCol = nx;
          playerRow = ny;
          updatePlayerPosition();
          corpse = c;
          break;
        }
      }
    }
    if (!corpse) {
      return false;
    }
    if (corpse.state !== 'dead' && corpse.dead !== true) {
      return false;
    }
    playerDraggingCorpse = true;
    playerDraggedGuard = corpse;
    playerDragKeyHeld = true;
    corpse.draggedByPlayer = true;
    corpse.col = playerCol;
    corpse.row = playerRow;
    clampGuard(corpse);
    updateGuardPosition(corpse);
    playerMoveCooldownTicks = 0; // allow immediate first move
    return true;
  }

  function tryMovePlayer(dCol, dRow, newDir) {
    // Do not move if game is over
    if (isGameOver) {
      return;
    }

    if (rifleAimActive) {
      exitRifleAim('player-move-input');
    }

    // Respect movement cooldown while dragging a corpse
    if (playerDraggingCorpse && playerMoveCooldownTicks > 0) {
      return;
    }

    // If somehow the dragged guard disappeared, stop dragging
    if (playerDraggingCorpse && (!playerDraggedGuard || playerDraggedGuard.state !== 'dead')) {
      stopDraggingCorpse();
    }

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

    // Move the dragged corpse along with the player
    if (playerDraggingCorpse && playerDraggedGuard) {
      playerDraggedGuard.col = playerCol;
      playerDraggedGuard.row = playerRow;
      clampGuard(playerDraggedGuard);
      updateGuardPosition(playerDraggedGuard);
    }

    // If A is held and we just stepped onto a corpse, auto-start dragging
    if (!playerDraggingCorpse && playerDragKeyHeld) {
      tryStartDraggingCorpse();
    }

    if (playerDraggingCorpse) {
      playerMoveCooldownTicks = getPlayerDragMoveCooldownTicks();
    } else {
      playerMoveCooldownTicks = 0;
    }

    clampPlayer();
    updatePlayerPosition();
    updatePlayerDirectionVisual();
    // update only FOV, alert and guard reactions will be done in the main tick
    updateAllFovAndAlert(false);
    checkGuardPlayerCollisions();
    checkPickupCollisions();

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

    // GAME mode and already game over: block input (except F1 handled above)
    if (mode === 'game' && isGameOver) {
      ev.preventDefault();
      ev.stopPropagation();
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

    // Block everything else, except arrows, A, shoot keys, F, D
    ev.preventDefault();
    ev.stopPropagation();

    const isArrow =
      key === 'ArrowUp' ||
      key === 'ArrowDown' ||
      key === 'ArrowLeft' ||
      key === 'ArrowRight';

    // While dragging a corpse, arrows move; A keeps dragging; F still cycles equipment
    if (playerDraggingCorpse) {
      if (key === 'a' || key === 'A') {
        playerDragKeyHeld = true;
        return;
      }
      if (key === 'f' || key === 'F') {
        cycleSelectedEquipment();
        return;
      }
      if (isArrow) {
        if (key === 'ArrowUp') {
          tryMovePlayer(0, -1, 'up');
        } else if (key === 'ArrowDown') {
          tryMovePlayer(0, 1, 'down');
        } else if (key === 'ArrowLeft') {
          tryMovePlayer(-1, 0, 'left');
        } else if (key === 'ArrowRight') {
          tryMovePlayer(1, 0, 'right');
        }
      }
      return;
    }

    if (isArrow) {
      if (key === 'ArrowUp') {
        tryMovePlayer(0, -1, 'up');
      } else if (key === 'ArrowDown') {
        tryMovePlayer(0, 1, 'down');
      } else if (key === 'ArrowLeft') {
        tryMovePlayer(-1, 0, 'left');
      } else if (key === 'ArrowRight') {
        tryMovePlayer(1, 0, 'right');
      }
    } else if (key === 'a' || key === 'A') {
      playerDragKeyHeld = true;
      // If on a corpse, start dragging; otherwise use normal activation
      if (!tryStartDraggingCorpse()) {
        tryActivateNearbyMarker();
      }
    } else if (PLAYER_SHOOT_KEYS.indexOf(key) !== -1) {
      // Player shoots in the facing direction
      spawnBulletFromPlayer();
    } else if (key === 'f' || key === 'F') {
      if (rifleAimActive && getSelectedEquipmentId() === 'rifle') {
        cycleRifleTarget();
      } else {
        cycleSelectedEquipment();
      }
    } else if (key === 'd' || key === 'D') {
      useSelectedEquipment();
    } else {

      if (DEBUG) {
        console.log(
          '[overlay] Key blocked in GAME mode (not arrows, not Space/A/S/D/F):',
          key
        );
      }
      return;
    }
  }

  function onKeyUp(ev) {
    const key = ev.key;

    if (mode === 'edit') return;

    if (key === 'a' || key === 'A') {
      ev.preventDefault();
      ev.stopPropagation();
      playerDragKeyHeld = false;
      if (playerDraggingCorpse) {
        stopDraggingCorpse();
      }
    }
  }


  function useSelectedEquipment() {
    const selected = getSelectedEquipment();
    if (!selected) return;

    if (selected.id === 'bait') {
      placeBaitInFrontOfPlayer();
    } else if (selected.id === 'rifle') {
      handleRifleAction();
    } else if (selected.id === 'shield') {
      handleShieldAction();
    } else if (selected.id === 'grenade') {
      handleGrenadeAction();
    } else {
      // Placeholder for future equipment mechanics (shield / grenade / rifle)
    }
  }

  function handleRifleAction() {
    if (playerRifles <= 0) {
      console.log('[overlay] PLAYER tried to use RIFLE but inventory is empty.');
      exitRifleAim('no-rifle');
      return;
    }

    if (!rifleAimActive) {
      enterRifleAim();
      return;
    }

    if (!rifleAimTargetGuardId) {
      exitRifleAim('no-target');
      return;
    }

    fireRifleShot();
  }

  function handleShieldAction() {
    if (shieldActive) {
      // Already active, ignore re-activation
      return;
    }
    if (playerShields <= 0) {
      console.log('[overlay] PLAYER tried to use SHIELD but inventory is empty.');
      return;
    }
    playerShields--;
    if (playerShields < 0) playerShields = 0;
    shieldActive = true;
    shieldTicks = SHIELD_DURATION_TICKS;
    shieldBlinkTicks = 0;
    setPlayerColor('#ff00ff'); // bright fuchsia
    updateModeVisual();
  }

  function handleGrenadeAction() {
    if (playerGrenades <= 0) {
      console.log('[overlay] PLAYER tried to use GRENADE but inventory is empty.');
      return;
    }
    launchGrenadeFromPlayer();
  }

  function placeBaitInFrontOfPlayer() {
    // No baits in inventory
    if (playerBaits <= 0) {
      console.log('[overlay] PLAYER tried to place BAIT but inventory is empty.');
      return;
    }

    // Do not place if game is over
    if (isGameOver) return;

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

    const targetCol = playerCol + dx;
    const targetRow = playerRow + dy;

    if (
      targetCol < 0 ||
      targetRow < 0 ||
      targetCol >= gridCols ||
      targetRow >= gridRows
    ) {
      return;
    }

    // Use same constraints as pickups: walkable, no guard, no other bait, no pickup, no player
    if (!isCellFreeForPickup(targetCol, targetRow)) {
      console.log('[overlay] Cannot place BAIT on non-free cell at', targetCol, targetRow);
      return;
    }

    createPlacedBait(targetCol, targetRow);
    playerBaits--;
    if (playerBaits < 0) playerBaits = 0;
    updateModeVisual();
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
    window.addEventListener('keyup', onKeyUp, true);

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
