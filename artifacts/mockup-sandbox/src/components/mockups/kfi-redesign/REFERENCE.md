# KFI Driver Detail — Structural Reference

This document describes the page structure + the exact data values every variant must show. ALL FOUR VARIANTS must display the same data so the dispatcher can compare visual treatments directly. Pull values verbatim from this document; do not invent your own numbers. The reference screenshot is at `/__mockup/images/driver-detail-ref.png` (also open it locally at `artifacts/mockup-sandbox/public/images/driver-detail-ref.png`).

## Page identity (use these EXACT values in every variant)

- Active driver: **Benjamin Rodriguez Gonzalez**
- Customer: **Landscape Structures**
- KFI ID: **2003681**
- Display timezone: **America/Chicago** (badge), Customer TZ badge: **Landscape Structures: America/Chicago**
- Week reviewed: **17 / 18 reviewed**
- Punches: **0 / 18 punches** flagged
- Status: **Good** (selected) / **Bad** (unselected)
- Lock: unlocked

## Logo

- Primary (with background): `/__mockup/images/kfi-logo.png`
- Transparent (preferred on light surfaces): `/__mockup/images/kfi-logo-transparent.png`
- Place in top-left of the app bar. Size around 28-40px tall depending on variant chrome.

## 1. Top app bar (sticky, full width)

Left cluster (in order):
- KFI Staffing logo (`/__mockup/images/kfi-logo-transparent.png`)
- A `←  Back` ghost button (lucide `ArrowLeft`)

Center cluster (segmented pill toggles):
- Language toggle: `EN` (active) / `ES`
- Reviewed counter pill: `17 / 18 reviewed` (lucide `CheckCircle2`)
- Punches counter pill: `0/18 punches` (lucide `Check`)

Right cluster (in order, all small buttons with icon + label):
- Good toggle (lucide `ThumbsUp`) — `Good` (active)
- Bad toggle (lucide `ThumbsDown`) — `Bad`
- `Lock` (lucide `Lock`)
- `Refresh` (lucide `RefreshCw`)
- Primary CTA `+ Add Punch` (lucide `Plus`)
- `Print` (lucide `Printer`)

## 2. Sidebar — Drivers by Customer (left rail, ~280px wide)

Header: `DRIVERS BY CUSTOMER` (small caps) + a panel-collapse icon button (lucide `PanelLeftClose`).

Below: search input `Search name or KFI ID` (lucide `Search`).

Below: filter chip `UN-REVIEWED` (toggle pill, currently off).

Customer groups (render in this exact order, with these counts and drivers). Each group header is small caps with a numeric count badge to the right. Each driver row is a list item with a circular status indicator on the left, the name, optional `OT` badge on the right, and a `MoreHorizontal` icon. **Highlight Benjamin Rodriguez Gonzalez under Landscape Structures as the active row.**

- ADIENT (1)
  - Jose Angulo Alfaro — OT
- SCHUETTE METALS (1)
  - Giovanni Alexander
- BURNETT DAIRY - GRANTSBURG (3)
  - Felix Baez Caballero
  - Isidro Guerrero
  - Willie Medina
- DELALLO (2)
  - Cory Brittman — OT
  - Davidson Alcide — OT
- INTERNATIONAL WIRE (1)
  - Jonathan Cedeno Mendez
- KFI STAFFING (1)
  - William Mejia
- LANDSCAPE STRUCTURES (3)
  - **Benjamin Rodriguez Gonzalez — OT  ← ACTIVE ROW**
  - Sebastian Villarreal
  - Tyrek Patterson
- PENDA CORP (2)

Status dots: green = reviewed; outline circle = unreviewed.

## 3. Page header band (right of sidebar, full width above panels)

- H1: `Benjamin Rodriguez Gonzalez` (very prominent)
- Sub-row, monospace, dot-separated:
  - `Customer: Landscape Structures`
  - `KFI ID: 2003681`
  - `America/Chicago` (with lucide `Globe` icon, as a badge)
  - `Landscape Structures: America/Chicago` (badge)
- Legend row below (small dots + label, comma- or pill-separated):
  - black dot `Driver (Connecteam)`
  - teal dot `Customer (Timesheet)`
  - amber dot `Overtime threshold`
- Right side of this band: two destructive secondary buttons aligned right:
  - `Remove Connecteam time` (lucide `Trash2`, outlined-red style)
  - `Reset customer punches` (lucide `Trash2`, outlined-red style)

## 4. Two-up panels: Summary + Checks

Render side-by-side (50/50 on desktop). Each is a panel/card with a header row and tabular rows.

### Summary panel
Header: `Summary` (left) + amber warning chip `DIFFERS FROM CONNECTEAM (4)` (right, lucide `AlertTriangle`).
Rows (label left, right-aligned numeric right, monospace digits):
| Label | Value |
|---|---|
| Total Driver | **6.39** |
| Total Customer | **40.23** |
| Total Hours | **46.62** |
| Customer RT | **34.23** |
| Customer OT | **6.00** *(amber-tinted)* |
| Driver RT | **5.77** |
| Driver OT | **0.62** *(amber-tinted)* |

### Checks panel
Header: lucide `CheckCircle2` + `Checks — all reconcile` (green-tinted header).
Rows (small check icon left of label, value right, all monospace):
| Label | Value |
|---|---|
| Total = Driver + Customer | 46.62 |
| Customer = Total - Driver | 40.23 |
| Driver = Total - Customer | 6.39 |
| Customer RT + Driver RT = RT | 40.00 |
| Customer OT + Driver OT = OT | 6.62 |
| RT + OT = Total | 46.62 |

## 5. Punches table (main content, below the two-up panels, spans full content width)

Columns (in this order):
`DATE` · `SOURCE` · `CLOCK IN` · `CLOCK OUT` · `HOURS` · `RUNNING` · `TYPE` · actions cluster

Actions cluster on every row (5 small icon buttons, right-aligned): reviewed checkbox · `Flag` · `MessageSquare` (note) · `Pencil` (edit) · `Trash2` (delete, red).

Source badge styles:
- `DRIVER` — dark filled badge with `EDITED` micro-label underneath when the row was hand-edited
- `CUSTOMER` — teal filled badge

Type column is plain text: `Driver` or `Customer` (color-matched to the badge).

Render these EXACT 8 rows (in order — match the screenshot):

| Date | Source | Clock in | Clock out | Hours | Running | Type |
|---|---|---|---|---|---|---|
| 2026-05-11 | DRIVER (edited) | 05/11, 12:32 PM | 05/11, 1:20 PM | 0.80 | 0.80 | Driver |
| 2026-05-11 | CUSTOMER | 05/11, 1:28 PM | 05/11, 6:40 PM | 5.20 | 6.00 | Customer |
| 2026-05-11 | CUSTOMER | 05/11, 7:10 PM | 05/12, 12:00 AM | 4.83 | 10.83 | Customer |
| 2026-05-12 | DRIVER (edited) | 05/12, 12:00 AM | 05/12, 12:29 AM | 0.48 | 11.31 | Driver |
| 2026-05-12 | DRIVER | 05/12, 12:32 PM | 05/12, 1:16 PM | 0.73 | 12.04 | Driver |
| 2026-05-12 | CUSTOMER | 05/12, 1:26 PM | 05/12, 6:38 PM | 5.20 | 17.24 | Customer |
| 2026-05-13 | DRIVER | 05/13, 12:01 PM | 05/13, 12:48 PM | 0.78 | 18.02 | Driver |
| 2026-05-13 | CUSTOMER | 05/13, 12:53 PM | 05/13, 6:42 PM | 5.82 | 23.84 | Customer |

(Don't try to render more than ~8-10 rows — the goal is visual fidelity, not full week.)

## 6. Floating help button

Round button bottom-right corner with a help/cluster icon (lucide `LifeBuoy` or `HelpCircle`). Branded accent color of the variant.

## What MUST stay identical across all variants

- All copy and numeric values above
- Section order and presence (sidebar → header band → two-up panels → table → floating help)
- Column order and column count in the table
- Sidebar grouping order and which driver is highlighted
- The "Good/Bad" toggle has Good selected; lock is unlocked
- The amber warning chip on the Summary panel
- No emojis anywhere

## What MUST differ across variants

- Color palette (background, surfaces, borders, accents)
- Typography (font family, sizes, weights, letter-spacing)
- Surface treatment (flat vs raised, borders vs shadows vs grooves)
- Badge / pill shapes and styling
- How emphasis is created (color blocks, type contrast, dividers)
- Density mood (cozy vs airy vs crisp) — but NOT the layout itself
