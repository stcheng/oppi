# Oppi Icon Design Concept

## The Idea

Game of Life grid of rounded squares forming π (pi) on an 8×8 grid. Mostly **monochrome** (white/gray cells) with **1–3 rare bright colored "spark" cells** — representing good ideas, rare breakthroughs emerging from computation.

## Character

- The π shape is intentionally **rough**: some edge cells eroded, some growth cells bleeding outward, scattered debris around it
- Interior gap between the two legs is always protected — π stays readable
- Right leg kicks outward (correct π shape)
- Looks like a frozen Game of Life simulation that *almost* converged on π but placed some wrong pieces
- **"Random with intention and polish"**

## Visual Details

- Dark background (near-black, subtle gradient)
- Monochrome cells: white/off-white/light gray with slight variation
- Spark cells: vivid warm (orange/gold/rose) or cool (cyan/blue) — max 3
- Each cell has:
  - Inner highlight (top-left specular)
  - Subtle bottom shadow
  - Rounded corners (~24% of cell size)
- Growth cells (adjacent to π): dimmer opacity (~30–40%)
- Scatter debris: faintest (~8–10%)
- Gap between cells: ~13% of cell size

## Apple Liquid Glass

- Layered icon format (`.icon` / Icon Composer)
- Background layer: dark solid/gradient
- Foreground layer: the grid cells on transparent background
- System applies specular highlights, translucency, frostiness
- Clearly defined edges on foreground shapes (Apple guideline)

## Implementation

- Experiment HTML: `clients/apple/icon-experiments.html`
- Current favorite palettes: "Mono + Warm Sparks", "Mono + Neon Sparks"
- Favorite roughness: "Lived-in" (erosion 0.18, growth 0.22, scatter 0.08)
