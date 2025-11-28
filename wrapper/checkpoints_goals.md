# ORCA STEALTH WRAPPER – EARLY CHECKPOINTS

This document defines the **initial design goals and milestones** for building the Orca Stealth Wrapper, assuming a simple Orca patch is already running in the web version.

These checkpoints are intentionally small and focused, so they can be implemented and tested incrementally (and used as clear prompts for an LLM-based coding workflow).

---

## Checkpoint 1 – “Ghost Walking Through Code”

**Goal:**  
Have Orca Web running inside a `<div>` with an overlay on top that renders a controllable player character (e.g. `@`) which can move around the grid, obeying basic collision rules with the existing Orca text.

### Description

- Orca Web runs normally in the browser, drawing its grid to a canvas.
- A second, transparent overlay canvas is positioned exactly on top of Orca’s canvas.
- A **player** (rendered on the overlay, e.g. as `@` or a small square) can be moved with WASD (or arrow keys).
- The player:
  - **cannot enter “solid” cells** (cells where Orca shows letters, numbers, or operators),
  - **can stand only on empty cells** (visually blank grid cells).

No guards, no alert logic, and no liberation mechanics are implemented yet.

### Technical Requirements

1. **Orca Web in a container**
   - Orca’s existing web UI is displayed inside a known container element (e.g. a `<div id="orca-container">`).
   - The wrapper script (`overlay.js`) is included from `index.html` after Orca’s own scripts.

2. **Overlay canvas**
   - A `<canvas id="overlay">` is created and positioned on top of Orca’s canvas.
   - It shares the same width, height, and cell size (so that grid cells line up exactly).
   - It is transparent, so Orca’s grid is visible underneath.

3. **Player representation**
   - A `Player` object exists in JS, e.g.:
     ```js
     const Player = {
       x: 5,
       y: 10,
       alive: true
     };
     ```
   - Coordinates `(x, y)` match Orca’s grid coordinates.

4. **Input handling in “game mode”**
   - A simple game mode state exists:
     ```js
     const GameState = {
       mode: "game" // future: "edit"
     };
     ```
   - When `GameState.mode === "game"`:
     - WASD / arrow keys move the player attempt in that direction.
     - Orca’s own editing input is suppressed or bypassed for these keys (or is only active in other modes).

5. **Solid vs walkable cells**
   - A helper like `getCell(x, y)` returns the character currently at `(x, y)` from Orca’s grid.
   - A basic rule decides if a cell is walkable:
     - if `char` is `null`, space, or a known “empty” placeholder → walkable;
     - if `char` is a letter, number, operator, or any non-empty symbol → solid.
   - Before moving the player to `(nx, ny)`:
     - read `getCell(nx, ny)`,
     - move only if walkable.

6. **Rendering the player**
   - On each frame:
     - overlay canvas is cleared,
     - player is drawn in the correct cell aligned over Orca’s grid.

### Acceptance Criteria

- Orca Web runs and behaves normally (e.g. a simple patch is visible).
- Pressing WASD/arrow keys moves the player icon between empty cells.
- The player **cannot move onto cells containing Orca characters**.
- The overlay visually aligns perfectly with the Orca grid (no offset, no scaling mismatch).

When this works, we have:

- Orca ↔ overlay coordinate mapping in place.
- A working `getCell`-style function to read Orca’s grid.
- Basic game input pipeline (`GameState.mode === "game"`).

---

## Checkpoint 2 – “A Guard That Sees You”

**Goal:**  
Add a single guard entity with a simple field-of-view (FOV). If the player steps into the guard’s FOV, the game raises `alertLevel` and shows a visual feedback in the overlay.

### Description

- A **guard** is added to the overlay, also living in Orca grid coordinates.
- The guard has:
  - a position `(x, y)`,
  - a facing direction (e.g. `"up"`, `"down"`, `"left"`, `"right"`),
  - a simple patrol or can even stay still in the first version.
- A basic **FOV** is implemented:
  - for example, in a straight line in front of the guard on the same row/column for N cells (e.g. 5 cells).
- When the player enters this FOV region:
  - `GameState.alertLevel` is set to `1` (or incremented),
  - a clear visual cue appears (e.g. red tint on the overlay, flashing FOV, indicator in HUD).

### Technical Requirements

1. **Guard representation**
   - Introduce a `Guard` object:
     ```js
     const Guard = {
       x: 20,
       y: 5,
       dir: "left",       // "up", "down", "left", "right"
       state: "idle"      // future use: "alert", "chasing"
     };
     ```
   - Initially, only one guard is needed.

2. **GameState alert**
   - Extend `GameState`:
     ```js
     const GameState = {
       mode: "game",
       alertLevel: 0
     };
     ```

3. **FOV computation**
   - For each frame, compute the FOV cells based on `Guard.x, Guard.y, Guard.dir`:
     - for example, N=5 cells in a straight line.
   - Represent FOV as a simple list of `(x, y)` cells.

4. **Player detection**
   - During `update()`:
     - check if `Player`’s `(x, y)` is inside the guard’s FOV.
     - If yes:
       - set `GameState.alertLevel = 1` (or clamp to max),
       - optionally set `Guard.state = "alert"`.

5. **Rendering guard and FOV**
   - In `render()`:
     - draw the guard at `(Guard.x, Guard.y)` on the overlay.
     - draw FOV cells with a distinct visual style (e.g. a tinted rectangle over those cells).
     - if `alertLevel >= 1`, intensify color or show a visible warning border/indicator.

### Acceptance Criteria

- The guard appears in the overlay at a fixed position.
- Player can move; guard remains in place (or follows a very simple motion pattern, if implemented).
- FOV cells are clearly visible on the overlay.
- When the player steps into the FOV:
  - `alertLevel` becomes `1`,
  - some visual reaction indicates the alert (e.g. red FOV, a warning icon, etc.).

No need for complex guard behavior or chasing yet: this checkpoint is just about **being seen** and reacting.

---

## Checkpoint 3 – “First Patch Liberation”

**Goal:**  
Introduce the first **liberation mechanic**, where stepping on a specific cell and pressing an action key triggers a real modification of the Orca patch via `writeCell(...)` (or similar), and causes a musical change (e.g. enabling a simple rhythmic section).

### Description

- Define one **liberation point** in the level metadata.
- When the player stands on that cell and presses the action key:
  - the wrapper:
    - updates game state (`liberatedBlocks++`),
    - calls a helper like `writeCell(x, y, char)` that sends an Orca command.
- The Orca patch reacts musically:
  - for example:
    - a `#` is removed, activating a dormant sequence,
    - or a specific operator is inserted to start a rhythm or sequence.

### Technical Requirements

1. **Level metadata for liberation**
   - Extend or introduce a `Level` definition with at least one liberation point:
     ```js
     const Level = {
       liberationPoints: [
         { x: 15, y: 8 }
       ],
       levelGoal: 1
     };
     ```
   - `GameState` extended:
     ```js
     const GameState = {
       mode: "game",
       alertLevel: 0,
       liberatedBlocks: 0,
       levelGoal: 1,
       isLevelComplete: false
     };
     ```

2. **Action key handling**
   - Define an action key (e.g. `E` or space).
   - During `update()` in `"game"` mode:
     - if action key is pressed:
       - check if `Player.x, Player.y` matches any `liberationPoint`.
       - if yes:
         - call the liberation logic.

3. **Liberation logic**
   - When the player activates a liberation point:
     - increment `GameState.liberatedBlocks`.
     - check:
       ```js
       if (GameState.liberatedBlocks >= GameState.levelGoal) {
         GameState.isLevelComplete = true;
       }
       ```
     - call a helper to modify the patch, e.g.:
       ```js
       writeCell(libX, libY, '.'); // or remove a '#', etc.
       ```
   - `writeCell(x, y, char)` internally uses Orca’s command system:
     - e.g. `orca.runCommand("write:.;15;8")` or equivalent API.

4. **Musical feedback**
   - The Orca patch must be set up so that this write/uncomment:
     - **enables a new audible section**, e.g. a simple rhythmic pattern.
   - This is more of a level-design requirement:
     - the `.orca` file used for this checkpoint should contain at least:
       - a muted/commented sequence that becomes active when the liberation happens.

5. **Visual feedback**
   - Optional but recommended:
     - highlight liberation points on the overlay (e.g. a subtle icon on that cell).
     - when a liberation succeeds:
       - briefly flash that cell or show a small effect.

### Acceptance Criteria

- The player can move to the liberation point cell.
- Pressing the action key while on that cell:
  - increments `GameState.liberatedBlocks`,
  - triggers `writeCell` (or similar) to actually modify the Orca grid,
  - audibly changes the Orca output (e.g. a new rhythmic layer starts).
- If `levelGoal` is met:
  - `GameState.isLevelComplete` becomes `true` (even if no special level-end UX is implemented yet).

---

## Summary of Early Milestones

- **Checkpoint 1 – Ghost in the Grid:**  
  - Orca Web running,
  - overlay canvas aligned,
  - player moving only in empty cells.

- **Checkpoint 2 – The First Watcher:**  
  - single guard entity,
  - simple straight-line FOV,
  - entering FOV sets `alertLevel = 1` and shows a visual warning.

- **Checkpoint 3 – First Liberation:**  
  - one liberation point,
  - action key triggers a real `writeCell(...)` patch modification,
  - Orca’s audio responds (e.g. new rhythm), and `liberatedBlocks` is updated.

These three checkpoints establish:

- integration between Orca’s grid and the overlay,
- basic stealth mechanics (movement + being seen),
- and the core loop of **“stealth → reach point → liberate code → hear patch evolve”**.
