(() => {
  const FOIL_RARITIES = new Set(["R", "RR", "OSR", "S", "SY", "SR", "UR", "OUR", "HR", "SEC"]);
  const HIGH_RARITIES = new Set(["SEC", "OUR", "UR", "SR", "S", "SY", "HR"]);
  const PARALLEL_RARITIES = new Set(["SEC", "OUR", "UR", "SR", "S", "SY", "HR"]);
  const RARITY_ORDER = {
    SEC: 1, OUR: 2, OSR: 3, UR: 4, SR: 5, RR: 6,
    S: 7, SY: 8, HR: 9, R: 10, U: 11, C: 12, OC: 13, P: 14,
  };

  const ADMIN_EMAILS = new Set(["sebastianberr@gmail.com"]);

  const LS_COLLECTION = "hocg-cloud-guest-collection";
  const LS_DECKS = "hocg-cloud-guest-decks";
  const LS_TRADES = "hocg-cloud-guest-trades";
  const LS_RATE = "hocg-cloud-guest-rate";
  const IDB_NAME = "hocg-catalog-cache-v1";
  const IDB_STORE = "kv";
  const IDB_BUNDLE_KEY = "catalog_bundle";

  let app = null;
  let auth = null;
  let db = null;
  let fbAuthMod = null;
  let fbFsMod = null;
  let sdkBootstrapPromise = null;

  let currentUser = null;
  let useCloudBackend = false;
  let catalogLoaded = false;

  let cardsList = [];
  let cardsById = new Map();
  let editionsList = [];
  let auditReport = {};
  let catalogSyncInfo = {
    source: "Hosting CDN (/data)",
    catalogUpdatedAt: "",
    pricesUpdatedAt: "",
    editionsCount: 0,
    totalProducts: 0,
    cacheHit: false,
  };
  let defaultRate = {
    rateClpPerUsd: 1002.07,
    source: "Banco Central de Chile",
    observedDate: new Date().toISOString().slice(0, 10),
    updatedAt: new Date().toISOString(),
  };
  let cloudAutoRate = null;
  let personalRate = null;

  let collectionMap = new Map(); // productId -> CollectionEntry
  let decksList = [];
  let tradesList = [];
  let activeRate = { ...defaultRate };
  let unsubs = [];

  function resolveEffectiveRate(metaRate, userRate) {
    if (userRate && Number(userRate.rateClpPerUsd) > 0) {
      if (userRate.source === "Manual") return userRate;
      if (!metaRate || String(userRate.updatedAt || "") >= String(metaRate.updatedAt || "")) {
        return userRate;
      }
    }
    if (metaRate && Number(metaRate.rateClpPerUsd) > 0) return metaRate;
    return { ...defaultRate };
  }

  function refreshActiveRate() {
    activeRate = resolveEffectiveRate(cloudAutoRate, personalRate);
  }

  function openCacheDb() {
    return new Promise((resolve) => {
      if (typeof indexedDB === "undefined") {
        resolve(null);
        return;
      }
      try {
        const req = indexedDB.open(IDB_NAME, 1);
        req.onupgradeneeded = () => {
          const idb = req.result;
          if (!idb.objectStoreNames.contains(IDB_STORE)) {
            idb.createObjectStore(IDB_STORE);
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      } catch (_) {
        resolve(null);
      }
    });
  }

  async function idbGet(key) {
    const idb = await openCacheDb();
    if (!idb) return null;
    return new Promise((resolve) => {
      try {
        const tx = idb.transaction(IDB_STORE, "readonly");
        const req = tx.objectStore(IDB_STORE).get(key);
        req.onsuccess = () => resolve(req.result ?? null);
        req.onerror = () => resolve(null);
      } catch (_) {
        resolve(null);
      }
    });
  }

  async function idbSet(key, val) {
    const idb = await openCacheDb();
    if (!idb) return;
    return new Promise((resolve) => {
      try {
        const tx = idb.transaction(IDB_STORE, "readwrite");
        tx.objectStore(IDB_STORE).put(val, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch (_) {
        resolve();
      }
    });
  }

  async function idbDelete(key) {
    const idb = await openCacheDb();
    if (!idb) return;
    return new Promise((resolve) => {
      try {
        const tx = idb.transaction(IDB_STORE, "readwrite");
        tx.objectStore(IDB_STORE).delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch (_) {
        resolve();
      }
    });
  }

  async function ensureFirebaseModules() {
    if (!window.FIREBASE_CONFIG) return null;
    if (db && fbFsMod && auth && fbAuthMod) return { app, auth, db, fbFsMod, fbAuthMod };
    if (!sdkBootstrapPromise) {
      sdkBootstrapPromise = (async () => {
        const [appMod, authMod, fsMod] = await Promise.all([
          import("https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js"),
          import("https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js"),
          import("https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js"),
        ]);
        fbAuthMod = authMod;
        fbFsMod = fsMod;
        app = appMod.getApps?.().length ? appMod.getApp() : appMod.initializeApp(window.FIREBASE_CONFIG);
        auth = authMod.getAuth(app);
        db = fsMod.getFirestore(app);
        return { app, auth, db, fbFsMod, fbAuthMod };
      })();
    }
    return sdkBootstrapPromise;
  }

  function clearSnapshotListeners() {
    unsubs.forEach((fn) => {
      try { fn(); } catch (_) {}
    });
    unsubs = [];
  }

  function normalizeEmail(email) {
    return String(email || "").trim().toLowerCase();
  }

  function getUserRole() {
    if (currentUser) {
      const isVerifiedAdmin =
        currentUser.emailVerified === true &&
        ADMIN_EMAILS.has(normalizeEmail(currentUser.email));
      return isVerifiedAdmin ? "admin" : "user";
    }
    return useCloudBackend ? "guest" : "admin";
  }

  function isCurrentUserAdmin() {
    return getUserRole() === "admin";
  }

  function isCardFoil(card) {
    if (!card || card.itemCategory === "sealed") return false;
    if (FOIL_RARITIES.has(card.rarity)) return true;
    return card.rarity === "P" && String(card.priceSubtype || "").toLowerCase() === "foil";
  }

  function effectivePrice(card) {
    return card.marketPrice ?? card.foilMarketPrice ?? null;
  }

  function loadGuestStateFromStorage() {
    try {
      const rawCol = localStorage.getItem(LS_COLLECTION);
      collectionMap = new Map();
      if (rawCol) {
        for (const item of JSON.parse(rawCol)) {
          if (item && item.productId) collectionMap.set(Number(item.productId), item);
        }
      }
      const rawDecks = localStorage.getItem(LS_DECKS);
      decksList = rawDecks ? JSON.parse(rawDecks) : [];
      const rawTrades = localStorage.getItem(LS_TRADES);
      tradesList = rawTrades ? JSON.parse(rawTrades) : [];
      const rawRate = localStorage.getItem(LS_RATE);
      personalRate = rawRate ? JSON.parse(rawRate) : null;
      refreshActiveRate();
    } catch (_) {
      collectionMap = new Map();
      decksList = [];
      tradesList = [];
      personalRate = null;
      refreshActiveRate();
    }
  }

  function saveGuestStateToStorage() {
    if (currentUser) return;
    localStorage.setItem(LS_COLLECTION, JSON.stringify(Array.from(collectionMap.values())));
    localStorage.setItem(LS_DECKS, JSON.stringify(decksList));
    localStorage.setItem(LS_TRADES, JSON.stringify(tradesList));
    if (personalRate) {
      localStorage.setItem(LS_RATE, JSON.stringify(personalRate));
    }
  }

  async function detectRuntimeMode() {
    const host = window.location.hostname;
    const isLocalHost = host === "127.0.0.1" || host === "localhost";
    if (!isLocalHost) {
      useCloudBackend = true;
      return;
    }
    try {
      const res = await fetch("/api/health", { signal: AbortSignal.timeout(700) });
      if (res.ok) {
        const body = await res.json();
        if (body && body.engine === "rust-axum-sqlite3") {
          useCloudBackend = false;
          return;
        }
      }
    } catch (_) {}
    useCloudBackend = true;
  }

  function sortEditionsDesc(list) {
    return (list || []).slice().sort((a, b) => {
      const pa = String(a.publishedOn || "");
      const pb = String(b.publishedOn || "");
      if (pb !== pa) return pb.localeCompare(pa);
      return Number(b.groupId) - Number(a.groupId);
    });
  }

  function hydrateSlimCard(raw, edMeta) {
    return {
      productId: Number(raw.productId),
      groupId: Number(edMeta.groupId),
      editionName: edMeta.name || "",
      editionAbbr: edMeta.abbreviation || "",
      name: raw.name || "",
      cleanName: raw.cleanName || raw.name || "",
      imageUrl: raw.imageUrl || "",
      url: raw.url || "",
      itemCategory: raw.itemCategory || "card",
      cardNumber: raw.cardNumber || "",
      rarity: raw.rarity || "",
      rarityName: raw.rarityName || "",
      cardType: raw.cardType || "",
      subtype: raw.subtype || "",
      color: raw.color || "",
      bloomLevel: raw.bloomLevel || "",
      hp: raw.hp ?? null,
      life: raw.life ?? null,
      batonPass: raw.batonPass || "",
      tags: raw.tags || "",
      oshiSkill: raw.oshiSkill || "",
      spOshiSkill: raw.spOshiSkill || "",
      keywordText: raw.keywordText || "",
      arts1: raw.arts1 || "",
      arts2: raw.arts2 || "",
      specialRules: raw.specialRules || "",
      descriptionText: raw.descriptionText || "",
      effectText: raw.effectText || "",
      rawDescription: raw.rawDescription || "",
      marketPrice: raw.marketPrice ?? null,
      lowPrice: raw.lowPrice ?? null,
      midPrice: raw.midPrice ?? null,
      highPrice: raw.highPrice ?? null,
      directLowPrice: raw.directLowPrice ?? null,
      foilMarketPrice: raw.foilMarketPrice ?? null,
      foilLowPrice: raw.foilLowPrice ?? null,
      priceSubtype: raw.priceSubtype || "Normal",
      sanitizedFlag: Boolean(raw.sanitizedFlag),
      hadCommaOrHtml: Boolean(raw.hadCommaOrHtml),
    };
  }

  const ARTS_COLOR_PREFIX_MAP = {
    W: "White",
    G: "Green",
    R: "Red",
    B: "Blue",
    P: "Purple",
    Y: "Yellow",
  };
  const COLOR_ORDER = ["White", "Green", "Red", "Blue", "Purple", "Yellow"];
  const COLOR_ORDER_INDEX = Object.fromEntries(COLOR_ORDER.map((c, i) => [c, i]));
  const HBP06_BUZZ_CARD_NUMBERS = new Set([
    "hBP06-013",
    "hBP06-026",
    "hBP06-052",
    "hBP06-065",
    "hBP06-076",
  ]);
  const CARD_NUMBER_COLOR_RANGES = [
    ["hBP06-", 1, 2, "White"],
    ["hBP06-", 3, 3, "Green"],
    ["hBP06-", 4, 5, "Red"],
    ["hBP06-", 6, 6, "Blue"],
    ["hBP06-", 7, 7, "Purple"],
    ["hBP06-", 8, 8, "Yellow"],
    ["hBP06-", 9, 21, "White"],
    ["hBP06-", 22, 33, "Green"],
    ["hBP06-", 34, 47, "Red"],
    ["hBP06-", 48, 60, "Blue"],
    ["hBP06-", 61, 71, "Purple"],
    ["hBP06-", 72, 83, "Yellow"],
    ["hBP06-", 84, 84, "Colorless"],
    ["hSD10-", 1, 6, "Green"],
    ["hSD10-", 7, 9, "Purple"],
    ["hSD10-", 10, 10, "Colorless"],
    ["hSD11-", 1, 6, "Yellow"],
    ["hSD11-", 7, 9, "Blue"],
  ];

  function lookupCardNumberColorOverride(cardNumber) {
    const m = String(cardNumber || "").trim().match(/^(hBP06-|hSD10-|hSD11-)(\d+)$/);
    if (!m) return null;
    const prefix = m[1];
    const num = Number(m[2]);
    for (const [p, lo, hi, color] of CARD_NUMBER_COLOR_RANGES) {
      if (p === prefix && num >= lo && num <= hi) return color;
    }
    return null;
  }

  const CARD_NUMBER_BLOOM_OVERRIDES = Object.fromEntries([
    ...[
      "hBP06-009", "hBP06-010", "hBP06-015", "hBP06-016", "hBP06-022", "hBP06-023",
      "hBP06-028", "hBP06-034", "hBP06-035", "hBP06-040", "hBP06-041", "hBP06-048",
      "hBP06-049", "hBP06-057", "hBP06-061", "hBP06-062", "hBP06-067", "hBP06-072",
      "hBP06-073", "hBP06-078", "hSD10-002", "hSD10-007", "hSD11-002", "hSD11-007",
    ].map((cn) => [cn, "Debut"]),
    ...[
      "hBP06-011", "hBP06-012", "hBP06-013", "hBP06-017", "hBP06-018", "hBP06-019",
      "hBP06-024", "hBP06-025", "hBP06-026", "hBP06-029", "hBP06-030", "hBP06-032",
      "hBP06-033", "hBP06-036", "hBP06-037", "hBP06-038", "hBP06-042", "hBP06-043",
      "hBP06-044", "hBP06-050", "hBP06-051", "hBP06-052", "hBP06-058", "hBP06-059",
      "hBP06-063", "hBP06-064", "hBP06-065", "hBP06-068", "hBP06-069", "hBP06-074",
      "hBP06-075", "hBP06-076", "hBP06-079", "hBP06-080", "hBP06-083", "hSD10-003",
      "hSD10-004", "hSD10-005", "hSD10-008", "hSD11-003", "hSD11-004", "hSD11-005",
      "hSD11-008",
    ].map((cn) => [cn, "1st"]),
    ...[
      "hBP06-014", "hBP06-020", "hBP06-021", "hBP06-027", "hBP06-031", "hBP06-039",
      "hBP06-045", "hBP06-046", "hBP06-047", "hBP06-053", "hBP06-054", "hBP06-055",
      "hBP06-056", "hBP06-060", "hBP06-066", "hBP06-070", "hBP06-071", "hBP06-077",
      "hBP06-081", "hBP06-082", "hSD10-006", "hSD10-009", "hSD11-006", "hSD11-009",
    ].map((cn) => [cn, "2nd"]),
    ...["hBP06-084", "hSD10-010"].map((cn) => [cn, "Spot"]),
  ]);

  function lookupCardNumberBloomOverride(cardNumber) {
    return CARD_NUMBER_BLOOM_OVERRIDES[String(cardNumber || "").trim()] || null;
  }

  function canonicalizeColorValue(raw) {
    const tokens = [];
    for (const part of String(raw || "").split(/[;/]/)) {
      const t = part.trim();
      if (!t) continue;
      const low = t.toLowerCase();
      const norm =
        low === "neutral" || low === "colorless"
          ? "Colorless"
          : t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
      if (!tokens.includes(norm)) tokens.push(norm);
    }
    if (!tokens.length) return "";
    const filtered =
      tokens.length > 1 ? tokens.filter((t) => t !== "Colorless") : tokens;
    filtered.sort((a, b) => (COLOR_ORDER_INDEX[a] ?? 99) - (COLOR_ORDER_INDEX[b] ?? 99));
    return filtered.join(" / ");
  }

  function extractArtsColors(arts1, arts2) {
    const found = [];
    const text = `${arts1 || ""} ${arts2 || ""}`;
    for (const m of text.matchAll(/\[([WGRBPYN]+)\]/g)) {
      for (const ch of m[1]) {
        const col = ARTS_COLOR_PREFIX_MAP[ch];
        if (col && !found.includes(col)) found.push(col);
      }
    }
    found.sort((a, b) => (COLOR_ORDER_INDEX[a] ?? 99) - (COLOR_ORDER_INDEX[b] ?? 99));
    return found;
  }

  function repairCatalogCardMetadata(cards) {
    if (!Array.isArray(cards) || !cards.length) return;
    const byCardNumber = new Map();

    for (const c of cards) {
      if (!c || c.itemCategory === "sealed") continue;
      const cn = String(c.cardNumber || "").trim();
      if (HBP06_BUZZ_CARD_NUMBERS.has(cn)) {
        if (c.cardType !== "Buzz Holomem") {
          c.cardType = "Buzz Holomem";
          c.sanitizedFlag = true;
        }
      }
      const bloomOv = lookupCardNumberBloomOverride(cn);
      if (
        bloomOv &&
        (c.cardType === "Holomem" || c.cardType === "Buzz Holomem") &&
        c.bloomLevel !== bloomOv
      ) {
        c.bloomLevel = bloomOv;
        c.sanitizedFlag = true;
      }
      if (c.color) {
        const canon = canonicalizeColorValue(c.color);
        if (canon && canon !== c.color) {
          c.color = canon;
          c.sanitizedFlag = true;
        }
      }
      if (c.cardType !== "Support" && cn) {
        const ov = lookupCardNumberColorOverride(cn);
        if (ov && c.color !== ov) {
          c.color = ov;
          c.sanitizedFlag = true;
        }
        if (!byCardNumber.has(cn)) byCardNumber.set(cn, []);
        byCardNumber.get(cn).push(c);
      }
    }

    for (const [cn, group] of byCardNumber.entries()) {
      const isBuzz =
        HBP06_BUZZ_CARD_NUMBERS.has(cn) || group.some((r) => r.cardType === "Buzz Holomem");
      if (isBuzz) {
        for (const r of group) {
          if (r.cardType !== "Oshi Holomem" && r.cardType !== "Buzz Holomem") {
            r.cardType = "Buzz Holomem";
            r.sanitizedFlag = true;
          }
        }
      }

      const bloomOverride = lookupCardNumberBloomOverride(cn);
      const knownBloom =
        bloomOverride ||
        (HBP06_BUZZ_CARD_NUMBERS.has(cn)
          ? "1st"
          : group.map((r) => String(r.bloomLevel || "").trim()).find(Boolean) || "");
      if (knownBloom) {
        for (const r of group) {
          const isHolomem = r.cardType === "Holomem" || r.cardType === "Buzz Holomem";
          const curBloom = String(r.bloomLevel || "").trim();
          if (isHolomem && ((bloomOverride && curBloom !== knownBloom) || !curBloom)) {
            r.bloomLevel = knownBloom;
            r.sanitizedFlag = true;
          }
        }
      }

      const ov = lookupCardNumberColorOverride(cn);
      if (ov) {
        for (const r of group) {
          if (r.color !== ov) {
            r.color = ov;
            r.sanitizedFlag = true;
          }
        }
        continue;
      }

      const counts = new Map();
      let artsColors = [];
      for (const r of group) {
        const col = String(r.color || "").trim();
        if (col && col !== "Colorless") {
          counts.set(col, (counts.get(col) || 0) + 1);
        }
        if (!artsColors.length) {
          artsColors = extractArtsColors(r.arts1 || r.effectText, r.arts2);
        }
      }

      if (counts.size > 0) {
        let winningColor = "";
        let bestScore = [-1, -1, -1];
        for (const [col, count] of counts.entries()) {
          const score = [
            count,
            col.includes(" / ") ? 1 : 0,
            artsColors.some((ac) => col.includes(ac)) ? 1 : 0,
          ];
          if (
            score[0] > bestScore[0] ||
            (score[0] === bestScore[0] &&
              (score[1] > bestScore[1] ||
                (score[1] === bestScore[1] && score[2] > bestScore[2])))
          ) {
            bestScore = score;
            winningColor = col;
          }
        }
        if (winningColor) {
          for (const r of group) {
            if (r.color !== winningColor) {
              r.color = winningColor;
              r.sanitizedFlag = true;
            }
          }
        }
      }
    }

    for (const c of cards) {
      if (!c || c.itemCategory === "sealed" || c.cardType === "Support") continue;
      if (lookupCardNumberColorOverride(c.cardNumber)) continue;
      const curCol = String(c.color || "").trim();
      if (curCol && curCol !== "Colorless") continue;
      if (String(c.bloomLevel || "").trim() === "Spot") continue;

      const artsCols = extractArtsColors(c.arts1 || c.effectText, c.arts2);
      if (artsCols.length) {
        c.color = artsCols.join(" / ");
        c.sanitizedFlag = true;
      } else if (c.cardType === "Cheer") {
        const lowName = String(c.name || "").toLowerCase();
        for (const colorName of COLOR_ORDER) {
          if (new RegExp(`\\b${colorName.toLowerCase()}\\b`).test(lowName)) {
            c.color = colorName;
            c.sanitizedFlag = true;
            break;
          }
        }
      } else if (!curCol) {
        c.color = "Colorless";
      }
    }
  }

  function applyPricesOverlay(cards, pricesMap) {
    if (!pricesMap) return;
    for (const c of cards) {
      const row = pricesMap[String(c.productId)];
      if (!Array.isArray(row)) continue;
      c.marketPrice = row[0] ?? null;
      c.lowPrice = row[1] ?? null;
      c.midPrice = row[2] ?? null;
      c.highPrice = row[3] ?? null;
      c.directLowPrice = row[4] ?? null;
      c.foilMarketPrice = row[5] ?? null;
      c.foilLowPrice = row[6] ?? null;
    }
  }

  async function syncExchangeRateFromMetadata() {
    try {
      const mods = await ensureFirebaseModules();
      if (!mods || !mods.db || !mods.fbFsMod) return null;
      const { doc, getDoc } = mods.fbFsMod;
      const snap = await getDoc(doc(mods.db, "metadata", "exchangeRate"));
      if (snap.exists()) {
        const rateData = snap.data();
        if (rateData && Number(rateData.rateClpPerUsd) > 0) {
          cloudAutoRate = rateData;
          defaultRate = rateData;
          refreshActiveRate();
          return rateData;
        }
      }
    } catch (err) {
      console.warn("Firestore exchangeRate read skipped:", err?.message || err);
    }
    return null;
  }

  async function tryLoadCatalogFromFirestore(forceRefresh = false) {
    try {
      const mods = await Promise.race([
        ensureFirebaseModules(),
        new Promise((resolve) => setTimeout(() => resolve(null), 4000)),
      ]);
      if (!mods || !mods.db || !mods.fbFsMod) return false;

      const { collection, doc, getDoc, getDocs } = mods.fbFsMod;
      const [catSnap, rateSnap] = await Promise.all([
        getDoc(doc(mods.db, "metadata", "catalog")),
        getDoc(doc(mods.db, "metadata", "exchangeRate")).catch(() => null),
      ]);

      if (rateSnap && rateSnap.exists()) {
        const rateData = rateSnap.data();
        if (rateData && Number(rateData.rateClpPerUsd) > 0) {
          cloudAutoRate = rateData;
          defaultRate = rateData;
          refreshActiveRate();
        }
      }

      if (!catSnap || !catSnap.exists()) {
        return false;
      }

      const catMeta = catSnap.data() || {};
      const catalogHash = String(catMeta.catalogHash || "");
      const pricesUpdatedAt = String(catMeta.pricesUpdatedAt || "");
      const catalogUpdatedAt = String(catMeta.catalogUpdatedAt || pricesUpdatedAt);

      if (!forceRefresh && catalogHash) {
        const cached = await idbGet(IDB_BUNDLE_KEY);
        if (cached && Array.isArray(cached.cards) && cached.cards.length > 0 && cached.catalogHash === catalogHash) {
          if (cached.pricesUpdatedAt === pricesUpdatedAt) {
            cardsList = cached.cards;
            cardsById = new Map(cardsList.map((c) => [Number(c.productId), c]));
            editionsList = sortEditionsDesc(cached.editions || []);
            catalogSyncInfo = {
              source: "Cloud Firestore (Caché local al día)",
              catalogUpdatedAt,
              pricesUpdatedAt,
              editionsCount: editionsList.length,
              totalProducts: cardsList.length,
              cacheHit: true,
            };
            return true;
          }

          // Catalog structure unchanged, only daily prices updated -> read 1 doc (metadata/prices)!
          const pricesSnap = await getDoc(doc(mods.db, "metadata", "prices"));
          if (pricesSnap.exists()) {
            const pData = pricesSnap.data() || {};
            const pricesMap = pData.pricesJson ? JSON.parse(pData.pricesJson) : {};
            applyPricesOverlay(cached.cards, pricesMap);
            cardsList = cached.cards;
            cardsById = new Map(cardsList.map((c) => [Number(c.productId), c]));
            editionsList = sortEditionsDesc(cached.editions || []);
            await idbSet(IDB_BUNDLE_KEY, {
              catalogHash,
              catalogUpdatedAt,
              pricesUpdatedAt,
              cards: cardsList,
              editions: editionsList,
            });
            catalogSyncInfo = {
              source: "Cloud Firestore (Precios actualizados hoy)",
              catalogUpdatedAt,
              pricesUpdatedAt,
              editionsCount: editionsList.length,
              totalProducts: cardsList.length,
              cacheHit: "prices-only",
            };
            return true;
          }
        }
      }

      // Full sync from Firestore (editions + metadata/prices only; audit is lazy-loaded for admins)
      const [editionsSnap, pricesSnap] = await Promise.all([
        getDocs(collection(mods.db, "editions")),
        getDoc(doc(mods.db, "metadata", "prices")),
      ]);

      if (editionsSnap.empty || !pricesSnap.exists()) {
        return false;
      }

      const pricesData = pricesSnap.data() || {};
      const pricesMap = pricesData.pricesJson ? JSON.parse(pricesData.pricesJson) : {};

      const nextEditions = [];
      const nextCards = [];

      editionsSnap.forEach((docSnap) => {
        const d = docSnap.data() || {};
        const edMeta = {
          groupId: Number(d.groupId || docSnap.id),
          name: String(d.name || ""),
          abbreviation: String(d.abbreviation || ""),
          isSupplemental: Boolean(d.isSupplemental),
          publishedOn: String(d.publishedOn || ""),
          modifiedOn: String(d.modifiedOn || ""),
        };
        nextEditions.push(edMeta);

        const rawCards = d.cardsJson ? JSON.parse(d.cardsJson) : Array.isArray(d.cards) ? d.cards : [];
        for (const rawCard of rawCards) {
          nextCards.push(hydrateSlimCard(rawCard, edMeta));
        }
      });

      if (!nextCards.length) return false;
      applyPricesOverlay(nextCards, pricesMap);

      cardsList = nextCards;
      cardsById = new Map(cardsList.map((c) => [Number(c.productId), c]));
      editionsList = sortEditionsDesc(nextEditions);

      await idbSet(IDB_BUNDLE_KEY, {
        catalogHash,
        catalogUpdatedAt,
        pricesUpdatedAt,
        cards: cardsList,
        editions: editionsList,
      });

      catalogSyncInfo = {
        source: "Cloud Firestore",
        catalogUpdatedAt,
        pricesUpdatedAt,
        editionsCount: editionsList.length,
        totalProducts: cardsList.length,
        cacheHit: false,
      };
      return true;
    } catch (err) {
      console.warn("Firestore catalog fallback to static /data/:", err?.message || err);
      return false;
    }
  }

  async function ensureCatalogLoaded(forceRefresh = false) {
    if (catalogLoaded && !forceRefresh) return;

    if (forceRefresh) {
      await idbDelete(IDB_BUNDLE_KEY);
    }

    const loadedFromCloud = await tryLoadCatalogFromFirestore(forceRefresh);
    if (loadedFromCloud) {
      repairCatalogCardMetadata(cardsList);
      catalogLoaded = true;
      return;
    }

    const [cardsRes, groupsRes, rateRes] = await Promise.all([
      fetch("/data/cards_cleaned.json"),
      fetch("/data/groups.json"),
      fetch("/data/exchange_rate.json").catch(() => null),
    ]);

    if (!cardsRes.ok || !groupsRes.ok) {
      throw new Error("No se pudieron cargar los datos estáticos del catálogo (/data/)");
    }

    cardsList = await cardsRes.json();
    repairCatalogCardMetadata(cardsList);
    cardsById = new Map(cardsList.map((c) => [Number(c.productId), c]));

    const groupsJson = await groupsRes.json();
    editionsList = sortEditionsDesc(groupsJson.results || []);

    if (rateRes && rateRes.ok && !cloudAutoRate) {
      defaultRate = await rateRes.json();
      refreshActiveRate();
    }

    catalogSyncInfo = {
      source: "Hosting CDN (/data)",
      catalogUpdatedAt: "",
      pricesUpdatedAt: "",
      editionsCount: editionsList.length,
      totalProducts: cardsList.length,
      cacheHit: false,
    };
    catalogLoaded = true;
  }

  function normalizeAuditReport(r) {
    return {
      editionsProcessed: r.editionsProcessed ?? r.editions_processed ?? 0,
      totalProducts: r.totalProducts ?? r.total_products ?? 0,
      totalCards: r.totalCards ?? r.total_cards ?? 0,
      totalSealed: r.totalSealed ?? r.total_sealed ?? 0,
      csvRowsParsed: r.csvRowsParsed ?? r.csv_rows_parsed ?? 0,
      naiveCsvBrokenRows: r.naiveCsvBrokenRows ?? r.naive_csv_broken_rows ?? 0,
      csvRowsWithCommasInText: r.csvRowsWithCommasInText ?? r.csv_rows_with_commas_in_text ?? 0,
      csvRowsWithNewlinesInText: r.csvRowsWithNewlinesInText ?? r.csv_rows_with_newlines_in_text ?? 0,
      csvRowsWithQuotesInText: r.csvRowsWithQuotesInText ?? r.csv_rows_with_quotes_in_text ?? 0,
      descriptionsHtmlCleaned: r.descriptionsHtmlCleaned ?? r.descriptions_html_cleaned ?? 0,
      spacingBugsFixed: r.spacingBugsFixed ?? r.spacing_bugs_fixed ?? 0,
      typosFixed: r.typosFixed ?? r.typos_fixed ?? 0,
      missingCardTypeInferred: r.missingCardTypeInferred ?? r.missing_card_type_inferred ?? 0,
      missingColorInferred: r.missingColorInferred ?? r.missing_color_inferred ?? 0,
      examples: (r.examples || []).map((ex) => ({
        productId: ex.productId ?? ex.product_id,
        name: ex.name,
        cardNumber: ex.cardNumber ?? ex.card_number ?? "",
        issuesFixed: ex.issuesFixed ?? ex.issues_fixed ?? [],
        rawSnippet: ex.rawSnippet ?? ex.raw_snippet ?? "",
        cleanedSnippet: ex.cleanedSnippet ?? ex.cleaned_snippet ?? "",
      })),
    };
  }

  async function loadAuditReportForAdmin(forceRefresh = false) {
    if (!isCurrentUserAdmin()) {
      throw new Error("Acceso denegado: se requieren privilegios de administrador.");
    }
    if (!forceRefresh && auditReport && Number(auditReport.totalProducts || 0) > 0) {
      return auditReport;
    }

    let loaded = null;
    try {
      const mods = await Promise.race([
        ensureFirebaseModules(),
        new Promise((resolve) => setTimeout(() => resolve(null), 4000)),
      ]);
      if (mods && mods.db && mods.fbFsMod) {
        const { doc, getDoc } = mods.fbFsMod;
        const auditSnap = await getDoc(doc(mods.db, "metadata", "audit"));
        if (auditSnap && auditSnap.exists()) {
          const ad = auditSnap.data() || {};
          loaded = ad.reportJson ? JSON.parse(ad.reportJson) : ad.report || ad;
        }
      }
    } catch (err) {
      if (err?.code === "permission-denied") {
        throw new Error("Acceso denegado por reglas de Firestore.");
      }
      console.warn("Admin Firestore audit read skipped:", err?.message || err);
    }

    auditReport = normalizeAuditReport(loaded || {});
    return auditReport;
  }

  function toFirestoreCollectionDoc(entry) {
    const qty = Math.max(0, Math.min(9999, Math.trunc(Number(entry.quantity ?? entry.quantityNormal ?? 0))));
    const cond = ["NM", "LP", "MP", "HP", "DMG"].includes(entry.condition) ? entry.condition : "NM";
    const price =
      entry.purchasePrice !== null && entry.purchasePrice !== undefined && entry.purchasePrice !== ""
        ? Math.max(0, Math.min(1000000, Number(entry.purchasePrice)))
        : null;
    return {
      productId: Math.trunc(Number(entry.productId)),
      quantity: qty,
      quantityNormal: qty,
      quantityFoil: 0,
      condition: cond,
      language: String(entry.language || "EN").slice(0, 16),
      purchasePrice: price,
      isFavorite: Boolean(entry.isFavorite),
      isWishlist: Boolean(entry.isWishlist),
      wishlistTargetQty: Math.max(1, Math.min(9999, Math.trunc(Number(entry.wishlistTargetQty || 1)))),
      notes: String(entry.notes || "").slice(0, 1000),
      updatedAt: String(entry.updatedAt || new Date().toISOString()).slice(0, 64),
    };
  }

  function toFirestoreDeckDoc(deck) {
    const now = new Date().toISOString().slice(0, 64);
    const rawOshi = Number(deck?.oshiProductId);
    const oshiProductId = Number.isInteger(rawOshi) && rawOshi > 0 ? rawOshi : null;
    const rawCards = Array.isArray(deck?.cards) ? deck.cards : [];
    const cards = rawCards
      .map((c) => {
        const pid = Math.trunc(Number(c?.productId));
        const qty = Math.max(1, Math.min(50, Math.trunc(Number(c?.quantity || 1))));
        const zone = String(c?.zone || "main") === "cheer" ? "cheer" : "main";
        return { productId: pid, zone, quantity: qty };
      })
      .filter((c) => Number.isInteger(c.productId) && c.productId > 0)
      .slice(0, 100);
    const createdAt = (typeof deck?.createdAt === "string" ? deck.createdAt : now).slice(0, 64);

    return {
      name: String(deck?.name || "Mazo").trim().slice(0, 120) || "Mazo",
      oshiProductId,
      description: String(deck?.description || "").slice(0, 1000),
      cards,
      createdAt,
      updatedAt: now,
    };
  }

  function round2(val) {
    const num = Number(val);
    if (!Number.isFinite(num)) return 0;
    return Math.round(num * 100) / 100;
  }

  function clampUsd(val) {
    const num = Number(val);
    if (!Number.isFinite(num)) return 0;
    return round2(Math.max(0, Math.min(1000000, num)));
  }

  function clampOriginalCash(val) {
    const num = Number(val);
    if (!Number.isFinite(num)) return 0;
    return round2(Math.max(0, Math.min(1000000000, num)));
  }

  function classifyTradeVerdict(balanceUsd, roiPct) {
    if (Math.abs(balanceUsd) < 0.5 && Math.abs(roiPct) < 5.0) {
      return "fair";
    }
    if (balanceUsd > 0 && (roiPct >= 5.0 || balanceUsd >= 5.0)) {
      return "worth";
    }
    if (balanceUsd < 0 && (roiPct <= -5.0 || balanceUsd <= -5.0)) {
      return "not_worth";
    }
    return "fair";
  }

  function computeTradeRoiPct(balanceUsd, inTotal, outTotal) {
    if (outTotal > 0) return round2((balanceUsd / outTotal) * 100);
    if (inTotal > 0) return 100;
    return 0;
  }

  function normalizeTradeItems(rawItems) {
    const order = [];
    const byPid = new Map();
    for (const raw of rawItems || []) {
      const pid = Math.trunc(Number(raw?.productId));
      const qtyRaw = Math.trunc(Number(raw?.quantity || 0));
      if (!Number.isInteger(pid) || pid <= 0 || qtyRaw <= 0) continue;
      const card = cardsById.get(pid);
      if (!card) continue;

      const qty = Math.max(1, Math.min(999, qtyRaw));
      const defaultMarket = clampUsd(effectivePrice(card) ?? 0);
      const unitMarketUsd =
        raw?.unitMarketUsd !== null && raw?.unitMarketUsd !== undefined && raw?.unitMarketUsd !== "" && Number.isFinite(Number(raw.unitMarketUsd))
          ? clampUsd(raw.unitMarketUsd)
          : defaultMarket;
      const unitCostUsd =
        raw?.unitCostUsd !== null && raw?.unitCostUsd !== undefined && raw?.unitCostUsd !== "" && Number.isFinite(Number(raw.unitCostUsd))
          ? clampUsd(raw.unitCostUsd)
          : null;
      const condition = ["NM", "LP", "MP", "HP", "DMG"].includes(raw?.condition) ? raw.condition : "NM";

      if (byPid.has(pid)) {
        const prev = byPid.get(pid);
        const totalQ = prev.quantity + qty;
        prev.unitMarketUsd = round2(((prev.unitMarketUsd * prev.quantity) + (unitMarketUsd * qty)) / totalQ);
        if (prev.unitCostUsd !== null && unitCostUsd !== null) {
          prev.unitCostUsd = round2(((prev.unitCostUsd * prev.quantity) + (unitCostUsd * qty)) / totalQ);
        } else if (prev.unitCostUsd === null) {
          prev.unitCostUsd = unitCostUsd;
        }
        prev.quantity = Math.max(1, Math.min(999, totalQ));
      } else {
        if (order.length >= 50) continue;
        order.push(pid);
        byPid.set(pid, {
          productId: pid,
          quantity: qty,
          unitMarketUsd,
          unitCostUsd,
          condition,
        });
      }
    }
    return order.map((pid) => byPid.get(pid));
  }

  function toFirestoreTradeDoc(trade, nowOverride) {
    const now = String(nowOverride || new Date().toISOString()).slice(0, 64);
    const type = ["buy", "sell", "trade"].includes(String(trade?.type || "").trim().toLowerCase())
      ? String(trade.type).trim().toLowerCase()
      : "trade";
    const date = String(trade?.date || "").trim().slice(0, 32) || now.slice(0, 10);
    const rateNum = Number(trade?.exchangeRateUsed || activeRate?.rateClpPerUsd || 1000);
    const exchangeRateUsed =
      Number.isFinite(rateNum) && rateNum > 0
        ? round2(Math.max(1, Math.min(1000000, rateNum)))
        : 1000;
    const cashPaidUsd = clampUsd(trade?.cashPaidUsd || 0);
    const cashReceivedUsd = clampUsd(trade?.cashReceivedUsd || 0);
    const cashPaidOriginal = clampOriginalCash(trade?.cashPaidOriginal ?? cashPaidUsd);
    const cashReceivedOriginal = clampOriginalCash(trade?.cashReceivedOriginal ?? cashReceivedUsd);
    const serializeItem = (item) => ({
      productId: Math.trunc(Number(item.productId)),
      quantity: Math.max(1, Math.min(999, Math.trunc(Number(item.quantity || 1)))),
      unitMarketUsd: clampUsd(item.unitMarketUsd || 0),
      unitCostUsd:
        item.unitCostUsd !== null && item.unitCostUsd !== undefined && Number.isFinite(Number(item.unitCostUsd))
          ? clampUsd(item.unitCostUsd)
          : null,
      condition: ["NM", "LP", "MP", "HP", "DMG"].includes(item.condition) ? item.condition : "NM",
    });

    const itemsIn = (Array.isArray(trade?.itemsIn) ? trade.itemsIn : []).slice(0, 50).map(serializeItem);
    const itemsOut = (Array.isArray(trade?.itemsOut) ? trade.itemsOut : []).slice(0, 50).map(serializeItem);
    const wishlistFulfilledIds = Array.from(
      new Set(
        (Array.isArray(trade?.wishlistFulfilledIds) ? trade.wishlistFulfilledIds : [])
          .map((id) => Math.trunc(Number(id)))
          .filter((id) => Number.isInteger(id) && id > 0)
      )
    ).slice(0, 50);

    const createdAt = (typeof trade?.createdAt === "string" && trade.createdAt ? trade.createdAt : now).slice(0, 64);

    return {
      type,
      date,
      counterparty: String(trade?.counterparty || "").trim().slice(0, 120),
      notes: String(trade?.notes || "").trim().slice(0, 1000),
      currencyInput: trade?.currencyInput === "CLP" ? "CLP" : "USD",
      exchangeRateUsed,
      cashPaidUsd,
      cashReceivedUsd,
      cashPaidOriginal,
      cashReceivedOriginal,
      itemsIn,
      itemsOut,
      appliedToCollection: trade?.appliedToCollection !== false,
      wishlistFulfilledIds,
      createdAt,
      updatedAt: now,
    };
  }

  async function applyTradeToCollection(tradeDoc) {
    const itemsIn = tradeDoc.itemsIn || [];
    const itemsOut = tradeDoc.itemsOut || [];

    if (tradeDoc.type === "buy" && tradeDoc.cashPaidUsd > 0) {
      const totalInMarket = itemsIn.reduce((acc, it) => acc + it.quantity * it.unitMarketUsd, 0);
      const totalInUnits = itemsIn.reduce((acc, it) => acc + it.quantity, 0);
      for (const it of itemsIn) {
        if (it.unitCostUsd === null || it.unitCostUsd === undefined) {
          if (totalInMarket > 0) {
            it.unitCostUsd = clampUsd(it.unitMarketUsd * (tradeDoc.cashPaidUsd / totalInMarket));
          } else if (totalInUnits > 0) {
            it.unitCostUsd = clampUsd(tradeDoc.cashPaidUsd / totalInUnits);
          }
        }
      }
    }

    const fulfilledIds = [];
    for (const item of itemsIn) {
      const card = cardsById.get(Number(item.productId));
      if (!card) continue;
      const existing = joinCardWithCollection(card);
      const prevQty = Math.max(0, Number(existing.totalOwned || 0));
      const nextQty = Math.min(9999, prevQty + Number(item.quantity || 0));

      let nextPurchasePrice = existing.purchasePrice;
      if (item.unitCostUsd !== null && item.unitCostUsd !== undefined) {
        if (prevQty > 0 && existing.purchasePrice !== null && existing.purchasePrice !== undefined) {
          nextPurchasePrice = clampUsd(
            ((Number(existing.purchasePrice) * prevQty) + (Number(item.unitCostUsd) * Number(item.quantity))) / nextQty
          );
        } else {
          nextPurchasePrice = clampUsd(item.unitCostUsd);
        }
      }

      let nextWishlist = Boolean(existing.isWishlist);
      if (existing.isWishlist && nextQty >= Number(existing.wishlistTargetQty || 1)) {
        nextWishlist = false;
        fulfilledIds.push(Number(item.productId));
      }

      const nextCondition = prevQty === 0 && !existing.updatedAt ? (item.condition || "NM") : existing.condition;
      await persistCollectionEntry(Number(item.productId), {
        productId: Number(item.productId),
        quantity: nextQty,
        condition: nextCondition,
        language: existing.language,
        purchasePrice: nextPurchasePrice,
        isFavorite: existing.isFavorite,
        isWishlist: nextWishlist,
        wishlistTargetQty: existing.wishlistTargetQty,
        notes: existing.notes,
        updatedAt: new Date().toISOString(),
      });
    }

    for (const item of itemsOut) {
      const card = cardsById.get(Number(item.productId));
      if (!card) continue;
      const existing = joinCardWithCollection(card);
      if ((item.unitCostUsd === null || item.unitCostUsd === undefined) && existing.purchasePrice !== null && existing.purchasePrice !== undefined) {
        item.unitCostUsd = clampUsd(existing.purchasePrice);
      }
      const prevQty = Math.max(0, Number(existing.totalOwned || 0));
      const nextQty = Math.max(0, prevQty - Number(item.quantity || 0));
      await persistCollectionEntry(Number(item.productId), {
        productId: Number(item.productId),
        quantity: nextQty,
        condition: existing.condition,
        language: existing.language,
        purchasePrice: existing.purchasePrice,
        isFavorite: existing.isFavorite,
        isWishlist: existing.isWishlist,
        wishlistTargetQty: existing.wishlistTargetQty,
        notes: existing.notes,
        updatedAt: new Date().toISOString(),
      });
    }

    tradeDoc.wishlistFulfilledIds = Array.from(new Set(fulfilledIds));
    return tradeDoc.wishlistFulfilledIds;
  }

  async function revertTradeFromCollection(trade) {
    if (!trade || !trade.appliedToCollection) return false;
    const fulfilledSet = new Set((trade.wishlistFulfilledIds || []).map((id) => Number(id)));

    for (const item of trade.itemsIn || []) {
      const pid = Number(item.productId);
      const card = cardsById.get(pid);
      if (!card) continue;
      const existing = joinCardWithCollection(card);
      const nextQty = Math.max(0, Math.max(0, Number(existing.totalOwned || 0)) - Number(item.quantity || 0));
      const nextWishlist = fulfilledSet.has(pid) ? true : Boolean(existing.isWishlist);
      await persistCollectionEntry(pid, {
        productId: pid,
        quantity: nextQty,
        condition: existing.condition,
        language: existing.language,
        purchasePrice: existing.purchasePrice,
        isFavorite: existing.isFavorite,
        isWishlist: nextWishlist,
        wishlistTargetQty: existing.wishlistTargetQty,
        notes: existing.notes,
        updatedAt: new Date().toISOString(),
      });
    }

    for (const item of trade.itemsOut || []) {
      const pid = Number(item.productId);
      const card = cardsById.get(pid);
      if (!card) continue;
      const existing = joinCardWithCollection(card);
      const nextQty = Math.min(9999, Math.max(0, Number(existing.totalOwned || 0)) + Number(item.quantity || 0));
      const nextPurchasePrice =
        (existing.purchasePrice === null || existing.purchasePrice === undefined) &&
        item.unitCostUsd !== null &&
        item.unitCostUsd !== undefined
          ? clampUsd(item.unitCostUsd)
          : existing.purchasePrice;
      await persistCollectionEntry(pid, {
        productId: pid,
        quantity: nextQty,
        condition: existing.condition,
        language: existing.language,
        purchasePrice: nextPurchasePrice,
        isFavorite: existing.isFavorite,
        isWishlist: existing.isWishlist,
        wishlistTargetQty: existing.wishlistTargetQty,
        notes: existing.notes,
        updatedAt: new Date().toISOString(),
      });
    }
    return true;
  }

  function enrichTradeItemDetail(item) {
    const pid = Number(item.productId);
    const card = cardsById.get(pid);
    const col = collectionMap.get(pid);
    const have = col ? Number(col.quantity ?? ((col.quantityNormal || 0) + (col.quantityFoil || 0))) : 0;
    const currentMarketUsd = card ? effectivePrice(card) : null;
    return {
      productId: pid,
      quantity: Number(item.quantity || 1),
      unitMarketUsd: clampUsd(item.unitMarketUsd || 0),
      unitCostUsd:
        item.unitCostUsd !== null && item.unitCostUsd !== undefined ? clampUsd(item.unitCostUsd) : null,
      condition: item.condition || "NM",
      name: card?.name || `#${pid}`,
      cardNumber: card?.cardNumber || "",
      editionName: card?.editionName || "",
      editionAbbr: card?.editionAbbr || "",
      rarity: card?.rarity || "",
      color: card?.color || "",
      cardType: card?.cardType || "",
      imageUrl: card?.imageUrl || "",
      itemCategory: card?.itemCategory || "card",
      currentMarketUsd: currentMarketUsd !== null && currentMarketUsd !== undefined ? clampUsd(currentMarketUsd) : null,
      ownedQuantity: have,
      isWishlist: Boolean(col?.isWishlist),
      wishlistTargetQty: Number(col?.wishlistTargetQty || 1),
    };
  }

  function enrichTradeDetail(trade) {
    const itemsIn = (trade.itemsIn || []).map(enrichTradeItemDetail);
    const itemsOut = (trade.itemsOut || []).map(enrichTradeItemDetail);
    const cashPaidUsd = clampUsd(trade.cashPaidUsd || 0);
    const cashReceivedUsd = clampUsd(trade.cashReceivedUsd || 0);

    const inValueAtDealUsd = round2(itemsIn.reduce((s, i) => s + i.quantity * i.unitMarketUsd, 0));
    const outValueAtDealUsd = round2(itemsOut.reduce((s, i) => s + i.quantity * i.unitMarketUsd, 0));
    const inTotalAtDeal = inValueAtDealUsd + cashReceivedUsd;
    const outTotalAtDeal = outValueAtDealUsd + cashPaidUsd;
    const dealBalanceUsd = round2(inTotalAtDeal - outTotalAtDeal);
    const dealRoiPct = computeTradeRoiPct(dealBalanceUsd, inTotalAtDeal, outTotalAtDeal);
    const verdictAtDeal = classifyTradeVerdict(dealBalanceUsd, dealRoiPct);

    const inValueNowUsd = round2(
      itemsIn.reduce((s, i) => s + i.quantity * (i.currentMarketUsd ?? i.unitMarketUsd), 0)
    );
    const outValueNowUsd = round2(
      itemsOut.reduce((s, i) => s + i.quantity * (i.currentMarketUsd ?? i.unitMarketUsd), 0)
    );
    const inTotalNow = inValueNowUsd + cashReceivedUsd;
    const outTotalNow = outValueNowUsd + cashPaidUsd;
    const currentBalanceUsd = round2(inTotalNow - outTotalNow);
    const currentRoiPct = computeTradeRoiPct(currentBalanceUsd, inTotalNow, outTotalNow);
    const verdictNow = classifyTradeVerdict(currentBalanceUsd, currentRoiPct);

    let outCostBasisUsd = null;
    let realizedProfitUsd = null;
    if (itemsOut.length > 0 && itemsOut.every((i) => i.unitCostUsd !== null && i.unitCostUsd !== undefined)) {
      outCostBasisUsd = round2(itemsOut.reduce((s, i) => s + i.quantity * Number(i.unitCostUsd || 0), 0));
      realizedProfitUsd = round2((cashReceivedUsd + inValueAtDealUsd) - cashPaidUsd - outCostBasisUsd);
    }

    return {
      id: trade.id,
      type: trade.type || "trade",
      date: trade.date || "",
      counterparty: trade.counterparty || "",
      notes: trade.notes || "",
      currencyInput: trade.currencyInput || "USD",
      exchangeRateUsed: Number(trade.exchangeRateUsed || activeRate?.rateClpPerUsd || 1000),
      cashPaidUsd,
      cashReceivedUsd,
      cashPaidOriginal: clampOriginalCash(trade.cashPaidOriginal ?? cashPaidUsd),
      cashReceivedOriginal: clampOriginalCash(trade.cashReceivedOriginal ?? cashReceivedUsd),
      itemsIn,
      itemsOut,
      appliedToCollection: Boolean(trade.appliedToCollection),
      wishlistFulfilledIds: Array.isArray(trade.wishlistFulfilledIds) ? trade.wishlistFulfilledIds : [],
      inValueAtDealUsd,
      outValueAtDealUsd,
      dealBalanceUsd,
      dealRoiPct,
      verdictAtDeal,
      inValueNowUsd,
      outValueNowUsd,
      currentBalanceUsd,
      currentRoiPct,
      verdictNow,
      outCostBasisUsd,
      realizedProfitUsd,
      createdAt: trade.createdAt || "",
      updatedAt: trade.updatedAt || "",
    };
  }

  function formatTradeHighlightLabel(trade) {
    const kind = trade.type === "buy" ? "Compra" : trade.type === "sell" ? "Venta" : "Intercambio";
    const head = (trade.itemsIn?.[0] || trade.itemsOut?.[0])?.name || "Movimiento";
    return trade.counterparty ? `${kind}: ${head} (${trade.counterparty})` : `${kind}: ${head}`;
  }

  function computeTradesSummary(items) {
    const totalTrades = items.length;
    let buyCount = 0;
    let sellCount = 0;
    let tradeCount = 0;
    let totalCashPaidUsd = 0;
    let totalCashReceivedUsd = 0;
    let netWorthAtDealUsd = 0;
    let netWorthNowUsd = 0;
    let worthCountNow = 0;
    let fairCountNow = 0;
    let notWorthCountNow = 0;
    let worthCountAtDeal = 0;
    let fairCountAtDeal = 0;
    let notWorthCountAtDeal = 0;
    let wishlistFulfilledTotal = 0;
    let bestTrade = null;

    for (const t of items) {
      if (t.type === "buy") buyCount += 1;
      else if (t.type === "sell") sellCount += 1;
      else tradeCount += 1;

      totalCashPaidUsd += t.cashPaidUsd;
      totalCashReceivedUsd += t.cashReceivedUsd;
      netWorthAtDealUsd += t.dealBalanceUsd;
      netWorthNowUsd += t.currentBalanceUsd;
      wishlistFulfilledTotal += (t.wishlistFulfilledIds || []).length;

      if (t.verdictNow === "worth") worthCountNow += 1;
      else if (t.verdictNow === "not_worth") notWorthCountNow += 1;
      else fairCountNow += 1;

      if (t.verdictAtDeal === "worth") worthCountAtDeal += 1;
      else if (t.verdictAtDeal === "not_worth") notWorthCountAtDeal += 1;
      else fairCountAtDeal += 1;

      if (!bestTrade || t.currentBalanceUsd > bestTrade.currentBalanceUsd) {
        bestTrade = t;
      }
    }

    return {
      totalTrades,
      buyCount,
      sellCount,
      tradeCount,
      totalCashPaidUsd: round2(totalCashPaidUsd),
      totalCashReceivedUsd: round2(totalCashReceivedUsd),
      netCashflowUsd: round2(totalCashReceivedUsd - totalCashPaidUsd),
      netWorthAtDealUsd: round2(netWorthAtDealUsd),
      netWorthNowUsd: round2(netWorthNowUsd),
      worthCountNow,
      fairCountNow,
      notWorthCountNow,
      worthCountAtDeal,
      fairCountAtDeal,
      notWorthCountAtDeal,
      worthRateNowPct: totalTrades > 0 ? round2((worthCountNow / totalTrades) * 100) : 0,
      worthRateAtDealPct: totalTrades > 0 ? round2((worthCountAtDeal / totalTrades) * 100) : 0,
      wishlistFulfilledTotal,
      bestTradeId: bestTrade ? bestTrade.id : null,
      bestTradeLabel: bestTrade ? formatTradeHighlightLabel(bestTrade) : null,
      bestTradeGainUsd: bestTrade ? bestTrade.currentBalanceUsd : null,
    };
  }

  function attachFirestoreListeners(uid) {
    clearSnapshotListeners();
    if (!db || !fbFsMod) return;
    const { collection, doc, onSnapshot } = fbFsMod;

    const colRef = collection(db, "users", uid, "collection");
    const unsubCol = onSnapshot(
      colRef,
      (snap) => {
        const nextMap = new Map();
        snap.forEach((d) => {
          const data = d.data();
          const pid = Number(data.productId || d.id);
          const qty = Number(data.quantity ?? ((data.quantityNormal || 0) + (data.quantityFoil || 0)));
          nextMap.set(pid, {
            productId: pid,
            quantityNormal: qty,
            quantityFoil: 0,
            quantity: qty,
            condition: data.condition || "NM",
            language: data.language || "EN",
            purchasePrice: data.purchasePrice ?? null,
            isFavorite: Boolean(data.isFavorite),
            isWishlist: Boolean(data.isWishlist),
            wishlistTargetQty: Number(data.wishlistTargetQty || 1),
            notes: data.notes || "",
            updatedAt: data.updatedAt || "",
          });
        });
        collectionMap = nextMap;
        window.onCloudDataChanged?.();
      },
      (err) => console.error("Firestore collection listener error:", err)
    );

    const decksRef = collection(db, "users", uid, "decks");
    const unsubDecks = onSnapshot(
      decksRef,
      (snap) => {
        const list = [];
        snap.forEach((d) => {
          const data = d.data();
          list.push({
            id: Number(d.id) || d.id,
            rawId: d.id,
            name: data.name || "Mazo",
            oshiProductId: data.oshiProductId ?? null,
            description: data.description || "",
            cards: Array.isArray(data.cards) ? data.cards : [],
            createdAt: data.createdAt || "",
            updatedAt: data.updatedAt || "",
          });
        });
        list.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
        decksList = list;
        window.onCloudDataChanged?.();
      },
      (err) => console.error("Firestore decks listener error:", err)
    );

    const rateRef = doc(db, "users", uid, "settings", "exchangeRate");
    const unsubRate = onSnapshot(
      rateRef,
      (snap) => {
        if (snap.exists()) {
          personalRate = snap.data();
          refreshActiveRate();
          window.onCloudDataChanged?.();
        }
      },
      (err) => console.error("Firestore settings listener error:", err)
    );

    const tradesRef = collection(db, "users", uid, "trades");
    const unsubTrades = onSnapshot(
      tradesRef,
      (snap) => {
        const list = [];
        snap.forEach((d) => {
          const data = d.data() || {};
          list.push({
            id: Number(d.id) || d.id,
            rawId: d.id,
            ...data,
          });
        });
        list.sort((a, b) => {
          const da = String(a.date || "");
          const dbv = String(b.date || "");
          if (dbv !== da) return dbv.localeCompare(da);
          return String(b.createdAt || "").localeCompare(String(a.createdAt || ""));
        });
        tradesList = list;
        window.onCloudDataChanged?.();
      },
      (err) => console.error("Firestore trades listener error:", err)
    );

    unsubs.push(unsubCol, unsubDecks, unsubRate, unsubTrades);
  }

  async function migrateGuestCollectionToCloud(uid) {
    if (!db || !fbFsMod) return;
    const { collection, getDocs, getDoc, doc, setDoc } = fbFsMod;

    try {
      const rawCol = localStorage.getItem(LS_COLLECTION);
      if (rawCol) {
        const guestItems = JSON.parse(rawCol);
        if (Array.isArray(guestItems) && guestItems.length) {
          const existingSnap = await getDocs(collection(db, "users", uid, "collection"));
          if (existingSnap.empty) {
            for (const item of guestItems) {
              const docPayload = toFirestoreCollectionDoc(item);
              await setDoc(doc(db, "users", uid, "collection", String(docPayload.productId)), docPayload);
            }
          }
        }
        localStorage.removeItem(LS_COLLECTION);
      }
    } catch (err) {
      console.warn("Guest collection migration warning:", err);
    }

    try {
      const rawDecks = localStorage.getItem(LS_DECKS);
      if (rawDecks) {
        const guestDecks = JSON.parse(rawDecks);
        if (Array.isArray(guestDecks) && guestDecks.length) {
          const existingSnap = await getDocs(collection(db, "users", uid, "decks"));
          const existingIds = new Set();
          existingSnap.forEach((d) => existingIds.add(d.id));
          for (const gDeck of guestDecks) {
            const docId = String(gDeck.rawId || gDeck.id || Date.now());
            if (!existingIds.has(docId)) {
              const docPayload = toFirestoreDeckDoc(gDeck);
              await setDoc(doc(db, "users", uid, "decks", docId), docPayload);
            }
          }
        }
        localStorage.removeItem(LS_DECKS);
      }
    } catch (err) {
      console.warn("Guest decks migration warning:", err);
    }

    try {
      const rawTrades = localStorage.getItem(LS_TRADES);
      if (rawTrades) {
        const guestTrades = JSON.parse(rawTrades);
        if (Array.isArray(guestTrades) && guestTrades.length) {
          const existingSnap = await getDocs(collection(db, "users", uid, "trades"));
          const existingIds = new Set();
          existingSnap.forEach((d) => existingIds.add(d.id));
          for (const gTrade of guestTrades) {
            const docId = String(gTrade.rawId || gTrade.id || Date.now());
            if (!existingIds.has(docId)) {
              const docPayload = toFirestoreTradeDoc(gTrade);
              if (docPayload.itemsIn.length > 0 || docPayload.itemsOut.length > 0) {
                await setDoc(doc(db, "users", uid, "trades", docId), docPayload);
              }
            }
          }
        }
        localStorage.removeItem(LS_TRADES);
      }
    } catch (err) {
      console.warn("Guest trades migration warning:", err);
    }

    try {
      const rawRate = localStorage.getItem(LS_RATE);
      if (rawRate) {
        const guestRate = JSON.parse(rawRate);
        if (guestRate && Number(guestRate.rateClpPerUsd) > 0) {
          const rateRef = doc(db, "users", uid, "settings", "exchangeRate");
          const snap = await getDoc(rateRef);
          if (!snap.exists()) {
            await setDoc(rateRef, {
              rateClpPerUsd: Math.round(Number(guestRate.rateClpPerUsd) * 100) / 100,
              source: String(guestRate.source || "Manual").slice(0, 120),
              observedDate: String(guestRate.observedDate || new Date().toISOString().slice(0, 10)).slice(0, 64),
              updatedAt: String(guestRate.updatedAt || new Date().toISOString()).slice(0, 64),
            });
          }
        }
        localStorage.removeItem(LS_RATE);
      }
    } catch (err) {
      console.warn("Guest rate migration warning:", err);
    }
  }

  async function initFirebaseSdk() {
    if (!window.FIREBASE_CONFIG) return;
    try {
      const mods = await ensureFirebaseModules();
      if (!mods || !mods.auth || !mods.fbAuthMod) return;
      if (initFirebaseSdk._bound) return;
      initFirebaseSdk._bound = true;

      await new Promise((resolve) => {
        let settled = false;
        mods.fbAuthMod.onAuthStateChanged(mods.auth, async (user) => {
          currentUser = user;
          if (user) {
            await migrateGuestCollectionToCloud(user.uid);
            attachFirestoreListeners(user.uid);
          } else {
            clearSnapshotListeners();
            personalRate = null;
            collectionMap = new Map();
            decksList = [];
            tradesList = [];
            if (useCloudBackend) loadGuestStateFromStorage();
            else refreshActiveRate();
          }
          if (!isCurrentUserAdmin()) {
            auditReport = {};
          }
          window.onFirebaseAuthChanged?.(user);
          if (!settled) {
            settled = true;
            resolve();
          } else {
            window.onCloudDataChanged?.();
          }
        });
      });
    } catch (err) {
      console.warn("Firebase SDK unavailable (running offline/local):", err.message || err);
    }
  }

  function joinCardWithCollection(card) {
    const col = collectionMap.get(Number(card.productId));
    const qty = col ? Number(col.quantity ?? ((col.quantityNormal || 0) + (col.quantityFoil || 0))) : 0;
    return {
      ...card,
      quantityNormal: qty,
      quantityFoil: 0,
      totalOwned: qty,
      condition: col?.condition || "NM",
      language: col?.language || "EN",
      purchasePrice: col?.purchasePrice ?? null,
      isFavorite: Boolean(col?.isFavorite),
      isWishlist: Boolean(col?.isWishlist),
      wishlistTargetQty: Number(col?.wishlistTargetQty || 1),
      notes: col?.notes || "",
      updatedAt: col?.updatedAt || null,
    };
  }

  function computeKpis() {
    const catalogTotalCards = cardsList.filter((c) => c.itemCategory === "card").length;
    const catalogTotalSealed = cardsList.filter((c) => c.itemCategory === "sealed").length;

    let ownedUniqueCards = 0;
    let ownedNormalCopies = 0;
    let ownedFoilCopies = 0;
    let collectionMarketValueUsd = 0;
    let collectionCostBasisUsd = 0;
    let favoritesCount = 0;
    let wishlistCount = 0;
    let highRarityOwnedCopies = 0;
    let topOwnedCard = null;
    let topPrice = -1;

    const colorMap = new Map();
    const rarityMap = new Map();

    for (const c of cardsList) {
      const col = collectionMap.get(Number(c.productId));
      const qty = col ? Number(col.quantity ?? ((col.quantityNormal || 0) + (col.quantityFoil || 0))) : 0;
      const price = effectivePrice(c) ?? 0;

      if (c.itemCategory === "card") {
        const cg = !c.color ? "Sin color" : c.color.includes("/") ? "Multi-color" : c.color;
        if (!colorMap.has(cg)) {
          colorMap.set(cg, { color: cg, catalogCount: 0, ownedUnique: 0, ownedCopies: 0 });
        }
        const cEntry = colorMap.get(cg);
        cEntry.catalogCount += 1;
        if (qty > 0) {
          cEntry.ownedUnique += 1;
          cEntry.ownedCopies += qty;
        }

        if (c.rarity) {
          if (!rarityMap.has(c.rarity)) {
            rarityMap.set(c.rarity, {
              rarity: c.rarity,
              rarityName: c.rarityName || c.rarity,
              catalogCount: 0,
              ownedUnique: 0,
              ownedCopies: 0,
            });
          }
          const rEntry = rarityMap.get(c.rarity);
          rEntry.catalogCount += 1;
          if (qty > 0) {
            rEntry.ownedUnique += 1;
            rEntry.ownedCopies += qty;
          }
        }
      }

      if (col) {
        if (col.isFavorite) favoritesCount += 1;
        if (col.isWishlist) wishlistCount += 1;
      }

      if (qty > 0) {
        if (c.itemCategory === "card") ownedUniqueCards += 1;
        if (isCardFoil(c)) ownedFoilCopies += qty;
        else ownedNormalCopies += qty;
        if (HIGH_RARITIES.has(c.rarity)) highRarityOwnedCopies += qty;
        collectionMarketValueUsd += qty * price;
        if (col && col.purchasePrice !== null && col.purchasePrice !== undefined) {
          collectionCostBasisUsd += Number(col.purchasePrice) * qty;
        }
        if (price > topPrice) {
          topPrice = price;
          topOwnedCard = {
            productId: c.productId,
            name: c.name,
            cardNumber: c.cardNumber || "",
            rarity: c.rarity || "",
            marketPrice: price,
            imageUrl: c.imageUrl || "",
          };
        }
      }
    }

    const ownedTotalCopies = ownedNormalCopies + ownedFoilCopies;
    const completionPct = catalogTotalCards > 0 ? (ownedUniqueCards / catalogTotalCards) * 100 : 0;
    const netGainUsd = collectionCostBasisUsd > 0 ? collectionMarketValueUsd - collectionCostBasisUsd : 0;

    return {
      totalEditions: editionsList.length,
      catalogTotalCards,
      catalogTotalSealed,
      ownedUniqueCards,
      completionPct,
      ownedTotalCopies,
      ownedNormalCopies,
      ownedFoilCopies,
      collectionMarketValueUsd,
      collectionCostBasisUsd,
      netGainUsd,
      favoritesCount,
      wishlistCount,
      highRarityOwnedCopies,
      topOwnedCard,
      colorBreakdown: Array.from(colorMap.values()).sort((a, b) => b.catalogCount - a.catalogCount),
      rarityBreakdown: Array.from(rarityMap.values()).sort(
        (a, b) => (RARITY_ORDER[a.rarity] || 99) - (RARITY_ORDER[b.rarity] || 99)
      ),
      exchangeRate: activeRate,
      lastSyncedAt: new Date().toISOString(),
    };
  }

  function computeEditionsStats() {
    const byGroup = new Map();
    for (const ed of editionsList) {
      byGroup.set(Number(ed.groupId), {
        groupId: Number(ed.groupId),
        name: ed.name,
        abbreviation: ed.abbreviation || "",
        isSupplemental: Boolean(ed.isSupplemental),
        publishedOn: ed.publishedOn || "",
        totalCards: 0,
        totalSealed: 0,
        ownedUniqueCards: 0,
        ownedTotalCopies: 0,
        completionPct: 0,
        collectionValueUsd: 0,
        setTotalValueUsd: 0,
      });
    }

    for (const c of cardsList) {
      const ed = byGroup.get(Number(c.groupId));
      if (!ed) continue;
      const col = collectionMap.get(Number(c.productId));
      const qty = col ? Number(col.quantity ?? ((col.quantityNormal || 0) + (col.quantityFoil || 0))) : 0;
      const price = effectivePrice(c) ?? 0;

      if (c.itemCategory === "card") {
        ed.totalCards += 1;
        ed.setTotalValueUsd += price;
        if (qty > 0) {
          ed.ownedUniqueCards += 1;
          ed.ownedTotalCopies += qty;
        }
      } else {
        ed.totalSealed += 1;
      }
      ed.collectionValueUsd += qty * price;
    }

    return Array.from(byGroup.values()).map((ed) => ({
      ...ed,
      completionPct: ed.totalCards > 0 ? (ed.ownedUniqueCards / ed.totalCards) * 100 : 0,
    }));
  }

  function isLimitedSupportCard(card) {
    if (!card || card.cardType !== "Support") return false;
    return /(?:^|\r?\n)\s*LIMITED\s*:/i.test(String(card.effectText || ""));
  }

  function queryCards(searchParams) {
    const q = (searchParams.get("q") || "").trim().toLowerCase();
    const groupId = searchParams.get("group_id");
    const color = (searchParams.get("color") || "").trim();
    const rarity = (searchParams.get("rarity") || "").trim();
    const cardType = (searchParams.get("card_type") || "").trim();
    const bloomLevel = (searchParams.get("bloom_level") || "").trim();
    const itemCategory = (searchParams.get("item_category") || "card").trim() || "card";
    const ownership = (searchParams.get("ownership") || "all").trim();
    const deckZone = (searchParams.get("deck_zone") || "").trim();
    const parallel = (searchParams.get("parallel") || "all").trim();
    const limitedOnlyRaw = (searchParams.get("limited_only") || "").trim().toLowerCase();
    const limitedOnly = limitedOnlyRaw === "1" || limitedOnlyRaw === "true";
    const minPriceRaw = searchParams.get("min_price");
    const maxPriceRaw = searchParams.get("max_price");
    const sort = searchParams.get("sort") || "price_desc";

    const filtered = [];
    for (const c of cardsList) {
      if (itemCategory !== "all" && c.itemCategory !== itemCategory) continue;
      if (groupId && Number(c.groupId) !== Number(groupId)) continue;
      if (deckZone === "oshi" && c.cardType !== "Oshi Holomem") continue;
      if (deckZone === "main" && c.cardType !== "Holomem" && c.cardType !== "Buzz Holomem" && c.cardType !== "Support") continue;
      if (deckZone === "cheer" && c.cardType !== "Cheer") continue;
      if (parallel === "base" && PARALLEL_RARITIES.has(c.rarity)) continue;
      if (parallel === "only" && !PARALLEL_RARITIES.has(c.rarity)) continue;
      if (limitedOnly && !isLimitedSupportCard(c)) continue;
      if (q) {
        const hay = `${c.name} ${c.cardNumber} ${c.effectText} ${c.tags} ${c.editionName}`.toLowerCase();
        if (!hay.includes(q)) continue;
      }
      if (color) {
        if (color.toLowerCase() === "colorless") {
          if (c.color !== "Colorless" && c.color !== "") continue;
        } else if (!String(c.color || "").toLowerCase().includes(color.toLowerCase())) {
          continue;
        }
      }
      if (rarity && c.rarity !== rarity) continue;
      if (cardType) {
        if (cardType === "Holomem") {
          if (c.cardType !== "Holomem" && c.cardType !== "Buzz Holomem") continue;
        } else if (c.cardType !== cardType) {
          continue;
        }
      }
      if (bloomLevel && c.bloomLevel !== bloomLevel) continue;

      const priceVal = effectivePrice(c) ?? 0;
      if (minPriceRaw !== null && minPriceRaw !== "" && priceVal < Number(minPriceRaw)) continue;
      if (maxPriceRaw !== null && maxPriceRaw !== "" && priceVal > Number(maxPriceRaw)) continue;

      const full = joinCardWithCollection(c);
      if (ownership === "owned" && full.totalOwned <= 0) continue;
      if (ownership === "missing" && full.totalOwned > 0) continue;
      if (ownership === "favorite" && !full.isFavorite) continue;
      if (ownership === "wishlist" && !full.isWishlist) continue;

      filtered.push(full);
    }

    filtered.sort((a, b) => {
      const pa = effectivePrice(a);
      const pb = effectivePrice(b);
      if (sort === "price_asc") {
        return (pa ?? 9999999) - (pb ?? 9999999) || a.name.localeCompare(b.name);
      }
      if (sort === "number_asc") {
        const na = a.cardNumber || "\uffff";
        const nb = b.cardNumber || "\uffff";
        return na.localeCompare(nb) || a.name.localeCompare(b.name);
      }
      if (sort === "number_desc") {
        return (b.cardNumber || "").localeCompare(a.cardNumber || "") || a.name.localeCompare(b.name);
      }
      if (sort === "name_asc") {
        return a.name.localeCompare(b.name) || (a.cardNumber || "").localeCompare(b.cardNumber || "");
      }
      if (sort === "owned_desc") {
        return b.totalOwned - a.totalOwned || (pb ?? -1) - (pa ?? -1);
      }
      if (sort === "rarity_desc") {
        const ra = RARITY_ORDER[a.rarity] || 99;
        const rb = RARITY_ORDER[b.rarity] || 99;
        return ra - rb || (pb ?? -1) - (pa ?? -1);
      }
      // price_desc default
      return (pb ?? -1) - (pa ?? -1) || (a.cardNumber || "").localeCompare(b.cardNumber || "") || a.name.localeCompare(b.name);
    });

    const total = filtered.length;
    const perPage = Math.max(1, Math.min(250, Number(searchParams.get("per_page") || 36)));
    const totalPages = Math.max(1, Math.ceil(total / perPage));
    const page = Math.max(1, Math.min(totalPages, Number(searchParams.get("page") || 1)));
    const offset = (page - 1) * perPage;

    return {
      items: filtered.slice(offset, offset + perPage),
      total,
      page,
      perPage,
      totalPages,
      facets: { colors: [], rarities: [], cardTypes: [], bloomLevels: [] },
    };
  }

  async function persistCollectionEntry(productId, entry) {
    const qty = Math.max(0, Number(entry.quantity ?? ((entry.quantityNormal || 0) + (entry.quantityFoil || 0))));
    const shouldDelete =
      qty === 0 &&
      !entry.isFavorite &&
      !entry.isWishlist &&
      !String(entry.notes || "").trim();

    if (shouldDelete) {
      collectionMap.delete(productId);
      if (currentUser && db && fbFsMod) {
        const { doc, deleteDoc } = fbFsMod;
        await deleteDoc(doc(db, "users", currentUser.uid, "collection", String(productId)));
      } else {
        saveGuestStateToStorage();
      }
      return;
    }

    const docData = toFirestoreCollectionDoc({ ...entry, productId, quantity: qty });
    collectionMap.set(productId, {
      ...docData,
      quantityNormal: qty,
      quantityFoil: 0,
    });

    if (currentUser && db && fbFsMod) {
      const { doc, setDoc } = fbFsMod;
      await setDoc(doc(db, "users", currentUser.uid, "collection", String(productId)), docData);
    } else {
      saveGuestStateToStorage();
    }
  }

  async function saveExchangeRate(rateVal, source, observedDate) {
    const rateObj = {
      rateClpPerUsd: Math.round(Number(rateVal) * 100) / 100,
      source: String(source || "Manual").slice(0, 120),
      observedDate: String(observedDate || new Date().toISOString().slice(0, 10)).slice(0, 64),
      updatedAt: new Date().toISOString().slice(0, 64),
    };
    personalRate = rateObj;
    if (rateObj.source !== "Manual") {
      cloudAutoRate = rateObj;
    }
    refreshActiveRate();
    if (currentUser && db && fbFsMod) {
      const { doc, setDoc } = fbFsMod;
      await setDoc(doc(db, "users", currentUser.uid, "settings", "exchangeRate"), rateObj);
    } else {
      saveGuestStateToStorage();
    }
    return activeRate;
  }

  async function handleRequest(url, options = {}) {
    await ensureCatalogLoaded();
    const method = (options.method || "GET").toUpperCase();
    const parsedUrl = new URL(url, window.location.origin);
    const path = parsedUrl.pathname;
    const body = options.body ? JSON.parse(options.body) : {};

    if (path === "/api/kpis") {
      return computeKpis();
    }
    if (path === "/api/editions") {
      return computeEditionsStats();
    }
    if (path === "/api/cards") {
      return queryCards(parsedUrl.searchParams);
    }
    if (path.startsWith("/api/cards/")) {
      const pid = Number(path.split("/").pop());
      const card = cardsById.get(pid);
      if (!card) throw new Error(`Card ${pid} not found`);
      return joinCardWithCollection(card);
    }
    if (path.startsWith("/api/collection/") && path.endsWith("/adjust") && method === "PATCH") {
      const parts = path.split("/");
      const pid = Number(parts[3]);
      const card = cardsById.get(pid);
      if (!card) throw new Error(`Card ${pid} not found`);
      const existing = joinCardWithCollection(card);
      const delta = Number(body.delta ?? ((body.deltaNormal || 0) + (body.deltaFoil || 0)));
      const nextQty = Math.max(0, existing.totalOwned + delta);
      await persistCollectionEntry(pid, {
        productId: pid,
        quantity: nextQty,
        condition: existing.condition,
        language: existing.language,
        purchasePrice: existing.purchasePrice,
        isFavorite: body.toggleFavorite ? !existing.isFavorite : existing.isFavorite,
        isWishlist: body.toggleWishlist ? !existing.isWishlist : existing.isWishlist,
        wishlistTargetQty: existing.wishlistTargetQty,
        notes: existing.notes,
        updatedAt: new Date().toISOString(),
      });
      return joinCardWithCollection(card);
    }
    if (path === "/api/collection/export") {
      return {
        exportedAt: new Date().toISOString(),
        version: "1.0",
        entries: Array.from(collectionMap.values()),
      };
    }
    if (path === "/api/collection/import" && method === "POST") {
      let imported = 0;
      let skipped = 0;
      for (const entry of body.entries || []) {
        const pid = Number(entry.productId);
        if (!cardsById.has(pid)) {
          skipped += 1;
          continue;
        }
        await persistCollectionEntry(pid, entry);
        imported += 1;
      }
      return { imported, skipped };
    }
    if (path.startsWith("/api/collection/") && method === "POST") {
      const pid = Number(path.split("/").pop());
      const card = cardsById.get(pid);
      if (!card) throw new Error(`Card ${pid} not found`);
      const existing = joinCardWithCollection(card);
      const nextQty =
        body.quantity !== undefined && body.quantity !== null
          ? Math.max(0, Number(body.quantity))
          : body.quantityNormal !== undefined || body.quantityFoil !== undefined
            ? Math.max(0, Number(body.quantityNormal || 0) + Number(body.quantityFoil || 0))
            : existing.totalOwned;
      await persistCollectionEntry(pid, {
        productId: pid,
        quantity: nextQty,
        condition: body.condition ?? existing.condition,
        language: body.language ?? existing.language,
        purchasePrice: body.purchasePrice !== undefined ? body.purchasePrice : existing.purchasePrice,
        isFavorite: body.isFavorite ?? existing.isFavorite,
        isWishlist: body.isWishlist ?? existing.isWishlist,
        wishlistTargetQty: body.wishlistTargetQty ?? existing.wishlistTargetQty,
        notes: body.notes ?? existing.notes,
        updatedAt: new Date().toISOString(),
      });
      return joinCardWithCollection(card);
    }
    if (path === "/api/audit") {
      if (!isCurrentUserAdmin()) {
        throw new Error("Acceso denegado: solo el administrador puede consultar la auditoría.");
      }
      const report = await loadAuditReportForAdmin();
      return {
        syncedAt: catalogSyncInfo.pricesUpdatedAt || catalogSyncInfo.catalogUpdatedAt || new Date().toISOString(),
        source: catalogSyncInfo.source,
        catalogUpdatedAt: catalogSyncInfo.catalogUpdatedAt || "",
        pricesUpdatedAt: catalogSyncInfo.pricesUpdatedAt || "",
        report,
      };
    }
    if (path === "/api/resync" && method === "POST") {
      if (!isCurrentUserAdmin()) {
        throw new Error("Acceso denegado: solo el administrador puede resincronizar el catálogo.");
      }
      catalogLoaded = false;
      auditReport = {};
      await ensureCatalogLoaded(true);
      await loadAuditReportForAdmin(true);
      return {
        editionsSynced: editionsList.length,
        cardsSynced: cardsList.length,
        skippedAlreadyPopulated: false,
        source: catalogSyncInfo.source,
        syncedAt: catalogSyncInfo.pricesUpdatedAt || new Date().toISOString(),
      };
    }
    if (path === "/api/exchange-rate" && method === "GET") {
      return activeRate;
    }
    if (path === "/api/exchange-rate" && method === "PUT") {
      return saveExchangeRate(body.rateClpPerUsd, body.source, body.observedDate);
    }
    if (path === "/api/exchange-rate/refresh" && method === "POST") {
      await syncExchangeRateFromMetadata();
      return activeRate;
    }
    if (path === "/api/decks" && method === "GET") {
      return decksList.map((d) => {
        const oshi = d.oshiProductId ? cardsById.get(Number(d.oshiProductId)) : null;
        let mainCount = 0;
        let cheerCount = 0;
        let total = oshi ? 1 : 0;
        let owned = 0;
        let estCost = oshi ? (effectivePrice(oshi) ?? 0) : 0;
        let missingCost = 0;
        if (oshi) {
          const ocol = collectionMap.get(Number(oshi.productId));
          const oHave = ocol ? Number(ocol.quantity ?? ((ocol.quantityNormal || 0) + (ocol.quantityFoil || 0))) : 0;
          if (oHave > 0) owned += 1;
          else missingCost += effectivePrice(oshi) ?? 0;
        }
        for (const item of d.cards || []) {
          const q = Number(item.quantity || 0);
          total += q;
          if (item.zone === "cheer") cheerCount += q;
          else mainCount += q;
          const col = collectionMap.get(Number(item.productId));
          const have = col ? Number(col.quantity ?? ((col.quantityNormal || 0) + (col.quantityFoil || 0))) : 0;
          owned += Math.min(q, have);
          const card = cardsById.get(Number(item.productId));
          if (card) {
            const price = effectivePrice(card) ?? 0;
            estCost += q * price;
            missingCost += Math.max(0, q - have) * price;
          }
        }
        return {
          id: d.id,
          name: d.name,
          oshiProductId: d.oshiProductId ?? null,
          oshiName: oshi?.name || null,
          oshiCardNumber: oshi?.cardNumber || null,
          oshiColor: oshi?.color || null,
          oshiImageUrl: oshi?.imageUrl || null,
          description: d.description || "",
          mainCount,
          cheerCount,
          ownedCoveragePct: total > 0 ? (owned / total) * 100 : 0,
          estimatedCostUsd: estCost,
          missingCostUsd: missingCost,
          createdAt: d.createdAt,
          updatedAt: d.updatedAt,
        };
      });
    }
    if (path === "/api/decks" && method === "POST") {
      const id = Date.now();
      const docData = toFirestoreDeckDoc(body);
      const created = { id, rawId: String(id), ...docData };
      if (currentUser && db && fbFsMod) {
        const { doc, setDoc } = fbFsMod;
        await setDoc(doc(db, "users", currentUser.uid, "decks", String(id)), docData);
        decksList = [created, ...decksList.filter((d) => String(d.rawId || d.id) !== String(id))];
      } else {
        decksList.unshift(created);
        saveGuestStateToStorage();
      }
      return enrichDeckDetail(created);
    }
    if (path.startsWith("/api/decks/")) {
      const idStr = decodeURIComponent(path.split("/").pop());
      const deck = decksList.find((d) => String(d.id) === idStr || String(d.rawId) === idStr);
      if (method === "GET") {
        if (!deck) throw new Error(`Deck ${idStr} not found`);
        return enrichDeckDetail(deck);
      }
      if (method === "PUT") {
        if (!deck) throw new Error(`Deck ${idStr} not found`);
        const docData = toFirestoreDeckDoc({ ...body, createdAt: deck.createdAt });
        if (currentUser && db && fbFsMod) {
          const { doc, setDoc } = fbFsMod;
          await setDoc(doc(db, "users", currentUser.uid, "decks", String(deck.rawId || deck.id)), docData);
          Object.assign(deck, docData);
        } else {
          Object.assign(deck, docData);
          saveGuestStateToStorage();
        }
        return enrichDeckDetail({ ...deck, ...docData });
      }
      if (method === "DELETE") {
        const targetRawId = String(deck?.rawId || idStr);
        if (currentUser && db && fbFsMod) {
          const { doc, deleteDoc } = fbFsMod;
          await deleteDoc(doc(db, "users", currentUser.uid, "decks", targetRawId));
          decksList = decksList.filter((d) => String(d.rawId || d.id) !== targetRawId && String(d.id) !== idStr);
        } else {
          decksList = decksList.filter((d) => String(d.id) !== idStr && String(d.rawId) !== idStr);
          saveGuestStateToStorage();
        }
        return { deleted: true };
      }
    }

    if (path === "/api/trades" && method === "GET") {
      const enriched = tradesList
        .map(enrichTradeDetail)
        .sort((a, b) => {
          const da = String(a.date || "");
          const dbv = String(b.date || "");
          if (dbv !== da) return dbv.localeCompare(da);
          return String(b.createdAt || "").localeCompare(String(a.createdAt || ""));
        });
      return {
        summary: computeTradesSummary(enriched),
        items: enriched,
      };
    }

    if (path === "/api/trades" && method === "POST") {
      const id = Date.now();
      const normalizedIn = normalizeTradeItems(body.itemsIn);
      const normalizedOut = normalizeTradeItems(body.itemsOut);
      const tradeType = ["buy", "sell", "trade"].includes(String(body.type || "").trim().toLowerCase())
        ? String(body.type).trim().toLowerCase()
        : "trade";
      if (tradeType === "buy" && normalizedIn.length === 0) {
        throw new Error("Agrega al menos 1 carta recibida en la compra");
      }
      if (tradeType === "sell" && normalizedOut.length === 0) {
        throw new Error("Agrega al menos 1 carta entregada en la venta");
      }
      if (normalizedIn.length === 0 && normalizedOut.length === 0) {
        throw new Error("El movimiento debe incluir al menos 1 carta");
      }

      const applyCol = body.applyToCollection !== false;
      const docData = toFirestoreTradeDoc({
        ...body,
        type: tradeType,
        itemsIn: normalizedIn,
        itemsOut: normalizedOut,
        appliedToCollection: applyCol,
        wishlistFulfilledIds: [],
      });

      if (applyCol) {
        await applyTradeToCollection(docData);
      }

      const created = { id, rawId: String(id), ...docData };
      if (currentUser && db && fbFsMod) {
        const { doc, setDoc } = fbFsMod;
        await setDoc(doc(db, "users", currentUser.uid, "trades", String(id)), docData);
        tradesList = [created, ...tradesList.filter((t) => String(t.rawId || t.id) !== String(id))];
      } else {
        tradesList.unshift(created);
        saveGuestStateToStorage();
      }
      return {
        trade: enrichTradeDetail(created),
        wishlistFulfilledCount: (docData.wishlistFulfilledIds || []).length,
      };
    }

    if (path.startsWith("/api/trades/")) {
      const idStr = decodeURIComponent(path.split("/").pop());
      const existing = tradesList.find((t) => String(t.id) === idStr || String(t.rawId) === idStr);
      if (method === "PUT") {
        if (!existing) throw new Error(`Trade ${idStr} not found`);
        const normalizedIn = normalizeTradeItems(body.itemsIn);
        const normalizedOut = normalizeTradeItems(body.itemsOut);
        const tradeType = ["buy", "sell", "trade"].includes(String(body.type || "").trim().toLowerCase())
          ? String(body.type).trim().toLowerCase()
          : "trade";
        if (tradeType === "buy" && normalizedIn.length === 0) {
          throw new Error("Agrega al menos 1 carta recibida en la compra");
        }
        if (tradeType === "sell" && normalizedOut.length === 0) {
          throw new Error("Agrega al menos 1 carta entregada en la venta");
        }
        if (normalizedIn.length === 0 && normalizedOut.length === 0) {
          throw new Error("El movimiento debe incluir al menos 1 carta");
        }

        if (existing.appliedToCollection) {
          await revertTradeFromCollection(existing);
        }

        const applyCol = body.applyToCollection !== false;
        const docData = toFirestoreTradeDoc({
          ...body,
          type: tradeType,
          itemsIn: normalizedIn,
          itemsOut: normalizedOut,
          appliedToCollection: applyCol,
          wishlistFulfilledIds: [],
          createdAt: existing.createdAt,
        });

        if (applyCol) {
          await applyTradeToCollection(docData);
        }

        const targetRawId = String(existing.rawId || existing.id);
        if (currentUser && db && fbFsMod) {
          const { doc, setDoc } = fbFsMod;
          await setDoc(doc(db, "users", currentUser.uid, "trades", targetRawId), docData);
          Object.assign(existing, docData);
        } else {
          Object.assign(existing, docData);
          saveGuestStateToStorage();
        }
        return {
          trade: enrichTradeDetail({ ...existing, ...docData }),
          wishlistFulfilledCount: (docData.wishlistFulfilledIds || []).length,
        };
      }
      if (method === "DELETE") {
        const revert = parsedUrl.searchParams.get("revert") !== "false";
        let reverted = false;
        if (revert && existing && existing.appliedToCollection) {
          reverted = await revertTradeFromCollection(existing);
        }
        const targetRawId = String(existing?.rawId || idStr);
        if (currentUser && db && fbFsMod) {
          const { doc, deleteDoc } = fbFsMod;
          await deleteDoc(doc(db, "users", currentUser.uid, "trades", targetRawId));
          tradesList = tradesList.filter((t) => String(t.rawId || t.id) !== targetRawId && String(t.id) !== idStr);
        } else {
          tradesList = tradesList.filter((t) => String(t.id) !== idStr && String(t.rawId) !== idStr);
          saveGuestStateToStorage();
        }
        return { deleted: true, reverted };
      }
    }

    throw new Error(`Unsupported cloud API route: ${method} ${path}`);
  }

  function formatDeckCardDetail(productId, zone, quantity) {
    const pid = Number(productId);
    const card = cardsById.get(pid);
    const col = collectionMap.get(pid);
    const have = col ? Number(col.quantity ?? ((col.quantityNormal || 0) + (col.quantityFoil || 0))) : 0;
    return {
      productId: pid,
      zone: zone || "main",
      quantity: Number(quantity || 1),
      ownedQuantity: have,
      name: card?.name || `#${pid}`,
      cardNumber: card?.cardNumber || "",
      cardType: card?.cardType || "",
      bloomLevel: card?.bloomLevel || "",
      color: card?.color || "",
      rarity: card?.rarity || "",
      effectText: card?.effectText || "",
      imageUrl: card?.imageUrl || "",
      marketPrice: card ? effectivePrice(card) : null,
    };
  }

  function enrichDeckDetail(deck) {
    const oshiProductId = deck.oshiProductId ? Number(deck.oshiProductId) : null;
    return {
      id: deck.id,
      name: deck.name,
      oshiProductId,
      oshiCard: oshiProductId ? formatDeckCardDetail(oshiProductId, "oshi", 1) : null,
      description: deck.description || "",
      cards: (deck.cards || []).map((item) => formatDeckCardDetail(item.productId, item.zone, item.quantity)),
      createdAt: deck.createdAt || "",
      updatedAt: deck.updatedAt || "",
    };
  }

  async function signInWithGoogle() {
    if (!auth || !fbAuthMod) {
      throw new Error("Firebase Auth no está inicializado aún.");
    }
    const provider = new fbAuthMod.GoogleAuthProvider();
    try {
      const result = await fbAuthMod.signInWithPopup(auth, provider);
      return result.user;
    } catch (err) {
      if (err && (err.code === "auth/popup-blocked" || err.code === "auth/operation-not-supported-in-this-environment")) {
        await fbAuthMod.signInWithRedirect(auth, provider);
        return null;
      }
      throw err;
    }
  }

  async function signOutUser() {
    if (!auth || !fbAuthMod) return;
    await fbAuthMod.signOut(auth);
  }

  async function pushLocalCollectionToFirestore(entries) {
    if (!currentUser || !db || !fbFsMod) {
      throw new Error("Inicia sesión con Google primero para sincronizar con Firestore.");
    }
    const { doc, setDoc } = fbFsMod;
    let pushed = 0;
    for (const entry of entries || []) {
      const docData = toFirestoreCollectionDoc(entry);
      await setDoc(doc(db, "users", currentUser.uid, "collection", String(docData.productId)), docData);
      pushed += 1;
    }
    return pushed;
  }

  async function pushLocalDecksToFirestore(decks) {
    if (!currentUser || !db || !fbFsMod) {
      throw new Error("Inicia sesión con Google primero para sincronizar mazos con Firestore.");
    }
    const { doc, setDoc } = fbFsMod;
    let pushed = 0;
    for (const deck of decks || []) {
      const docId = `local_${deck.id}`;
      const docData = toFirestoreDeckDoc(deck);
      await setDoc(doc(db, "users", currentUser.uid, "decks", docId), docData);
      pushed += 1;
    }
    return pushed;
  }

  async function pushLocalTradesToFirestore(trades) {
    if (!currentUser || !db || !fbFsMod) {
      throw new Error("Inicia sesión con Google primero para sincronizar trading con Firestore.");
    }
    const { doc, setDoc } = fbFsMod;
    let pushed = 0;
    for (const trade of trades || []) {
      const docId = `local_${trade.id}`;
      const docData = toFirestoreTradeDoc(trade);
      if (docData.itemsIn.length > 0 || docData.itemsOut.length > 0) {
        await setDoc(doc(db, "users", currentUser.uid, "trades", docId), docData);
        pushed += 1;
      }
    }
    return pushed;
  }

  const initPromise = (async () => {
    await detectRuntimeMode();
    if (useCloudBackend) {
      loadGuestStateFromStorage();
      await Promise.all([ensureCatalogLoaded(), initFirebaseSdk()]);
    } else {
      // On local Rust server, initialize Firebase SDK softly in background for optional cloud sync
      initFirebaseSdk();
    }
  })();

  window.HololiveCloudBackend = {
    initPromise,
    isCloudMode: () => useCloudBackend,
    getCurrentUser: () => currentUser,
    getUserRole,
    isAdmin: isCurrentUserAdmin,
    getCatalogSyncInfo: () => ({ ...catalogSyncInfo }),
    signInWithGoogle,
    signOutUser,
    pushLocalCollectionToFirestore,
    pushLocalDecksToFirestore,
    pushLocalTradesToFirestore,
    handleRequest,
  };
})();
