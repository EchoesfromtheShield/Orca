# ORCA WRAPPER – GAME DESIGN NOTES (STEALTH-ROGUELITE DIRECTION)

## 1. Scope

This file captures the **high-level game design direction** for the Orca wrapper:
- Top-down perspective, grid-based (Orca grid as world).
- Hybrid between **stealth** and **action roguelite**, not pure stealth.
- Combat is a **valid** and expected option, not just a punishment.
- Levels are more **systemic** than hand-crafted puzzle stealth.

`design.md` stays focused on **technical/architectural details** of the wrapper (overlay, grid access, zoom policy, etc.).  
This document focuses on **gameplay philosophy and systems**.

---

## 2. Core Fantasy & Playstyle

### Player fantasy

- You are a “ghost” / agent moving **inside a living Orca patch**, trying to:
  - move through code clusters,
  - avoid or confront sentinels,
  - **liberate** parts of the patch so that the music evolves.

### Playstyle goals

- **Stealth is a strong advantage**, but:
  - not mandatory,
  - not ultra-precise or punishing.
- **Combat exists and is legitimate**:
  - you can choose to fight your way out,
  - or to stay hidden and reduce conflict.

The experience should feel like:
> “I stoop and slide between lines of code. Sometimes I mess up and have to fight my way through, but the run keeps going.”

---

## 3. Stealth vs Combat Philosophy

### Stealth as advantage, not as dogma

- Being unseen:
  - avoids extra enemies,
  - keeps global **alert/heat** low,
  - can grant better rewards (more “clean” liberation).

- Being seen:
  - does **not** mean instant game over,
  - instead ramps up pressure (more enemies, more noise in the patch).

### Combat as a valid mode

- Combat is:
  - simple to execute (no complex combos),
  - constrained by resources (ammo, cooldowns, health),
  - risky but sometimes faster than pure sneaking.

Design emphasis:
- Player should often ask:
  - “Do I try to sneak this room, or do I blow it up and live with the consequences?”

---

## 4. Alert / Heat System

Instead of a binary “detected / not detected”, we maintain an **alert/heat** variable.

### Alert sources

Alert goes **up** when:

- guards clearly see the player (inside their FOV for long enough),
- noisy actions are used:
  - loud weapons,
  - explosives,
  - triggering visible traps,
- guards are killed or knocked out **in view** of other guards,
- alarms / security systems are triggered.

Alert goes **down** when:

- the player escapes line of sight and stays hidden for some time,
- systems are sabotaged (e.g. destroy or “cool down” alert nodes),
- specific abilities or gadgets are used (future design).

### Effects of high alert

When `alertLevel` rises:

- More enemies can **spawn** or enter the area.
- Existing guards can:
  - shorten patrol routes (stay closer to critical lines),
  - move faster,
  - scan more aggressively.
- Musically:
  - patches can become denser, more dissonant or noisy,
  - tempo/intensity can rise.

High alert should feel like:
- the world is **pressing back**,
- the patch is becoming unstable, noisy, harder to control.

---

## 5. Enemies & AI – Simple but Expressive

Goal: avoid extremely complex stealth AI. Use **few archetypes** and simple state machines.

### Archetypes

- **Guard (basic)**:
  - moves along a simple path (line back-and-forth, small loop),
  - has a FOV cone/line,
  - on seeing the player:
    - sets alert up,
    - chases for a while.

- **Sentinel / Turret**:
  - static, looks around or scans a fixed angle,
  - strong FOV but no movement,
  - forces positioning decisions.

- (Optional later) **Heavy / Brute**:
  - slow, high health,
  - punishes staying too long in one place.

### States

Minimal state machine:

- `patrol`:
  - follows path,
  - regular FOV.
- `suspicious`:
  - heard a noise or saw something briefly,
  - moves to investigate last known position.
- `alert/chasing`:
  - has detected the player clearly,
  - tries to move directly toward the player for some time.

If they lose sight of the player for N seconds:

- fall back to `suspicious` or `patrol`,
- but keep **global alert** raised until it decays.

---

## 6. Player Toolkit – Movement & Combat

### Movement

- Eight-direction or grid-based movement (depending on implementation).
- Two speeds (optional but nice):
  - **sneak**: slower, less noisy, ideal for staying undetected.
  - **run**: faster but louder, used for escapes or aggressive pushes.

### Combat

Keep the input light:

- 1 primary attack (melee or short-range),
- 1 ranged/gadget button (if ammo or charges are available),
- 1 “special” / ability (dash, temporary stealth, stun, etc. – future).

Combat should:

- resolve fast (no long slugfests),
- cost something (health, alert, ammo),
- not be the *only* reasonable choice but a **viable shortcut**.

---

## 7. Level Design – Stealth-Flavored Roguelite

Instead of ultra-curated stealth puzzles, think in **modular rooms** / sectors:

### Room templates

Each room type can be designed as a **template**:

- **Safe / transition rooms**:
  - few or no enemies,
  - connective tissue between intense zones.

- **Stealth-favored rooms**:
  - lots of cover, side paths, corners,
  - fewer enemies but more line-of-sight tricks,
  - reward for playing quietly.

- **Combat-heavy rooms**:
  - more open space, less cover,
  - more enemies or stronger types,
  - higher immediate rewards (resources, liberation progress).

You can reuse templates, randomize placement, and vary:

- number of guards,
- patrol paths,
- positions of liberation points.

This reduces the need to engineer each room by hand.

### Multiple approaches

For most rooms, offer at least:

- one **safer but longer** path (stealth heavy),
- one **riskier but shorter** path (combat-friendly).

The player chooses based on:

- current health and resources,
- alert level,
- personal preference.

---

## 8. Progression (Roguelite Layer)

### In-run progression

During a single run, the player can:

- find or earn **temporary upgrades**:
  - extra dash charges,
  - more max health or shields,
  - stronger stealth (slower detection),
  - combat boosts (more damage, extra shots).

These vanish at the end of the run.

### Meta-progression

Across multiple runs, the player unlocks:

- new gadgets (stun tools, noise creators, short-range teleports),
- new “builds” or starting kits:
  - more stealth oriented,
  - more combat heavy,
  - hybrid options.

This supports replayability without requiring huge numbers of unique handcrafted levels.

---

## 9. Failure & Run Structure

### Failure philosophy

- Detection and combat **do not instantly end the run**.
- The run usually ends when:
  - health hits zero,
  - or the alert/heat system reaches a “critical meltdown” state that overwhelms the player.

### Stealth failure → combat phase

- Being spotted or making noise often transitions to:
  - short, intense combat / escape segments,
  - with permanent consequences for the rest of the run (higher alert, fewer resources).

This keeps tension high but avoids constant hard resets.

---

## 10. Implications for the Wrapper & Orca Integration

These design choices influence how the wrapper should evolve beyond v0:

- Guard AI:
  - can remain **simple** (few states, basic path patterns).
- Alert system:
  - will need a global `alertLevel` that can:
    - affect spawn rates,
    - adapt guard behavior,
    - modulate Orca patches (tempo, density, noise, etc.).
- Level logic:
  - can be data-driven (room templates + parameters),
  - instead of handcrafted patrols per cell.

From Orca’s perspective:

- Stealth vs combat vs alert changes can map to:
  - enabling/disabling sections of the patch (liberation or corruption),
  - changing parameters (BPM, density, effects),
  - switching scenes or layers of sound.

This document is meant as a **compass**, not a fixed blueprint:  
implementation details can shift, but the key idea remains:

> Stealth is a powerful option, combat is allowed, the world reacts systemically, and each run through the patch tells a different story.
