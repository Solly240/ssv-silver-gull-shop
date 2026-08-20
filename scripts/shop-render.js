/**
 * SSV Silver Gull — Shops & Trade : renderer + economy core.
 *
 * This file is deliberately FOUNDRY-AGNOSTIC: it must never reference `game`,
 * `ui`, `Hooks`, `canvas` or any Foundry document class. Everything it needs
 * arrives in a `ctx` object built by shop.js (in Foundry) or by preview.html
 * (in a plain browser), so the standalone preview exercises the real renderer
 * and the real pricing math. Exposed as globalThis.SSVSHOP.
 */
(function () {
  "use strict";
  const S = {};
  globalThis.SSVSHOP = S;

  /* ---------------------------------------------------------------- utils */
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
  const r2 = (n) => Math.round(n * 100) / 100;
  S.esc = esc; S.clamp = clamp;

  /* ------------------------------------------------------------- currency */
  // Everything is integer copper. gp is only ever a display unit.
  const CP = { pp: 1000, gp: 100, ep: 50, sp: 10, cp: 1 };
  const DENOMS = ["pp", "gp", "ep", "sp", "cp"];
  S.CP = CP;

  const toCp = (c) => Math.round((c?.pp || 0) * 1000 + (c?.gp || 0) * 100 +
                                 (c?.ep || 0) * 50 + (c?.sp || 0) * 10 + (c?.cp || 0));
  S.toCp = toCp;

  /** Price for display: "12 gp", "3 gp 4 sp", "8 sp 2 cp", "45 cp". */
  function fmtCp(cp) {
    cp = Math.round(cp || 0);
    if (cp <= 0) return "0 gp";
    const gp = Math.floor(cp / 100), sp = Math.floor((cp % 100) / 10), c = cp % 10;
    if (gp >= 1000) return `${gp.toLocaleString()} gp`;
    const parts = [];
    if (gp) parts.push(`${gp} gp`);
    if (sp) parts.push(`${sp} sp`);
    if (c) parts.push(`${c} cp`);
    return parts.slice(0, 2).join(" ");
  }
  /** Compact form for the tile badge — always one unit. */
  function fmtCpShort(cp) {
    cp = Math.round(cp || 0);
    if (cp >= 100) {
      const gp = cp / 100;
      return (gp >= 100 ? Math.round(gp).toLocaleString() : r2(gp)) + " gp";
    }
    if (cp >= 10) return r2(cp / 10) + " sp";
    return cp + " cp";
  }
  S.fmtCp = fmtCp; S.fmtCpShort = fmtCpShort;

  /**
   * Spend `cost` copper out of a purse, keeping the player's coin shape where
   * possible: pay small coins first, break a larger one only when short, and
   * hand back change in gp/sp/cp. Electrum is spent if present but never given
   * as change (dnd5e v4 worlds usually hide it). Returns a new purse, or null
   * when the purse cannot cover the cost.
   */
  function spendCp(cur, cost) {
    cost = Math.round(cost);
    if (cost <= 0) return { ...cur };
    if (toCp(cur) < cost) return null;
    const out = {}; for (const d of DENOMS) out[d] = Math.max(0, Math.round(cur?.[d] || 0));
    let left = cost;
    for (const d of ["cp", "sp", "ep", "gp", "pp"]) {          // small -> large
      const take = Math.min(out[d], Math.floor(left / CP[d]));
      out[d] -= take; left -= take * CP[d];
    }
    if (left > 0) {                                             // break a bigger coin
      for (const d of ["sp", "ep", "gp", "pp"]) {
        while (left > 0 && out[d] > 0) { out[d]--; left -= CP[d]; }
        if (left <= 0) break;
      }
    }
    if (left > 0) return null;
    if (left < 0) {                                             // change, no electrum
      let change = -left;
      for (const d of ["gp", "sp", "cp"]) {
        const n = Math.floor(change / CP[d]); out[d] += n; change -= n * CP[d];
      }
    }
    return out;
  }
  /** Add copper to a purse as gp/sp/cp. */
  function gainCp(cur, cp) {
    const out = {}; for (const d of DENOMS) out[d] = Math.max(0, Math.round(cur?.[d] || 0));
    let r = Math.round(cp);
    for (const d of ["gp", "sp", "cp"]) { const n = Math.floor(r / CP[d]); out[d] += n; r -= n * CP[d]; }
    return out;
  }
  S.spendCp = spendCp; S.gainCp = gainCp;

  /** dnd5e system.price is a bare Number (v2) or {value,denomination} (v3/v4). */
  function priceCpOf(sys) {
    const p = sys?.price;
    if (p == null) return 0;
    if (typeof p === "number") return Math.round(p * 100);
    return Math.round((Number(p.value) || 0) * (CP[p.denomination] ?? 100));
  }
  S.priceCpOf = priceCpOf;

  /* ------------------------------------------------------------------ rng */
  // Seeded so a shop's stock is stable across re-renders and every client
  // derives the same list; "re-roll stock" is just a new seed.
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hashStr(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  S.mulberry32 = mulberry32; S.hashStr = hashStr;

  /* ------------------------------------------------------- catalogue index */
  /**
   * Fold the shipped catalogue + the GM's overrides + any runtime SRD index
   * into fast lookup maps. Call once per catalogue change; cheap enough to
   * call per render.
   */
  function buildIndex(cat, overrides, srdItems) {
    const ov = overrides || {};
    const items = new Map();
    const add = (it) => { if (it && it.id) items.set(it.id, it); };
    for (const it of cat.items || []) add(it);
    for (const it of srdItems || []) add(it);
    for (const [id, def] of Object.entries(ov.free || {})) {
      add({ id, name: def.name, img: def.img, type: def.type || "loot",
            rarity: def.rarity || "common", basePriceGp: Number(def.basePriceGp) || 1,
            categories: def.categories?.length ? def.categories : ["gear"],
            par: def.par ?? 2, stockWeight: def.stockWeight ?? 1, desc: def.desc || "" });
    }
    // Per-item GM overrides win over everything.
    for (const [id, patch] of Object.entries(ov.items || {})) {
      const base = items.get(id); if (!base) continue;
      items.set(id, { ...base, ...patch });
    }
    const types = new Map();
    for (const t of cat.shopTypes || []) types.set(t.id, { ...t, ...(ov.types?.[t.id] || {}) });
    const wealth = new Map((cat.wealth || []).map((w) => [w.tier, w]));
    const sizes = new Map((cat.sizes || []).map((z) => [z.id, z]));
    return { cat, items, types, wealth, sizes,
             labels: cat.categoryLabels || {}, rarityPar: cat.rarityPar || {},
             rarityWeight: cat.rarityWeight || {}, rarityOrder: cat.rarityOrder || [] };
  }
  S.buildIndex = buildIndex;

  /* -------------------------------------------------------------- pricing */
  const STANDING_TIERS = [
    { min: -10, max: -6, id: "hated",      label: "Hated",      color: "#e0454d" },
    { min: -6,  max: -3, id: "hostile",    label: "Hostile",    color: "#e0454d" },
    { min: -3,  max: -1, id: "unfriendly", label: "Unfriendly", color: "#f2b03d" },
    { min: -1,  max: 1,  id: "neutral",    label: "Neutral",    color: "#9fb2bd" },
    { min: 1,   max: 3,  id: "friendly",   label: "Friendly",   color: "#42d16a" },
    { min: 3,   max: 6,  id: "honored",    label: "Honored",    color: "#3aa0ff" },
    { min: 6,   max: 10, id: "exalted",    label: "Exalted",    color: "#b06bf0" },
  ];
  function tierOf(s) {
    const v = clamp(Number(s) || 0, -10, 10);
    for (const t of STANDING_TIERS) if (v >= t.min && v < t.max) return t;
    return STANDING_TIERS[STANDING_TIERS.length - 1];
  }
  S.STANDING_TIERS = STANDING_TIERS; S.tierOf = tierOf;

  const RARITY = {
    common:    { label: "Common",    color: "#9fb2bd" },
    uncommon:  { label: "Uncommon",  color: "#42d16a" },
    rare:      { label: "Rare",      color: "#3aa0ff" },
    veryRare:  { label: "Very Rare", color: "#b06bf0" },
    legendary: { label: "Legendary", color: "#f2b03d" },
    artifact:  { label: "Exotic",    color: "#ff8a4c" },
  };
  S.RARITY = RARITY;

  /** Region modifier for an item at a location (its FIRST category rules). */
  function regionMod(loc, item, ov) {
    const mods = { ...(loc?.mods || {}), ...(ov?.regions?.[loc?.id] || {}) };
    const cat = item?.categories?.[0];
    const m = mods[cat] ?? mods.default ?? 1.0;
    return clamp(Number(m) || 1.0, 0.50, 2.50);
  }
  /** Scarcity: stock below par costs more, a glut costs less. */
  function scarcityMod(qty, par) {
    const p = Math.max(0.5, Number(par) || 1);
    return clamp(Math.pow(p / Math.max(Number(qty) || 0, 0.5), 0.35), 0.80, 1.60);
  }
  /** Standing weight: unaligned shops care half as much, and only about the mean. */
  function standingWeight(type, shop) {
    return (Number(type?.standingWeight) || 1) * (shop?.faction ? 1 : 0.5);
  }
  function standingBuyMod(s, w) { return clamp(1 - 0.03 * clamp(s, -10, 10) * w, 0.70, 1.45); }
  function standingSellMod(s, w) { return clamp(1 + 0.02 * clamp(s, -10, 10) * w, 0.80, 1.25); }
  S.regionMod = regionMod; S.scarcityMod = scarcityMod;
  S.standingBuyMod = standingBuyMod; S.standingSellMod = standingSellMod;

  const markupOf = (shop, type, wealth) =>
    (shop?.markupOverride ?? type?.markup ?? 1) * (wealth?.markup ?? 1);
  const sellRateOf = (shop, type) => shop?.sellRateOverride ?? type?.sellRate ?? 0.45;

  /** True when this shop refuses to deal at all (hostile, and not an outlaw type). */
  function refusesTrade(type, shop, standing) {
    if (type?.outlaw) return false;
    if (!shop?.faction) return false;
    return (Number(standing) || 0) <= -3;
  }
  S.refusesTrade = refusesTrade;

  /**
   * Buy price per unit, in copper, with the full factor breakdown attached so
   * the hover popup can show its working. `env` = {index, loc, shop, type,
   * wealth, standing, overrides, haggle}.
   */
  function priceBuy(item, entry, env) {
    const P0 = Math.max(1, Math.round((Number(item?.basePriceGp) || 0) * 100));
    if (entry?.priceCpOverride != null) {
      const fixed = Math.max(1, Math.round(entry.priceCpOverride));
      return { cp: fixed, P0, fixed: true, factors: [] };
    }
    const w = standingWeight(env.type, env.shop);
    const mRegion = regionMod(env.loc, item, env.overrides);
    const mScarce = scarcityMod(entry?.qty, entry?.par ?? item?.par ?? 2);
    const mStand = standingBuyMod(env.standing, w);
    const mMarkup = markupOf(env.shop, env.type, env.wealth);
    const jit = Number(entry?.jit) || 1;
    const mOutlaw = (env.type?.outlaw && (Number(env.standing) || 0) <= -3) ? 1.25 : 1;
    const mHaggle = Number(env.haggle?.buyMult) || 1;
    let cp = Math.round(P0 * mRegion * mScarce * mStand * mMarkup * jit * mOutlaw * mHaggle);
    cp = Math.round(clamp(cp, 0.25 * P0, 4.0 * P0));
    return {
      cp: Math.max(1, cp), P0, fixed: false,
      factors: [
        ["REGION",   mRegion, env.loc?.name || ""],
        ["SCARCITY", mScarce, `${entry?.qty ?? 0} / par ${entry?.par ?? item?.par ?? 2}`],
        ["STANDING", mStand,  `${tierOf(env.standing).label} (${r2(env.standing)})`],
        ["MARKUP",   mMarkup, `${env.type?.label || ""} · ${env.wealth?.label || ""}`],
        ["JITTER",   jit,     ""],
      ].concat(mOutlaw !== 1 ? [["OUTLAW", mOutlaw, "they deal with anyone — for a price"]] : [])
       .concat(mHaggle !== 1 ? [["HAGGLE", mHaggle, "your deal"]] : []),
    };
  }

  /**
   * Sell price per unit, in copper. Derived from the BASE price, never from the
   * (possibly inflated) buy price — otherwise buying scarce and selling back is
   * a money printer. Hard-capped at 90% of what the same item costs here.
   */
  function priceSell(item, env, onHandQty) {
    const P0 = Math.max(1, Math.round((Number(item?.basePriceGp) || 0) * 100));
    const w = standingWeight(env.type, env.shop);
    const par = Math.max(0.5, Number(item?.par) || 2);
    const mRegion = regionMod(env.loc, item, env.overrides);
    const mStand = standingSellMod(env.standing, w);
    const rate = sellRateOf(env.shop, env.type);
    const mGlut = clamp(1.15 - 0.20 * ((Number(onHandQty) || 0) / par), 0.45, 1.15);
    const mOutlaw = (env.type?.outlaw && (Number(env.standing) || 0) <= -3) ? 0.85 : 1;
    const mHaggle = Number(env.haggle?.sellMult) || 1;
    let cp = Math.round(P0 * mRegion * mStand * rate * mGlut * mOutlaw * mHaggle);
    // Never pay out more than 90% of what the same goods cost here. Price the
    // ceiling against the SAME stock level (a glutted shop sells cheap, so it
    // must also pay little) and against the lowest jitter any line can carry,
    // so no individual entry can be bought and sold back at a profit.
    const ceiling = Math.floor(0.90 * priceBuy(item,
      { qty: Number(onHandQty) || par, par, jit: 0.92 }, env).cp);
    cp = clamp(cp, 1, Math.max(1, ceiling));
    return {
      cp, P0,
      factors: [
        ["REGION",   mRegion, env.loc?.name || ""],
        ["STANDING", mStand,  `${tierOf(env.standing).label} (${r2(env.standing)})`],
        ["OFFER",    rate,    env.type?.label || ""],
        ["GLUT",     mGlut,   `they hold ${Math.round(onHandQty || 0)} / par ${Math.round(par)}`],
      ].concat(mOutlaw !== 1 ? [["OUTLAW", mOutlaw, "no questions, poor rate"]] : [])
       .concat(mHaggle !== 1 ? [["HAGGLE", mHaggle, "your deal"]] : []),
    };
  }
  S.priceBuy = priceBuy; S.priceSell = priceSell;

  /** Does this shop buy things in these categories at all? */
  function buysCategory(type, categories) {
    const buys = type?.buys || [];
    if (buys.includes("*")) return true;
    return (categories || []).some((c) => buys.includes(c));
  }
  S.buysCategory = buysCategory;

  /** Haggle outcome from a finished Persuasion roll. */
  function haggleResult(total, dc, nat) {
    const margin = (Number(total) || 0) - dc;
    if (nat === 20 || margin >= 10) return { sellMult: 1.20, buyMult: 0.90, tone: "great", locked: false,
      text: "They like you. Prices move your way." };
    if (margin >= 0) return { sellMult: 1.10, buyMult: 0.95, tone: "good", locked: false,
      text: "A little off the top." };
    if (nat === 1 || margin <= -5) return { sellMult: 0.90, buyMult: 1.05, tone: "bad", locked: true,
      text: "You have insulted them. The price just went up." };
    return { sellMult: 1.00, buyMult: 1.00, tone: "flat", locked: false,
      text: "They do not budge." };
  }
  S.haggleResult = haggleResult;
  S.haggleDC = (type, shop) => 10 + (Number(type?.haggleDC) || 0) + Math.floor((Number(shop?.wealth) || 3) / 2);

  /* ----------------------------------------------------- stock generation */
  const NAME_PRE = ["Wrenn's", "Halbrook", "Sallow", "Kessik", "Ordo", "Vantt", "Marek's", "Quill",
    "Dromm", "Hesper", "Iolo's", "Barrow", "Tessine", "Corvid", "Ashgate", "Verrow", "Muldoon's",
    "Pell", "Tanaquil", "Grix", "Osgood's", "Ninefold", "Saltmarch", "Ferro", "Lune"];
  const NAME_POST = ["& Co.", "Provisions", "Trade", "Supply", "Exchange", "Works", "Yard", "House",
    "Concern", "Holdings", "Consortium", "Outfitters", "Depot", "Emporium", "Stores", "Chandlery"];
  const KEEPERS = ["Wrenn Sallow", "Ada Kessik", "Old Marek", "Tessine Vann", "Grix", "Hesper Dole",
    "Barrow Nine", "Ilya Corvid", "Muldoon", "Sable Ordo", "Quill", "Fen Ashgate", "Osgood Pell",
    "Tanaquil Rue", "Dromm", "Lune Verrow", "Cass Ferro", "The Bookkeeper", "Nix", "Sister Ammet"];

  function pick(rnd, arr) { return arr[Math.floor(rnd() * arr.length)]; }

  /** A plausible shop name + keeper + blurb, seeded off the shop's own seed. */
  function flavour(type, seed) {
    const rnd = mulberry32((seed >>> 0) ^ 0x9e3779b9);
    const parts = type?.nameParts || {};
    const pre = pick(rnd, parts.pre?.length ? parts.pre : NAME_PRE);
    const post = pick(rnd, parts.post?.length ? parts.post : NAME_POST);
    return {
      name: `${pre} ${post}`,
      keeper: pick(rnd, type?.keeperNames?.length ? type.keeperNames : KEEPERS),
      blurb: type?.blurbs?.length ? pick(rnd, type.blurbs) : "",
    };
  }
  S.flavour = flavour;

  /**
   * Roll a shop's stock. Deterministic in (seed, shop shape, catalogue), so
   * every client renders the same shelves and "re-roll" is a seed bump.
   * Returns a fresh stock array of the 7-field entries the setting stores.
   */
  function generateStock(shop, index, loc, srdItems) {
    const type = index.types.get(shop.type);
    const wealth = index.wealth.get(Number(shop.wealth) || 3) || { sizeMult: 1, rarityCeiling: "rare" };
    const size = index.sizes.get(shop.size) || { slots: 22, cashMult: 1 };
    if (!type) return [];
    const rnd = mulberry32(shop.seed >>> 0);
    const order = index.rarityOrder.length ? index.rarityOrder
      : ["common", "uncommon", "rare", "veryRare", "legendary", "artifact"];
    const ceiling = order.indexOf(wealth.rarityCeiling || "rare");
    const law = Number(loc?.law) || 0;

    const pool = [];
    for (const it of index.items.values()) {
      const cats = it.categories || [];
      if (!cats.some((c) => type.stocks.includes(c))) continue;
      if (order.indexOf(it.rarity || "common") > ceiling) continue;
      if (cats.includes("contraband") && law >= 3 && !type.outlaw) continue;
      const cat = cats[0];
      const affinity = 1 / clamp(Number(loc?.mods?.[cat] ?? loc?.mods?.default ?? 1) || 1, 0.5, 2.5);
      const weight = (Number(it.stockWeight) || 1) * (type.weights?.[cat] ?? 1) *
                     (index.rarityWeight[it.rarity] ?? 1) * affinity;
      if (weight > 0) pool.push({ it, weight });
    }

    const slots = Math.round(clamp((size.slots || 22) * (wealth.sizeMult || 1), 4, 60));
    const chosen = [];
    const taken = new Set();
    const perCat = new Map();                      // how many lines each category has taken
    const bump = (it) => {
      const c = it.categories?.[0] || "gear";
      perCat.set(c, (perCat.get(c) || 0) + 1);
    };
    for (const id of type.always || []) {          // guaranteed lines skip the gates
      const it = index.items.get(id);
      if (it && !taken.has(id)) { taken.add(id); chosen.push(it); bump(it); }
    }
    let live = pool.filter((p) => !taken.has(p.it.id));
    while (chosen.length < slots && live.length) {
      // Diminishing returns per category, so a shop whose pool happens to be
      // 16 fuel items and 3 tools still ends up looking like a shop and not a
      // fuel warehouse. Each line already taken in a category halves the pull
      // of the next one from it.
      let total = 0;
      const eff = live.map((p) => {
        const c = p.it.categories?.[0] || "gear";
        const w = p.weight / (1 + 0.55 * (perCat.get(c) || 0));
        total += w; return w;
      });
      let roll = rnd() * total, hit = live.length - 1;
      for (let i = 0; i < live.length; i++) { roll -= eff[i]; if (roll <= 0) { hit = i; break; } }
      const p = live[hit];
      taken.add(p.it.id); chosen.push(p.it); bump(p.it);
      live = live.slice(0, hit).concat(live.slice(hit + 1));
    }

    return chosen.map((it, i) => {
      const par = Math.max(1, Number(it.par) || index.rarityPar[it.rarity] || 2);
      return {
        eid: `e${i}`, catId: it.id,
        qty: Math.round(clamp(par * (0.5 + rnd()) * (wealth.sizeMult || 1), 1, 99)),
        par,
        jit: r2(0.92 + rnd() * 0.16),
        priceCpOverride: null,
        hidden: false,
      };
    });
  }
  S.generateStock = generateStock;

  /** Cash a shop of this wealth/size should hold, in copper. */
  function shopCash(index, shop) {
    const w = index.wealth.get(Number(shop.wealth) || 3) || { cashGp: 2000 };
    const z = index.sizes.get(shop.size) || { cashMult: 1 };
    return Math.round((w.cashGp || 2000) * (z.cashMult || 1) * 100);
  }
  S.shopCash = shopCash;

  /**
   * Restock: pull quantities back toward par and top the till up, KEEPING the
   * item list and any GM price overrides. Mutates a copy and returns it.
   */
  function restockShop(shop, index, nowMs) {
    const next = { ...shop, stock: (shop.stock || []).map((e) => ({ ...e })) };
    const rnd = mulberry32(hashStr(shop.id + ":" + (nowMs || 0)));
    for (const e of next.stock) {
      e.qty = Math.round(clamp((e.par || 2) * (0.6 + rnd() * 0.8), 0, 99));
    }
    next.cash = shopCash(index, shop);
    next.restockedAt = nowMs || 0;
    next.haggle = {};
    return next;
  }
  S.restockShop = restockShop;

  /** A brand-new shop record, ready to write into the `shops` setting. */
  function makeShop(opts, index, loc) {
    const type = index.types.get(opts.type) || index.types.values().next().value;
    const seed = (opts.seed ?? hashStr(`${opts.type}:${opts.locationId}:${opts.stamp || 0}`)) >>> 0;
    const f = flavour(type, seed);
    const shop = {
      id: opts.id, name: opts.name || f.name, type: type.id,
      locationId: opts.locationId, wealth: clamp(Number(opts.wealth) || 3, 1, 5),
      size: opts.size || "medium", faction: opts.faction ?? loc?.faction ?? null,
      open: opts.open !== false, seed,
      keeper: opts.keeper || f.keeper, blurb: opts.blurb || f.blurb, img: opts.img || "",
      cash: 0, markupOverride: null, sellRateOverride: null,
      createdAt: opts.stamp || 0, restockedAt: opts.stamp || 0,
      stock: [], haggle: {}, log: [],
    };
    shop.cash = shopCash(index, shop);
    shop.stock = generateStock(shop, index, loc);
    return shop;
  }
  S.makeShop = makeShop;

  /* ----------------------------------------------------------------- CSS */
  // Deliberately a COPY of the ship-combat console styling rather than a
  // dependency on it: same palette, same tiles, but its own style id and root
  // class so neither module can break the other and the shop still looks right
  // with ship-combat disabled.
  const CSS = `
.sgshop{position:fixed;inset:0;z-index:60;display:flex;gap:0;background:
   radial-gradient(1200px 700px at 30% -10%,rgba(29,106,134,.22),transparent 60%),#03070d;
  font-family:'Courier New',monospace;color:#cfeef0;overflow:hidden;}
.sgshop *{box-sizing:border-box;}
.sgshop .con-left{flex:0 0 clamp(300px,30%,420px);min-width:0;overflow:auto;padding:16px 16px 22px;
  display:flex;flex-direction:column;gap:14px;border-right:1px solid #12455a;background:rgba(6,14,22,.55);}
.sgshop .con-right{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:12px;padding:16px 18px 20px;overflow:hidden;}
.sgshop .con-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
.sgshop .con-title{flex:1;font-size:16px;font-weight:700;letter-spacing:2px;color:#38e1c4;text-shadow:0 0 10px rgba(56,225,196,.4);}
.sgshop .con-x{cursor:pointer;background:#0a1c26;border:1px solid #1d6a86;color:#cfeef0;border-radius:7px;width:30px;height:30px;font-weight:700;font-family:inherit;}
.sgshop .con-x:hover{border-color:#f2b03d;color:#f2b03d;}
.sgshop .con-inv{cursor:pointer;background:#0a1c26;border:1px solid #1d6a86;color:#cfeef0;border-radius:7px;height:30px;padding:0 9px;font-weight:700;font-family:inherit;font-size:12px;}
.sgshop .con-inv:hover{border-color:#38e1c4;color:#38e1c4;}
.sgshop .con-inv.on{border-color:#38e1c4;color:#38e1c4;box-shadow:0 0 10px rgba(56,225,196,.28);}
.sgshop .con-sec{display:flex;flex-direction:column;gap:8px;}
.sgshop .con-h{font-size:11px;letter-spacing:2px;color:#7fa6b4;border-bottom:1px solid #12455a;padding-bottom:4px;}
.sgshop .con-btns{display:flex;flex-direction:column;gap:8px;}
.sgshop .con-btn{font-family:inherit;text-align:left;font-size:13px;font-weight:700;color:#cfeef0;background:#0a1c26;
  border:1px solid #1d6a86;border-radius:8px;padding:9px 12px;cursor:pointer;transition:border-color .12s,box-shadow .12s;}
.sgshop .con-btn:hover{border-color:#38e1c4;box-shadow:0 0 12px rgba(56,225,196,.35);}
.sgshop .con-btn.armed{border-color:#f2b03d;box-shadow:0 0 14px rgba(242,176,61,.5);color:#f2b03d;}
.sgshop .con-btn[disabled]{opacity:.4;cursor:not-allowed;border-style:dashed;box-shadow:none;}
.sgshop .con-hint{font-size:12px;color:#f2b03d;letter-spacing:1px;text-align:center;}
.sgshop .con-empty{font-size:12px;color:#6f97a6;letter-spacing:1px;}
/* shop identity block */
.sgshop .sh-art{width:100%;aspect-ratio:16/10;border:1px solid #163b4e;border-radius:13px;overflow:hidden;
  display:flex;align-items:center;justify-content:center;font-size:64px;
  background:radial-gradient(120% 90% at 50% 0,rgba(29,106,134,.35),transparent 70%),rgba(8,20,30,.7);}
.sgshop .sh-art img{width:100%;height:100%;object-fit:cover;}
.sgshop .sh-name{font-size:19px;font-weight:700;letter-spacing:1px;color:#eaf7fa;line-height:1.2;}
.sgshop .sh-keeper{font-size:12px;color:#38e1c4;letter-spacing:1px;}
.sgshop .sh-blurb{font-size:12px;line-height:1.5;color:#9fc0cc;}
.sgshop .sh-meta{display:flex;flex-wrap:wrap;gap:6px;}
.sgshop .schip{font-size:10.5px;font-weight:700;letter-spacing:1px;text-transform:uppercase;
  border:1px solid #1d6a86;color:#9fc0cc;background:rgba(10,28,38,.6);border-radius:7px;padding:2px 7px;}
.sgshop .schip.stand{border-color:currentColor;}
/* wealth pips are used in the panel AND in the shop-list popup, which is not
   inside .sgshop — scope them to both roots. */
.sgshop .wpips,.sgsl .wpips{display:inline-flex;gap:3px;align-items:center;}
.sgshop .wpip,.sgsl .wpip{width:7px;height:7px;border-radius:2px;background:#12455a;}
.sgshop .wpip.on,.sgsl .wpip.on{background:#f2b03d;box-shadow:0 0 6px rgba(242,176,61,.7);}
/* money gauges — the fuel/power gauge look */
.sgshop .ig{position:relative;border:1px solid #163b4e;border-radius:12px;padding:10px 13px;
  display:flex;flex-direction:column;justify-content:center;background:linear-gradient(180deg,rgba(16,38,52,.7),rgba(8,20,30,.7));overflow:hidden;}
.sgshop .ig.gm{cursor:pointer;}
.sgshop .ig.gm:hover{border-color:#2b7d99;box-shadow:0 0 16px rgba(56,225,196,.2);}
.sgshop .ig-top{display:flex;align-items:center;gap:9px;margin-bottom:9px;}
.sgshop .ig-ico{font-size:16px;line-height:1;filter:drop-shadow(0 0 5px rgba(0,0,0,.5));}
.sgshop .ig-label{font-size:12px;letter-spacing:2px;color:#8fb2c0;font-weight:700;}
.sgshop .ig-val{margin-left:auto;font-size:18px;font-weight:700;color:#eaf7fa;white-space:nowrap;}
.sgshop .ig-val small{font-size:11px;color:#7fa6b4;font-weight:700;}
.sgshop .ig-track{position:relative;height:15px;border-radius:9px;background:#07141d;border:1px solid #103042;overflow:hidden;box-shadow:inset 0 1px 4px rgba(0,0,0,.7);}
.sgshop .ig-track::after{content:"";position:absolute;inset:0;pointer-events:none;opacity:.45;
  background:repeating-linear-gradient(90deg,transparent 0 13px,rgba(0,0,0,.45) 13px 14px);}
.sgshop .ig-fill{position:absolute;top:0;left:0;bottom:0;border-radius:9px;transition:width .4s cubic-bezier(.2,.7,.2,1);overflow:hidden;}
.sgshop .ig-fill::before{content:"";position:absolute;inset:0;background:linear-gradient(90deg,transparent,rgba(255,255,255,.32),transparent);
  transform:translateX(-100%);animation:sgshop-sheen 3.4s ease-in-out infinite;}
@keyframes sgshop-sheen{0%{transform:translateX(-100%);}55%,100%{transform:translateX(240%);}}
.sgshop .ig.treasury .ig-ico{color:#f2b03d;}
.sgshop .ig.treasury .ig-fill{background:linear-gradient(90deg,#a75f16,#f2b03d,#ffd987);box-shadow:0 0 14px rgba(242,176,61,.75);}
.sgshop .ig.purse .ig-ico{color:#38e1c4;}
.sgshop .ig.purse .ig-fill{background:linear-gradient(90deg,#0f8f89,#38e1c4,#9dffef);box-shadow:0 0 14px rgba(56,225,196,.75);}
.sgshop .ig.broke .ig-val{color:#ff9c9c;}
.sgshop .ig.paying{border-color:#38e1c4;box-shadow:0 0 14px rgba(56,225,196,.3);}
/* tabs / search / list — lifted from the ship inventory */
.sgshop .inv-top{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
.sgshop .inv-tabs{display:flex;gap:6px;}
.sgshop .inv-tab{cursor:pointer;font-family:inherit;font-weight:700;font-size:12px;letter-spacing:1px;color:#7fa6b4;background:#0a1c26;border:1px solid #12455a;border-radius:9px;padding:7px 14px;}
.sgshop .inv-tab:hover{border-color:#1d6a86;color:#cfeef0;}
.sgshop .inv-tab.active{color:#38e1c4;border-color:#38e1c4;box-shadow:0 0 10px rgba(56,225,196,.28);}
.sgshop .inv-search{flex:1;min-width:150px;display:flex;align-items:center;gap:8px;background:#0a1c26;border:1px solid #1d6a86;border-radius:9px;padding:7px 12px;}
.sgshop .inv-search input{flex:1;background:transparent;border:none;outline:none;color:#cfeef0;font-family:inherit;font-size:13px;}
.sgshop .inv-list{flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:10px;padding:6px 2px;border-radius:10px;}
.sgshop .inv-sec{display:flex;flex-direction:column;}
.sgshop .inv-sec-head{display:flex;align-items:center;gap:9px;cursor:pointer;padding:8px 11px;border:1px solid #163b4e;border-radius:9px;user-select:none;
  background:linear-gradient(180deg,rgba(20,44,60,.7),rgba(10,24,34,.6));transition:border-color .12s,box-shadow .12s;}
.sgshop .inv-sec-head:hover{border-color:#2b7d99;box-shadow:0 0 12px rgba(56,225,196,.15);}
.sgshop .inv-caret{color:#38e1c4;font-size:11px;line-height:1;transition:transform .15s;}
.sgshop .inv-sec.collapsed .inv-caret{transform:rotate(-90deg);}
.sgshop .inv-sec-name{font-size:12px;font-weight:700;letter-spacing:1.5px;color:#cfeef0;text-transform:uppercase;}
.sgshop .inv-sec-count{margin-left:auto;font-size:11px;font-weight:700;color:#7fa6b4;background:#0a1c26;border:1px solid #12455a;border-radius:10px;padding:1px 9px;}
.sgshop .inv-sec-body{display:grid;grid-template-columns:repeat(auto-fill,minmax(116px,1fr));gap:12px;padding:10px 4px 6px;}
.sgshop .inv-sec.collapsed .inv-sec-body{display:none;}
.sgshop .inv-tile{position:relative;display:flex;flex-direction:column;align-items:center;gap:6px;padding:8px;border:1px solid #1d6a86;border-radius:13px;
  background:linear-gradient(180deg,rgba(22,48,64,.65),rgba(9,22,32,.65));transition:border-color .12s,box-shadow .12s,transform .12s;}
.sgshop .inv-tile:hover{border-color:#38e1c4;box-shadow:0 0 16px rgba(56,225,196,.35);transform:translateY(-2px);}
.sgshop .inv-tile.oos,.sgshop .inv-tile.nobuy{opacity:.45;border-style:dashed;}
.sgshop .inv-tile.oos:hover,.sgshop .inv-tile.nobuy:hover{border-color:#1d6a86;box-shadow:none;transform:none;}
.sgshop .inv-tile .it-imgwrap{position:relative;margin-top:2px;}
.sgshop .inv-tile .it-imgwrap img{display:block;width:56px;height:56px;object-fit:contain;border-radius:9px;filter:drop-shadow(0 0 5px rgba(0,0,0,.55));background:rgba(4,10,18,.35);}
.sgshop .inv-tile .it-qty{position:absolute;top:-9px;left:50%;transform:translateX(-50%);font-size:12px;font-weight:700;color:#04121c;
  background:#38e1c4;border-radius:9px;padding:1px 8px;box-shadow:0 0 8px rgba(56,225,196,.55);white-space:nowrap;}
.sgshop .inv-tile .it-name{font-size:11px;line-height:1.2;text-align:center;color:#cfeef0;max-height:2.5em;overflow:hidden;}
.sgshop .inv-tile .it-tier{font-size:8.5px;font-weight:700;letter-spacing:1px;text-transform:uppercase;border:1px solid;border-radius:5px;padding:0 5px;opacity:.9;}
.sgshop .inv-tile .it-price{font-size:11.5px;font-weight:700;letter-spacing:.5px;color:#f2b03d;white-space:nowrap;
  text-shadow:0 0 8px rgba(242,176,61,.35);}
.sgshop .inv-tile .it-price.cant{color:#e0454d;text-shadow:none;}
.sgshop .inv-tile .it-price.none{color:#6f97a6;font-size:9.5px;letter-spacing:1px;text-shadow:none;}
.sgshop .inv-tile .it-bottom{display:flex;width:100%;align-items:center;justify-content:space-between;gap:6px;min-height:28px;}
.sgshop .inv-tile .it-bl,.sgshop .inv-tile .it-br{display:flex;gap:4px;}
.sgshop .it-ib{width:28px;height:28px;flex:none;display:flex;align-items:center;justify-content:center;font-size:14px;line-height:1;padding:0;
  font-family:inherit;color:#cfeef0;background:#0a1c26;border:1px solid #1d6a86;border-radius:8px;cursor:pointer;transition:border-color .12s,color .12s,box-shadow .12s;}
.sgshop .it-ib:hover{border-color:#38e1c4;color:#38e1c4;box-shadow:0 0 8px rgba(56,225,196,.3);}
.sgshop .it-ib.danger:hover{border-color:#e0454d;color:#e0454d;box-shadow:0 0 8px rgba(224,69,77,.35);}
.sgshop .it-ib[disabled]{opacity:.35;cursor:not-allowed;}
.sgshop .it-ib.wide{width:auto;padding:0 9px;font-size:12px;font-weight:700;letter-spacing:1px;}
.sgshop .inv-tile .it-tl{position:absolute;top:6px;left:6px;z-index:2;}
.sgshop .inv-tile .it-tr{position:absolute;top:6px;right:6px;z-index:2;}
.sgshop .inv-empty{grid-column:1/-1;color:#6f97a6;font-size:12px;letter-spacing:1px;text-align:center;padding:28px 10px;}
.sgshop .sh-refuse{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;text-align:center;padding:40px 20px;}
.sgshop .sh-refuse.sh-note .rf-big{color:#f2b03d;text-shadow:0 0 14px rgba(242,176,61,.35);}
.sgshop .sh-refuse .rf-big{font-size:17px;font-weight:700;letter-spacing:2px;color:#e0454d;text-shadow:0 0 14px rgba(224,69,77,.4);}
.sgshop .sh-refuse .rf-sub{font-size:12px;color:#9fc0cc;max-width:420px;line-height:1.6;}
@media (max-width:820px){.sgshop{flex-direction:column;}.sgshop .con-left{flex-basis:auto;border-right:none;border-bottom:1px solid #12455a;}}
/* hover detail popup — pointer-events:none so the tile buttons still work */
.sgshop-invpop{position:fixed;z-index:66;width:264px;pointer-events:none;font-family:'Courier New',monospace;
  background:linear-gradient(180deg,#0d2334,#081521);border:1px solid #1d6a86;border-radius:13px;box-shadow:0 16px 46px rgba(0,0,0,.65);
  padding:13px;opacity:0;transform:translateY(4px);transition:opacity .12s,transform .12s;color:#cfeef0;}
.sgshop-invpop.show{opacity:1;transform:none;}
.sgshop-invpop img{width:66px;height:66px;object-fit:contain;float:left;margin:0 11px 6px 0;border-radius:9px;background:rgba(4,10,18,.4);}
.sgshop-invpop .ip-name{font-size:14px;font-weight:700;color:#38e1c4;line-height:1.2;}
.sgshop-invpop .ip-type{font-size:11px;color:#7fa6b4;text-transform:capitalize;margin:2px 0 7px;}
.sgshop-invpop .ip-meta{font-size:11px;color:#9fc0cc;margin-bottom:7px;}
.sgshop-invpop .ip-desc{clear:both;font-size:12px;line-height:1.45;color:#bcd7df;max-height:120px;overflow:hidden;}
.sgshop-invpop .ip-price{clear:both;margin-top:9px;border-top:1px solid #12455a;padding-top:8px;font-size:11px;}
.sgshop-invpop .ip-row{display:flex;justify-content:space-between;gap:8px;color:#8fb2c0;line-height:1.6;}
.sgshop-invpop .ip-row b{color:#cfeef0;font-weight:700;}
.sgshop-invpop .ip-row .ip-why{flex:1;text-align:right;color:#5f8494;font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.sgshop-invpop .ip-row.total{border-top:1px dashed #12455a;margin-top:5px;padding-top:5px;color:#f2b03d;}
.sgshop-invpop .ip-row.total b{color:#f2b03d;font-size:13px;}
/* the shop-list popup + the GM item browser */
.sgsl-overlay{position:fixed;inset:0;z-index:64;background:rgba(2,6,12,.72);display:flex;align-items:center;justify-content:center;
  font-family:'Courier New',monospace;color:#cfeef0;}
.sgsl{width:min(820px,94vw);max-height:84vh;display:flex;flex-direction:column;border:1px solid #1d6a86;border-radius:16px;overflow:hidden;
  background:linear-gradient(180deg,#0c2334,#081521);box-shadow:0 26px 74px rgba(0,0,0,.72);}
.sgsl *{box-sizing:border-box;}
.sgsl-head{display:flex;align-items:center;gap:12px;padding:14px 16px;border-bottom:1px solid #12455a;flex-wrap:wrap;}
.sgsl-title{font-weight:700;letter-spacing:2px;color:#38e1c4;text-shadow:0 0 10px rgba(56,225,196,.4);white-space:nowrap;}
.sgsl-sub{font-size:11px;color:#7fa6b4;letter-spacing:1px;width:100%;}
.sgsl-search{flex:1;min-width:180px;display:flex;align-items:center;gap:8px;background:#0a1c26;border:1px solid #1d6a86;border-radius:9px;padding:8px 12px;}
.sgsl-search input{flex:1;background:transparent;border:none;outline:none;color:#cfeef0;font-family:inherit;font-size:14px;}
.sgsl-x{cursor:pointer;background:#0a1c26;border:1px solid #1d6a86;color:#cfeef0;border-radius:8px;width:32px;height:32px;font-weight:700;font-family:inherit;}
.sgsl-x:hover{border-color:#f2b03d;color:#f2b03d;}
.sgsl-body{flex:1;min-height:0;overflow:auto;padding:12px 16px 16px;display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:10px;align-content:start;}
.sgsl-card{display:flex;gap:11px;align-items:center;padding:11px;border:1px solid #1d6a86;border-radius:11px;cursor:pointer;
  background:linear-gradient(180deg,rgba(22,48,64,.55),rgba(9,22,32,.55));transition:border-color .12s,box-shadow .12s,transform .12s;min-width:0;text-align:left;
  font-family:inherit;color:inherit;}
.sgsl-card:hover{border-color:#38e1c4;box-shadow:0 0 14px rgba(56,225,196,.3);transform:translateY(-2px);}
.sgsl-card.added{border-color:#42d16a;box-shadow:0 0 14px rgba(66,209,106,.5);}
.sgsl-card.shut{opacity:.5;border-style:dashed;}
.sgsl-card img{width:42px;height:42px;flex:none;object-fit:contain;border-radius:8px;background:rgba(4,10,18,.4);}
.sgsl-glyph{width:42px;height:42px;flex:none;display:flex;align-items:center;justify-content:center;font-size:22px;border-radius:8px;
  background:rgba(4,10,18,.45);border:1px solid #163b4e;}
.sgsl-meta{min-width:0;flex:1;display:flex;flex-direction:column;gap:2px;align-items:flex-start;}
.sgsl-name{display:block;max-width:100%;font-size:13px;font-weight:700;color:#eaf7fa;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.sgsl-sub2{display:block;max-width:100%;font-size:11px;color:#7fa6b4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.sgsl-empty{grid-column:1/-1;text-align:center;color:#6f97a6;padding:38px 20px;font-size:12px;letter-spacing:1px;line-height:1.8;}
.sgsl-foot{display:flex;align-items:center;gap:10px;justify-content:flex-start;padding:11px 16px;border-top:1px solid #12455a;flex-wrap:wrap;}
.sgsl-btn{cursor:pointer;font-family:inherit;font-size:12px;font-weight:700;color:#cfeef0;background:#0a1c26;border:1px solid #1d6a86;border-radius:8px;padding:7px 11px;}
.sgsl-btn:hover{border-color:#38e1c4;color:#38e1c4;box-shadow:0 0 10px rgba(56,225,196,.3);}
.sgsl-hint{flex:1;font-size:11px;color:#6f97a6;text-align:right;min-width:140px;}
@keyframes sgshop-swap{from{opacity:0;transform:translateX(26px);}to{opacity:1;transform:none;}}
.sgshop.do-swap .con-right{animation:sgshop-swap .3s cubic-bezier(.2,.75,.25,1) both;}
`;

  S.ensureStyles = function ensureStyles(doc) {
    const d = doc || globalThis.document;
    if (!d || d.getElementById("ssvshop-styles")) return;
    const el = d.createElement("style");
    el.id = "ssvshop-styles";
    el.textContent = CSS;
    d.head.appendChild(el);
  };

  /* --------------------------------------------------------- categorising */
  /**
   * Work out what an arbitrary owned item counts as. Catalogue match first
   * (by id, then by name), then the ordered srdRules, then a plain type map.
   */
  /**
   * Compile a catalogue name pattern. Always case-insensitive, and tolerant of a
   * leading Python-style `(?i)` (JavaScript has no inline flags and throws on
   * one). Cached, and a pattern that will not compile is skipped rather than
   * allowed to abort the render that called it.
   */
  const _reCache = new Map();
  function ruleRe(src) {
    if (_reCache.has(src)) return _reCache.get(src);
    let re = null;
    try {
      re = new RegExp(String(src).replace(/^\(\?[a-z]+\)/, ""), "i");
    } catch (e) {
      console.warn("SSVSHOP | ignoring uncompilable name pattern:", src, e);
    }
    _reCache.set(src, re);
    return re;
  }

  const TYPE_FALLBACK = { weapon: ["weapon"], equipment: ["gear"], consumable: ["gear"],
    tool: ["tool"], loot: ["material"], container: ["gear"], backpack: ["gear"] };

  // Items on an actor rarely match the catalogue character for character:
  // "Rations (1 day)" vs "Navy Ration Pack", stray punctuation, plurals.
  const normName = (s) => String(s || "").toLowerCase()
    .replace(/\(.*?\)/g, " ").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  // No single de-pluralising rule covers both "grenade+s" and "patch+es", so
  // try each candidate: "frag grenades" -> "frag grenade",
  // "vacc suit hull patches" -> "...patch", "batteries" -> "battery".
  const singulars = (n) => [
    n.replace(/ies$/, "y"),
    n.replace(/es$/, ""),
    n.replace(/s$/, ""),
  ].filter((v) => v && v !== n);
  const nameIndex = (index) => index._byName || (index._byName = (() => {
    const m = new Map();
    for (const it of index.items.values()) {
      const n = normName(it.name);
      for (const key of [n, ...singulars(n)]) if (!m.has(key)) m.set(key, it);
    }
    return m;
  })());
  const lookupByName = (index, name) => {
    const m = nameIndex(index), n = normName(name);
    if (m.has(n)) return m.get(n);
    for (const c of singulars(n)) if (m.has(c)) return m.get(c);
    return null;
  };

  /**
   * What an item is worth when nothing else says. Campaign items created by
   * macro often carry no dnd5e `system.price` at all, and without this every
   * one of them prices at zero and the shop refuses to buy it.
   */
  const RARITY_FALLBACK_GP = { common: 1, uncommon: 25, rare: 150, veryRare: 600,
                               legendary: 2000, artifact: 5000 };

  function categoriesFor(item, index) {
    if (item.catId && index.items.has(item.catId)) return index.items.get(item.catId).categories || [];
    if (item.categories?.length) return item.categories;
    const hit = lookupByName(index, item.name);
    if (hit) return hit.categories || [];
    for (const rule of index.cat.srdRules || []) {
      const w = rule.when || {};
      if (w.type && w.type !== item.type) continue;
      if (w.rarityIn && !w.rarityIn.includes(item.rarity)) continue;
      if (w.nameRe && !ruleRe(w.nameRe)?.test(item.name || "")) continue;
      return rule.categories;
    }
    return TYPE_FALLBACK[item.type] || ["gear"];
  }
  /**
   * Base price for an owned item: the catalogue first, then a name match, then
   * its own dnd5e price, and finally a rarity-based estimate so an item with no
   * price data is still worth *something* rather than being unsellable.
   * Returns {gp, estimated} so the UI can be honest about which it used.
   */
  function basePriceOf(item, index) {
    if (item.catId && index.items.has(item.catId))
      return { gp: index.items.get(item.catId).basePriceGp, estimated: false };
    const hit = lookupByName(index, item.name);
    if (hit) return { gp: hit.basePriceGp, estimated: false };
    if (item.basePriceGp != null) return { gp: item.basePriceGp, estimated: false };
    const own = (Number(item.priceCp) || 0) / 100;
    if (own > 0) return { gp: own, estimated: false };
    return { gp: RARITY_FALLBACK_GP[item.rarity] ?? 1, estimated: true };
  }
  const basePriceGpFor = (item, index) => basePriceOf(item, index).gp;
  S.categoriesFor = categoriesFor; S.basePriceGpFor = basePriceGpFor;
  S.basePriceOf = basePriceOf; S.normName = normName;

  /* ------------------------------------------------- transient UI state */
  const _collapsed = new Set();   // section names the user folded away
  let _search = "";
  S.resetUiState = () => { _collapsed.clear(); _search = ""; };

  /* ------------------------------------------------------- hover popup */
  let _pop = null;
  function popEl() {
    const d = globalThis.document;
    if (_pop && _pop.isConnected) return _pop;
    _pop = d.createElement("div");
    _pop.className = "sgshop-invpop";
    _pop.id = "ssvshop-pop";
    d.body.appendChild(_pop);
    return _pop;
  }
  function hidePop() { if (_pop) _pop.classList.remove("show"); }
  S.hidePop = hidePop;

  function priceRows(price, label) {
    const rows = price.factors.map(([name, mult, why]) =>
      `<div class="ip-row"><span>${esc(name)}</span><b>×${r2(mult).toFixed(2)}</b>` +
      `<span class="ip-why">${esc(why || "")}</span></div>`).join("");
    return `<div class="ip-price">` +
      `<div class="ip-row"><span>BASE</span><b>${esc(fmtCpShort(price.P0))}</b><span class="ip-why"></span></div>` +
      rows +
      `<div class="ip-row total"><span>${esc(label)}</span><b>${esc(fmtCpShort(price.cp))}</b>` +
      `<span class="ip-why"></span></div></div>`;
  }

  function showPop(view, tileEl, ctx) {
    const el = popEl();
    const showMath = (ctx.isGM || ctx.config?.showBreakdown) && view.price && !view.price.fixed;
    const meta = [];
    if (view.rarity) meta.push(RARITY[view.rarity]?.label || view.rarity);
    if (view.stock != null) meta.push(`Stock ${view.stock}`);
    if (view.owned != null) meta.push(`You have ${view.owned}`);
    if (view.weight) meta.push(`${view.weight} lb`);
    if (view.estimated) meta.push("value estimated");
    el.innerHTML =
      `<img src="${esc(view.img)}" alt="">` +
      `<div class="ip-name">${esc(view.name)}</div>` +
      `<div class="ip-type">${esc(view.typeLabel || view.type || "")}</div>` +
      (meta.length ? `<div class="ip-meta">${esc(meta.join(" · "))}</div>` : "") +
      (view.desc ? `<div class="ip-desc">${esc(view.desc)}</div>` : "") +
      (view.price ? (showMath ? priceRows(view.price, view.priceLabel || "UNIT")
        : `<div class="ip-price"><div class="ip-row total"><span>${esc(view.priceLabel || "UNIT")}</span>` +
          `<b>${esc(fmtCpShort(view.price.cp))}</b><span class="ip-why"></span></div></div>`) : "");
    // place beside the tile, flipping when it would leave the viewport
    const r = tileEl.getBoundingClientRect();
    const w = 264, gap = 12;
    let left = r.right + gap;
    if (left + w > globalThis.innerWidth - 8) left = Math.max(8, r.left - w - gap);
    el.style.left = left + "px";
    el.style.top = "0px";
    el.classList.add("show");
    const h = el.offsetHeight;
    let top = r.top + r.height / 2 - h / 2;
    top = clamp(top, 8, Math.max(8, globalThis.innerHeight - h - 8));
    el.style.top = top + "px";
  }

  /* --------------------------------------------------------- tile markup */
  function tileHtml(v) {
    const rar = RARITY[v.rarity] || RARITY.common;
    const cls = ["inv-tile"];
    if (v.oos) cls.push("oos");
    if (v.nobuy) cls.push("nobuy");
    const priceCls = v.nobuy ? "it-price none" : (v.cant ? "it-price cant" : "it-price");
    const priceTxt = v.nobuy ? "NOT BOUGHT" : fmtCpShort(v.price.cp);
    return `<div class="${cls.join(" ")}" data-key="${esc(v.key)}" data-name="${esc(v.name.toLowerCase())}">` +
      (v.gmDelete ? `<button class="it-ib it-tl danger" data-act="gmdel" title="Remove from stock">🗑</button>` : "") +
      (v.gmEdit ? `<button class="it-ib it-tr" data-act="gmedit" title="Edit quantity / price">✎</button>` : "") +
      `<div class="it-imgwrap"><img src="${esc(v.img)}" alt="">` +
        (v.badge ? `<span class="it-qty">${esc(v.badge)}</span>` : "") + `</div>` +
      `<span class="it-name">${esc(v.name)}</span>` +
      `<span class="it-tier" style="color:${rar.color};border-color:${rar.color}">${esc(rar.label)}</span>` +
      `<span class="${priceCls}">${esc(priceTxt)}</span>` +
      `<div class="it-bottom">` +
        `<span class="it-bl">` + (v.canAct && v.maxQty > 1
          ? `<button class="it-ib" data-act="many" title="Choose a quantity">＃</button>` : "") + `</span>` +
        `<span class="it-br">` + (v.canAct
          ? `<button class="it-ib wide" data-act="one" title="${esc(v.actionTitle)}">${esc(v.actionIcon)}</button>`
          : "") + `</span>` +
      `</div></div>`;
  }

  /** Group views into collapsible sections in catalogue-category order. */
  function sectionsHtml(views, index) {
    const order = index.cat.categories || [];
    const labels = index.labels;
    const buckets = new Map();
    for (const v of views) {
      const key = v.section;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(v);
    }
    const keys = [...buckets.keys()].sort((a, b) => {
      const ia = order.indexOf(a), ib = order.indexOf(b);
      return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
    });
    if (!keys.length) return `<div class="inv-sec"><div class="inv-sec-body">` +
      `<div class="inv-empty">NOTHING HERE.</div></div></div>`;
    return keys.map((k) => {
      const list = buckets.get(k);
      const label = labels[k] || k;
      const collapsed = _collapsed.has(k) ? " collapsed" : "";
      return `<div class="inv-sec${collapsed}" data-sec="${esc(k)}">` +
        `<div class="inv-sec-head"><span class="inv-caret">▾</span>` +
        `<span class="inv-sec-name">${esc(label)}</span>` +
        `<span class="inv-sec-count">${list.length}</span></div>` +
        `<div class="inv-sec-body">${list.map(tileHtml).join("")}</div></div>`;
    }).join("");
  }

  /* ------------------------------------------------------ the shop panel */
  const money = (cp) => fmtCp(cp);

  function gaugeHtml(kind, label, ico, cp, paying, clickable) {
    // No natural maximum for money, so the bar is "how full against a soft
    // reference" — it reads as a fuel gauge without ever claiming a cap.
    const soft = Math.max(cp, 10000);
    const pct = clamp((cp / soft) * 100, cp > 0 ? 4 : 0, 100);
    const cls = ["ig", kind];
    if (cp <= 0) cls.push("broke");
    if (paying) cls.push("paying");
    if (clickable) cls.push("gm");
    return `<div class="${cls.join(" ")}"${clickable ? ` data-edit="${kind}"` : ""}>` +
      `<div class="ig-top"><span class="ig-ico">${ico}</span><span class="ig-label">${esc(label)}</span>` +
      `<span class="ig-val">${esc(money(cp))}</span></div>` +
      `<div class="ig-track"><div class="ig-fill" style="width:${pct.toFixed(1)}%"></div></div></div>`;
  }

  function leftPanel(ctx) {
    const { shop, loc, index } = ctx;
    const type = index.types.get(shop.type) || {};
    const wealth = index.wealth.get(Number(shop.wealth) || 3) || {};
    const size = index.sizes.get(shop.size) || {};
    const tier = tierOf(ctx.standing);
    const pips = [1, 2, 3, 4, 5].map((n) =>
      `<span class="wpip${n <= (shop.wealth || 3) ? " on" : ""}"></span>`).join("");
    const payShip = ctx.purse === "ship";
    const treasuryLocked = !ctx.isGM && ctx.config?.treasuryOpenToPlayers === false;
    return `` +
      `<div class="sh-art">${shop.img ? `<img src="${esc(shop.img)}" alt="">` : esc(type.icon || "🛒")}</div>` +
      `<div class="con-sec">` +
        `<div class="sh-name">${esc(shop.name)}</div>` +
        (shop.keeper ? `<div class="sh-keeper">${esc(shop.keeper)}</div>` : "") +
        (shop.blurb ? `<div class="sh-blurb">${esc(shop.blurb)}</div>` : "") +
        `<div class="sh-meta">` +
          `<span class="schip">${esc(type.label || shop.type)}</span>` +
          `<span class="schip">${esc(loc?.name || "Unknown")}</span>` +
          `<span class="schip">${esc(size.label || shop.size)}</span>` +
          `<span class="schip">${esc(wealth.label || "")} <span class="wpips">${pips}</span></span>` +
          `<span class="schip stand" style="color:${tier.color}">${esc(tier.label)} ${r2(ctx.standing)}</span>` +
        `</div>` +
      `</div>` +
      `<div class="con-sec"><div class="con-h">MONEY</div>` +
        gaugeHtml("treasury", "SHIP TREASURY", "⛁", ctx.treasuryCp, payShip, ctx.isGM) +
        gaugeHtml("purse", "YOUR PURSE", "◈", ctx.purseCp, !payShip, false) +
        `<div class="con-btns">` +
          `<button class="con-btn${payShip ? " armed" : ""}" data-purse="ship"${treasuryLocked ? " disabled" : ""}>` +
            `PAY / BANK: SHIP</button>` +
          `<button class="con-btn${!payShip ? " armed" : ""}" data-purse="you"${ctx.hasPlayerActor ? "" : " disabled"}>` +
            `PAY / BANK: YOU</button>` +
        `</div>` +
        (treasuryLocked ? `<div class="con-empty">The treasury is GM-locked.</div>` : "") +
        (ctx.hasPlayerActor ? "" : `<div class="con-empty">No character assigned to you.</div>`) +
      `</div>` +
      `<div class="con-sec"><div class="con-h">TILL</div>` +
        `<div class="con-empty">They can pay out ${esc(money(shop.cash || 0))}.</div>` +
        (ctx.config?.haggleEnabled && !ctx.isGM
          ? `<button class="con-btn" data-act="haggle"${ctx.haggle ? " disabled" : ""}>` +
            (ctx.haggle ? `HAGGLED — ${esc(ctx.haggle.text || "done")}` : "HAGGLE (PERSUASION)") + `</button>`
          : "") +
      `</div>` +
      (ctx.isGM ? `<div class="con-sec"><div class="con-h">GM</div><div class="con-btns">` +
        `<button class="con-btn" data-act="gmpanel">⚙ SHOP SETTINGS</button>` +
        `<button class="con-btn" data-act="gmtreasury">⛁ EDIT TREASURY</button>` +
        `</div></div>` : "");
  }

  /** Build the tile view-models for BUY mode. */
  function buyViews(ctx) {
    const { shop, index } = ctx;
    const env = priceEnv(ctx);
    const spendable = ctx.purse === "ship" ? ctx.treasuryCp : ctx.purseCp;
    const out = [];
    for (const e of shop.stock || []) {
      if (e.hidden && !ctx.isGM) continue;
      const item = index.items.get(e.catId);
      if (!item) continue;
      const price = priceBuy(item, e, env);
      out.push({
        key: e.eid, kind: "buy", name: item.name, img: item.img, rarity: item.rarity || "common",
        type: item.type, typeLabel: item.type, desc: item.desc, section: item.categories?.[0] || "gear",
        price, priceLabel: "UNIT", badge: e.qty > 0 ? `×${e.qty}` : "0",
        stock: e.qty, oos: e.qty <= 0, nobuy: false,
        cant: price.cp > spendable, maxQty: Math.max(1, e.qty),
        canAct: e.qty > 0 && ctx.canTrade && !ctx.readOnly,
        actionIcon: "BUY", actionTitle: `Buy one for ${fmtCp(price.cp)}`,
        gmDelete: ctx.isGM, gmEdit: ctx.isGM,
        item, entry: e,
      });
    }
    return out;
  }

  /** Build the tile view-models for SELL mode (the party's own goods). */
  function sellViews(ctx) {
    const { shop, index } = ctx;
    const type = index.types.get(shop.type) || {};
    const env = priceEnv(ctx);
    const held = new Map();
    for (const e of shop.stock || []) held.set(e.catId, (held.get(e.catId) || 0) + (e.qty || 0));
    const out = [];
    for (const it of ctx.partyItems || []) {
      const cats = categoriesFor(it, index);
      const { gp, estimated } = basePriceOf(it, index);
      const pseudo = { ...it, categories: cats, basePriceGp: gp,
                       par: index.items.get(it.catId)?.par || index.rarityPar[it.rarity] || 2 };
      const takes = buysCategory(type, cats) && gp > 0;
      const onHand = held.get(it.catId) || 0;
      const price = priceSell(pseudo, env, onHand);
      out.push({
        key: it.id, kind: "sell", name: it.name, img: it.img, rarity: it.rarity || "common",
        type: it.type, typeLabel: it.type, desc: it.desc, section: cats[0] || "gear",
        price, priceLabel: "THEY PAY", badge: `×${it.qty}`, owned: it.qty,
        oos: false, nobuy: !takes, cant: false, maxQty: Math.max(1, it.qty), estimated,
        canAct: takes && ctx.canTrade && !ctx.readOnly && (shop.cash || 0) >= price.cp,
        actionIcon: "SELL", actionTitle: `Sell one for ${fmtCp(price.cp)}`,
        gmDelete: false, gmEdit: false,
        item: pseudo, owned_id: it.id,
      });
    }
    return out;
  }

  function priceEnv(ctx) {
    const index = ctx.index;
    return {
      index, loc: ctx.loc, shop: ctx.shop,
      type: index.types.get(ctx.shop.type),
      wealth: index.wealth.get(Number(ctx.shop.wealth) || 3),
      standing: Number(ctx.standing) || 0,
      overrides: ctx.overrides || {},
      haggle: ctx.haggle || null,
    };
  }
  S.priceEnv = priceEnv;

  /**
   * Render the whole shop over `root`. `ctx` is built by shop.js (Foundry) or
   * preview.html; see MAINTAINING.md for the full contract.
   */
  S.renderShop = function renderShop(root, ctx) {
    S.ensureStyles(root.ownerDocument);
    hidePop();
    const { shop, index } = ctx;
    const type = index.types.get(shop.type) || {};
    root.className = "sgshop" + (ctx.animateSwap ? " do-swap" : "");

    if (ctx.gmPanel && ctx.isGM) return renderGMPanel(root, ctx);

    const refuses = refusesTrade(type, shop, ctx.standing);
    const views = refuses ? [] : (ctx.mode === "sell" ? sellViews(ctx) : buyViews(ctx));
    const canSwitchSide = ctx.mode === "sell" ? true : true;

    const body = (!refuses && !views.length && ctx.sideEmptyReason)
      ? `<div class="sh-refuse sh-note"><div class="rf-big">${esc(ctx.sideEmptyReason.title)}</div>` +
        `<div class="rf-sub">${esc(ctx.sideEmptyReason.text)}</div></div>`
      : refuses
      ? `<div class="sh-refuse"><div class="rf-big">THEY REFUSE TO DEAL WITH YOU</div>` +
        `<div class="rf-sub">Word travels. ${esc(shop.name)} answers to ${esc(ctx.factionName || "their patrons")}, ` +
        `and your standing there is ${esc(tierOf(ctx.standing).label.toLowerCase())}. ` +
        `Mend that — or find someone who does not care who you are.</div></div>`
      : `<div class="inv-list">${sectionsHtml(views, index)}</div>`;

    root.innerHTML =
      `<div class="con-left">${leftPanel(ctx)}</div>` +
      `<div class="con-right">` +
        `<div class="con-head">` +
          `<span class="con-title">${esc(shop.name.toUpperCase())}</span>` +
          (ctx.isGM ? `<button class="con-inv" data-act="gmpanel">⚙ GM</button>` : "") +
          `<button class="con-x" data-act="close" title="Close (Esc)">✕</button>` +
        `</div>` +
        `<div class="inv-top">` +
          `<div class="inv-tabs">` +
            `<button class="inv-tab${ctx.mode === "buy" ? " active" : ""}" data-mode="buy">🛒 BUY</button>` +
            `<button class="inv-tab${ctx.mode === "sell" ? " active" : ""}" data-mode="sell">💰 SELL</button>` +
          `</div>` +
          (canSwitchSide ? `<div class="inv-tabs">` +
            `<button class="inv-tab${ctx.side === "ship" ? " active" : ""}" data-side="ship">SHIP CARGO</button>` +
            `<button class="inv-tab${ctx.side === "you" ? " active" : ""}" data-side="you">YOUR ITEMS</button>` +
          `</div>` : "") +
          `<div class="inv-search"><span>🔎</span>` +
            `<input type="text" placeholder="${ctx.mode === "sell" ? "Search your goods…" : "Search the shelves…"}" ` +
            `value="${esc(_search)}" data-search="1"></div>` +
          (ctx.isGM ? `<button class="con-inv" data-act="additem">＋ Add item</button>` +
                      `<button class="con-inv" data-act="reroll">⟳ Re-roll</button>` : "") +
        `</div>` +
        (ctx.mode === "buy"
          ? `<div class="con-empty">Buying into <b>${ctx.side === "ship" ? "ship cargo" : "your own kit"}</b>` +
            `, paid from <b>${ctx.purse === "ship" ? "the ship treasury" : "your purse"}</b>.</div>`
          : `<div class="con-empty">Selling from <b>${ctx.side === "ship" ? "ship cargo" : "your own kit"}</b>` +
            `, banked to <b>${ctx.purse === "ship" ? "the ship treasury" : "your purse"}</b>.</div>`) +
        (ctx.canTrade ? "" : `<div class="con-hint">${esc(ctx.blockedReason || "TRADING IS CLOSED.")}</div>`) +
        body +
      `</div>`;

    wireShop(root, ctx, views);
    applySearch(root);
  };

  function applySearch(root) {
    const q = _search.trim().toLowerCase();
    for (const sec of root.querySelectorAll(".inv-sec")) {
      let shown = 0;
      for (const tile of sec.querySelectorAll(".inv-tile")) {
        const hit = !q || (tile.dataset.name || "").includes(q);
        tile.style.display = hit ? "" : "none";
        if (hit) shown++;
      }
      sec.style.display = shown ? "" : "none";
      const count = sec.querySelector(".inv-sec-count");
      if (count && q) count.textContent = String(shown);
    }
  }

  function wireShop(root, ctx, views) {
    const byKey = new Map(views.map((v) => [v.key, v]));
    const on = (sel, ev, fn) => root.querySelectorAll(sel).forEach((el) => el.addEventListener(ev, fn));

    on("[data-act='close']", "click", () => ctx.close?.());
    on("[data-act='gmpanel']", "click", () => ctx.openGMPanel?.());
    on("[data-act='gmtreasury']", "click", () => ctx.editTreasury?.());
    on("[data-act='additem']", "click", () => ctx.gmAddItem?.());
    on("[data-act='reroll']", "click", () => ctx.gmReroll?.());
    on("[data-act='haggle']", "click", () => ctx.doHaggle?.());
    on("[data-edit='treasury']", "click", () => ctx.editTreasury?.());
    on("[data-mode]", "click", (e) => ctx.setMode?.(e.currentTarget.dataset.mode));
    on("[data-side]", "click", (e) => ctx.setSide?.(e.currentTarget.dataset.side));
    on("[data-purse]", "click", (e) => {
      if (e.currentTarget.disabled) return;
      ctx.setPurse?.(e.currentTarget.dataset.purse);
    });

    const search = root.querySelector("[data-search]");
    if (search) {
      search.addEventListener("input", () => { _search = search.value; applySearch(root); });
      // keep focus across the in-place filter, exactly like the ship inventory
      if (_search) { search.focus(); search.setSelectionRange(_search.length, _search.length); }
    }

    for (const head of root.querySelectorAll(".inv-sec-head")) {
      head.addEventListener("click", () => {
        const sec = head.closest(".inv-sec"); const key = sec.dataset.sec;
        if (_collapsed.has(key)) _collapsed.delete(key); else _collapsed.add(key);
        sec.classList.toggle("collapsed");
      });
    }

    for (const tile of root.querySelectorAll(".inv-tile")) {
      const v = byKey.get(tile.dataset.key);
      if (!v) continue;
      tile.addEventListener("mouseenter", () => showPop(v, tile, ctx));
      tile.addEventListener("mouseleave", hidePop);
      tile.querySelectorAll("[data-act]").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation(); hidePop();
          const act = btn.dataset.act;
          if (act === "gmdel") return ctx.gmRemoveEntry?.(v.key);
          if (act === "gmedit") return ctx.gmEditEntry?.(v.key);
          const many = act === "many";
          if (v.kind === "buy") ctx.buy?.(v.key, many ? null : 1, v.price.cp);
          else ctx.sell?.(v.key, many ? null : 1, v.price.cp);
        });
      });
    }
  }

  /* ---------------------------------------------------------- GM panel */
  function renderGMPanel(root, ctx) {
    const { shop, index } = ctx;
    const type = index.types.get(shop.type) || {};
    const wealth = index.wealth.get(Number(shop.wealth) || 3) || {};
    const size = index.sizes.get(shop.size) || {};
    const rows = [
      ["rename",   "✎ Name…",                 shop.name],
      ["type",     "🏷 Type…",                 type.label || shop.type],
      ["location", "📍 Location…",             ctx.loc?.name || shop.locationId],
      ["wealth",   "💰 Wealth…",               wealth.label || shop.wealth],
      ["size",     "📐 Size…",                 size.label || shop.size],
      ["faction",  "⚑ Faction…",               ctx.factionName || "unaligned"],
      ["keeper",   "👤 Keeper & blurb…",       shop.keeper || "—"],
      ["markup",   "📈 Markup override…",      shop.markupOverride == null ? "auto" : `×${shop.markupOverride}`],
      ["sellrate", "📉 Sell-rate override…",   shop.sellRateOverride == null ? "auto" : `×${shop.sellRateOverride}`],
      ["cash",     "⛁ Till…",                  money(shop.cash || 0)],
      ["shipactor", "🚀 Ship cargo actor…",    ctx.shipActorName || "NOT SET"],
    ];
    root.innerHTML =
      `<div class="con-left">${leftPanel(ctx)}</div>` +
      `<div class="con-right">` +
        `<div class="con-head"><span class="con-title">GM — ${esc(shop.name.toUpperCase())}</span>` +
          `<button class="con-inv on" data-act="back">← BACK TO SHOP</button>` +
          `<button class="con-x" data-act="close">✕</button></div>` +
        `<div class="inv-list">` +
          `<div class="con-sec"><div class="con-h">SHOP</div><div class="con-btns">` +
            rows.map(([k, label, val]) =>
              `<button class="con-btn" data-gm="${k}">${esc(label)} <span style="float:right;color:#7fa6b4">` +
              `${esc(String(val))}</span></button>`).join("") +
            `<button class="con-btn${shop.open ? " armed" : ""}" data-gm="open">` +
              `${shop.open ? "🔓 OPEN — players can shop here" : "🔒 CLOSED — hidden from players"}</button>` +
          `</div></div>` +
          `<div class="con-sec"><div class="con-h">STOCK — ${shop.stock?.length || 0} LINES</div><div class="con-btns">` +
            `<button class="con-btn" data-gm="additem">＋ Add an item…</button>` +
            `<button class="con-btn" data-gm="reroll">⟳ Re-roll the whole stock</button>` +
            `<button class="con-btn" data-gm="restock">📦 Restock (quantities back toward par)</button>` +
            `<button class="con-btn" data-gm="clearhaggle">🤝 Clear everyone's haggle result</button>` +
          `</div></div>` +
          `<div class="con-sec"><div class="con-h">LOG</div>` +
            (shop.log?.length
              ? shop.log.slice(-12).reverse().map((l) =>
                  `<div class="con-empty">${esc(l.kind === "buy" ? "→" : "←")} ${esc(l.who || "someone")} ` +
                  `${esc(l.kind)} ${esc(l.name)} ×${esc(l.qty)} for ${esc(fmtCpShort(l.cp))}</div>`).join("")
              : `<div class="con-empty">Nothing has changed hands here yet.</div>`) +
          `</div>` +
          `<div class="con-sec"><div class="con-h">DANGER</div><div class="con-btns">` +
            `<button class="con-btn" data-gm="delete" style="border-color:#e0454d;color:#e0454d">🗑 Delete this shop</button>` +
          `</div></div>` +
        `</div>` +
      `</div>`;
    root.querySelectorAll("[data-act='back']").forEach((b) =>
      b.addEventListener("click", () => ctx.closeGMPanel?.()));
    root.querySelectorAll("[data-act='close']").forEach((b) =>
      b.addEventListener("click", () => ctx.close?.()));
    root.querySelectorAll("[data-gm]").forEach((b) =>
      b.addEventListener("click", () => ctx.gmAction?.(b.dataset.gm)));
    root.querySelectorAll("[data-purse]").forEach((b) =>
      b.addEventListener("click", () => ctx.setPurse?.(b.dataset.purse)));
    root.querySelectorAll("[data-edit='treasury']").forEach((b) =>
      b.addEventListener("click", () => ctx.editTreasury?.()));
    root.querySelectorAll("[data-act='gmtreasury']").forEach((b) =>
      b.addEventListener("click", () => ctx.editTreasury?.()));
  }

  /* -------------------------------------------------- the shop-list popup */
  /**
   * `ctx` = {isGM, locName, locBlurb, shops:[{id,name,typeLabel,icon,wealth,size,open}],
   *          openShop(id), close(), gmNewShop(), gmSetLocation(), gmManage(), noGM}
   */
  S.renderShopList = function renderShopList(root, ctx) {
    S.ensureStyles(root.ownerDocument);
    root.className = "sgsl-overlay";
    const cards = ctx.shops.map((s) => {
      const pips = [1, 2, 3, 4, 5].map((n) =>
        `<span class="wpip${n <= (s.wealth || 3) ? " on" : ""}"></span>`).join("");
      return `<button class="sgsl-card${s.open ? "" : " shut"}" data-shop="${esc(s.id)}">` +
        `<span class="sgsl-glyph">${esc(s.icon || "🛒")}</span>` +
        `<span class="sgsl-meta"><span class="sgsl-name">${esc(s.name)}</span>` +
        `<span class="sgsl-sub2">${esc(s.typeLabel)} · ${esc(s.size)}${s.open ? "" : " · CLOSED"}</span>` +
        `<span class="wpips">${pips}</span></span></button>`;
    }).join("");
    root.innerHTML =
      `<div class="sgsl">` +
        `<div class="sgsl-head">` +
          `<span class="sgsl-title">SHOPS — ${esc((ctx.locName || "NOWHERE").toUpperCase())}</span>` +
          `<span style="flex:1"></span>` +
          `<button class="sgsl-x" data-act="close">✕</button>` +
          (ctx.locBlurb ? `<div class="sgsl-sub">${esc(ctx.locBlurb)}</div>` : "") +
        `</div>` +
        `<div class="sgsl-body">` +
          (cards || `<div class="sgsl-empty">NO SHOPS HERE.<br>Nothing but dust and locked hatches.` +
            (ctx.isGM ? `<br><br>Open a shop with ＋ New shop below, or move the crew somewhere with a market.`
                      : "") + `</div>`) +
        `</div>` +
        `<div class="sgsl-foot">` +
          (ctx.isGM
            ? `<button class="sgsl-btn" data-act="new">＋ New shop…</button>` +
              `<button class="sgsl-btn" data-act="where">📍 Set location…</button>` +
              `<button class="sgsl-btn" data-act="manage">⚙ Manage shops…</button>` +
              `<button class="sgsl-btn" data-act="treasury">⛁ Treasury…</button>`
            : "") +
          `<span class="sgsl-hint">${esc(ctx.noGM ? "No GM connected — the market is shut."
                                                  : "Esc to close")}</span>` +
        `</div>` +
      `</div>`;
    root.querySelectorAll("[data-shop]").forEach((b) =>
      b.addEventListener("click", () => ctx.openShop?.(b.dataset.shop)));
    const act = { close: ctx.close, new: ctx.gmNewShop, where: ctx.gmSetLocation,
                  manage: ctx.gmManage, treasury: ctx.editTreasury };
    root.querySelectorAll("[data-act]").forEach((b) =>
      b.addEventListener("click", () => act[b.dataset.act]?.()));
    root.addEventListener("mousedown", (e) => { if (e.target === root) ctx.close?.(); });
  };
})();
