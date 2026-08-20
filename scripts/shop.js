/**
 * SSV Silver Gull — Shops & Trade : Foundry wiring.
 *
 * All UI and all pricing live in shop-render.js (globalThis.SSVSHOP); this file
 * only does Foundry: settings, the ctx contract, dialogs, the socket, and the
 * GM-side transaction handlers. Players never write — every mutation is sent to
 * the active GM, who re-derives the price and commits it.
 */
const MODULE_ID = "ssv-silver-gull-shop";
const SOCKET = `module.${MODULE_ID}`;
const POLITICS_ID = "ssv-silver-gull-politics";
const SHIPCOMBAT_ID = "ssv-silver-gull-ship-combat";
const DEFAULT_ITEM_IMG = "icons/svg/item-bag.svg";

const SET_SHOPS = "shops";
const SET_LOCATIONS = "locations";
const SET_TREASURY = "treasury";
const SET_OVERRIDES = "catalogueOverrides";
const SET_CONFIG = "config";

const S = () => globalThis.SSVSHOP;
const D2 = () => foundry.applications?.api?.DialogV2;
const isActiveGM = () =>
  game.user.isGM && (game.users?.activeGM?.id ?? game.user.id) === game.user.id;
const anyGM = () => !!game.users?.activeGM || game.user.isGM;

/* ------------------------------------------------------------- catalogue */
let CATALOGUE = null;
let INDEX = null;
let SRD_INDEX = null;          // built lazily, cached for the session

async function loadCatalogue() {
  if (CATALOGUE) return CATALOGUE;
  const res = await fetch(`modules/${MODULE_ID}/data/shops-catalogue.json`);
  CATALOGUE = await res.json();
  return CATALOGUE;
}
function rebuildIndex() {
  INDEX = S().buildIndex(CATALOGUE, getOverrides(), SRD_INDEX || []);
  return INDEX;
}
function idx() { return INDEX || rebuildIndex(); }

/**
 * Index every Item compendium in the world. Pack ids differ between dnd5e
 * majors (v3 `dnd5e.items`; v4 splits into PHB'24 packs, and some worlds get
 * their SRD content from a separate module), so never hardcode one — walk
 * game.packs the way the ship-combat item browser does.
 */
async function buildSrdIndex() {
  if (SRD_INDEX) return SRD_INDEX;
  const out = [];
  const rules = CATALOGUE.srdRules || [];
  const packs = (game.packs || []).filter((p) => p.documentName === "Item");
  for (const p of packs) {
    let index;
    try {
      index = await p.getIndex({ fields: ["img", "type", "system.price", "system.rarity"] });
    } catch (e) { console.warn(`${MODULE_ID} | could not index ${p.collection}`, e); continue; }
    for (const e of index) {
      const priceCp = S().priceCpOf(e.system);
      if (!priceCp) continue;                       // no price = not sellable stock
      const cats = categoriesFromRules(e, rules);
      if (!cats) continue;
      out.push({
        id: `srd:${p.collection}.${e._id}`, uuid: `Compendium.${p.collection}.${e._id}`,
        name: e.name, img: e.img || DEFAULT_ITEM_IMG, type: e.type,
        rarity: e.system?.rarity || "common", basePriceGp: priceCp / 100,
        categories: cats, par: CATALOGUE.rarityPar?.[e.system?.rarity || "common"] ?? 4,
        stockWeight: 0.85, desc: "",
      });
    }
  }
  SRD_INDEX = out;
  console.log(`${MODULE_ID} | indexed ${out.length} priced compendium items from ${packs.length} packs`);
  rebuildIndex();
  return out;
}
function categoriesFromRules(entry, rules) {
  for (const rule of rules) {
    const w = rule.when || {};
    if (w.type && w.type !== entry.type) continue;
    if (w.rarityIn && !w.rarityIn.includes(entry.system?.rarity)) continue;
    if (w.nameRe && !new RegExp(w.nameRe).test(entry.name || "")) continue;
    return rule.categories;
  }
  return null;
}

/* ------------------------------------------------------------- settings */
const getShops = () => normalizeShops(game.settings.get(MODULE_ID, SET_SHOPS));
const getLocations = () => normalizeLocations(game.settings.get(MODULE_ID, SET_LOCATIONS));
const getTreasury = () => normalizeTreasury(game.settings.get(MODULE_ID, SET_TREASURY));
const getOverrides = () => game.settings.get(MODULE_ID, SET_OVERRIDES) || {};
const getConfig = () => ({
  haggleEnabled: true, showBreakdown: true, treasuryOpenToPlayers: true,
  restockDays: 7, shipActorId: "",
  ...(game.settings.get(MODULE_ID, SET_CONFIG) || {}),
});

// Merge stored data onto defaults so new fields appear without a world reset.
function normalizeShops(stored) {
  const out = {};
  for (const [id, s] of Object.entries(stored || {})) {
    out[id] = {
      id, name: "Unnamed", type: "general-store", locationId: "", wealth: 3, size: "medium",
      faction: null, open: true, seed: 1, keeper: "", blurb: "", img: "", cash: 0,
      markupOverride: null, sellRateOverride: null, createdAt: 0, restockedAt: 0,
      ...s,
      stock: (s.stock || []).map((e) => ({ eid: "e0", catId: "", qty: 0, par: 2, jit: 1,
                                           priceCpOverride: null, hidden: false, ...e })),
      haggle: s.haggle || {}, log: s.log || [],
    };
  }
  return out;
}
function normalizeLocations(stored) {
  const places = {};
  for (const l of CATALOGUE?.locations || []) places[l.id] = { ...l, shopIds: [], enabled: true };
  for (const [id, l] of Object.entries(stored?.places || {})) places[id] = { ...(places[id] || {}), ...l };
  return { current: stored?.current || CATALOGUE?.locations?.[0]?.id || "", places };
}
function normalizeTreasury(stored) {
  return { pp: 0, gp: 0, ep: 0, sp: 0, cp: 0, log: [], ...(stored || {}) };
}
const currentLoc = () => { const L = getLocations(); return L.places[L.current] || null; };

/* ------------------------------------------------------------- standing */
function standingFor(factionId) {
  try {
    const api = game.modules.get(POLITICS_ID)?.api;
    if (!api?.getData) return 0;
    const data = api.getData();
    if (factionId) return Number(data?.[factionId]?.standing) || 0;
    const vals = Object.values(data || {}).map((f) => Number(f?.standing) || 0);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
  } catch (e) { return 0; }
}
// Readable names even when the politics module is not installed, so a raw id
// never reaches a player-facing refusal message.
const FACTION_NAMES = {
  "iron-directorate": "the Iron Directorate",
  "apostles-threshold": "the Apostles of the Threshold",
  "sovereign-horizon": "the Sovereign Horizon",
};
function factionName(id) {
  if (!id) return null;
  try {
    const n = game.modules.get(POLITICS_ID)?.api?.FACTIONS?.[id]?.name;
    if (n) return n;
  } catch (e) { /* politics not installed */ }
  return FACTION_NAMES[id] || id;
}

/* ---------------------------------------------------------------- actors */
const PHYSICAL_TYPES = new Set(["weapon", "equipment", "consumable", "tool", "loot", "container", "backpack"]);

/** The ship's cargo actor: our own setting, then ship-combat's, then by name. */
function getShipActor() {
  const cfg = getConfig();
  if (cfg.shipActorId) { const a = game.actors.get(cfg.shipActorId); if (a) return a; }
  try {
    const st = game.settings.get(SHIPCOMBAT_ID, "shipState");
    if (st?.actorId) { const a = game.actors.get(st.actorId); if (a) return a; }
    if (st?.name) {
      const a = game.actors?.find((x) => x.name === st.name && !x.getFlag?.(SHIPCOMBAT_ID, "shipIcon"));
      if (a) return a;
    }
  } catch (e) { /* ship-combat not installed */ }
  return game.actors?.find((a) => a.name === "SSV Silver Gull" && !a.getFlag?.(SHIPCOMBAT_ID, "shipIcon")) || null;
}
const userActor = (userId) => (userId ? game.users.get(userId)?.character : game.user.character) || null;

/** Owned items as plain view-models the renderer can price. */
function physicalItems(actor) {
  if (!actor?.items) return [];
  return actor.items.filter((i) => PHYSICAL_TYPES.has(i.type)).map((i) => {
    const w = i.system?.weight;
    return {
      id: i.id, name: i.name, img: i.img || DEFAULT_ITEM_IMG,
      qty: i.system?.quantity ?? 1, type: i.type,
      rarity: i.system?.rarity || "common",
      weight: (w && typeof w === "object") ? (w.value ?? 0) : (w ?? 0),
      desc: stripHtml(i.system?.description?.value),
      catId: i.getFlag?.(MODULE_ID, "catId") || null,
      priceCp: S().priceCpOf(i.system),
    };
  });
}
const stripHtml = (h) => String(h || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

/** dnd5e currency purse for an actor, or null when it has none (vehicles). */
const actorPurse = (a) => (a?.system?.currency ? { ...a.system.currency } : null);

/* ----------------------------------------------------------------- state */
let _root = null;          // the full-screen shop panel
let _listRoot = null;      // the shop-list overlay
let _openShopId = null;
let _mode = "buy", _side = "ship", _purse = "ship", _gmPanel = false, _swap = false;

const shopById = (id) => getShops()[id] || null;
const shopsAt = (locId) => Object.values(getShops()).filter((s) => s.locationId === locId);

function emit(msg) { game.socket.emit(SOCKET, msg); }
function notify(userId, text, kind = "warn") {
  if (userId === game.user.id) return ui.notifications?.[kind]?.(text);
  emit({ type: "notify", toUser: userId, text, kind });
}

/* -------------------------------------------------------------- open/close */
function ensureRoot() {
  if (_root?.isConnected) return _root;
  _root = document.createElement("div");
  _root.id = "ssvshop-panel";
  _root.style.display = "none";
  document.body.appendChild(_root);
  return _root;
}
const shopOpen = () => _root?.isConnected && _root.style.display !== "none";
const listOpen = () => !!_listRoot?.isConnected;

function closeShop() {
  S().hidePop();
  _openShopId = null; _gmPanel = false;
  if (_root) _root.style.display = "none";
}
function closeList() {
  if (_listRoot) { _listRoot.remove(); _listRoot = null; }
}
function closeAll() { closeShop(); closeList(); }

/** Re-render whatever is on screen (used by the socket refresh + hooks). */
function refreshOpen() {
  if (shopOpen() && _openShopId) {
    const s = shopById(_openShopId);
    if (!s) return closeShop();
    drawShop();
  }
  if (listOpen()) drawList();
}

async function openShops() {
  await loadCatalogue();
  if (shopOpen() || listOpen()) return closeAll();
  drawList();
}

function drawList() {
  const L = getLocations();
  const loc = L.places[L.current];
  const index = idx();
  if (!_listRoot?.isConnected) {
    _listRoot = document.createElement("div");
    document.body.appendChild(_listRoot);
  }
  const list = shopsAt(L.current)
    .filter((s) => s.open || game.user.isGM)
    .map((s) => {
      const t = index.types.get(s.type) || {};
      return { id: s.id, name: s.name, typeLabel: t.label || s.type, icon: t.icon || "🛒",
               wealth: s.wealth, size: (index.sizes.get(s.size) || {}).label || s.size, open: s.open };
    });
  S().renderShopList(_listRoot, {
    isGM: game.user.isGM, locName: loc?.name || "Nowhere", locBlurb: loc?.blurb || "",
    shops: list, noGM: !anyGM(),
    openShop: (id) => { closeList(); openShop(id); },
    close: closeList,
    gmNewShop: () => gmNewShopDialog(),
    gmSetLocation: () => gmSetLocationDialog(),
    gmManage: () => gmManageDialog(),
    editTreasury: () => gmTreasuryDialog(),
  });
}

function openShop(id) {
  const s = shopById(id);
  if (!s) return ui.notifications?.warn("That shop is gone.");
  if (!s.open && !game.user.isGM) return ui.notifications?.warn("That shop is shut.");
  _openShopId = id; _mode = "buy"; _gmPanel = false; _swap = true;
  S().resetUiState();
  ensureRoot().style.display = "flex";
  maybeRestock(s);
  drawShop();
}

/** Quantities and till recover over time — only ever on the GM's client. */
async function maybeRestock(shop) {
  if (!isActiveGM()) return;
  const cfg = getConfig();
  const days = Number(cfg.restockDays) || 0;
  if (!days || !shop.restockedAt) return;
  if (Date.now() - shop.restockedAt < days * 86400000) return;
  const next = S().restockShop(shop, idx(), Date.now());
  await writeShop(next);
  ui.notifications?.info(`${shop.name} has restocked.`);
}

/* ------------------------------------------------------- the ctx contract */
function drawShop() {
  const shop = shopById(_openShopId);
  if (!shop) return closeShop();
  const index = idx();
  const L = getLocations();
  const loc = L.places[shop.locationId] || null;
  const cfg = getConfig();
  const actor = game.user.character;
  const purse = actorPurse(actor);
  const standing = standingFor(shop.faction);
  const ship = getShipActor();
  const haggle = shop.haggle?.[game.user.id] || null;

  let blockedReason = "";
  if (!anyGM()) blockedReason = "NO GM CONNECTED — THE MARKET IS SHUT.";
  else if (shop.locationId !== L.current && !game.user.isGM)
    blockedReason = "THE CREW ARE NOT DOCKED HERE ANY MORE.";
  else if (!shop.open && !game.user.isGM) blockedReason = "CLOSED.";

  const ctx = {
    isGM: game.user.isGM, userId: game.user.id,
    index, catalogue: CATALOGUE, shop, loc, standing,
    overrides: getOverrides(), factionName: factionName(shop.faction),
    config: cfg,
    mode: _mode, side: _side, purse: _purse, gmPanel: _gmPanel,
    animateSwap: (() => { const a = _swap; _swap = false; return a; })(),
    treasuryCp: S().toCp(getTreasury()),
    purseCp: purse ? S().toCp(purse) : 0,
    hasPlayerActor: !!actor,
    partyItems: physicalItems(_side === "ship" ? ship : actor),
    haggle,
    canTrade: !blockedReason, blockedReason,
    setMode: (m) => { _mode = (m === "sell" ? "sell" : "buy"); _swap = true; drawShop(); },
    setSide: (s) => { _side = (s === "you" ? "you" : "ship"); drawShop(); },
    setPurse: (p) => { _purse = (p === "you" ? "you" : "ship"); drawShop(); },
    openGMPanel: () => { _gmPanel = true; _swap = true; drawShop(); },
    closeGMPanel: () => { _gmPanel = false; _swap = true; drawShop(); },
    close: closeShop,
    buy: (eid, qty, quoteCp) => doBuy(shop, eid, qty, quoteCp),
    sell: (itemId, qty, quoteCp) => doSell(shop, itemId, qty, quoteCp),
    doHaggle: () => doHaggle(shop),
    editTreasury: () => gmTreasuryDialog(),
    gmAddItem: () => gmAddItemBrowser(shop),
    gmReroll: () => gmReroll(shop),
    gmRemoveEntry: (eid) => gmRemoveEntry(shop, eid),
    gmEditEntry: (eid) => gmEditEntryDialog(shop, eid),
    gmAction: (a) => gmAction(shop, a),
  };
  S().renderShop(ensureRoot(), ctx);
}

/* ----------------------------------------------------- player-side actions */
async function promptNumber(title, label, value, max) {
  const content = `<div style="display:flex;flex-direction:column;gap:6px;"><label>${label}` +
    `<input type="number" name="v" value="${value}" min="1"${max != null ? ` max="${max}"` : ""}></label></div>`;
  const read = (form) => { const n = Number(form.elements.v.value); return Number.isFinite(n) ? n : null; };
  const D = D2();
  if (D) return D.prompt({ window: { title }, content, ok: { label: "OK", callback: (e, b) => read(b.form) } })
    .catch(() => null);
  return new Promise((res) => new Dialog({
    title, content,
    buttons: { ok: { label: "OK", callback: (h) => res(read(h[0].querySelector("form") || h[0])) },
               cancel: { label: "Cancel", callback: () => res(null) } },
    default: "ok",
  }).render(true));
}

async function doBuy(shop, eid, qty, quoteCp) {
  const entry = shop.stock.find((e) => e.eid === eid);
  if (!entry) return;
  let n = qty;
  if (n == null) {
    n = await promptNumber(`Buy — ${idx().items.get(entry.catId)?.name || ""}`,
                           `How many? (${entry.qty} in stock)`, 1, entry.qty);
    if (!n) return;
  }
  n = Math.max(1, Math.min(Math.round(n), entry.qty));
  const payload = { type: "buyRequest", toGM: true, userId: game.user.id, shopId: shop.id,
                    eid, qty: n, purse: _purse, dest: _side, quoteCp: quoteCp * n };
  if (isActiveGM()) return tx(() => gmBuy(payload));
  if (!anyGM()) return ui.notifications?.warn("No GM connected — the market is shut.");
  emit(payload);
}

async function doSell(shop, itemId, qty, quoteCp) {
  const src = _side === "ship" ? getShipActor() : game.user.character;
  const item = src?.items?.get(itemId);
  if (!item) return;
  const have = item.system?.quantity ?? 1;
  let n = qty;
  if (n == null) {
    n = await promptNumber(`Sell — ${item.name}`, `How many? (you have ${have})`, 1, have);
    if (!n) return;
  }
  n = Math.max(1, Math.min(Math.round(n), have));
  const payload = { type: "sellRequest", toGM: true, userId: game.user.id, shopId: shop.id,
                    itemId, qty: n, source: _side, into: _purse, quoteCp: quoteCp * n };
  if (isActiveGM()) return tx(() => gmSell(payload));
  if (!anyGM()) return ui.notifications?.warn("No GM connected — the market is shut.");
  emit(payload);
}

/** One Persuasion check per shop per visit, rolled on the player's own client. */
async function doHaggle(shop) {
  if (shop.haggle?.[game.user.id]) return ui.notifications?.warn("You have already tried your luck here.");
  const actor = game.user.character;
  if (!actor) return ui.notifications?.warn("No character assigned to you.");
  const type = idx().types.get(shop.type);
  const dc = S().haggleDC(type, shop);
  let total = null, nat = null;
  try {
    const roll = await (actor.rollSkill?.length >= 1
      ? actor.rollSkill({ skill: "per" }).catch(() => actor.rollSkill("per"))
      : actor.rollSkill("per"));
    const r = Array.isArray(roll) ? roll[0] : roll;
    total = r?.total ?? null;
    nat = r?.dice?.[0]?.results?.find((x) => x.active)?.result ?? null;
  } catch (e) { /* fall through to a manual total */ }
  if (total == null) {
    total = await promptNumber("Haggle", `Persuasion total vs DC ${dc}?`, 10, null);
    if (total == null) return;
  }
  const payload = { type: "haggleRequest", toGM: true, userId: game.user.id, shopId: shop.id,
                    total, nat, dc };
  if (isActiveGM()) return tx(() => gmHaggle(payload));
  emit(payload);
}

/* ================================================================ GM side */
// Foundry has no transactions, so every mutation runs through one promise
// chain on the active GM's client. Without it two players buying the last unit
// both read qty:1 and both succeed.
let _txChain = Promise.resolve();
const tx = (fn) => (_txChain = _txChain.then(fn, fn).catch((e) =>
  console.error(`${MODULE_ID} | transaction failed`, e)));

async function writeShop(shop) {
  const all = getShops();
  all[shop.id] = shop;
  await game.settings.set(MODULE_ID, SET_SHOPS, all);
}
async function deleteShop(id) {
  const all = getShops();
  delete all[id];
  await game.settings.set(MODULE_ID, SET_SHOPS, all);
}
function logLine(shop, entry) {
  shop.log = (shop.log || []).concat([entry]).slice(-40);
}
async function creditTreasury(cp, reason) {
  const t = getTreasury();
  const next = cp >= 0 ? S().gainCp(t, cp) : S().spendCp(t, -cp);
  if (!next) return false;
  next.log = (t.log || []).concat([{ ts: Date.now(), deltaCp: cp, reason }]).slice(-60);
  await game.settings.set(MODULE_ID, SET_TREASURY, next);
  return true;
}

/** Build the same pricing environment the client used, from live state. */
function envFor(shop) {
  const index = idx();
  const L = getLocations();
  return {
    index, loc: L.places[shop.locationId] || null, shop,
    type: index.types.get(shop.type), wealth: index.wealth.get(Number(shop.wealth) || 3),
    standing: standingFor(shop.faction), overrides: getOverrides(), haggle: null,
  };
}

async function gmBuy(msg) {
  if (!isActiveGM()) return;
  const user = game.users.get(msg.userId);
  const shop = shopById(msg.shopId);
  if (!user || !shop) return notify(msg.userId, "That shop is gone.");

  const L = getLocations();
  if (!user.isGM && (!shop.open || shop.locationId !== L.current))
    return notify(msg.userId, "That shop is not trading right now.");

  const entry = shop.stock.find((e) => e.eid === msg.eid);
  if (!entry || (entry.hidden && !user.isGM)) return notify(msg.userId, "That line is gone.");
  const index = idx();
  const item = index.items.get(entry.catId);
  if (!item) return notify(msg.userId, "That item is no longer in the catalogue.");

  const qty = Math.max(1, Math.min(Math.round(Number(msg.qty) || 1), entry.qty));
  if (qty < 1 || entry.qty < 1) return notify(msg.userId, "Out of stock.");

  const env = envFor(shop);
  env.haggle = shop.haggle?.[msg.userId] || null;
  if (S().refusesTrade(env.type, shop, env.standing))
    return notify(msg.userId, "They refuse to deal with you.");

  const unitCp = S().priceBuy(item, entry, env).cp;
  const totalCp = unitCp * qty;
  // A stale quote means the client priced against state that has since moved
  // (someone else bought the last three, standing shifted). Refuse rather than
  // silently charging a different number than the player clicked.
  if (msg.quoteCp != null && Math.abs(msg.quoteCp - totalCp) > Math.max(1, totalCp * 0.001))
    return notify(msg.userId, "The price moved — reopen the shop and try again.");

  const buyerActor = userActor(msg.userId);
  const ship = getShipActor();
  const dst = msg.dest === "you" ? buyerActor : ship;
  if (!dst) return notify(msg.userId, msg.dest === "you"
    ? "You have no character to carry that." : "No ship cargo actor is configured (GM: shop settings).");

  const cfg = getConfig();
  const fromShip = msg.purse === "ship";
  if (fromShip && !user.isGM && cfg.treasuryOpenToPlayers === false)
    return notify(msg.userId, "The ship treasury is GM-locked.");
  const purseBefore = fromShip ? getTreasury() : actorPurse(buyerActor);
  if (!purseBefore) return notify(msg.userId, "That purse does not exist.");
  const purseAfter = S().spendCp(purseBefore, totalCp);
  if (!purseAfter) return notify(msg.userId, "Not enough coin.");

  // Commit: money, then goods, then the shop. Undo in reverse on failure.
  let moneyDone = false, createdId = null, stackedFrom = null;
  try {
    if (fromShip) {
      purseAfter.log = (purseBefore.log || [])
        .concat([{ ts: Date.now(), deltaCp: -totalCp, reason: `Bought ${item.name} x${qty} @ ${shop.name}` }])
        .slice(-60);
      await game.settings.set(MODULE_ID, SET_TREASURY, purseAfter);
    } else {
      await buyerActor.update({ "system.currency": stripLog(purseAfter) });
    }
    moneyDone = true;

    const twin = dst.items.find((i) => i.name === item.name && i.type === item.type);
    if (twin) {
      stackedFrom = { id: twin.id, qty: twin.system?.quantity ?? 1 };
      await twin.update({ "system.quantity": stackedFrom.qty + qty });
    } else {
      const data = await itemDataFor(item, qty);
      const [made] = await dst.createEmbeddedDocuments("Item", [data]);
      createdId = made?.id || null;
    }

    const next = { ...shop, stock: shop.stock.map((e) => ({ ...e })) };
    const ne = next.stock.find((e) => e.eid === msg.eid);
    ne.qty = Math.max(0, ne.qty - qty);
    next.cash = (next.cash || 0) + totalCp;
    logLine(next, { ts: Date.now(), who: user.name, kind: "buy", name: item.name, qty, cp: totalCp });
    await writeShop(next);
  } catch (err) {
    console.error(`${MODULE_ID} | buy failed, rolling back`, err);
    try {
      if (createdId) await dst.deleteEmbeddedDocuments("Item", [createdId]);
      else if (stackedFrom) await dst.items.get(stackedFrom.id)?.update({ "system.quantity": stackedFrom.qty });
      if (moneyDone) {
        if (fromShip) await game.settings.set(MODULE_ID, SET_TREASURY, purseBefore);
        else await buyerActor.update({ "system.currency": stripLog(purseBefore) });
      }
    } catch (e2) { console.error(`${MODULE_ID} | ROLLBACK FAILED — check the treasury log`, e2); }
    return notify(msg.userId, "The sale fell through. Nothing changed.");
  }

  emit({ type: "refresh" });
  refreshOpen();
  const where = msg.dest === "you" ? (buyerActor?.name || "their kit") : "ship cargo";
  await ChatMessage.create({
    speaker: { alias: shop.name },
    content: `<b>${escHtml(user.name)}</b> bought <b>${escHtml(item.name)}</b> ×${qty} for ` +
             `<b>${S().fmtCp(totalCp)}</b> — into ${escHtml(where)}.`,
  });
}

async function gmSell(msg) {
  if (!isActiveGM()) return;
  const user = game.users.get(msg.userId);
  const shop = shopById(msg.shopId);
  if (!user || !shop) return notify(msg.userId, "That shop is gone.");
  const L = getLocations();
  if (!user.isGM && (!shop.open || shop.locationId !== L.current))
    return notify(msg.userId, "That shop is not trading right now.");

  const sellerActor = userActor(msg.userId);
  const ship = getShipActor();
  const src = msg.source === "you" ? sellerActor : ship;
  const item = src?.items?.get(msg.itemId);
  if (!item) return notify(msg.userId, "You no longer have that.");
  const have = item.system?.quantity ?? 1;
  const qty = Math.max(1, Math.min(Math.round(Number(msg.qty) || 1), have));

  const index = idx();
  const env = envFor(shop);
  env.haggle = shop.haggle?.[msg.userId] || null;
  if (S().refusesTrade(env.type, shop, env.standing))
    return notify(msg.userId, "They refuse to deal with you.");

  const view = physicalItems(src).find((v) => v.id === msg.itemId);
  const cats = S().categoriesFor(view, index);
  if (!S().buysCategory(env.type, cats)) return notify(msg.userId, "They do not buy that here.");
  const gp = S().basePriceGpFor(view, index);
  if (!gp) return notify(msg.userId, "They cannot put a price on that.");

  const catId = view.catId || matchCatId(view, index);
  const onHand = (shop.stock || []).filter((e) => e.catId === catId)
                                   .reduce((a, e) => a + (e.qty || 0), 0);
  const pseudo = { ...view, categories: cats, basePriceGp: gp,
                   par: index.items.get(catId)?.par || index.rarityPar[view.rarity] || 2 };
  const unitCp = S().priceSell(pseudo, env, onHand).cp;
  let takeQty = qty;
  if (unitCp * takeQty > (shop.cash || 0)) takeQty = Math.floor((shop.cash || 0) / unitCp);
  if (takeQty < 1) return notify(msg.userId, "They are out of coin.");
  const totalCp = unitCp * takeQty;
  if (msg.quoteCp != null && takeQty === qty &&
      Math.abs(msg.quoteCp - totalCp) > Math.max(1, totalCp * 0.001))
    return notify(msg.userId, "The offer moved — reopen the shop and try again.");

  const intoShip = msg.into === "ship";
  const cfg = getConfig();
  if (intoShip && !user.isGM && cfg.treasuryOpenToPlayers === false)
    return notify(msg.userId, "The ship treasury is GM-locked.");
  const purseBefore = intoShip ? getTreasury() : actorPurse(sellerActor);
  if (!purseBefore) return notify(msg.userId, "That purse does not exist.");

  let goodsDone = false;
  const beforeQty = have;
  try {
    if (have - takeQty > 0) await item.update({ "system.quantity": have - takeQty });
    else await item.delete();
    goodsDone = true;

    const next = { ...shop, stock: shop.stock.map((e) => ({ ...e })) };
    const line = next.stock.find((e) => e.catId === catId);
    if (line) line.qty += takeQty;
    else if (catId && index.items.has(catId)) {
      next.stock.push({ eid: `e${Date.now().toString(36)}`, catId,
                        qty: takeQty, par: pseudo.par, jit: 1, priceCpOverride: null, hidden: false });
    }
    next.cash = Math.max(0, (next.cash || 0) - totalCp);
    logLine(next, { ts: Date.now(), who: user.name, kind: "sell", name: item.name, qty: takeQty, cp: totalCp });
    await writeShop(next);

    if (intoShip) await creditTreasury(totalCp, `Sold ${item.name} x${takeQty} @ ${shop.name}`);
    else await sellerActor.update({ "system.currency": stripLog(S().gainCp(purseBefore, totalCp)) });
  } catch (err) {
    console.error(`${MODULE_ID} | sell failed`, err);
    if (goodsDone) console.error(`${MODULE_ID} | goods already left the actor — restore ${item.name} x${beforeQty} by hand`);
    return notify(msg.userId, "The sale fell through. Check your inventory.");
  }

  emit({ type: "refresh" });
  refreshOpen();
  const short = takeQty < qty ? ` (they could only take ${takeQty})` : "";
  await ChatMessage.create({
    speaker: { alias: shop.name },
    content: `<b>${escHtml(user.name)}</b> sold <b>${escHtml(item.name)}</b> ×${takeQty} for ` +
             `<b>${S().fmtCp(totalCp)}</b>${escHtml(short)}.`,
  });
}

async function gmHaggle(msg) {
  if (!isActiveGM()) return;
  const shop = shopById(msg.shopId);
  const user = game.users.get(msg.userId);
  if (!shop || !user) return;
  if (shop.haggle?.[msg.userId]) return notify(msg.userId, "You have already tried your luck here.");
  const type = idx().types.get(shop.type);
  const dc = Number(msg.dc) || S().haggleDC(type, shop);
  const r = S().haggleResult(msg.total, dc, msg.nat);
  const next = { ...shop, haggle: { ...(shop.haggle || {}), [msg.userId]: { ...r, ts: Date.now() } } };
  await writeShop(next);
  emit({ type: "refresh" });
  refreshOpen();
  await ChatMessage.create({
    speaker: { alias: shop.name },
    content: `<b>${escHtml(user.name)}</b> haggles — ${msg.total} vs DC ${dc}. ${escHtml(r.text)}`,
  });
}

const stripLog = (p) => { const { log, ...rest } = p || {}; return rest; };
const escHtml = (s) => S().esc(s);

/** Find the catalogue id an owned item corresponds to, if any. */
function matchCatId(view, index) {
  if (view.catId && index.items.has(view.catId)) return view.catId;
  const name = String(view.name || "").toLowerCase();
  for (const it of index.items.values()) if (String(it.name).toLowerCase() === name) return it.id;
  return null;
}

/** Item document data for a catalogue entry, ready to create on an actor. */
async function itemDataFor(item, qty) {
  let data = null;
  if (item.uuid) {
    const src = await fromUuid(item.uuid);
    if (src) data = src.toObject();
  }
  if (!data) {
    data = {
      name: item.name, type: item.type || "loot", img: item.img || DEFAULT_ITEM_IMG,
      system: {
        description: { value: item.desc || "" },
        rarity: item.rarity || "common",
        price: { value: Number(item.basePriceGp) || 0, denomination: "gp" },
      },
    };
  }
  delete data._id; delete data.folder; delete data.ownership; delete data.sort;
  data.system = data.system || {};
  data.system.quantity = qty;
  data.flags = { ...(data.flags || {}), [MODULE_ID]: { catId: item.id } };
  // Fuel and power cells must work in the ship-combat gauges the moment they
  // land in cargo, so stamp that module's flags on the way in.
  if (item.res) {
    data.flags[SHIPCOMBAT_ID] = { ...(data.flags[SHIPCOMBAT_ID] || {}),
      resKind: item.res.kind, resAmount: item.res.amount, overcharge: !!item.res.overcharge,
      resItem: true, tier: item.tier || undefined };
  }
  return data;
}

/* --------------------------------------------------------- GM: authoring */
async function form(title, content, okLabel = "Save") {
  const read = (f) => {
    const out = {};
    for (const el of f.elements) if (el.name) out[el.name] = el.type === "checkbox" ? el.checked : el.value;
    return out;
  };
  const D = D2();
  if (D) return D.prompt({ window: { title }, content,
    ok: { label: okLabel, callback: (e, b) => read(b.form) } }).catch(() => null);
  return new Promise((res) => new Dialog({
    title, content,
    buttons: { ok: { label: okLabel, callback: (h) => res(read(h[0].querySelector("form") || h[0])) },
               cancel: { label: "Cancel", callback: () => res(null) } },
    default: "ok",
  }).render(true));
}
const row = (label, field) =>
  `<label style="display:flex;justify-content:space-between;align-items:center;gap:12px;margin:4px 0;">` +
  `${label} ${field}</label>`;
const sel = (name, options, current, width = "190px") =>
  `<select name="${name}" style="width:${width}">` +
  options.map(([v, l]) => `<option value="${v}"${String(v) === String(current) ? " selected" : ""}>${l}</option>`).join("") +
  `</select>`;

async function gmNewShopDialog() {
  if (!game.user.isGM) return;
  await loadCatalogue();
  const index = idx();
  const L = getLocations();
  const types = CATALOGUE.shopTypes.map((t) => [t.id, `${t.icon} ${t.label}`]);
  const locs = Object.values(L.places).map((p) => [p.id, p.name]);
  const v = await form("New shop",
    `<div style="min-width:340px">` +
    row("Type", sel("type", types, "general-store")) +
    row("Location", sel("locationId", locs, L.current)) +
    row("Wealth", sel("wealth", CATALOGUE.wealth.map((w) => [w.tier, `${w.tier} — ${w.label}`]), 3)) +
    row("Size", sel("size", CATALOGUE.sizes.map((z) => [z.id, z.label]), "medium")) +
    row("Faction", sel("faction", [["", "unaligned"], ["iron-directorate", "Iron Directorate"],
      ["apostles-threshold", "Apostles of the Threshold"], ["sovereign-horizon", "Sovereign Horizon"]], "")) +
    row("Name", `<input name="name" placeholder="(roll one)" style="width:190px">`) +
    row("Open to players", `<input type="checkbox" name="open" checked>`) +
    `<p style="opacity:.7;font-size:12px;margin:8px 0 0">Stock and prices generate immediately from the ` +
    `type, the world's economy and the shop's wealth. You can edit every line afterwards.</p></div>`,
    "Create");
  if (!v) return;
  const loc = L.places[v.locationId];
  const shop = S().makeShop({
    id: `shop-${foundry.utils.randomID(6).toLowerCase()}`,
    type: v.type, locationId: v.locationId, wealth: Number(v.wealth), size: v.size,
    faction: v.faction || null, name: v.name?.trim() || "", open: !!v.open, stamp: Date.now(),
  }, index, loc);
  await writeShop(shop);
  ui.notifications?.info(`${shop.name} is open at ${loc?.name}.`);
  emit({ type: "refresh" });
  refreshOpen();
  if (listOpen()) drawList();
}

async function gmSetLocationDialog() {
  if (!game.user.isGM) return;
  const L = getLocations();
  const locs = Object.values(L.places).map((p) => [p.id, `${p.name} — ${p.blurb || ""}`.slice(0, 70)]);
  const v = await form("Where are the crew?",
    `<div style="min-width:340px">${row("Docked at", sel("current", locs, L.current, "260px"))}` +
    `<p style="opacity:.7;font-size:12px;margin:8px 0 0">Players only see shops at the current location.</p></div>`,
    "Set");
  if (!v) return;
  await game.settings.set(MODULE_ID, SET_LOCATIONS, { ...L, current: v.current });
  emit({ type: "refresh" });
  refreshOpen();
  if (listOpen()) drawList();
  ui.notifications?.info(`The crew are now at ${L.places[v.current]?.name}.`);
}

async function gmTreasuryDialog() {
  if (!game.user.isGM) return ui.notifications?.warn("Only the GM can edit the treasury.");
  const t = getTreasury();
  const v = await form("Ship treasury",
    `<div style="min-width:280px">` +
    ["pp", "gp", "ep", "sp", "cp"].map((d) =>
      row(d.toUpperCase(), `<input type="number" name="${d}" value="${t[d] || 0}" min="0" style="width:120px">`)).join("") +
    `<p style="opacity:.7;font-size:12px;margin:8px 0 0">Total: ${S().fmtCp(S().toCp(t))}</p></div>`);
  if (!v) return;
  const next = { pp: +v.pp || 0, gp: +v.gp || 0, ep: +v.ep || 0, sp: +v.sp || 0, cp: +v.cp || 0,
                 log: (t.log || []).concat([{ ts: Date.now(), deltaCp: 0, reason: "GM set the treasury" }]).slice(-60) };
  await game.settings.set(MODULE_ID, SET_TREASURY, next);
  emit({ type: "refresh" });
  refreshOpen();
}

async function gmManageDialog() {
  if (!game.user.isGM) return;
  const all = Object.values(getShops());
  if (!all.length) return ui.notifications?.info("No shops exist yet.");
  const L = getLocations();
  const index = idx();
  const v = await form("Manage shops",
    `<div style="min-width:380px">` +
    row("Shop", sel("id", all.map((s) => [s.id,
      `${s.name} — ${(index.types.get(s.type) || {}).label} @ ${L.places[s.locationId]?.name || "?"}` +
      `${s.open ? "" : " (closed)"}`]), all[0].id, "300px")) +
    `<p style="opacity:.7;font-size:12px;margin:8px 0 0">Opens the shop with its GM panel.</p></div>`,
    "Open");
  if (!v) return;
  closeList();
  openShop(v.id);
  _gmPanel = true;
  drawShop();
}

async function gmAction(shop, action) {
  if (!game.user.isGM) return;
  const index = idx();
  const L = getLocations();
  const patch = async (p) => { await writeShop({ ...shopById(shop.id), ...p }); emit({ type: "refresh" }); refreshOpen(); };
  switch (action) {
    case "rename": {
      const v = await form("Name", `<div>${row("Name", `<input name="name" value="${S().esc(shop.name)}" style="width:220px">`)}</div>`);
      if (v?.name) await patch({ name: v.name.trim() });
      break;
    }
    case "keeper": {
      const v = await form("Keeper & blurb",
        `<div style="min-width:340px">${row("Keeper", `<input name="keeper" value="${S().esc(shop.keeper || "")}" style="width:220px">`)}` +
        `<label style="display:block;margin-top:6px">Blurb<br><textarea name="blurb" rows="3" style="width:100%">${S().esc(shop.blurb || "")}</textarea></label></div>`);
      if (v) await patch({ keeper: v.keeper, blurb: v.blurb });
      break;
    }
    case "type": case "wealth": case "size": case "location": case "faction": {
      const opts = {
        type: ["type", CATALOGUE.shopTypes.map((t) => [t.id, t.label]), shop.type],
        wealth: ["wealth", CATALOGUE.wealth.map((w) => [w.tier, `${w.tier} — ${w.label}`]), shop.wealth],
        size: ["size", CATALOGUE.sizes.map((z) => [z.id, z.label]), shop.size],
        location: ["locationId", Object.values(L.places).map((p) => [p.id, p.name]), shop.locationId],
        faction: ["faction", [["", "unaligned"], ["iron-directorate", "Iron Directorate"],
          ["apostles-threshold", "Apostles of the Threshold"], ["sovereign-horizon", "Sovereign Horizon"]], shop.faction || ""],
      }[action];
      const v = await form(`Set ${action}`, `<div>${row(action, sel(opts[0], opts[1], opts[2], "240px"))}` +
        (action === "type" || action === "wealth" || action === "size"
          ? `<label style="display:flex;gap:8px;margin-top:8px"><input type="checkbox" name="reroll" checked> Re-roll the stock to match</label>` : "") +
        `</div>`);
      if (!v) return;
      const key = opts[0];
      const next = { ...shopById(shop.id), [key]: key === "wealth" ? Number(v[key]) : (v[key] || null) };
      if (key === "faction" && !v[key]) next.faction = null;
      if (v.reroll) { next.cash = S().shopCash(index, next); next.stock = S().generateStock(next, index, L.places[next.locationId]); }
      await writeShop(next); emit({ type: "refresh" }); refreshOpen();
      break;
    }
    case "markup": case "sellrate": {
      const isMarkup = action === "markup";
      const cur = isMarkup ? shop.markupOverride : shop.sellRateOverride;
      const v = await form(isMarkup ? "Markup override" : "Sell-rate override",
        `<div style="min-width:300px">${row("Multiplier", `<input name="v" value="${cur ?? ""}" placeholder="blank = automatic" style="width:120px">`)}` +
        `<p style="opacity:.7;font-size:12px;margin:8px 0 0">${isMarkup
          ? "Replaces the shop type's markup (e.g. 1.5 = half again)."
          : "Replaces the fraction of value they pay when buying from the crew (e.g. 0.5)."}</p></div>`);
      if (!v) return;
      const n = v.v.trim() === "" ? null : Number(v.v);
      await patch(isMarkup ? { markupOverride: n } : { sellRateOverride: n });
      break;
    }
    case "cash": {
      const v = await form("Till", `<div>${row("Coin they hold (gp)", `<input type="number" name="gp" value="${Math.round((shop.cash || 0) / 100)}" min="0" style="width:140px">`)}</div>`);
      if (v) await patch({ cash: Math.max(0, Math.round(Number(v.gp) * 100) || 0) });
      break;
    }
    case "open": await patch({ open: !shop.open }); break;
    case "reroll": await gmReroll(shop); break;
    case "restock": {
      await writeShop(S().restockShop(shopById(shop.id), index, Date.now()));
      emit({ type: "refresh" }); refreshOpen();
      break;
    }
    case "clearhaggle": await patch({ haggle: {} }); break;
    case "additem": await gmAddItemBrowser(shop); break;
    case "delete": {
      const ok = await confirmDialog("Delete shop", `Delete ${shop.name} for good?`);
      if (!ok) return;
      await deleteShop(shop.id);
      closeShop(); emit({ type: "refresh" });
      break;
    }
  }
}

async function confirmDialog(title, text) {
  const D = D2();
  if (D?.confirm) return D.confirm({ window: { title }, content: `<p>${S().esc(text)}</p>` }).catch(() => false);
  return new Promise((res) => new Dialog({
    title, content: `<p>${S().esc(text)}</p>`,
    buttons: { yes: { label: "Yes", callback: () => res(true) }, no: { label: "No", callback: () => res(false) } },
    default: "no",
  }).render(true));
}

async function gmReroll(shop) {
  if (!game.user.isGM) return;
  const index = idx();
  const L = getLocations();
  const live = shopById(shop.id);
  const next = { ...live, seed: (live.seed + 7919) >>> 0 };
  next.stock = S().generateStock(next, index, L.places[next.locationId]);
  next.cash = S().shopCash(index, next);
  await writeShop(next);
  emit({ type: "refresh" });
  refreshOpen();
}

async function gmRemoveEntry(shop, eid) {
  if (!game.user.isGM) return;
  const live = shopById(shop.id);
  await writeShop({ ...live, stock: live.stock.filter((e) => e.eid !== eid) });
  emit({ type: "refresh" });
  refreshOpen();
}

async function gmEditEntryDialog(shop, eid) {
  if (!game.user.isGM) return;
  const live = shopById(shop.id);
  const e = live.stock.find((x) => x.eid === eid);
  if (!e) return;
  const item = idx().items.get(e.catId);
  const v = await form(`Stock — ${item?.name || e.catId}`,
    `<div style="min-width:320px">` +
    row("Quantity", `<input type="number" name="qty" value="${e.qty}" min="0" style="width:110px">`) +
    row("Par (their normal stock)", `<input type="number" name="par" value="${e.par}" min="1" style="width:110px">`) +
    row("Price override (gp)", `<input name="price" value="${e.priceCpOverride == null ? "" : e.priceCpOverride / 100}" placeholder="blank = live pricing" style="width:110px">`) +
    row("Hidden from players", `<input type="checkbox" name="hidden" ${e.hidden ? "checked" : ""}>`) +
    `<p style="opacity:.7;font-size:12px;margin:8px 0 0">Quantity 0 leaves the line on the shelf but out of stock. ` +
    `A price override freezes this line — region, scarcity and standing stop applying to it.</p></div>`);
  if (!v) return;
  const next = { ...live, stock: live.stock.map((x) => x.eid !== eid ? x : {
    ...x, qty: Math.max(0, Math.round(Number(v.qty) || 0)),
    par: Math.max(1, Math.round(Number(v.par) || 1)),
    priceCpOverride: String(v.price).trim() === "" ? null : Math.max(1, Math.round(Number(v.price) * 100)),
    hidden: !!v.hidden,
  }) };
  await writeShop(next);
  emit({ type: "refresh" });
  refreshOpen();
}

/* --------------------------------------- GM: add a catalogue line by hand */
let _browser = null;
function closeBrowser() { if (_browser) { _browser.remove(); _browser = null; } }

async function gmAddItemBrowser(shop) {
  if (!game.user.isGM) return;
  await buildSrdIndex();
  const index = idx();
  const items = [...index.items.values()];
  closeBrowser();
  _browser = document.createElement("div");
  document.body.appendChild(_browser);
  const CAP = 200;
  const draw = (q) => {
    const query = q.trim().toLowerCase();
    const hits = (query ? items.filter((i) => i.name.toLowerCase().includes(query)) : items).slice(0, CAP);
    S().renderShopList(_browser, {
      isGM: false,
      locName: `Stock ${shop.name}`,
      locBlurb: `${items.length} catalogue and compendium lines. Click one to add it to the shelves.`,
      shops: hits.map((i) => ({ id: i.id, name: i.name, icon: "", img: i.img,
        typeLabel: `${(i.categories || []).join(", ")} · ${S().fmtCpShort((i.basePriceGp || 0) * 100)}`,
        size: i.rarity, wealth: 0, open: true })),
      close: closeBrowser,
      openShop: async (catId) => {
        const live = shopById(shop.id);
        const it = index.items.get(catId);
        const existing = live.stock.find((e) => e.catId === catId);
        if (existing) existing.qty += 1;
        else live.stock.push({ eid: `e${Date.now().toString(36)}`, catId,
          qty: 1, par: it.par || 2, jit: 1, priceCpOverride: null, hidden: false });
        await writeShop(live);
        ui.notifications?.info(`Added ${it.name}.`);
        emit({ type: "refresh" }); refreshOpen();
      },
    });
    // the shop-list renderer has no search box of its own; graft one on
    const head = _browser.querySelector(".sgsl-head");
    if (head && !head.querySelector(".sgsl-search")) {
      const box = document.createElement("div");
      box.className = "sgsl-search";
      box.innerHTML = `<span>🔎</span><input type="text" placeholder="Search items…" value="${S().esc(q)}">`;
      head.insertBefore(box, head.querySelector(".sgsl-x"));
      const input = box.querySelector("input");
      input.addEventListener("input", () => draw(input.value));
      input.focus(); input.setSelectionRange(q.length, q.length);
    }
  };
  draw("");
}

/* ---------------------------------------------------------------- socket */
function onSocket(msg) {
  if (!msg || typeof msg !== "object") return;
  if (msg.toUser && msg.toUser !== game.user.id) return;
  if (msg.toGM && !isActiveGM()) return;
  switch (msg.type) {
    case "buyRequest": return tx(() => gmBuy(msg));
    case "sellRequest": return tx(() => gmSell(msg));
    case "haggleRequest": return tx(() => gmHaggle(msg));
    case "notify": return ui.notifications?.[msg.kind || "warn"]?.(msg.text);
    case "refresh": return refreshOpen();
  }
}

/* -------------------------------------------------------------- lifecycle */
Hooks.once("init", () => {
  const refresh = () => refreshOpen();
  for (const [key, dflt] of [[SET_SHOPS, {}], [SET_LOCATIONS, {}], [SET_TREASURY, {}],
                             [SET_OVERRIDES, {}], [SET_CONFIG, {}]]) {
    game.settings.register(MODULE_ID, key, {
      scope: "world", config: false, type: Object, default: dflt, onChange: refresh,
    });
  }
  game.settings.register(MODULE_ID, "haggleEnabled", {
    name: game.i18n.localize(`${MODULE_ID}.settings.haggle.name`),
    hint: game.i18n.localize(`${MODULE_ID}.settings.haggle.hint`),
    scope: "world", config: true, type: Boolean, default: true,
    onChange: (v) => setConfig({ haggleEnabled: v }),
  });
  game.settings.register(MODULE_ID, "showBreakdown", {
    name: game.i18n.localize(`${MODULE_ID}.settings.breakdown.name`),
    hint: game.i18n.localize(`${MODULE_ID}.settings.breakdown.hint`),
    scope: "world", config: true, type: Boolean, default: true,
    onChange: (v) => setConfig({ showBreakdown: v }),
  });
  game.settings.register(MODULE_ID, "treasuryOpenToPlayers", {
    name: game.i18n.localize(`${MODULE_ID}.settings.treasury.name`),
    hint: game.i18n.localize(`${MODULE_ID}.settings.treasury.hint`),
    scope: "world", config: true, type: Boolean, default: true,
    onChange: (v) => setConfig({ treasuryOpenToPlayers: v }),
  });
  game.settings.register(MODULE_ID, "restockDays", {
    name: game.i18n.localize(`${MODULE_ID}.settings.restock.name`),
    hint: game.i18n.localize(`${MODULE_ID}.settings.restock.hint`),
    scope: "world", config: true, type: Number, default: 7,
    onChange: (v) => setConfig({ restockDays: v }),
  });

  game.keybindings.register(MODULE_ID, "open", {
    name: game.i18n.localize(`${MODULE_ID}.keybind.open.name`),
    hint: game.i18n.localize(`${MODULE_ID}.keybind.open.hint`),
    editable: [{ key: "KeyI" }],
    onDown: () => { openShops(); return true; },
  });
});

async function setConfig(patch) {
  if (!game.user.isGM) return;
  await game.settings.set(MODULE_ID, SET_CONFIG, { ...getConfig(), ...patch });
}

// The scene-control shape changed at v13: arrays of controls with array tools
// became keyed objects with keyed tools. Handle both.
Hooks.on("getSceneControlButtons", (controls) => {
  const tool = {
    name: "ssv-shops", title: game.i18n.localize(`${MODULE_ID}.control.title`),
    icon: "fa-solid fa-cart-shopping", button: true, visible: true,
    onClick: () => openShops(), onChange: () => openShops(), order: 99,
  };
  try {
    if (Array.isArray(controls)) {
      const t = controls.find((c) => c.name === "token" || c.name === "tokens");
      if (t?.tools && !t.tools.some((x) => x.name === tool.name)) t.tools.push(tool);
    } else {
      const t = controls.tokens ?? controls.token;
      if (t?.tools) t.tools[tool.name] = tool;
    }
  } catch (e) { console.warn(`${MODULE_ID} | could not add the scene control`, e); }
});

Hooks.once("ready", async () => {
  await loadCatalogue();
  rebuildIndex();

  // Seed the canon worlds once, on the GM's client only.
  if (game.user.isGM) {
    const stored = game.settings.get(MODULE_ID, SET_LOCATIONS);
    if (!stored?.places || !Object.keys(stored.places).length) {
      const places = {};
      for (const l of CATALOGUE.locations) places[l.id] = { ...l, shopIds: [], enabled: true };
      await game.settings.set(MODULE_ID, SET_LOCATIONS, { current: CATALOGUE.locations[0].id, places });
      console.log(`${MODULE_ID} | seeded ${CATALOGUE.locations.length} locations`);
    }
    // mirror the checkbox settings into the config blob the renderer reads
    await setConfig({
      haggleEnabled: game.settings.get(MODULE_ID, "haggleEnabled"),
      showBreakdown: game.settings.get(MODULE_ID, "showBreakdown"),
      treasuryOpenToPlayers: game.settings.get(MODULE_ID, "treasuryOpenToPlayers"),
      restockDays: game.settings.get(MODULE_ID, "restockDays"),
    });
  }

  game.socket.on(SOCKET, onSocket);

  // Esc closes the shop before Foundry's menu gets it.
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (_browser) { e.preventDefault(); e.stopImmediatePropagation(); return closeBrowser(); }
    if (shopOpen()) { e.preventDefault(); e.stopImmediatePropagation(); return closeShop(); }
    if (listOpen()) { e.preventDefault(); e.stopImmediatePropagation(); return closeList(); }
  }, true);

  // Keep an open shop honest when inventories or money change underneath it.
  const touched = (doc) => {
    const p = doc?.parent;
    return p && (p === getShipActor() || p === game.user.character);
  };
  for (const h of ["createItem", "updateItem", "deleteItem"])
    Hooks.on(h, (doc) => { if (touched(doc)) refreshOpen(); });
  Hooks.on("updateActor", (a) => { if (a === getShipActor() || a === game.user.character) refreshOpen(); });

  const api = {
    open: openShops, openShop, close: closeAll,
    createShop: async (opts) => {
      if (!game.user.isGM) return null;
      const L = getLocations();
      const shop = S().makeShop({
        id: opts.id || `shop-${foundry.utils.randomID(6).toLowerCase()}`,
        stamp: Date.now(), ...opts,
      }, idx(), L.places[opts.locationId]);
      await writeShop(shop);
      return shop;
    },
    deleteShop, setLocation: async (id) => {
      if (!game.user.isGM) return;
      await game.settings.set(MODULE_ID, SET_LOCATIONS, { ...getLocations(), current: id });
    },
    /**
     * Populate the whole sector in one go from the catalogue's per-world seed
     * lists (56 shops across 16 worlds). Skips any world that already has
     * shops, so it is safe to re-run after adding a location.
     */
    seedSector: async ({ force = false } = {}) => {
      if (!game.user.isGM) return ui.notifications?.warn("Only the GM can seed the sector.");
      const L = getLocations();
      const all = getShops();
      let made = 0, skipped = 0;
      for (const loc of CATALOGUE.locations) {
        const seeds = loc.seed || [];
        if (!seeds.length) continue;
        const already = Object.values(all).some((sh) => sh.locationId === loc.id);
        if (already && !force) { skipped++; continue; }
        seeds.forEach(([type, wealth, size], i) => {
          const shop = S().makeShop({
            id: `shop-${loc.id}-${type}`.slice(0, 48),
            type, locationId: loc.id, wealth, size,
            faction: loc.faction || null, stamp: Date.now() + i,
          }, idx(), L.places[loc.id] || loc);
          all[shop.id] = shop;
          made++;
        });
      }
      await game.settings.set(MODULE_ID, SET_SHOPS, all);
      const bytes = JSON.stringify(all).length;
      ui.notifications?.info(`Seeded ${made} shops (${skipped} worlds already had some). ` +
                             `Shop data: ${(bytes / 1024).toFixed(0)} KB.`);
      emit({ type: "refresh" });
      refreshOpen();
      return { made, skipped, bytes };
    },
    getShops, getLocations, getTreasury, getCatalogue: () => CATALOGUE,
    setTreasury: async (c) => { if (game.user.isGM) await game.settings.set(MODULE_ID, SET_TREASURY, { ...getTreasury(), ...c }); },
    buildSrdIndex, rebuildIndex,
  };
  const mod = game.modules.get(MODULE_ID);
  if (mod) mod.api = api;
  globalThis.SilverGullShop = api;
  console.log(`${MODULE_ID} | ready — ${CATALOGUE.items.length} catalogue items, ` +
              `${CATALOGUE.shopTypes.length} shop types`);
});

// Prices move when standing does.
Hooks.on(`${POLITICS_ID}.updated`, () => refreshOpen());
