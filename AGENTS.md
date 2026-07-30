# AGENTS.md

## Project

This is a stylized first-person Three.js experience focused on atmosphere, photography and immersion.

The goal is not to create a traditional game but a peaceful interactive experience with strong visual identity.

Every implementation should prioritize immersion, simplicity and visual quality.

---

## General Principles

Before writing code:

- Understand the existing architecture.
- Reuse existing systems whenever possible.
- Prefer extending systems over creating new ones.
- Keep changes localized.
- Avoid unnecessary abstractions.

---

## Visual Quality

Visual quality has priority over technical purity.

Whenever multiple implementations are possible:

- choose the solution that looks better
- keep performance reasonable
- fake expensive effects whenever possible

Do not implement physically correct rendering unless requested.

---

## Art Direction

The visual target is:

- warm golden hour
- cinematic lighting
- long shadows
- soft atmospheric fog
- vibrant but believable colors
- dreamlike atmosphere

Natural elements should feel organic.

Man-made objects should remain stylized low-poly.

The contrast is intentional.

---

## Gameplay Philosophy

This is NOT an FPS.

Movement should feel:

- slow
- peaceful
- cinematic
- immersive

The player should enjoy simply walking through the environment.

Avoid mechanics that interrupt immersion.

---

## Camera

The camera is first-person.

There are no visible arms.

A floating vintage camera follows the player with subtle inertia as if controlled through telekinesis.

It should never feel rigidly attached to the viewport.

---

## UI

Minimal UI.

Avoid:

- crosshairs
- health bars
- inventories
- permanent HUD
- debug overlays in production

The world itself should communicate information.

---

## Assets

Natural environment:

- smooth
- organic
- believable

Objects:

- handcrafted
- Blockbench-inspired
- clean silhouettes
- readable shapes

Never generate Minecraft-style cubes unless explicitly requested.

---

## Performance

Target platform:

- Desktop
- iPhone 15 Safari

Always consider performance.

Prefer:

- fewer draw calls
- GPU-friendly rendering
- simple materials over expensive ones
- visual tricks over heavy simulations

---

## Code Style

Write modular code.

Prefer composition.

Avoid giant files.

Avoid magic numbers.

Comment only when necessary.

---

## Before Finishing

Before considering a task complete:

- check for obvious bugs
- remove dead code
- verify imports
- keep naming consistent
- ensure the project still runs

## Rule Zero

When making implementation decisions, always optimize for the emotional impact of the experience rather than technical sophistication.

If the player says "this place feels beautiful", the implementation is successful.