# ORCA STEALTH WRAPPER – DESIGN

## 1. High-Level Vision

This project adds a stealth/action game layer on top of the **ORCΛ** livecoding environment, using the **web version** of Orca as the core engine.

Core idea:

- The **Orca grid** is treated as a **top-down map**.
- **Orca operators** visible on the grid become:
  - walls and structures,
  - moving hazards (e.g. traveling operators interpreted as projectiles),
  - “frozen” musical sections when commented out.
- A **player** and **guards** are rendered as extra entities, occupying the same cell grid as Orca.
- The player’s goal is to **“liberate” the Orca patch**:
  - by reaching specific cells on the grid,
  - triggering Orca commands that remove comments or inject code,
  - gradually bringing the whole patch to life, musically.

The wrapper **does not replace Orca**:

- Orca continues to execute the patch and handle MIDI/OSC.
- The wrapper *reads* the visual/logical state of the grid and treats it as game terrain.
- When needed, the wrapper *writes* back into the grid using Orca’s command system (e.g. `write`, `inject`, etc.).

---

## 2. Goals

- Use **real Orca patches** as playable levels, not synthetic mockups.
- Avoid deep intrusive changes to the Orca core:
  - the wrapper lives **around** Orca (overlay + API calls), not inside its execution engine.
- Let Orca users:
  - open a `.orca` file,
  - enable a **game mode**,
  - play the level,
  - optionally drop back into standard Orca editing to tweak the patch.

Longer-term goals:

- Translate game state (stealth, alert, liberation) into **musical consequences**:
  - more sections unlocked = richer, more stable groove,
  - higher alert = glitchier, more intense audio.

---

## 3. Architecture Overview

### 3.1 Layers

1. **Orca (lower layer)**  
   - 2D text-based language and grid.
   - Executes operators every frame (tick).
   - Emits MIDI/OSC/UDP (depending on platform).
   - Renders the grid to a `<canvas>` in the browser (web version).

2. **Stealth Game Wrapper (upper layer)**  
   - A **transparent overlay canvas**, aligned 1:1 with Orca’s canvas (same pixel size and cell size).
   - Game logic:
     - global state (`GameState`),
     - player state,
     - guard AI and field-of-view,
     - collisions, alert level, objective completion.
   - Communication with Orca via:
     - **grid reads** (to know what’s in each cell),
     - **commands** (`write`, `inject`, `select`, etc.) to modify the patch when gameplay demands it.

### 3.2 File Layout (Wrapper)

Suggested structure inside the Orca repo:

```text
Orca/
  index.html          # web Orca entrypoint
  ...
  wrapper/
    design.md         # this design document
    src/
      overlay.js      # main wrapper/game logic + overlay rendering
      (optionally more JS files later)
```

`index.html` includes `wrapper/src/overlay.js` after all Orca scripts, so the wrapper has access to Orca’s global objects / APIs.

---

## 4. Core Game Concepts

### 4.1 Player

- Lives on **Orca grid coordinates** `(x, y)` (integer cell coordinates).
- Rendered on the overlay as a **single-cell icon** aligned with one grid cell.
- **Version 0 visual policy:** use ASCII-style rendering only (e.g. `@`, a filled rectangle, or simple text glyphs), no external sprite assets yet.
- Can move only through **walkable cells**.

**Movement rule (conceptual):**

- Before moving the player to `(nx, ny)`, the wrapper asks Orca:
  - `char = getCell(nx, ny)`
- If the character is defined as **solid** (e.g. letters, numbers, operators, or certain symbols), the cell is treated as a wall.
- If the cell is **empty** or marked as walkable, the player can move there.

The exact definition of “solid” vs “walkable” is configurable but should be simple in the first prototype.

---

### 4.2 Guards

- Each guard also lives on Orca grid coordinates `(x, y)`.
- Each guard has:
  - `dir` (facing direction: `"up"`, `"down"`, `"left"`, `"right"`),
  - `pattern` (patrol behavior, e.g. back-and-forth along a line),
  - `state` (e.g. `"idle"`, `"alert"`, `"chasing"`).
- A **field of view (FOV)** is defined in grid cells in front of the guard.
  - Initially can be very simple (straight line for N cells).
- **Version 0 visual policy:** guards are also rendered with ASCII-style graphics (e.g. a different character or colored rectangle), not sprite art.
- If the player enters a guard’s FOV:
  - The **global alert level** is raised.

---

### 4.3 Alert Level

- `alertLevel` can have discrete states, for example:
  - `0` – calm
  - `1` – suspicious
  - `2` – high alert
  - `"HUNT"` – full pursuit
- Consequences can include:
  - Visual:
    - stronger FOV coloration,
    - HUD indicators displayed on the overlay.
  - Audio (later iterations):
    - command Orca to adjust BPM,
    - inject extra rhythmic/dissonant patterns,
    - layer noise or distortions when alert is high.

**Version 0 alert visual policy:**

- All alert feedback is handled by the overlay:
  - tinted overlay layers (e.g. subtle red veil for alert),
  - changes in FOV color/intensity,
  - simple HUD indicators.
- The wrapper does **not** modify Orca’s internal themes/colors in v0.  
  Using Orca themes as alert feedback is considered a *future enhancement*.

---

### 4.4 Liberation Points

- Each level defines **liberation points**: specific grid positions that represent **locked / commented sections** of the Orca patch.
- When the player reaches such a point and presses the **action key**:
  - the wrapper:
    - updates its own state (`liberatedBlocks++`),
    - sends one or more **commands to Orca** to unlock the section:
      - e.g. remove a `#` comment,
      - insert specific operators,
      - inject a pre-made pattern via `inject`.
- Once enough liberation points have been triggered:
  - the level is considered **complete**.
  - Optionally, Orca’s patch enters a more “fully realized” musical state.

---

### 4.5 Using Orca Operators as Game Objects

The wrapper can interpret certain Orca operators as game entities:

- Example:
  - a south-moving operator `S` at cell `(x, y)` can be interpreted as a **projectile** moving downwards.
- Collision logic:
  - the wrapper scans the grid each frame:
    - if a cell contains `S` (or any defined projectile symbol),
    - and the player is on that same cell,
    - then the player is hit (damage/game over).
- Similarly, sequences of operators can be interpreted as:
  - moving hazards,
  - dynamic obstacles,
  - or color-coded “unsafe” zones.

This lets level designers create hazards using **pure Orca logic**, which the wrapper then interprets.

---

## 5. Game State Data Structures

### 5.1 GameState

Holds global game information:

```js
GameState = {
  mode: "game",           // "game" or "edit"
  alertLevel: 0,          // 0, 1, 2, "HUNT"
  liberatedBlocks: 0,     // number of liberated points so far
  levelGoal: 0,           // number of required liberation points
  isLevelComplete: false, // true when goal reached
};
```

### 5.2 Player

```js
Player = {
  x: 0,
  y: 0,
  alive: true
};
```

Later, additional fields can be added (e.g. health, inventory, abilities).

### 5.3 Guard

```js
Guard = {
  x: 0,
  y: 0,
  dir: "right",        // "up", "down", "left", "right"
  pattern: "line_lr",  // patrol pattern ID
  state: "idle"        // "idle", "alert", "chasing"
};
```

The wrapper holds an array of `Guard` objects per level.

### 5.4 Level Metadata

A level is a combination of:

- a **.orca file** (the patch itself), and
- **metadata** for the wrapper:

```js
Level = {
  orcaFile: "levels/level1.orca",
  preferredZoom: 1.0,   // v0: zoom set when entering game mode for this level
  playerStart: { x: 3, y: 12 },
  guards: [
    { x: 20, y: 5, dir: "left", pattern: "line_lr", state: "idle" },
    // more guards...
  ],
  liberationPoints: [
    { x: 15, y: 8 },
    { x: 32, y: 6 },
    // etc.
  ]
};
```

`preferredZoom` is used in v0 to set Orca’s zoom when the level is entered in game mode, and to restore a consistent 1:1 mapping between grid cells and overlay cells.

Future refinements may include different rules per level, win conditions, or scripted events.

---

## 6. Modes: Game vs Edit

To keep controls and UX sane, the wrapper distinguishes **two modes**:

### 6.1 Mode `"game"`

- Arrow keys / WASD:
  - **move the player** on the grid (handled by the wrapper).
- Action key (e.g. `E` or space):
  - if the player is standing on a liberation point,
    - attempt to liberate that block (update game state + send commands to Orca).
- Special key (e.g. `Tab` or `F1`):
  - toggles to `"edit"` mode.

In this mode, the user is “playing” the level, not editing the patch directly.

### 6.2 Mode `"edit"`

- All keys behave as **standard Orca input**:
  - writing operators,
  - selecting areas,
  - commenting/uncommenting, etc.
- The wrapper:
  - **freezes player movement** (no updates to the player position),
  - can still render the overlay (to keep orientation), but logical game progression is paused.

This mode is intended for:

- advanced Orca users who want to tweak the level live,
- debugging: being able to inspect and adjust the patch without leaving the wrapper environment.

---

## 7. Communication with Orca

The wrapper must be able to **read** and **write** Orca’s grid.

### 7.1 Reading the Grid

Conceptual function:

```js
function getCell(x, y) -> char | null
```

Uses:

- To decide if the player can walk into a cell:
  - treat certain characters as walls/solid.
- To detect hazards:
  - e.g. interpret `S` as projectile cells.
- To identify commented regions or special “markers” for liberation.

Implementation detail:

- Orca represents the grid internally as a 2D array or similar structure.
- The wrapper will hook into that structure and expose a helper such as `getCell(x, y)`.
- If Orca does not provide a public API for this, a small wrapper function can be added in Orca’s JS code.

### 7.2 Writing / Modifying the Grid

To change the patch in response to player actions, the wrapper uses Orca’s **command system** (used by the command line and the UDP protocol), e.g.:

- `write:H;12;34` → write glyph `H` at `(12, 34)`
- `select:3;4;5;6` → select an area (optional)
- `inject:pattern;12;34` → inject a `.orca` file at `(12, 34)` (optional)

The wrapper will wrap these commands in helper functions. Example:

```js
function writeCell(x, y, char) {
  orca.runCommand(`write:${char};${x};${y}`);
}
```

Then, when the player liberates a block:

1. The wrapper updates `GameState.liberatedBlocks`.
2. The wrapper calls `writeCell(...)` and/or `inject(...)` to actually modify the Orca grid.
3. Orca’s audio output reflects this change immediately.

Further commands (e.g. `play`, `stop`, `bpm:120`) can also be used later to control playback or tempo based on game events.

---

## 8. Game Loop (Wrapper Side)

The wrapper runs its own loop in parallel with Orca’s execution, typically using `requestAnimationFrame`.

Each frame:

### 8.1 `update()`

1. **Read input**:
   - Depending on `GameState.mode`:
     - in `"game"`: interpret arrow keys / WASD / action key as gameplay input,
     - in `"edit"`: ignore movement logic and let Orca handle input.

2. **Update player** (if in `"game"` mode):
   - Compute intended new position `(nx, ny)` based on input.
   - Call `getCell(nx, ny)` to decide if the cell is walkable.
   - If walkable, update player position.

3. **Update guards**:
   - For each guard:
     - Follow its patrol pattern (e.g. move left/right).
     - Update facing direction.

4. **Compute detection / FOV**:
   - For each guard:
     - Compute FOV region based on direction and range.
     - If the player is inside the FOV:
       - increase `alertLevel` (within reasonable bounds),
       - optionally update guard state (`"alert"`, `"chasing"`).

5. **Check collisions and hazards**:
   - Player vs guards (same cell → capture / damage).
   - Player vs hazardous cells:
     - e.g. any cell containing `S` or other designated hazard characters.

6. **Handle liberation logic**:
   - If the player is standing on a liberation point and the action key is pressed:
     - update `liberatedBlocks`,
     - call `writeCell` or `inject` to unlock the relevant patch region.
   - If `liberatedBlocks >= levelGoal`:
     - set `isLevelComplete = true`,
     - optionally trigger an Orca command (e.g. special pattern or visual cue).

### 8.2 `render()`

1. Clear the overlay canvas.
2. Draw:
   - Guards:
     - their positions,
     - optional FOV regions (e.g. tinted cells ahead).
   - Player:
     - at `(Player.x, Player.y)` aligned to Orca’s grid.
   - Liberation points:
     - highlight or icon to indicate points of interest.
   - Alert indicators:
     - e.g. change overlay color tone or draw an icon based on `alertLevel`.

3. Optionally update a simple HUD (outside the canvas) with:
   - current alert level,
   - liberated blocks vs total,
   - mode (`game` / `edit`).

---

## 9. Rendering & Zoom Policy (Version 0)

To keep the first implementation simple and robust, **Version 0** enforces a strict policy on zoom and visuals.

### 9.1 Zoom handling

- Each `Level` may optionally define a `preferredZoom` value (e.g. `1.0`).
- When entering **game mode** for a level:
  - The wrapper:
    - stores the current Orca zoom as `previousZoom`,
    - sets Orca’s zoom to `Level.preferredZoom` (or a default if not provided),
    - aligns the overlay canvas with Orca’s canvas using this fixed zoom.
- While in **game mode**:
  - User zoom controls in Orca are considered disabled/ignored.
  - The overlay assumes a **static 1:1 mapping** between Orca grid cells and overlay cells.
- When exiting **game mode** back to **edit mode**:
  - The wrapper restores `previousZoom`,
  - Orca returns to the user’s normal zoom behavior.

This avoids complex runtime rescaling and guarantees solid alignment between the overlay and Orca’s grid during gameplay.

### 9.2 Visual style (ASCII-only in v0)

- The overlay uses **ASCII-like visuals only** in Version 0:
  - Player and guards are represented as:
    - single characters (e.g. `@`, `G`) drawn on the overlay at cell centers, or
    - simple filled rectangles aligned to cell bounds.
  - No external sprite images are loaded or used in v0.
- This keeps:
  - the aesthetic strongly consistent with Orca’s text-based world,
  - the implementation minimal (no asset loading, no scaling issues).

Future versions may introduce small pixel-art sprites, but they are out of scope for v0.

### 9.3 Alert visuals (overlay-only in v0)

- All alert-level feedback (0, 1, 2, `"HUNT"`) is represented **only through the overlay**:
  - color changes in guard FOV,
  - global tinted overlay layers,
  - simple HUD indicators.
- The underlying Orca theme (colors of grid and text) is **not modified** by the wrapper in v0.
- Using Orca’s own theme system as a reflection of alert state is explicitly considered a **future enhancement**, and should not be implemented yet.

---

This design is intended as a **stable reference** for implementation:

- It defines *what* the wrapper should do and *how* it conceptually interacts with Orca.
- It keeps Orca’s core intact, using only minimal hooks (grid read/write, command execution).
- It provides a clear basis for incremental development:
  - first, overlay + player movement;
  - then guards and FOV;
  - then liberation points and patch modification;
  - and finally, deeper musical and visual reactivity once Version 0 is solid.
