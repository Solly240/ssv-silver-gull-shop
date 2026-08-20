# SSV Silver Gull — Shops & Trade

A Foundry VTT module for the **SSV Silver Gull** campaign: location-gated shops with generated
stock, a living economy, a shared ship treasury alongside each character's purse, and GM tools for
spinning up a market in about fifteen seconds.

Built to look and feel like the ship-combat inventory console — same palette, same tiles, same
gauges — but it is a standalone module and works with ship-combat disabled.

---

## For players

**Press `I`** (or click the 🛒 in the scene controls) to see what is open where the crew are docked.
If there is nothing here, it says so.

Inside a shop:

| | |
|---|---|
| **BUY / SELL** | Switch between their shelves and your goods. |
| **SHIP CARGO / YOUR ITEMS** | Where the goods come from or go to. |
| **PAY / BANK: SHIP or YOU** | Whose money is spent, and whose gets paid. |
| **Hover an item** | Full detail — and the price breakdown, factor by factor. |
| **BUY / SELL button** | One unit. The **＃** button asks for a quantity. |
| **HAGGLE** | One Persuasion check per shop per visit. It can go badly. |

Prices are not fixed. The same fuel rod is cheap on Cindermoor (they refine it) and dear out at
Keth Minor (nobody goes there). A shop that is nearly out charges more; one drowning in stock
discounts. And every shop knows who you are — faction standing moves the number in both directions,
and a shop aligned to a faction that hates you will not open the door at all. The black market will,
for a price.

Shops only buy what they deal in. A Fuel Depot will not take your cutlass.

## For the GM

Everything is behind the shop-list popup (`I`) and the ⚙ GM button inside a shop.

- **＋ New shop…** — pick a type, a world, a wealth tier and a size. Stock and prices generate
  immediately from the world's economy. Name, keeper and blurb are rolled for you if you leave them
  blank.
- **📍 Set location…** — where the crew are docked. Players only see shops here.
- **⚙ Manage shops…** — open any shop straight into its GM panel.
- **⛁ Treasury…** — set the party's shared coin.

Inside the GM panel you can change anything: type, world, wealth, size, faction, open/closed, a
markup or sell-rate override, the till, re-roll the whole stock, restock quantities toward par, or
edit a single line (quantity, par, a fixed price, hide it from players).

**23 shop types**: General Store · Fuel Depot · Ship Chandler · Weaponsmith · Armoury · Med Bay ·
Cantina & Bar · Black Market · Smuggler's Hold · Fence · Pawn Shop · Salvage Yard · Refinery ·
Exotic Artificer · Ancient Relics · Shipwright · Vacc-Suit Outfitter · Bounty Office · Temple
Commissary · Directorate Quartermaster · Water Broker · Casino Cage · Travelling Peddler.

### The economy

Per unit, in copper:

```
buy  = base × region × scarcity × standing × markup × jitter     (clamped 0.25×…4.0× base)
sell = base × region × standing × offer-rate × glut              (never above 0.90 × buy)
```

- **region** — the world's own economy (Cindermoor fuel ×0.60, Marrow water ×2.50, Ossuary salvage
  ×0.50, Sib Vael drink ×0.55 …).
- **scarcity** — stock against the shop's normal level, 0.80× to 1.60×.
- **standing** — read live from the Politics module: 0.70× to 1.45× on buys, and hostile means no
  trade unless the shop is an outlaw type.
- **markup** — the shop type and its wealth tier.
- **glut** — the more of a thing they already hold, the less they pay for yours.

Sell is derived from the base price, never from the inflated buy price, and is hard-capped below
what the same goods cost here — so there is no buy-low-sell-back loop.

### What it stocks from

123 authored campaign items (fuel and power cells, Gobby's bar, ship parts, ammunition, medical,
vacc-suits, contraband, relics, water) **plus** every priced item in the world's Item compendiums,
sorted into categories automatically.

## Requirements

- Foundry VTT v12–v14, dnd5e.
- **Recommended:** `ssv-silver-gull-politics` (standing moves prices) and
  `ssv-silver-gull-ship-combat` (bought fuel and power cells feed the ship gauges immediately).
  Neither is required.

## Install

Foundry → **Add-on Modules → Install Module**, and paste:

```
https://github.com/Solly240/ssv-silver-gull-shop/releases/latest/download/module.json
```
