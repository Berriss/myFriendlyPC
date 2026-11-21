(() => {
  const FOIL_RARITIES = new Set(["R", "RR", "OSR", "S", "SY", "SR", "UR", "OUR", "HR", "SEC"]);
  const HIGH_RARITIES = new Set(["SEC", "OUR", "UR", "SR", "S", "SY", "HR"]);
  const RARITY_ORDER = {
    SEC: 1, OUR: 2, OSR: 3, UR: 4, SR: 5, RR: 6,
    S: 7, SY: 8, HR: 9, R: 10, U: 11, C: 12, OC: 13, P: 14,
  };

  const LS_COLLECTION = "hocg-cloud-guest-collection";
  const LS_DECKS = "hocg-cloud-guest-decks";
  const LS_RATE = "hocg-cloud-guest-rate";

  let app = null;
  let auth = null;
  let db = null;
  let fbAuthMod = null;
  let fbFsMod = null;

  let currentUser = null;
  let useCloudBackend = false;
  let catalogLoaded = false;

  let cardsList = [];
  let cardsById = new Map();
  let editionsList = [];
  let auditReport = {};
  let defaultRate = {
    rateClpPerUsd: 1002.07,
    source: "Banco Central de Chile",
    observedDate: new Date().toISOString().slice(0, 10),
    updatedAt: new Date().toISOString(),
  };

  let collectionMap = new Map(); // productId -> CollectionEntry
  let decksList = [];
  let activeRate = { ...defaultRate };
  let unsubs = [];

  function clearSnapshotListeners() {
    unsubs.forEach((fn) => {
      try { fn(); } catch (_) {}
    });
    unsubs = [];
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
      const rawRate = localStorage.getItem(LS_RATE);
      activeRate = rawRate ? JSON.parse(rawRate) : { ...defaultRate };
    } catch (_) {
      collectionMap = new Map();
      decksList = [];
      activeRate = { ...defaultRate };
    }
  }

  function saveGuestStateToStorage() {
    if (currentUser) return;
    localStorage.setItem(LS_COLLECTION, JSON.stringify(Array.from(collectionMap.values())));
    localStorage.setItem(LS_DECKS, JSON.stringify(decksList));
    localStorage.setItem(LS_RATE, JSON.stringify(activeRate));
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

  async function ensureCatalogLoaded() {
    if (catalogLoaded) return;
    const [cardsRes, groupsRes, auditRes, rateRes] = await Promise.all([
      fetch("/data/cards_cleaned.json"),
      fetch("/data/groups.json"),
      fetch("/data/audit_report.json").catch(() => null),
      fetch("/data/exchange_rate.json").catch(() => null),
    ]);

    if (!cardsRes.ok || !groupsRes.ok) {
      throw new Error("No se pudieron cargar los datos estáticos del catálogo (/data/)");
    }

    cardsList = await cardsRes.json();
    cardsById = new Map(cardsList.map((c) => [Number(c.productId), c]));

    const groupsJson = await groupsRes.json();
    editionsList = (groupsJson.results || []).slice().sort((a, b) => {
      const pa = String(a.publishedOn || "");
      const pb = String(b.publishedOn || "");
      if (pb !== pa) return pb.localeCompare(pa);
      return Number(b.groupId) - Number(a.groupId);
    });

    if (auditRes && auditRes.ok) {
      const rawAudit = await auditRes.json();
      auditReport = normalizeAuditReport(rawAudit);
    }
    if (rateRes && rateRes.ok) {
      defaultRate = await rateRes.json();
      if (!localStorage.getItem(LS_RATE) && !currentUser) {
        activeRate = { ...defaultRate };
      }
    }

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
    const now = new Date().toISOString();
    return {
      name: String(deck.name || "Mazo").trim().slice(0, 120) || "Mazo",
      oshiProductId: deck.oshiProductId ? Math.trunc(Number(deck.oshiProductId)) : null,
      description: String(deck.description || "").slice(0, 1000),
      cards: (Array.isArray(deck.cards) ? deck.cards : []).slice(0, 100).map((c) => ({
        productId: Number(c.productId),
        zone: String(c.zone || "main"),
        quantity: Math.max(1, Number(c.quantity || 1)),
      })),
      createdAt: String(deck.createdAt || now).slice(0, 64),
      updatedAt: String(now).slice(0, 64),
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
          activeRate = snap.data();
          window.onCloudDataChanged?.();
        }
      },
      (err) => console.error("Firestore settings listener error:", err)
    );

    unsubs.push(unsubCol, unsubDecks, unsubRate);
  }

  async function migrateGuestCollectionToCloud(uid) {
    if (!db || !fbFsMod) return;
    try {
      const rawCol = localStorage.getItem(LS_COLLECTION);
      if (!rawCol) return;
      const guestItems = JSON.parse(rawCol);
      if (!Array.isArray(guestItems) || !guestItems.length) return;

      const { collection, getDocs, doc, setDoc } = fbFsMod;
      const existingSnap = await getDocs(collection(db, "users", uid, "collection"));
      if (existingSnap.empty) {
        for (const item of guestItems) {
          const docPayload = toFirestoreCollectionDoc(item);
          await setDoc(doc(db, "users", uid, "collection", String(docPayload.productId)), docPayload);
        }
      }
      localStorage.removeItem(LS_COLLECTION);
    } catch (err) {
      console.warn("Guest migration warning:", err);
    }
  }

  async function initFirebaseSdk() {
    if (!window.FIREBASE_CONFIG || app) return;
    try {
      const [appMod, authMod, fsMod] = await Promise.all([
        import("https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js"),
        import("https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js"),
        import("https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js"),
      ]);
      fbAuthMod = authMod;
      fbFsMod = fsMod;
      app = appMod.initializeApp(window.FIREBASE_CONFIG);
      auth = authMod.getAuth(app);
      db = fsMod.getFirestore(app);

      await new Promise((resolve) => {
        let settled = false;
        authMod.onAuthStateChanged(auth, async (user) => {
          currentUser = user;
          if (user) {
            await migrateGuestCollectionToCloud(user.uid);
            attachFirestoreListeners(user.uid);
          } else {
            clearSnapshotListeners();
            if (useCloudBackend) loadGuestStateFromStorage();
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

  function queryCards(searchParams) {
    const q = (searchParams.get("q") || "").trim().toLowerCase();
    const groupId = searchParams.get("group_id");
    const color = (searchParams.get("color") || "").trim();
    const rarity = (searchParams.get("rarity") || "").trim();
    const cardType = (searchParams.get("card_type") || "").trim();
    const bloomLevel = (searchParams.get("bloom_level") || "").trim();
    const itemCategory = (searchParams.get("item_category") || "card").trim() || "card";
    const ownership = (searchParams.get("ownership") || "all").trim();
    const minPriceRaw = searchParams.get("min_price");
    const maxPriceRaw = searchParams.get("max_price");
    const sort = searchParams.get("sort") || "price_desc";

    const filtered = [];
    for (const c of cardsList) {
      if (itemCategory !== "all" && c.itemCategory !== itemCategory) continue;
      if (groupId && Number(c.groupId) !== Number(groupId)) continue;
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
      if (cardType && c.cardType !== cardType) continue;
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
    const perPage = Math.max(1, Math.min(120, Number(searchParams.get("per_page") || 36)));
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
    activeRate = rateObj;
    if (currentUser && db && fbFsMod) {
      const { doc, setDoc } = fbFsMod;
      await setDoc(doc(db, "users", currentUser.uid, "settings", "exchangeRate"), rateObj);
    } else {
      saveGuestStateToStorage();
    }
    return rateObj;
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
      return { syncedAt: new Date().toISOString(), report: auditReport };
    }
    if (path === "/api/resync" && method === "POST") {
      catalogLoaded = false;
      await ensureCatalogLoaded();
      return {
        editionsSynced: editionsList.length,
        cardsSynced: cardsList.length,
        skippedAlreadyPopulated: false,
        syncedAt: new Date().toISOString(),
      };
    }
    if (path === "/api/exchange-rate" && method === "GET") {
      return activeRate;
    }
    if (path === "/api/exchange-rate" && method === "PUT") {
      return saveExchangeRate(body.rateClpPerUsd, body.source, body.observedDate);
    }
    if (path === "/api/exchange-rate/refresh" && method === "POST") {
      return activeRate;
    }
    if (path === "/api/decks" && method === "GET") {
      return decksList.map((d) => {
        const oshi = d.oshiProductId ? cardsById.get(Number(d.oshiProductId)) : null;
        let mainCount = 0;
        let cheerCount = 0;
        let total = 0;
        let owned = 0;
        let estCost = 0;
        for (const item of d.cards || []) {
          const q = Number(item.quantity || 0);
          total += q;
          if (item.zone === "cheer") cheerCount += q;
          else mainCount += q;
          const col = collectionMap.get(Number(item.productId));
          const have = col ? Number(col.quantity ?? ((col.quantityNormal || 0) + (col.quantityFoil || 0))) : 0;
          owned += Math.min(q, have);
          const card = cardsById.get(Number(item.productId));
          if (card) estCost += q * (effectivePrice(card) ?? 0);
        }
        return {
          id: d.id,
          name: d.name,
          oshiProductId: d.oshiProductId ?? null,
          oshiName: oshi?.name || null,
          oshiImageUrl: oshi?.imageUrl || null,
          description: d.description || "",
          mainCount,
          cheerCount,
          ownedCoveragePct: total > 0 ? (owned / total) * 100 : 0,
          estimatedCostUsd: estCost,
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
      } else {
        decksList.unshift(created);
        saveGuestStateToStorage();
      }
      return enrichDeckDetail(created);
    }
    if (path.startsWith("/api/decks/")) {
      const idStr = path.split("/").pop();
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
        } else {
          Object.assign(deck, docData);
          saveGuestStateToStorage();
        }
        return enrichDeckDetail({ ...deck, ...docData });
      }
      if (method === "DELETE") {
        if (currentUser && db && fbFsMod) {
          const { doc, deleteDoc } = fbFsMod;
          await deleteDoc(doc(db, "users", currentUser.uid, "decks", String(deck?.rawId || idStr)));
        } else {
          decksList = decksList.filter((d) => String(d.id) !== idStr);
          saveGuestStateToStorage();
        }
        return { deleted: true };
      }
    }

    throw new Error(`Unsupported cloud API route: ${method} ${path}`);
  }

  function enrichDeckDetail(deck) {
    return {
      id: deck.id,
      name: deck.name,
      oshiProductId: deck.oshiProductId ?? null,
      description: deck.description || "",
      cards: (deck.cards || []).map((item) => {
        const card = cardsById.get(Number(item.productId));
        const col = collectionMap.get(Number(item.productId));
        const have = col ? Number(col.quantity ?? ((col.quantityNormal || 0) + (col.quantityFoil || 0))) : 0;
        return {
          productId: Number(item.productId),
          zone: item.zone || "main",
          quantity: Number(item.quantity || 1),
          ownedQuantity: have,
          name: card?.name || `#${item.productId}`,
          cardNumber: card?.cardNumber || "",
          cardType: card?.cardType || "",
          color: card?.color || "",
          rarity: card?.rarity || "",
          imageUrl: card?.imageUrl || "",
          marketPrice: card ? effectivePrice(card) : null,
        };
      }),
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
    signInWithGoogle,
    signOutUser,
    pushLocalCollectionToFirestore,
    handleRequest,
  };
})();
