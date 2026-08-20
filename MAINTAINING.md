# Maintaining `ssv-silver-gull-shop`

Everything a future maintainer needs. Read §1 and §2 before changing anything.

---

## 1. The two-file split

| File | What it is | Rule |
|---|---|---|
| `scripts/shop-render.js` | **Pure.** Styles, all renderers, **all pricing maths**, stock generation, currency. IIFE → `globalThis.SSVSHOP`. | **Must never reference `game`, `ui`, `Hooks` or `canvas`.** `grep -nE '\b(game\|ui\|Hooks\|canvas)\.'` must come back empty. |
| `scripts/shop.js` | Foundry wiring only: settings, the ctx object, dialogs, the socket, GM transaction handlers. | Everything that touches Foundry lives here. |

Why: `../preview.html` loads `shop-render.js` directly and feeds it a fake ctx, so the standalone
preview runs the **real** renderer and the **real** economy. If maths leaks into `shop.js`, the
preview stops telling the truth and you are tuning prices by rebooting Foundry.

`module.json` loads `shop-render.js` via `scripts` (classic, runs first) and `shop.js` via
`esmodules`, so `SSVSHOP` always exists before the wiring runs.

## 2. Content vs. state — never mix them

| Store | Lives in | Written by | Overwritten by a release? |
|---|---|---|---|
| `data/shops-catalogue.json` | the shipped file | you, via `tools/build_catalogue.py` | **YES** |
| world setting `shops` | Foundry | GM + GM-side socket handlers | no |
| world setting `locations` | Foundry | GM | no |
| world setting `treasury` | Foundry | the transaction handlers | no |
| world setting `catalogueOverrides`, `config` | Foundry | GM | no |

**Never** put shop stock, prices paid, or money into the catalogue: a release would reset the
party's economy. Conversely, never hand-edit the catalogue JSON — regenerate it (§3).

Every read goes through a `normalize*()` that merges stored data onto defaults, so adding a field
never needs a world reset.

## 3. Editing the catalogue

`data/shops-catalogue.json` is **generated**. Edit the sources instead, then rebuild:

```bash
cd "vtt/shop/tools" && python3 build_catalogue.py
```

| To change… | Edit |
|---|---|
| Shop types, their buy/stock categories, markups, blurbs | `tools/catalogue_parts.py` → `SHOP_TYPES` |
| Worlds, their price modifiers, wealth and law rating | `tools/catalogue_parts.py` → `LOCATIONS` |
| Wealth tiers, sizes, rarity weights, category list | `tools/catalogue_parts.py` |
| How compendium items are categorised | `tools/catalogue_parts.py` → `SRD_RULES` |
| Prices of the 34 original custom items | `tools/build_catalogue.py` → `CUSTOM` |
| Prices/categories of the 57 shop-added items | `tools/build_catalogue.py` → `NEW_ITEMS` |
| Fuel/power pricing formula | `tools/build_catalogue.py` → `RATE` / `TIER_MULT` |
| The 32 fuel/power items themselves | `../../inventory-icons/resource-items.json` (shared) |

The builder validates as it goes: unknown categories, duplicate ids, non-positive prices and unknown
rarities all abort the build.

**New item art**: give the item an `art` prompt in `NEW_ITEMS`, rebuild, then
`python3 tools/gen_art.py` (gpt-image-1, key from the repo-root `.env`). It only generates what is
missing, so it is safe to re-run. `tools/make_icons.py` re-imports the shared icon library from
`vtt/inventory-icons/`.

## 4. The economy, in one place

All of it is in `shop-render.js`: `priceBuy`, `priceSell`, `regionMod`, `scarcityMod`,
`standingBuyMod`, `standingSellMod`, `haggleResult`, `generateStock`, `restockShop`.

Two invariants you must not break:

1. **Sell derives from the base price, not the buy price.** Otherwise a scarce item bought elsewhere
   becomes a money printer here.
2. **`sell ≤ 0.90 × buy` for the same item at the same shop**, priced against the same stock level
   and the lowest jitter any line can carry. The preview's sweep asserts this across all 23 types at
   wealth 1 and 5; keep that check green.

`generateStock` applies **diminishing returns per category** (each line already taken in a category
weakens the next from it). Without that, any shop whose pool includes fuel becomes a fuel warehouse,
because the catalogue has 32 fuel/power items and only a handful of some other categories.

## 5. Verifying — do this before every release

```bash
node --check scripts/shop.js && node --check scripts/shop-render.js
python3 -c "import json;json.load(open('data/shops-catalogue.json'))"
grep -nE '\b(game|ui|Hooks|canvas)\.' scripts/shop-render.js    # must be empty
```

Then the preview:

```bash
python3 "vtt/shop/tools/serve.py"      # http://localhost:8793/preview.html
```

Click **PRICE MATH ▸** and confirm all three summary lines are green:

- `sell ≤ 0.90 × buy: holds for every line`
- `no type breaches sell ≤ 0.90 × buy`
- `clamp reach — …` every counter non-zero (the sweep deliberately uses a faction-aligned shop and
  walks depleted/at-par/glutted quantities so the clamps are actually reachable)

and that the **CURRENCY** table is all ✓. Then exercise by hand: buy something, switch to SELL,
check a shop refuses at hostile standing while a black market still trades, and set the location to
Tarn for the empty state.

In Foundry, the things worth re-testing after any change to `shop.js`:

- a **non-GM** buy: stock drops, coin leaves the chosen purse, the item lands on the chosen actor,
  a chat receipt fires, and **no permission error appears on the player's console** (players must
  never call `settings.set`)
- two players buying the last unit at once — one wins, one is told it is gone
- a bought fuel cell shows its ⛽ button in the ship-combat inventory
- disable the politics module — prices fall back to standing 0 with no errors

## 6. Multiplayer safety

Players never write. Every mutation is `emit({toGM:true, …})` and the **active** GM performs it —
`isActiveGM()` is mandatory, or a second connected GM runs every transaction twice.

GM-side handlers run through one promise chain (`tx()`), so two simultaneous buyers cannot both read
`qty: 1`. `gmBuy` re-derives the price from live state and **rejects a drifted client quote** rather
than silently charging a different number than the player clicked. Writes commit in a fixed order
(money → goods → shop) inside a try/catch that undoes them in reverse.

Foundry has no transactions, so this is the ceiling. `treasury.log` and each shop's `log` are
detailed enough to reconstruct a failed write by hand.

## 7. Size budget

Every purchase rewrites the whole `shops` setting and replicates it to every client. Stock entries
are deliberately 7 fields — names, images and descriptions resolve from the catalogue at render
time. Caps: 60 stock lines, 40 log entries per shop. Keep the blob under 250 KB:

```js
JSON.stringify(game.settings.get("ssv-silver-gull-shop","shops")).length
```

If it ever grows past that, split `shops` (definitions) from `shopStock` (mutable qty/cash) — that
halves the bytes moved per transaction.

## 8. Gotchas

1. **dnd5e `system.price`** is a bare Number in v2 and `{value, denomination}` in v3/v4 —
   `priceCpOf()` handles both. Most SRD `loot` has no price and is skipped.
2. **Never hardcode a compendium pack id.** v3 ships `dnd5e.items`; v4 splits into PHB'24 packs and
   some worlds get SRD content from a separate module. `buildSrdIndex()` walks `game.packs`.
3. **Vehicles have no `system.currency`** — that is why the ship treasury is a module setting and
   not actor data. Do not try to write currency onto the ship actor.
4. **Electrum** is spent if the purse holds it, but never handed out as change.
5. **Style isolation**: the CSS is a *copy* of ship-combat's under a `.sgshop` root with its own
   `#ssvshop-styles` id. Do not depend on ship-combat's stylesheet — the shop must look right with
   that module disabled.
6. **Keep `pointer-events:none` on `.sgshop-invpop`**, or the hover popup eats the tile buttons.
7. **Scene controls** changed shape at v13 (arrays → keyed objects). The hook handles both.
8. The only coupling to ship-combat is one hardcoded flag namespace
   (`ssv-silver-gull-ship-combat` → `resKind`/`resAmount`/`overcharge`) stamped onto bought fuel and
   power cells. Deliberate, one-way, and harmless when that module is absent.
9. **Never** put the base64 images from `inventory-icons/manifest_compact.json` into the catalogue or
   a setting — reference the shipped webp paths.

## 9. Releasing

```bash
cd "vtt/shop/ssv-silver-gull-shop"
# bump "version" in module.json first
git add -A && git commit -m "vX.Y.Z — what changed"
git push origin main
rm -f module.zip && zip -qr module.zip module.json scripts data lang assets README.md
gh release create vX.Y.Z module.json module.zip --title "vX.Y.Z" --notes "..."
```

Then in Foundry: **Setup → Add-on Modules → Update**, using
`https://github.com/Solly240/ssv-silver-gull-shop/releases/latest/download/module.json`, and hard
refresh once.
