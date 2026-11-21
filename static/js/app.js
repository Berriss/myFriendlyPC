(() => {
  const HIGH_RARITIES = new Set(["SEC", "OUR", "UR", "SR", "S", "SY", "HR"]);
  const FOIL_RARITIES = new Set(["R", "RR", "OSR", "S", "SY", "SR", "UR", "OUR", "HR", "SEC"]);

  function isCardFoil(card) {
    if (!card || card.itemCategory === "sealed") return false;
    if (FOIL_RARITIES.has(card.rarity)) return true;
    return card.rarity === "P" && String(card.priceSubtype || "").toLowerCase() === "foil";
  }

  function getRarityTierLabel(card) {
    switch (card.rarity) {
      case "SEC":
        return "Secret Rare — Foil con firma estampada";
      case "OUR":
        return "Oshi Ultra Rare — Foil Full-Art";
      case "UR":
        return "Ultra Rare — Foil Full-Art / Alt-Art";
      case "SR":
        return "Super Rare — Foil sin bordes";
      case "S":
        return "Special — Paralela Foil de C/U";
      case "SY":
        return "Special Yell — Cheer Foil Alt-Art";
      case "HR":
        return "Holomem Rare — Foil Especial";
      case "OSR":
        return "Oshi Super Rare — Foil Estándar";
      case "RR":
        return "Double Rare — Foil Estándar";
      case "R":
        return "Rare — Foil Estándar";
      case "P":
        return isCardFoil(card) ? "Promo — Acabado Foil" : "Promo";
      case "C":
      case "U":
      case "OC":
        return "Rareza Base — No-Foil";
      default:
        return card.itemCategory === "sealed" ? "Producto Sellado" : "Estándar";
    }
  }

  const state = {
    activeView: "catalog",
    viewMode: "grid",
    scrollMode: localStorage.getItem("hocg-scroll-mode") || "paged",
    currency: localStorage.getItem("hocg-currency") || "USD",
    exchangeRate: {
      rateClpPerUsd: 1007.79,
      source: "Referencia local",
      observedDate: "",
      updatedAt: "",
    },
    isLoadingMore: false,
    editions: [],
    kpis: null,
    cardsPage: null,
    decks: [],
    editingDeck: null,
    previewDeck: null,
    deckBuilder: {
      filters: {
        zone: "main",
        q: "",
        color: "",
        card_type: "",
        bloom_level: "",
        limited_only: false,
        group_id: "",
        rarity: "",
        parallel: "all",
        owned_only: false,
        sort: "number_asc",
        page: 1,
        per_page: 40,
      },
      browserPage: null,
      deckViewMode: localStorage.getItem("hocg-deck-view") || "list",
      mobilePane: "browser",
      isDirty: false,
      previewShowOwnership: true,
    },
    filters: {
      q: "",
      group_id: "",
      color: "",
      rarity: "",
      card_type: "",
      bloom_level: "",
      item_category: "card",
      ownership: "all",
      min_price: "",
      max_price: "",
      sort: "price_desc",
      page: 1,
      per_page: 36,
    },
  };

  let searchTimer = null;
  let snackbarTimer = null;
  let infiniteObserver = null;
  const pendingAdjustments = new Set();
  let suppressCloudCardsReloadUntil = 0;

  function wishHeartSvg(filled) {
    if (filled) {
      return `<svg viewBox="0 0 24 24" class="wish-icon" aria-hidden="true"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>`;
    }
    return `<svg viewBox="0 0 24 24" class="wish-icon" aria-hidden="true"><path d="M16.5 3c-1.74 0-3.41.81-4.5 2.09C10.91 3.81 9.24 3 7.5 3 4.42 3 2 5.42 2 8.5c0 3.78 3.4 6.86 8.55 11.54L12 21.35l1.45-1.32C18.6 15.36 22 12.28 22 8.5 22 5.42 19.58 3 16.5 3zm-4.4 15.55l-.1.1-.1-.1C7.14 14.24 4 11.39 4 8.5 4 6.5 5.5 5 7.5 5c1.54 0 3.04.99 3.57 2.36h1.87C13.46 5.99 14.96 5 16.5 5c2 0 3.5 1.5 3.5 3.5 0 2.89-3.14 5.74-7.9 10.05z"/></svg>`;
  }

  function cardMatchesOwnershipFilter(card, ownership) {
    if (ownership === "owned") return card.totalOwned > 0;
    if (ownership === "missing") return card.totalOwned <= 0;
    if (ownership === "favorite") return Boolean(card.isFavorite);
    if (ownership === "wishlist") return Boolean(card.isWishlist);
    return true;
  }

  function escapeHtml(str) {
    if (str === null || str === undefined) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function fmtUsd(val) {
    if (val === null || val === undefined || Number.isNaN(Number(val))) return "—";
    return "$" + Number(val).toFixed(2);
  }

  function fmtClp(usdVal) {
    if (usdVal === null || usdVal === undefined || Number.isNaN(Number(usdVal))) return "—";
    const rate = Number(state.exchangeRate?.rateClpPerUsd || 1);
    const clp = Math.round(Number(usdVal) * rate);
    return "$" + clp.toLocaleString("es-CL") + " CLP";
  }

  function fmtMoney(usdVal) {
    return state.currency === "CLP" ? fmtClp(usdVal) : fmtUsd(usdVal);
  }

  function updateCurrencyUI() {
    const isClp = state.currency === "CLP";
    document.getElementById("currency-usd").classList.toggle("active", !isClp);
    document.getElementById("currency-clp").classList.toggle("active", isClp);
    const rate = Number(state.exchangeRate?.rateClpPerUsd || 0);
    const roundedRate = Math.round(rate).toLocaleString("es-CL");
    document.getElementById("exchange-rate-label").textContent =
      `1 USD = $${roundedRate} CLP`;

    const railBtn = document.getElementById("currency-toggle-rail");
    const railCode = document.getElementById("currency-rail-code");
    const railRate = document.getElementById("exchange-rate-rail-val");
    if (railBtn && railCode) {
      railCode.textContent = isClp ? "CLP" : "USD";
      railBtn.classList.toggle("is-clp", isClp);
    }
    if (railRate) {
      railRate.textContent = `$${roundedRate}`;
    }
  }

  function setCurrency(nextCurrency) {
    if (state.currency === nextCurrency) return;
    state.currency = nextCurrency;
    localStorage.setItem("hocg-currency", nextCurrency);
    updateCurrencyUI();
    if (state.kpis) renderKpis(state.kpis);
    if (state.activeView === "collection") renderEditionsGrid(state.editions);
    if (state.activeView === "decks") {
      renderDecksList(state.decks);
      if (state.previewDeck && !document.getElementById("deck-preview-view")?.classList.contains("hidden")) {
        renderDeckPreview(state.previewDeck);
      }
      if (state.editingDeck && !document.getElementById("deck-builder-studio")?.classList.contains("hidden")) {
        renderDeckPanel();
        if (state.deckBuilder.browserPage) renderDeckBrowserGrid(state.deckBuilder.browserPage);
        if (!document.getElementById("deck-stats-modal")?.classList.contains("hidden")) renderDeckStatsModal();
      }
    }
    if (state.cardsPage) renderCards(state.cardsPage);
    showSnackbar(
      nextCurrency === "CLP"
        ? `Montos mostrados en CLP (1 USD = $${state.exchangeRate.rateClpPerUsd.toFixed(2)} CLP)`
        : "Montos mostrados en USD"
    );
  }

  function openExchangeRateModal() {
    const modal = document.getElementById("exchange-rate-modal");
    const r = state.exchangeRate;
    document.getElementById("rate-modal-current").textContent =
      `$${Number(r.rateClpPerUsd).toLocaleString("es-CL", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} CLP`;
    document.getElementById("rate-modal-meta").textContent =
      `Fuente: ${r.source || "Local"} · Fecha: ${r.observedDate || "—"}`;
    document.getElementById("manual-rate-input").value = Number(r.rateClpPerUsd).toFixed(2);
    modal.classList.remove("hidden");
  }

  async function saveExchangeRateToServer(rate, source, observedDate) {
    const updated = await apiFetch("/api/exchange-rate", {
      method: "PUT",
      body: JSON.stringify({
        rateClpPerUsd: rate,
        source,
        observedDate,
      }),
    });
    state.exchangeRate = updated;
    updateCurrencyUI();
    if (!document.getElementById("exchange-rate-modal").classList.contains("hidden")) {
      openExchangeRateModal();
    }
    await loadKpis();
    if (state.activeView === "collection") renderEditionsGrid(state.editions);
    if (state.activeView === "decks") {
      renderDecksList(state.decks);
      if (state.previewDeck && !document.getElementById("deck-preview-view")?.classList.contains("hidden")) {
        renderDeckPreview(state.previewDeck);
      }
      if (state.editingDeck && !document.getElementById("deck-builder-studio")?.classList.contains("hidden")) {
        renderDeckPanel();
        if (state.deckBuilder.browserPage) renderDeckBrowserGrid(state.deckBuilder.browserPage);
      }
    }
    if (state.cardsPage) renderCards(state.cardsPage);
    return updated;
  }

  async function refreshLiveExchangeRate() {
    const btn = document.getElementById("refresh-live-rate-btn");
    btn.disabled = true;
    btn.textContent = "Consultando tasa...";
    try {
      // Try official Banco Central (mindicador.cl) first, then open.er-api.com, then backend refresh
      let fetched = null;
      try {
        const res = await fetch("https://mindicador.cl/api/dolar", {
          signal: AbortSignal.timeout(5000),
        });
        if (res.ok) {
          const data = await res.json();
          if (data?.serie?.[0]?.valor) {
            fetched = {
              rate: Number(data.serie[0].valor),
              source: "Banco Central de Chile (mindicador.cl)",
              observedDate: String(data.serie[0].fecha || "").slice(0, 10),
            };
          }
        }
      } catch (_) {}

      if (!fetched) {
        try {
          const res = await fetch("https://open.er-api.com/v6/latest/USD", {
            signal: AbortSignal.timeout(6000),
          });
          if (res.ok) {
            const data = await res.json();
            if (data?.rates?.CLP) {
              fetched = {
                rate: Number(data.rates.CLP),
                source: "open.er-api.com (USD/CLP)",
                observedDate: String(data.time_last_update_utc || "").slice(0, 16),
              };
            }
          }
        } catch (_) {}
      }

      if (fetched && Number.isFinite(fetched.rate) && fetched.rate > 0) {
        await saveExchangeRateToServer(fetched.rate, fetched.source, fetched.observedDate);
        showSnackbar(`Tasa actualizada: 1 USD = $${fetched.rate.toFixed(2)} CLP`);
      } else {
        const backendRate = await apiFetch("/api/exchange-rate/refresh", { method: "POST" });
        state.exchangeRate = backendRate;
        updateCurrencyUI();
        openExchangeRateModal();
        await loadKpis();
        if (state.cardsPage) renderCards(state.cardsPage);
        showSnackbar(`Tasa sincronizada: 1 USD = $${backendRate.rateClpPerUsd.toFixed(2)} CLP`);
      }
    } catch (err) {
      showSnackbar(`No se pudo consultar tasa online: ${err.message}`);
    } finally {
      btn.disabled = false;
      btn.textContent = "↻ Actualizar tasa oficial del día";
    }
  }

  function showSnackbar(msg) {
    const el = document.getElementById("snackbar");
    el.textContent = msg;
    el.classList.remove("hidden");
    clearTimeout(snackbarTimer);
    snackbarTimer = setTimeout(() => {
      el.classList.add("hidden");
    }, 3000);
  }

  async function apiFetch(url, options = {}) {
    if (window.HololiveCloudBackend && window.HololiveCloudBackend.isCloudMode()) {
      return window.HololiveCloudBackend.handleRequest(url, options);
    }
    const res = await fetch(url, {
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
      ...options,
    });
    if (!res.ok) {
      let msg = `Error HTTP ${res.status}`;
      try {
        const err = await res.json();
        if (err && err.error) msg = err.error;
      } catch (_) {}
      throw new Error(msg);
    }
    return res.json();
  }

  function updateFirebaseAuthUI(user) {
    const authBtn = document.getElementById("firebase-auth-btn");
    const authLabel = document.getElementById("firebase-auth-label");
    const isCloud = Boolean(window.HololiveCloudBackend?.isCloudMode());

    if (authBtn && authLabel) {
      if (user) {
        const name = user.displayName || user.email || "Cuenta Google";
        authBtn.classList.add("is-signed-in");
        authLabel.textContent = `☁ ${name}`;
        authBtn.title = `Conectado como ${name} (Click para ver cuenta o cerrar sesión)`;
      } else {
        authBtn.classList.remove("is-signed-in");
        authLabel.textContent = isCloud ? "Iniciar sesión con Google" : "☁ Sync Google";
        authBtn.title = isCloud
          ? "Inicia sesión con Google para guardar tu colección y mazos en Cloud Firestore"
          : "Conectar cuenta Google para respaldar colección y mazos en Cloud Firestore";
      }
    }

    updateDecksAuthStatus(user, isCloud);
    updateDeckDirtyBadge();
  }

  function updateDecksAuthStatus(user, isCloud) {
    const banner = document.getElementById("decks-auth-banner");
    const bannerText = document.getElementById("decks-auth-banner-text");
    const signInBtn = document.getElementById("decks-signin-btn");
    const nudge = document.getElementById("deck-panel-auth-nudge");

    if (banner && bannerText) {
      if (user) {
        const label = user.email || user.displayName || "Cuenta Google";
        banner.classList.remove("hidden");
        banner.classList.add("is-synced");
        bannerText.textContent = isCloud
          ? `☁ Tus mazos están sincronizados en Firebase Cloud Firestore (${label}).`
          : `☁ Cuenta Google conectada (${label}). Usa "☁ Sync Google" para respaldar mazos en la nube.`;
        signInBtn?.classList.add("hidden");
      } else if (isCloud) {
        banner.classList.remove("hidden", "is-synced");
        bannerText.textContent =
          "Modo invitado local: inicia sesión con Google para guardar y sincronizar tus mazos en Firebase.";
        signInBtn?.classList.remove("hidden");
      } else {
        banner.classList.add("hidden");
        banner.classList.remove("is-synced");
        signInBtn?.classList.add("hidden");
      }
    }

    if (nudge) {
      nudge.classList.toggle("hidden", !isCloud || Boolean(user));
    }
  }

  function openSignOutModal(user) {
    if (!user) return;
    const modal = document.getElementById("signout-modal");
    const nameEl = document.getElementById("signout-account-name");
    const emailEl = document.getElementById("signout-account-email");
    const syncLocalBtn = document.getElementById("signout-sync-local-btn");
    const confirmBtn = document.getElementById("signout-confirm-btn");

    const name = user.displayName || user.email || "Cuenta Google";
    if (nameEl) nameEl.textContent = name;
    if (emailEl) {
      if (user.email && user.email !== user.displayName) {
        emailEl.textContent = user.email;
        emailEl.classList.remove("hidden");
      } else {
        emailEl.textContent = "";
        emailEl.classList.add("hidden");
      }
    }
    if (syncLocalBtn) {
      const isCloud = Boolean(window.HololiveCloudBackend?.isCloudMode());
      syncLocalBtn.classList.toggle("hidden", isCloud);
      syncLocalBtn.disabled = false;
      syncLocalBtn.textContent = "☁ Sincronizar ahora";
    }
    if (confirmBtn) {
      confirmBtn.disabled = false;
      confirmBtn.textContent = "Cerrar sesión";
    }
    modal?.classList.remove("hidden");
  }

  function closeSignOutModal() {
    document.getElementById("signout-modal")?.classList.add("hidden");
  }

  function configureRuntimeEnvironmentUI() {
    const isCloud = window.HololiveCloudBackend?.isCloudMode();
    const subtitle = document.getElementById("header-subtitle");
    if (isCloud) {
      if (subtitle) {
        subtitle.textContent = "Tracker online · Firebase Hosting + Cloud Firestore · Datos TCGCSV";
      }
      document.getElementById("shutdown-btn-rail")?.classList.add("hidden");
      document.getElementById("shutdown-btn-top")?.classList.add("hidden");
    }
    updateFirebaseAuthUI(window.HololiveCloudBackend?.getCurrentUser() || null);
  }

  /* ================= THEME (LIGHT / DARK MODE) ================= */
  function initTheme() {
    const saved = localStorage.getItem("hocg-theme");
    const prefersDark =
      window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    const theme = saved || (prefersDark ? "dark" : "light");
    applyTheme(theme);
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("hocg-theme", theme);
  }

  function toggleTheme() {
    const current = document.documentElement.getAttribute("data-theme") || "light";
    const next = current === "dark" ? "light" : "dark";
    applyTheme(next);
    showSnackbar(next === "dark" ? "Modo nocturno activado" : "Modo claro activado");
  }

  /* ================= NAVIGATION ================= */
  function switchView(viewName) {
    state.activeView = viewName;
    document.querySelectorAll(".view-section").forEach((sec) => {
      sec.classList.toggle("active", sec.id === `view-${viewName}`);
    });
    document.querySelectorAll("[data-view]").forEach((btn) => {
      btn.classList.toggle("active", btn.getAttribute("data-view") === viewName);
    });

    if (viewName === "collection") {
      loadEditionsAndBreakdowns();
    } else if (viewName === "decks") {
      loadDecks();
    } else if (viewName === "audit") {
      loadAudit();
    }
  }

  /* ================= KPIs ================= */
  async function loadKpis() {
    try {
      const kpis = await apiFetch("/api/kpis");
      state.kpis = kpis;
      renderKpis(kpis);
      if (state.activeView === "collection") {
        renderBreakdowns(kpis);
      }
    } catch (err) {
      console.error("Error loading KPIs:", err);
    }
  }

  function renderKpis(k) {
    if (k.exchangeRate && k.exchangeRate.rateClpPerUsd) {
      state.exchangeRate = k.exchangeRate;
      updateCurrencyUI();
    }

    const isClp = state.currency === "CLP";
    document.getElementById("kpi-value-title").textContent =
      isClp ? "Valor de Colección (CLP)" : "Valor de Colección (USD)";
    document.getElementById("kpi-value-badge").textContent = isClp ? "CLP" : "Market";

    document.getElementById("kpi-market-value").textContent = fmtMoney(k.collectionMarketValueUsd);
    document.getElementById("kpi-value-equiv").textContent = isClp
      ? `≈ ${fmtUsd(k.collectionMarketValueUsd)} USD (Tasa $${Math.round(state.exchangeRate.rateClpPerUsd).toLocaleString("es-CL")})`
      : `≈ ${fmtClp(k.collectionMarketValueUsd)}`;

    const netSign = k.netGainUsd >= 0 ? "+" : "-";
    const netAbs = Math.abs(k.netGainUsd);
    document.getElementById("kpi-value-sub").textContent =
      `Costo: ${fmtMoney(k.collectionCostBasisUsd)} · Neto: ${netSign}${fmtMoney(netAbs)}`;

    document.getElementById("kpi-completion-pct").textContent = `${k.completionPct.toFixed(1)}%`;
    document.getElementById("kpi-unique-owned").textContent =
      `${k.ownedUniqueCards.toLocaleString()} / ${k.catalogTotalCards.toLocaleString()}`;
    document.getElementById("kpi-progress-bar").style.width =
      `${Math.min(100, k.completionPct).toFixed(2)}%`;

    document.getElementById("kpi-total-copies").textContent = k.ownedTotalCopies.toLocaleString();
    document.getElementById("kpi-copies-sub").textContent =
      `${k.ownedFoilCopies} rareza Foil · ${k.ownedNormalCopies} Base (C/U/OC)`;
    document.getElementById("kpi-fav-wish-badge").textContent =
      `${k.favoritesCount} fav · ${k.wishlistCount} wish`;

    const chipFavCount = document.getElementById("chip-fav-count");
    if (chipFavCount) {
      chipFavCount.textContent = String(k.favoritesCount);
      chipFavCount.classList.toggle("hidden", k.favoritesCount <= 0);
    }
    const chipWishCount = document.getElementById("chip-wish-count");
    if (chipWishCount) {
      chipWishCount.textContent = String(k.wishlistCount);
      chipWishCount.classList.toggle("hidden", k.wishlistCount <= 0);
    }

    document.getElementById("kpi-editions-badge").textContent = `${k.totalEditions} sets`;
    document.getElementById("kpi-high-rarity").textContent = k.highRarityOwnedCopies.toLocaleString();

    const topEl = document.getElementById("kpi-top-card");
    if (k.topOwnedCard) {
      topEl.textContent = `Top: ${k.topOwnedCard.name} (${fmtMoney(k.topOwnedCard.marketPrice)})`;
      topEl.title = `${k.topOwnedCard.name} [${k.topOwnedCard.rarity}]`;
    } else {
      topEl.textContent = "Agrega cartas para ver tu carta top";
    }
  }

  /* ================= EDITIONS ================= */
  async function loadEditions() {
    try {
      const editions = await apiFetch("/api/editions");
      state.editions = editions;
      const select = document.getElementById("filter-edition");
      const currentVal = select.value;
      select.innerHTML = `<option value="">Todas las ediciones (${editions.length})</option>`;
      editions.forEach((ed) => {
        const opt = document.createElement("option");
        opt.value = String(ed.groupId);
        const abbr = ed.abbreviation ? `[${ed.abbreviation}] ` : "";
        opt.textContent = `${abbr}${ed.name} (${ed.ownedUniqueCards}/${ed.totalCards})`;
        select.appendChild(opt);
      });
      if (currentVal) select.value = currentVal;

      const deckEdSelect = document.getElementById("deck-filter-edition");
      if (deckEdSelect) {
        const curDeckVal = deckEdSelect.value;
        deckEdSelect.innerHTML = `<option value="">Todas las ediciones (${editions.length})</option>`;
        editions.forEach((ed) => {
          const opt = document.createElement("option");
          opt.value = String(ed.groupId);
          const abbr = ed.abbreviation ? `[${ed.abbreviation}] ` : "";
          opt.textContent = `${abbr}${ed.name}`;
          deckEdSelect.appendChild(opt);
        });
        if (curDeckVal) deckEdSelect.value = curDeckVal;
      }

      if (state.activeView === "collection") {
        renderEditionsGrid(editions);
      }
    } catch (err) {
      console.error("Error loading editions:", err);
    }
  }

  async function loadEditionsAndBreakdowns() {
    await Promise.all([loadEditions(), loadKpis()]);
    if (state.kpis) renderBreakdowns(state.kpis);
    renderEditionsGrid(state.editions);
  }

  function renderBreakdowns(kpis) {
    const colorHost = document.getElementById("color-breakdown-list");
    colorHost.innerHTML = (kpis.colorBreakdown || [])
      .map((item) => {
        const pct = item.catalogCount > 0 ? (item.ownedUnique / item.catalogCount) * 100 : 0;
        return `
          <div class="breakdown-row">
            <div class="breakdown-label">
              <span>${escapeHtml(item.color)}</span>
              <span>${item.ownedUnique}/${item.catalogCount} únicas · ${item.ownedCopies} copias (${pct.toFixed(1)}%)</span>
            </div>
            <div class="md3-progress-track">
              <div class="md3-progress-fill" style="width:${Math.min(100, pct)}%"></div>
            </div>
          </div>`;
      })
      .join("");

    const rarityHost = document.getElementById("rarity-breakdown-list");
    rarityHost.innerHTML = (kpis.rarityBreakdown || [])
      .map((item) => {
        const pct = item.catalogCount > 0 ? (item.ownedUnique / item.catalogCount) * 100 : 0;
        return `
          <div class="breakdown-row">
            <div class="breakdown-label">
              <span><strong>${escapeHtml(item.rarity)}</strong> — ${escapeHtml(item.rarityName)}</span>
              <span>${item.ownedUnique}/${item.catalogCount} · ${item.ownedCopies} copias</span>
            </div>
            <div class="md3-progress-track">
              <div class="md3-progress-fill" style="width:${Math.min(100, pct)}%"></div>
            </div>
          </div>`;
      })
      .join("");
  }

  function renderEditionsGrid(editions) {
    const host = document.getElementById("editions-progress-grid");
    host.innerHTML = editions
      .map(
        (ed) => `
      <article class="edition-card" data-jump-edition="${ed.groupId}">
        <div class="edition-head">
          <div class="edition-title">${escapeHtml(ed.name)}</div>
          <span class="edition-abbr">${escapeHtml(ed.abbreviation || "SET")}</span>
        </div>
        <div class="card-sub-meta">
          <span>${ed.ownedUniqueCards} / ${ed.totalCards} cartas (${ed.completionPct.toFixed(1)}%)</span>
          <span>${ed.ownedTotalCopies} copias</span>
        </div>
        <div class="md3-progress-track">
          <div class="md3-progress-fill" style="width:${Math.min(100, ed.completionPct)}%"></div>
        </div>
        <div class="card-sub-meta">
          <span>Mi valor: <strong>${fmtMoney(ed.collectionValueUsd)}</strong></span>
          <span>Set completo: ${fmtMoney(ed.setTotalValueUsd)}</span>
        </div>
      </article>`
      )
      .join("");

    host.querySelectorAll("[data-jump-edition]").forEach((el) => {
      el.addEventListener("click", () => {
        const gid = el.getAttribute("data-jump-edition");
        state.filters.group_id = gid;
        state.filters.page = 1;
        document.getElementById("filter-edition").value = gid;
        switchView("catalog");
        loadCards();
      });
    });
  }

  /* ================= CATALOG & FILTERS ================= */
  function buildCardsQueryString() {
    const params = new URLSearchParams();
    Object.entries(state.filters).forEach(([k, v]) => {
      if (v !== "" && v !== null && v !== undefined) {
        params.set(k, String(v));
      }
    });
    return params.toString();
  }

  function updateScrollModeUI() {
    const isInfinite = state.scrollMode === "infinite";
    document.getElementById("scroll-mode-paged").classList.toggle("active", !isInfinite);
    document.getElementById("scroll-mode-infinite").classList.toggle("active", isInfinite);
    document.getElementById("pagination-top").classList.toggle("hidden", isInfinite);
    document.getElementById("pagination-bottom").classList.toggle("hidden", isInfinite);

    const sentinel = document.getElementById("infinite-scroll-sentinel");
    if (!isInfinite || !state.cardsPage || !state.cardsPage.items.length) {
      sentinel.classList.add("hidden");
    } else {
      sentinel.classList.remove("hidden");
      if (state.isLoadingMore) {
        sentinel.textContent = "Cargando más cartas...";
      } else if (state.cardsPage.page < state.cardsPage.totalPages) {
        sentinel.textContent = `Desliza para cargar más (${state.cardsPage.items.length} de ${state.cardsPage.total.toLocaleString()})`;
      } else {
        sentinel.textContent = `Has llegado al final del listado (${state.cardsPage.total.toLocaleString()} resultados)`;
      }
    }
  }

  function setupInfiniteObserver() {
    const sentinel = document.getElementById("infinite-scroll-sentinel");
    if (!sentinel || typeof IntersectionObserver === "undefined") return;
    if (infiniteObserver) infiniteObserver.disconnect();
    infiniteObserver = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (
          entry &&
          entry.isIntersecting &&
          state.activeView === "catalog" &&
          state.scrollMode === "infinite" &&
          !state.isLoadingMore &&
          state.cardsPage &&
          state.cardsPage.page < state.cardsPage.totalPages
        ) {
          loadMoreCards();
        }
      },
      { rootMargin: "320px 0px" }
    );
    infiniteObserver.observe(sentinel);
  }

  async function loadCards() {
    const container = document.getElementById("cards-container");
    const countLabel = document.getElementById("results-count-label");
    countLabel.textContent = "Buscando cartas...";
    state.isLoadingMore = false;
    try {
      const data = await apiFetch(`/api/cards?${buildCardsQueryString()}`);
      state.cardsPage = data;
      renderCards(data);
    } catch (err) {
      container.innerHTML = `<div class="panel-card">Error cargando cartas: ${escapeHtml(err.message)}</div>`;
      countLabel.textContent = "Error al cargar";
    }
  }

  async function loadMoreCards() {
    if (
      state.isLoadingMore ||
      !state.cardsPage ||
      state.cardsPage.page >= state.cardsPage.totalPages
    ) {
      return;
    }
    state.isLoadingMore = true;
    state.filters.page = state.cardsPage.page + 1;
    updateScrollModeUI();

    try {
      const data = await apiFetch(`/api/cards?${buildCardsQueryString()}`);
      const newItems = data.items || [];
      state.cardsPage.items = state.cardsPage.items.concat(newItems);
      state.cardsPage.page = data.page;
      state.cardsPage.total = data.total;
      state.cardsPage.totalPages = data.totalPages;

      appendCardsToDom(newItems);
      updateResultsCountLabel();
    } catch (err) {
      showSnackbar(`Error al cargar más cartas: ${err.message}`);
    } finally {
      state.isLoadingMore = false;
      updateScrollModeUI();
    }
  }

  function updateResultsCountLabel() {
    if (!state.cardsPage) return;
    const countLabel = document.getElementById("results-count-label");
    if (state.scrollMode === "infinite") {
      countLabel.textContent = `Mostrando ${state.cardsPage.items.length} de ${state.cardsPage.total.toLocaleString()} resultados (Scroll infinito)`;
    } else {
      countLabel.textContent = `Mostrando ${state.cardsPage.items.length} de ${state.cardsPage.total.toLocaleString()} resultados (Página ${state.cardsPage.page} de ${state.cardsPage.totalPages})`;
    }
  }

  function appendCardsToDom(newItems) {
    if (!newItems.length) return;
    const container = document.getElementById("cards-container");
    const temp = document.createElement(state.viewMode === "grid" ? "div" : "tbody");

    if (state.viewMode === "grid") {
      temp.innerHTML = newItems.map(renderCardTile).join("");
      const nodes = Array.from(temp.children);
      nodes.forEach((node) => {
        container.appendChild(node);
        bindCardInteractions(node);
      });
    } else {
      const tbody = container.querySelector("tbody");
      if (!tbody) {
        renderCards(state.cardsPage);
        return;
      }
      temp.innerHTML = newItems.map(renderCardTableRow).join("");
      const rows = Array.from(temp.children);
      rows.forEach((row) => {
        tbody.appendChild(row);
        bindCardInteractions(row);
      });
    }
  }

  function renderCards(data) {
    const container = document.getElementById("cards-container");
    updateResultsCountLabel();

    renderPagination("pagination-top", data.page, data.totalPages);
    renderPagination("pagination-bottom", data.page, data.totalPages);
    updateScrollModeUI();

    if (!data.items.length) {
      container.className = "";
      container.innerHTML = `
        <div class="panel-card" style="text-align:center;padding:36px;">
          <h3>No se encontraron cartas con los filtros actuales</h3>
          <p class="muted-text">Prueba quitando algún filtro o cambiando el alcance de búsqueda.</p>
          <div style="margin-top:14px;">
            <button id="empty-reset-btn" class="tonal-btn" type="button">Restablecer filtros</button>
          </div>
        </div>`;
      const btn = document.getElementById("empty-reset-btn");
      if (btn) btn.addEventListener("click", resetFilters);
      return;
    }

    if (state.viewMode === "grid") {
      container.className = "cards-grid";
      container.innerHTML = data.items.map(renderCardTile).join("");
    } else {
      container.className = "cards-table-wrap";
      container.innerHTML = renderCardsTable(data.items);
    }

    bindCardInteractions(container);
    updateScrollModeUI();
  }

  function renderCardTile(c) {
    const isOwned = c.totalOwned > 0;
    const isHigh = HIGH_RARITIES.has(c.rarity);
    const isFoil = isCardFoil(c);
    const displayPrice = c.marketPrice ?? c.foilMarketPrice;
    const subPrice = c.lowPrice !== null && c.lowPrice !== undefined ? `Low ${fmtMoney(c.lowPrice)}` : "";
    const statTag = c.hp ? `HP ${c.hp}` : c.life ? `Life ${c.life}` : "";

    return `
      <article class="card-tile ${isOwned ? "is-owned" : ""} ${c.isWishlist ? "is-wishlisted" : ""}" data-pid="${c.productId}">
        <div class="card-art-wrap" data-open-detail="${c.productId}">
          ${
            c.imageUrl
              ? `<img src="${escapeHtml(c.imageUrl)}" alt="${escapeHtml(c.name)}" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.classList.remove('hidden');" />
                 <div class="art-fallback hidden">${escapeHtml(c.name)}</div>`
              : `<div class="art-fallback">${escapeHtml(c.name)}</div>`
          }
          <div class="badge-top-left">
            ${c.rarity ? `<span class="pill-tag ${isHigh ? "rarity-high" : ""}">${escapeHtml(c.rarity)}</span>` : ""}
            ${isFoil ? `<span class="pill-tag foil-tier" title="Rareza con acabado Foil">✦ Foil</span>` : ""}
            ${isOwned ? `<span class="pill-tag owned-pill">x${c.totalOwned}</span>` : ""}
            ${c.isWishlist ? `<span class="pill-tag wish-pill" title="En Wishlist">♥ Wish</span>` : ""}
          </div>
          <div class="badge-top-right">
            <button class="mini-icon-btn ${c.isFavorite ? "fav-active" : ""}" data-toggle-fav="${c.productId}" title="${c.isFavorite ? "Quitar de favoritas" : "Marcar como favorita"}" aria-label="Favorita" type="button">★</button>
          </div>
        </div>
        <div class="card-body">
          <button class="card-title-btn" data-open-detail="${c.productId}" type="button">${escapeHtml(c.name)}</button>
          <div class="card-sub-meta">
            <span>${escapeHtml(c.cardNumber || "S/N")}</span>
            <span class="truncate" title="${escapeHtml(c.editionName)}">${escapeHtml(c.editionAbbr || c.editionName)}</span>
          </div>
          <div class="card-attr-chips">
            ${c.color ? `<span class="attr-chip">${escapeHtml(c.color)}</span>` : ""}
            ${c.cardType ? `<span class="attr-chip">${escapeHtml(c.cardType)}</span>` : ""}
            ${c.bloomLevel ? `<span class="attr-chip">${escapeHtml(c.bloomLevel)}</span>` : ""}
            ${statTag ? `<span class="attr-chip">${escapeHtml(statTag)}</span>` : ""}
          </div>
          <div class="card-price-row">
            <span class="price-main">${fmtMoney(displayPrice)}</span>
            <span class="price-sub">${escapeHtml(subPrice)}</span>
          </div>
          <div class="collection-steppers">
            <div class="stepper-box ${isOwned ? "owned-active" : ""}">
              <span class="stepper-label">En colección</span>
              <div class="stepper-controls">
                <button class="step-btn" data-adjust="${c.productId}" data-delta="-1" type="button" aria-label="Restar copia">−</button>
                <span class="step-qty" data-qty-total="${c.productId}">${c.totalOwned}</span>
                <button class="step-btn plus" data-adjust="${c.productId}" data-delta="1" type="button" aria-label="Sumar copia">+</button>
              </div>
            </div>
            <button class="wish-toggle-btn ${c.isWishlist ? "is-wishlisted" : ""}" data-toggle-wish="${c.productId}" type="button" aria-pressed="${c.isWishlist ? "true" : "false"}" title="${c.isWishlist ? "Quitar de Wishlist" : "Agregar a Wishlist"}">
              ${wishHeartSvg(c.isWishlist)}
              <span>${c.isWishlist ? "En Wishlist" : "+ Wishlist"}</span>
            </button>
          </div>
        </div>
      </article>`;
  }

  function renderCardTableRow(c) {
    const isOwned = c.totalOwned > 0;
    const isFoil = isCardFoil(c);
    const price = c.marketPrice ?? c.foilMarketPrice;
    return `
      <tr class="${isOwned ? "is-owned" : ""} ${c.isWishlist ? "is-wishlisted" : ""}" data-pid="${c.productId}">
        <td><button class="card-title-btn" data-open-detail="${c.productId}" type="button">${escapeHtml(c.name)}</button></td>
        <td>${escapeHtml(c.cardNumber || "—")}</td>
        <td>${escapeHtml(c.editionAbbr || c.editionName)}</td>
        <td>${escapeHtml(c.rarity || "—")} ${isFoil ? `<span class="attr-chip">✦ Foil</span>` : ""}</td>
        <td>${escapeHtml(c.color || "—")}</td>
        <td>${escapeHtml(c.cardType || "—")}</td>
        <td><strong>${fmtMoney(price)}</strong></td>
        <td>
          <div class="stepper-controls">
            <button class="step-btn" data-adjust="${c.productId}" data-delta="-1" type="button">−</button>
            <span class="step-qty">${c.totalOwned}</span>
            <button class="step-btn plus" data-adjust="${c.productId}" data-delta="1" type="button">+</button>
          </div>
        </td>
        <td>
          <button class="wish-toggle-btn wish-toggle-compact ${c.isWishlist ? "is-wishlisted" : ""}" data-toggle-wish="${c.productId}" type="button" aria-pressed="${c.isWishlist ? "true" : "false"}" title="${c.isWishlist ? "Quitar de Wishlist" : "Agregar a Wishlist"}">
            ${wishHeartSvg(c.isWishlist)}
            <span>${c.isWishlist ? "En Wishlist" : "+ Wishlist"}</span>
          </button>
        </td>
      </tr>`;
  }

  function renderCardsTable(items) {
    const rows = items.map(renderCardTableRow).join("");

    return `
      <table class="cards-table">
        <thead>
          <tr>
            <th>Carta</th>
            <th>Código</th>
            <th>Edición</th>
            <th>Rareza</th>
            <th>Color</th>
            <th>Tipo</th>
            <th>Market</th>
            <th>Cantidad</th>
            <th>Wishlist</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>`;
  }

  function renderPagination(targetId, page, totalPages) {
    const el = document.getElementById(targetId);
    if (!el) return;
    el.innerHTML = `
      <button class="page-btn" ${page <= 1 ? "disabled" : ""} data-page="${page - 1}" type="button">← Anterior</button>
      <span class="page-info">Página ${page} / ${totalPages}</span>
      <button class="page-btn" ${page >= totalPages ? "disabled" : ""} data-page="${page + 1}" type="button">Siguiente →</button>
    `;
    el.querySelectorAll("[data-page]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const nextPage = Number(btn.getAttribute("data-page"));
        if (nextPage >= 1 && nextPage <= totalPages) {
          state.filters.page = nextPage;
          loadCards();
          window.scrollTo({ top: 0, behavior: "smooth" });
        }
      });
    });
  }

  function bindCardInteractions(container) {
    container.querySelectorAll("[data-open-detail]").forEach((el) => {
      el.addEventListener("click", () => {
        openCardModal(Number(el.getAttribute("data-open-detail")));
      });
    });

    container.querySelectorAll("[data-adjust]").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const pid = Number(btn.getAttribute("data-adjust"));
        const delta = Number(btn.getAttribute("data-delta"));
        await quickAdjustCard(pid, { delta });
      });
    });

    container.querySelectorAll("[data-toggle-fav]").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const pid = Number(btn.getAttribute("data-toggle-fav"));
        await quickAdjustCard(pid, { toggleFavorite: true });
      });
    });

    container.querySelectorAll("[data-toggle-wish]").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const pid = Number(btn.getAttribute("data-toggle-wish"));
        await quickAdjustCard(pid, { toggleWishlist: true });
      });
    });
  }

  function replaceSingleCardInDom(updated) {
    const existingEl = document.querySelector(`#cards-container [data-pid="${updated.productId}"]`);
    if (!existingEl) return;
    const wrapper = document.createElement(state.viewMode === "grid" ? "div" : "tbody");
    wrapper.innerHTML =
      state.viewMode === "grid" ? renderCardTile(updated) : renderCardTableRow(updated);
    const nextEl = wrapper.firstElementChild;
    if (nextEl) {
      existingEl.replaceWith(nextEl);
      bindCardInteractions(nextEl);
    }
  }

  async function quickAdjustCard(productId, payload) {
    if (pendingAdjustments.has(productId)) return null;
    pendingAdjustments.add(productId);
    suppressCloudCardsReloadUntil = Date.now() + 700;
    try {
      const updated = await apiFetch(`/api/collection/${productId}/adjust`, {
        method: "PATCH",
        body: JSON.stringify(payload),
      });

      if (state.cardsPage && state.cardsPage.items) {
        const idx = state.cardsPage.items.findIndex((x) => x.productId === productId);
        const stillMatches = cardMatchesOwnershipFilter(updated, state.filters.ownership);
        if (stillMatches) {
          if (idx >= 0) {
            state.cardsPage.items[idx] = updated;
          }
          replaceSingleCardInDom(updated);
        } else if (state.scrollMode === "infinite") {
          if (idx >= 0) {
            state.cardsPage.items.splice(idx, 1);
          }
          state.cardsPage.total = Math.max(0, (state.cardsPage.total || 0) - 1);
          document.querySelector(`#cards-container [data-pid="${productId}"]`)?.remove();
          if (!state.cardsPage.items.length) {
            renderCards(state.cardsPage);
          } else {
            updateResultsCountLabel();
            updateScrollModeUI();
          }
        } else {
          await loadCards();
        }
      }
      await Promise.all([loadKpis(), loadEditions()]);
      if (payload.toggleWishlist) {
        showSnackbar(
          updated.isWishlist
            ? `♥ ${updated.name} agregada a Wishlist`
            : `${updated.name} quitada de Wishlist`
        );
      } else if (payload.toggleFavorite) {
        showSnackbar(
          updated.isFavorite
            ? `★ ${updated.name} marcada como favorita`
            : `${updated.name} quitada de favoritas`
        );
      } else {
        showSnackbar(`${updated.name}: ${updated.totalOwned} en colección`);
      }
      return updated;
    } catch (err) {
      showSnackbar(`Error al actualizar: ${err.message}`);
      return null;
    } finally {
      pendingAdjustments.delete(productId);
    }
  }

  /* ================= CARD DETAIL MODAL ================= */
  async function openCardModal(productId) {
    const backdrop = document.getElementById("card-modal-backdrop");
    const body = document.getElementById("modal-body-content");
    backdrop.classList.remove("hidden");
    body.innerHTML = `<p class="muted-text">Cargando información de la carta...</p>`;

    try {
      const c = await apiFetch(`/api/cards/${productId}`);
      document.getElementById("modal-card-title").textContent = c.name;
      document.getElementById("modal-card-meta").textContent =
        `${c.editionName} · ${c.cardNumber || "Sin código"} · ${c.rarityName || c.rarity || "Producto"}`;

      const attrs = [
        ["Tipo", c.cardType],
        ["Subtipo", c.subtype],
        ["Color", c.color],
        ["Bloom Level", c.bloomLevel],
        ["HP", c.hp],
        ["Life", c.life],
        ["Baton Pass", c.batonPass],
        ["Tags", c.tags],
      ]
        .filter(([, val]) => val !== null && val !== undefined && val !== "")
        .map(([k, val]) => `<span class="attr-chip"><strong>${escapeHtml(k)}:</strong> ${escapeHtml(val)}</span>`)
        .join("");

      const sanitizedBadge = c.sanitizedFlag
        ? `<span class="edition-abbr" title="Saneado de comas/HTML/typos en el barrido">✓ Texto saneado TCGCSV</span>`
        : "";
      const rarityTierBadge = `<span class="attr-chip">${isCardFoil(c) ? "✦ " : ""}${escapeHtml(getRarityTierLabel(c))}</span>`;
      const effectiveMarket = c.marketPrice ?? c.foilMarketPrice;

      body.innerHTML = `
        <div class="modal-grid">
          <div>
            ${
              c.imageUrl
                ? `<img class="modal-art" src="${escapeHtml(c.imageUrl)}" alt="${escapeHtml(c.name)}" />`
                : `<div class="art-fallback">Sin imagen</div>`
            }
            <div style="margin-top:10px;display:flex;flex-direction:column;gap:6px;font-size:0.84rem;">
              <div><strong>Market Price (${escapeHtml(state.currency)}):</strong> ${fmtMoney(effectiveMarket)}</div>
              <div><strong>Equivalencia:</strong> ${fmtUsd(effectiveMarket)} USD / ${fmtClp(effectiveMarket)}</div>
              <div><strong>Low / Mid / High:</strong> ${fmtMoney(c.lowPrice)} / ${fmtMoney(c.midPrice)} / ${fmtMoney(c.highPrice)}</div>
              <div><strong>Acabado de rareza:</strong> ${escapeHtml(getRarityTierLabel(c))}</div>
              ${
                c.url
                  ? `<a class="outlined-btn" style="margin-top:6px;text-decoration:none;" href="${escapeHtml(c.url)}" target="_blank" rel="noopener noreferrer">Ver en TCGplayer ↗</a>`
                  : ""
              }
            </div>
          </div>

          <div>
            <div class="card-attr-chips" style="margin-bottom:10px;">${rarityTierBadge} ${attrs} ${sanitizedBadge}</div>

            ${
              c.effectText
                ? `<div>
                    <strong>Efectos &amp; Reglas</strong>
                    <div class="effect-box">${escapeHtml(c.effectText)}</div>
                    ${
                      c.rawDescription && c.rawDescription !== c.effectText
                        ? `<details style="font-size:0.8rem;margin-bottom:8px;">
                             <summary style="cursor:pointer;color:var(--md-sys-color-primary);">Ver texto crudo original de TCGplayer</summary>
                             <div class="audit-box" style="margin-top:6px;">${escapeHtml(c.rawDescription)}</div>
                           </details>`
                        : ""
                    }
                   </div>`
                : `<p class="muted-text">Sin descripción de efecto registrada.</p>`
            }

            <div class="modal-quick-actions">
              <button id="modal-wish-toggle-btn" class="wish-toggle-btn modal-action-pill ${c.isWishlist ? "is-wishlisted" : ""}" type="button" aria-pressed="${c.isWishlist ? "true" : "false"}">
                ${wishHeartSvg(c.isWishlist)}
                <span>${c.isWishlist ? "En Wishlist" : "Agregar a Wishlist"}</span>
              </button>
              <button id="modal-fav-toggle-btn" class="fav-toggle-btn modal-action-pill ${c.isFavorite ? "is-favorited" : ""}" type="button" aria-pressed="${c.isFavorite ? "true" : "false"}">
                <span>★</span>
                <span>${c.isFavorite ? "En Favoritas" : "Agregar a Favoritas"}</span>
              </button>
            </div>

            <form id="modal-collection-form" class="collection-form-box">
              <strong style="display:block;margin-bottom:10px;">Guardar en Mi Colección</strong>
              <div class="form-grid-3">
                <div class="field-group">
                  <label for="m-qty-total">Cantidad en Colección</label>
                  <input id="m-qty-total" type="number" min="0" value="${c.totalOwned}" />
                </div>
                <div class="field-group">
                  <label for="m-purchase-price">Compra c/u (USD)</label>
                  <input id="m-purchase-price" type="number" min="0" step="0.01" value="${c.purchasePrice ?? ""}" placeholder="Opcional" />
                </div>
                <div class="field-group">
                  <label for="m-condition">Condición</label>
                  <select id="m-condition">
                    ${["NM", "LP", "MP", "HP", "DMG"]
                      .map((cond) => `<option value="${cond}" ${c.condition === cond ? "selected" : ""}>${cond}</option>`)
                      .join("")}
                  </select>
                </div>
                <div class="field-group">
                  <label for="m-language">Idioma</label>
                  <select id="m-language">
                    ${["EN", "JP"]
                      .map((lang) => `<option value="${lang}" ${c.language === lang ? "selected" : ""}>${lang}</option>`)
                      .join("")}
                  </select>
                </div>
                <div class="field-group ${c.isWishlist ? "" : "hidden"}" id="m-wish-target-group">
                  <label for="m-wish-target">Meta Wishlist</label>
                  <input id="m-wish-target" type="number" min="1" value="${c.wishlistTargetQty}" />
                </div>
              </div>
              <div class="field-group" style="margin-top:10px;">
                <label for="m-notes">Notas personales</label>
                <textarea id="m-notes" rows="2" placeholder="Carpeta, intercambio, pull de caja...">${escapeHtml(c.notes)}</textarea>
              </div>
              <div class="action-row end">
                <button class="filled-btn" type="submit">Guardar cambios</button>
              </div>
            </form>
          </div>
        </div>`;

      let modalIsWishlist = Boolean(c.isWishlist);
      let modalIsFavorite = Boolean(c.isFavorite);

      const modalWishBtn = document.getElementById("modal-wish-toggle-btn");
      const modalFavBtn = document.getElementById("modal-fav-toggle-btn");
      const wishTargetGroup = document.getElementById("m-wish-target-group");

      modalWishBtn?.addEventListener("click", async () => {
        modalWishBtn.disabled = true;
        try {
          const updated = await quickAdjustCard(productId, { toggleWishlist: true });
          if (updated) {
            modalIsWishlist = Boolean(updated.isWishlist);
            modalWishBtn.classList.toggle("is-wishlisted", modalIsWishlist);
            modalWishBtn.setAttribute("aria-pressed", modalIsWishlist ? "true" : "false");
            modalWishBtn.innerHTML = `${wishHeartSvg(modalIsWishlist)}<span>${modalIsWishlist ? "En Wishlist" : "Agregar a Wishlist"}</span>`;
            wishTargetGroup?.classList.toggle("hidden", !modalIsWishlist);
          }
        } finally {
          modalWishBtn.disabled = false;
        }
      });

      modalFavBtn?.addEventListener("click", async () => {
        modalFavBtn.disabled = true;
        try {
          const updated = await quickAdjustCard(productId, { toggleFavorite: true });
          if (updated) {
            modalIsFavorite = Boolean(updated.isFavorite);
            modalFavBtn.classList.toggle("is-favorited", modalIsFavorite);
            modalFavBtn.setAttribute("aria-pressed", modalIsFavorite ? "true" : "false");
            modalFavBtn.innerHTML = `<span>★</span><span>${modalIsFavorite ? "En Favoritas" : "Agregar a Favoritas"}</span>`;
          }
        } finally {
          modalFavBtn.disabled = false;
        }
      });

      document.getElementById("modal-collection-form").addEventListener("submit", async (e) => {
        e.preventDefault();
        const priceRaw = document.getElementById("m-purchase-price").value.trim();
        const payload = {
          quantity: Number(document.getElementById("m-qty-total").value || 0),
          purchasePrice: priceRaw === "" ? null : Number(priceRaw),
          condition: document.getElementById("m-condition").value,
          language: document.getElementById("m-language").value,
          wishlistTargetQty: Math.max(1, Number(document.getElementById("m-wish-target")?.value || c.wishlistTargetQty || 1)),
          isFavorite: modalIsFavorite,
          isWishlist: modalIsWishlist,
          notes: document.getElementById("m-notes").value,
        };
        try {
          const savedCol = await apiFetch(`/api/collection/${productId}`, {
            method: "POST",
            body: JSON.stringify(payload),
          });
          backdrop.classList.add("hidden");
          syncEditingDeckOwnedCount(productId, savedCol?.totalOwned);
          await Promise.all([loadCards(), loadKpis(), loadEditions()]);
          showSnackbar(`Colección guardada para ${c.name}`);
        } catch (err) {
          showSnackbar(`Error al guardar: ${err.message}`);
        }
      });
    } catch (err) {
      body.innerHTML = `<p class="muted-text">No se pudo cargar la carta: ${escapeHtml(err.message)}</p>`;
    }
  }

  /* ================= EXPORT / IMPORT COLLECTION ================= */
  async function exportCollection() {
    try {
      const payload = await apiFetch("/api/collection/export");
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `hololive_ocg_collection_${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      showSnackbar(`Exportadas ${payload.entries.length} entradas de colección`);
    } catch (err) {
      showSnackbar(`Error al exportar: ${err.message}`);
    }
  }

  async function importCollectionFile(file) {
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const entries = Array.isArray(parsed) ? parsed : parsed.entries;
      if (!Array.isArray(entries)) throw new Error("Formato de JSON inválido");
      const res = await apiFetch("/api/collection/import", {
        method: "POST",
        body: JSON.stringify({ entries, replaceExisting: false }),
      });
      await Promise.all([loadKpis(), loadEditions(), loadCards()]);
      showSnackbar(`Importadas ${res.imported} cartas (${res.skipped} omitidas)`);
    } catch (err) {
      showSnackbar(`Error al importar: ${err.message}`);
    }
  }

  /* ================= DECK BUILDER STUDIO ================= */
  const HOLOLIVE_COLORS = ["White", "Green", "Red", "Blue", "Purple", "Yellow", "Colorless", "Multi-color"];
  let deckBrowserSearchTimer = null;

  function isUnlimitedCopyCard(card) {
    if (!card) return false;
    if (card.cardType === "Cheer" || card.zone === "cheer") return true;
    return /you may include any number/i.test(String(card.effectText || ""));
  }

  function getDeckCardNumberCount(deck, cardNumber, productId, zone) {
    if (!deck || !Array.isArray(deck.cards)) return 0;
    const targetNum = String(cardNumber || "").trim();
    let total = 0;
    for (const item of deck.cards) {
      if ((item.zone || "main") !== zone) continue;
      const itemNum = String(item.cardNumber || "").trim();
      if (targetNum && itemNum) {
        if (itemNum === targetNum) total += Number(item.quantity || 0);
      } else if (Number(item.productId) === Number(productId)) {
        total += Number(item.quantity || 0);
      }
    }
    return total;
  }

  function evaluateDeckRules(deck) {
    const cards = Array.isArray(deck?.cards) ? deck.cards : [];
    const hasOshi = Boolean(deck?.oshiProductId);
    const oshi = deck?.oshiCard || null;

    let mainCount = 0;
    let cheerCount = 0;
    const sameNumberMain = new Map();
    const sameNumberLabel = new Map();
    const sameNumberUnlimited = new Map();

    const bloomCounts = { Debut: 0, "1st": 0, Buzz: 0, "2nd": 0, Spot: 0, Otro: 0 };
    const typeCounts = { Holomem: 0, "Buzz Holomem": 0, Support: 0, LIMITED: 0, Cheer: 0 };
    const colorCounts = {
      White: 0, Green: 0, Red: 0, Blue: 0, Purple: 0, Yellow: 0, Colorless: 0, "Multi-color": 0,
    };

    let totalRequiredCopies = hasOshi ? 1 : 0;
    let ownedCopies = 0;
    let totalCostUsd = 0;
    let missingCostUsd = 0;
    const missingCards = [];

    if (hasOshi) {
      const oPrice = Number(oshi?.marketPrice || 0);
      const oHave = Number(oshi?.ownedQuantity || 0);
      totalCostUsd += oPrice;
      if (oHave > 0) {
        ownedCopies += 1;
      } else {
        missingCostUsd += oPrice;
        missingCards.push({
          productId: deck.oshiProductId,
          name: oshi?.name || `Oshi #${deck.oshiProductId}`,
          missingQty: 1,
        });
      }
    }

    for (const item of cards) {
      const qty = Math.max(0, Number(item.quantity || 0));
      if (qty === 0) continue;
      const zone = item.zone === "cheer" ? "cheer" : "main";
      const unlimited = isUnlimitedCopyCard(item);
      const key = String(item.cardNumber || "").trim() || `pid:${item.productId}`;

      if (zone === "cheer") {
        cheerCount += qty;
        typeCounts.Cheer += qty;
      } else {
        mainCount += qty;
        sameNumberMain.set(key, (sameNumberMain.get(key) || 0) + qty);
        sameNumberLabel.set(key, item.name || key);
        if (unlimited) sameNumberUnlimited.set(key, true);

        if (item.cardType === "Buzz Holomem") {
          typeCounts["Buzz Holomem"] += qty;
          bloomCounts.Buzz += qty;
        } else if (item.cardType === "Support") {
          typeCounts.Support += qty;
          if (String(item.effectText || "").includes("LIMITED")) {
            typeCounts.LIMITED += qty;
          }
        } else {
          typeCounts.Holomem += qty;
          const bl = item.bloomLevel || "";
          if (bl === "Debut" || bl === "1st" || bl === "2nd" || bl === "Spot") {
            bloomCounts[bl] += qty;
          } else {
            bloomCounts.Otro += qty;
          }
        }
      }

      const rawColor = String(item.color || "").trim();
      if (!rawColor || rawColor === "Colorless") {
        colorCounts.Colorless += qty;
      } else if (rawColor.includes("/")) {
        colorCounts["Multi-color"] += qty;
      } else if (Object.prototype.hasOwnProperty.call(colorCounts, rawColor)) {
        colorCounts[rawColor] += qty;
      } else {
        colorCounts.Colorless += qty;
      }

      const price = Number(item.marketPrice || 0);
      const have = Number(item.ownedQuantity || 0);
      totalRequiredCopies += qty;
      ownedCopies += Math.min(qty, have);
      totalCostUsd += qty * price;
      if (have < qty) {
        const shortfall = qty - have;
        missingCostUsd += shortfall * price;
        missingCards.push({
          productId: item.productId,
          name: item.name,
          missingQty: shortfall,
        });
      }
    }

    const violations = [];
    const hints = [];

    if (mainCount > 50) violations.push(`Main Deck excede 50 cartas (${mainCount}/50).`);
    if (cheerCount > 20) violations.push(`Cheer Deck excede 20 cartas (${cheerCount}/20).`);
    for (const [key, count] of sameNumberMain.entries()) {
      if (count > 4 && !sameNumberUnlimited.get(key)) {
        violations.push(`${sameNumberLabel.get(key)} (${key}) supera el límite de 4 copias (${count}/4).`);
      }
    }

    if (!hasOshi) hints.push("Falta elegir 1 carta Oshi Holomem.");
    if (mainCount < 50) hints.push(`Faltan ${50 - mainCount} carta(s) en el Main Deck (${mainCount}/50).`);
    if (cheerCount < 20) hints.push(`Faltan ${20 - cheerCount} carta(s) en el Cheer Deck (${cheerCount}/20).`);

    const isLegal = hasOshi && mainCount === 50 && cheerCount === 20 && violations.length === 0;
    const coveragePct = totalRequiredCopies > 0 ? (ownedCopies / totalRequiredCopies) * 100 : 0;

    return {
      hasOshi,
      mainCount,
      cheerCount,
      totalCount: (hasOshi ? 1 : 0) + mainCount + cheerCount,
      isLegal,
      violations,
      hints,
      bloomCounts,
      typeCounts,
      colorCounts,
      totalRequiredCopies,
      ownedCopies,
      coveragePct,
      totalCostUsd,
      missingCostUsd,
      missingCards,
    };
  }

  function getDeckGroupCategory(item) {
    if (item.zone === "cheer") return "cheer";
    if (item.cardType === "Support") return "support";
    if (item.cardType === "Buzz Holomem") return "1st";
    if (item.bloomLevel === "Debut") return "debut";
    if (item.bloomLevel === "1st") return "1st";
    if (item.bloomLevel === "2nd") return "2nd";
    if (item.bloomLevel === "Spot") return "spot";
    return "other";
  }

  function groupDeckCards(cards) {
    const defs = [
      { id: "debut", label: "Debut Holomem" },
      { id: "1st", label: "1st & Buzz Holomem" },
      { id: "2nd", label: "2nd Holomem" },
      { id: "spot", label: "Spot Holomem" },
      { id: "other", label: "Otros Holomem / Promo" },
      { id: "support", label: "Support (Item / Event / Tool / LIMITED)" },
      { id: "cheer", label: "Cheer Deck" },
    ];
    const buckets = new Map(defs.map((d) => [d.id, []]));
    for (const item of cards || []) {
      const gid = getDeckGroupCategory(item);
      buckets.get(gid).push(item);
    }
    return defs
      .map((d) => {
        const items = buckets.get(d.id).slice().sort((a, b) => {
          return String(a.cardNumber || "").localeCompare(String(b.cardNumber || "")) ||
            String(a.name || "").localeCompare(String(b.name || ""));
        });
        const count = items.reduce((acc, x) => acc + Number(x.quantity || 0), 0);
        return { ...d, items, count };
      })
      .filter((g) => g.items.length > 0);
  }

  function setDeckDirty(dirty) {
    state.deckBuilder.isDirty = Boolean(dirty);
    updateDeckDirtyBadge();
  }

  function updateDeckDirtyBadge() {
    const badge = document.getElementById("deck-dirty-badge");
    if (!badge) return;
    const isCloud = Boolean(window.HololiveCloudBackend?.isCloudMode());
    const user = window.HololiveCloudBackend?.getCurrentUser();
    const deckId = state.editingDeck?.id;

    badge.classList.remove("is-dirty", "is-cloud-saved");
    if (state.deckBuilder.isDirty) {
      badge.textContent = "Cambios sin guardar";
      badge.classList.add("is-dirty");
    } else if (!deckId) {
      badge.textContent = "Nuevo mazo";
    } else if (user && isCloud) {
      badge.textContent = "☁ Guardado en Firebase";
      badge.classList.add("is-cloud-saved");
    } else {
      badge.textContent = "Guardado";
    }
  }

  function syncDeckOwnedInCollectionObject(deckObj, productId, nextOwned) {
    if (!deckObj) return false;
    let changed = false;
    if (deckObj.oshiCard && Number(deckObj.oshiCard.productId) === Number(productId)) {
      deckObj.oshiCard.ownedQuantity = nextOwned;
      changed = true;
    }
    for (const item of deckObj.cards || []) {
      if (Number(item.productId) === Number(productId)) {
        item.ownedQuantity = nextOwned;
        changed = true;
      }
    }
    return changed;
  }

  function syncEditingDeckOwnedCount(productId, nextOwned) {
    if (nextOwned === undefined || nextOwned === null) return;
    const touchedStudio = syncDeckOwnedInCollectionObject(state.editingDeck, productId, nextOwned);
    const touchedPreview = syncDeckOwnedInCollectionObject(state.previewDeck, productId, nextOwned);
    let touchedBrowser = false;
    if (state.deckBuilder.browserPage?.items) {
      for (const card of state.deckBuilder.browserPage.items) {
        if (Number(card.productId) === Number(productId)) {
          card.totalOwned = nextOwned;
          touchedBrowser = true;
        }
      }
    }
    if (state.activeView === "decks") {
      if ((touchedStudio || touchedBrowser) && state.editingDeck && !document.getElementById("deck-builder-studio")?.classList.contains("hidden")) {
        renderDeckPanel();
        if (state.deckBuilder.browserPage) renderDeckBrowserGrid(state.deckBuilder.browserPage);
      }
      if (touchedPreview && state.previewDeck && !document.getElementById("deck-preview-view")?.classList.contains("hidden")) {
        renderDeckPreview(state.previewDeck);
      }
    }
  }

  async function loadDecks() {
    try {
      const decks = await apiFetch("/api/decks");
      state.decks = decks;
      const isCloud = Boolean(window.HololiveCloudBackend?.isCloudMode());
      const user = window.HololiveCloudBackend?.getCurrentUser();
      updateDecksAuthStatus(user, isCloud);
      renderDecksList(decks);
    } catch (err) {
      showSnackbar(`Error cargando mazos: ${err.message}`);
    }
  }

  function renderDecksList(decks) {
    const host = document.getElementById("decks-grid");
    if (!host) return;
    if (!decks.length) {
      host.innerHTML = `
        <div class="panel-card" style="grid-column:1/-1;">
          <p class="muted-text" style="margin:0;">Aún no tienes mazos creados. Pulsa <strong>+ Nuevo Mazo</strong> o <strong>Importar lista / JSON</strong> para comenzar a armar tu primer deck.</p>
        </div>`;
      return;
    }

    host.innerHTML = decks
      .map((d) => {
        const isComplete = Boolean(d.oshiProductId) && d.mainCount === 50 && d.cheerCount === 20;
        const cov = Math.min(100, Number(d.ownedCoveragePct || 0));
        return `
          <article class="deck-gallery-card" data-open-deck="${escapeHtml(String(d.id))}">
            <div class="deck-gallery-top">
              ${
                d.oshiImageUrl
                  ? `<img class="deck-gallery-thumb" src="${escapeHtml(d.oshiImageUrl)}" alt="${escapeHtml(d.oshiName || d.name)}" loading="lazy" />`
                  : `<div class="deck-gallery-thumb-placeholder">Sin Oshi</div>`
              }
              <div class="deck-gallery-info">
                <h3 class="deck-gallery-title" title="${escapeHtml(d.name)}">${escapeHtml(d.name)}</h3>
                <div class="card-sub-meta">
                  <span>Oshi: ${escapeHtml(d.oshiName || "Sin elegir")}</span>
                </div>
                <div class="deck-gallery-badges">
                  <span class="deck-legality-pill ${isComplete ? "legal-ok" : "legal-wip"}">
                    ${isComplete ? "✓ Completo (1·50·20)" : `${d.oshiProductId ? 1 : 0}/1 · ${d.mainCount}/50 · ${d.cheerCount}/20`}
                  </span>
                  ${d.oshiColor ? `<span class="attr-chip">${escapeHtml(d.oshiColor)}</span>` : ""}
                </div>
              </div>
            </div>
            <div class="card-sub-meta">
              <span>Cobertura colección: <strong>${cov.toFixed(0)}%</strong></span>
              <span>Valor: <strong>${fmtMoney(d.estimatedCostUsd)}</strong></span>
            </div>
            <div class="md3-progress-track">
              <div class="md3-progress-fill ${cov >= 100 ? "is-complete" : ""}" style="width:${cov}%"></div>
            </div>
            <div class="card-sub-meta">
              <span>Faltante est.: <strong>${fmtMoney(d.missingCostUsd ?? 0)}</strong></span>
              <span>${d.updatedAt ? escapeHtml(String(d.updatedAt).slice(0, 10)) : ""}</span>
            </div>
            <div class="deck-gallery-actions">
              <button class="deck-mini-btn" data-deck-action="preview" data-deck-id="${escapeHtml(String(d.id))}" type="button">Ver</button>
              <button class="deck-mini-btn" data-deck-action="edit" data-deck-id="${escapeHtml(String(d.id))}" type="button">Editar</button>
              <button class="deck-mini-btn" data-deck-action="duplicate" data-deck-id="${escapeHtml(String(d.id))}" type="button">Duplicar</button>
              <button class="deck-mini-btn" data-deck-action="copy" data-deck-id="${escapeHtml(String(d.id))}" type="button">Copiar</button>
              <button class="deck-mini-btn danger" data-deck-action="delete" data-deck-id="${escapeHtml(String(d.id))}" type="button">Eliminar</button>
            </div>
          </article>`;
      })
      .join("");

    host.querySelectorAll("[data-open-deck]").forEach((cardEl) => {
      cardEl.addEventListener("click", (e) => {
        if (e.target.closest("[data-deck-action]")) return;
        openDeckPreview(cardEl.getAttribute("data-open-deck"));
      });
    });

    host.querySelectorAll("[data-deck-action]").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const deckId = btn.getAttribute("data-deck-id");
        const action = btn.getAttribute("data-deck-action");
        if (action === "preview") {
          await openDeckPreview(deckId);
        } else if (action === "edit") {
          await openDeckEditor(deckId);
        } else if (action === "duplicate") {
          await duplicateDeckById(deckId);
        } else if (action === "copy") {
          try {
            const detail = await apiFetch(`/api/decks/${encodeURIComponent(deckId)}`);
            await copyDeckTextToClipboard(detail);
          } catch (err) {
            showSnackbar(`Error al copiar mazo: ${err.message}`);
          }
        } else if (action === "delete") {
          await deleteDeckById(deckId);
        }
      });
    });
  }

  function setDeckSubView(mode) {
    document.getElementById("decks-gallery-view")?.classList.toggle("hidden", mode !== "gallery");
    document.getElementById("deck-preview-view")?.classList.toggle("hidden", mode !== "preview");
    document.getElementById("deck-builder-studio")?.classList.toggle("hidden", mode !== "studio");
  }

  async function openDeckPreview(deckId) {
    try {
      const detail = await apiFetch(`/api/decks/${encodeURIComponent(deckId)}`);
      state.previewDeck = detail;
      setDeckSubView("preview");
      renderDeckPreview(detail);
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (err) {
      showSnackbar(`Error cargando vista previa: ${err.message}`);
    }
  }

  function closeDeckPreview() {
    state.previewDeck = null;
    setDeckSubView("gallery");
  }

  function renderPreviewCardTile(card, showOwnership, isOshi) {
    const owned = Number(card.ownedQuantity || 0);
    const req = isOshi ? 1 : Number(card.quantity || 1);
    const ok = owned >= req;
    return `
      <div class="preview-card-tile" title="${escapeHtml(card.name)} (${escapeHtml(card.cardNumber || "S/N")})">
        ${
          card.imageUrl
            ? `<img data-preview-zoom="${card.productId}" src="${escapeHtml(card.imageUrl)}" alt="${escapeHtml(card.name)}" loading="lazy" />`
            : `<div class="art-fallback">${escapeHtml(card.name)}</div>`
        }
        ${
          showOwnership
            ? `<span class="preview-owned-badge ${ok ? "owned-ok" : "owned-short"}">${ok ? "✓ " : ""}${owned}/${req}</span>`
            : ""
        }
        <button class="preview-zoom-btn" data-preview-zoom="${card.productId}" type="button" title="Ver detalle de carta">🔍</button>
        ${isOshi ? "" : `<span class="preview-qty-box">${req}</span>`}
      </div>`;
  }

  function renderDeckPreview(deck) {
    if (!deck) return;
    const rules = evaluateDeckRules(deck);

    const titleEl = document.getElementById("preview-deck-title");
    if (titleEl) titleEl.textContent = deck.name || "Mazo";

    const pillEl = document.getElementById("preview-deck-legality-pill");
    if (pillEl) {
      pillEl.className = `deck-legality-pill ${rules.isLegal ? "legal-ok" : "legal-wip"}`;
      pillEl.textContent = rules.isLegal
        ? "✓ Completo (1 · 50 · 20)"
        : `${rules.hasOshi ? 1 : 0}/1 Oshi · ${rules.mainCount}/50 Main · ${rules.cheerCount}/20 Cheer`;
    }

    const ruleMeta = document.getElementById("preview-rule-meta");
    if (ruleMeta) {
      ruleMeta.textContent = `Cobertura: ${rules.coveragePct.toFixed(0)}% · Valor: ${fmtMoney(rules.totalCostUsd)} · Faltan: ${fmtMoney(rules.missingCostUsd)}`;
    }

    const notesEl = document.getElementById("preview-deck-notes");
    if (notesEl) {
      const desc = String(deck.description || "").trim();
      notesEl.textContent = desc;
      notesEl.classList.toggle("hidden", !desc);
    }

    // 3-Column Analytics Band (Bloom Level, Color, Types & Totals)
    const analyticsHost = document.getElementById("preview-analytics-band");
    if (analyticsHost) {
      const bloomBars = [
        { label: "Debut", count: rules.bloomCounts.Debut },
        { label: "1st", count: rules.bloomCounts["1st"] + rules.bloomCounts.Buzz },
        { label: "2nd", count: rules.bloomCounts["2nd"] },
        { label: "Spot", count: rules.bloomCounts.Spot },
      ];
      const maxBloom = Math.max(1, ...bloomBars.map((b) => b.count));

      const colorBarMeta = [
        { key: "White", label: "White", color: "#cbd5e1" },
        { key: "Green", label: "Green", color: "#22c55e" },
        { key: "Red", label: "Red", color: "#ef4444" },
        { key: "Blue", label: "Blue", color: "#3b82f6" },
        { key: "Purple", label: "Purple", color: "#a855f7" },
        { key: "Yellow", label: "Yellow", color: "#eab308" },
        { key: "Colorless", label: "Neutral", color: "#64748b" },
      ];
      const maxColor = Math.max(1, ...colorBarMeta.map((c) => rules.colorCounts[c.key] || 0));

      const holomemTotal = rules.typeCounts.Holomem + rules.typeCounts["Buzz Holomem"];
      const buzzTotal = rules.typeCounts["Buzz Holomem"];
      const supportTotal = rules.typeCounts.Support;
      const limitedTotal = rules.typeCounts.LIMITED;
      const cheerTotal = rules.typeCounts.Cheer;

      analyticsHost.innerHTML = `
        <section class="vchart-box">
          <h4 class="vchart-title">Bloom Level</h4>
          <div class="vchart-surface">
            <div class="vchart-cols">
              ${bloomBars
                .map((b) => {
                  const pct = b.count > 0 ? Math.max(8, Math.round((b.count / maxBloom) * 100)) : 0;
                  return `
                    <div class="vchart-col">
                      <span class="vchart-pill ${b.count > 0 ? "has-val" : ""}">${b.count}</span>
                      <div class="vchart-bar-wrap">
                        <div class="vchart-bar" style="height:${pct}%"></div>
                      </div>
                      <span class="vchart-label">${escapeHtml(b.label)}</span>
                    </div>`;
                })
                .join("")}
            </div>
          </div>
        </section>

        <section class="vchart-box">
          <h4 class="vchart-title">Color</h4>
          <div class="vchart-surface">
            <div class="vchart-cols">
              ${colorBarMeta
                .map((c) => {
                  const val = rules.colorCounts[c.key] || 0;
                  const pct = val > 0 ? Math.max(8, Math.round((val / maxColor) * 100)) : 0;
                  return `
                    <div class="vchart-col">
                      <span class="vchart-pill ${val > 0 ? "has-val" : ""}">${val}</span>
                      <div class="vchart-bar-wrap">
                        <div class="vchart-bar" style="height:${pct}%;background:${c.color};"></div>
                      </div>
                      <span class="vchart-label">${escapeHtml(c.label)}</span>
                    </div>`;
                })
                .join("")}
            </div>
          </div>
        </section>

        <section class="preview-type-panel">
          <div class="preview-type-band">
            <div class="preview-type-list">
              <div class="preview-type-accent"><span>Holomem</span><strong>${holomemTotal}</strong></div>
              <div class="preview-type-sub"><span>└ Buzz holomem</span><strong>${buzzTotal}</strong></div>
              <div class="preview-type-accent"><span>Support</span><strong>${supportTotal}</strong></div>
              <div class="preview-type-sub"><span>└ LIMITED</span><strong>${limitedTotal}</strong></div>
            </div>
            <div class="preview-type-big">${rules.mainCount} / 50</div>
          </div>
          <hr style="border:none;border-top:1px solid var(--md-sys-color-outline-variant);margin:2px 0;" />
          <div class="preview-type-band">
            <div class="preview-type-list">
              <div class="preview-type-accent"><span>Cheer</span><strong>${cheerTotal}</strong></div>
            </div>
            <div class="preview-type-big">${rules.cheerCount} / 20</div>
          </div>
          <div class="preview-collector-row">
            <span>Tienes <strong>${rules.ownedCopies}/${rules.totalRequiredCopies}</strong> (${rules.coveragePct.toFixed(0)}%)</span>
            <button id="preview-add-missing-wishlist-btn" class="outlined-btn" style="height:32px;padding:0 12px;font-size:0.76rem;" type="button" title="Agregar cartas faltantes a Wishlist" ${rules.missingCards.length === 0 ? "disabled" : ""}>
              ${rules.missingCards.length ? `♥ Faltantes (${rules.missingCards.length})` : "♥ Completo"}
            </button>
          </div>
        </section>`;

      document.getElementById("preview-add-missing-wishlist-btn")?.addEventListener("click", () => {
        addMissingCardsToWishlistForDeck(state.previewDeck, "preview-add-missing-wishlist-btn");
      });
    }

    // Visual Card Sheet (Oshi, Main Deck, Cheer Deck)
    const sheetHost = document.getElementById("preview-deck-sheet");
    if (!sheetHost) return;
    const showOwnership = Boolean(state.deckBuilder.previewShowOwnership);
    const toggleEl = document.getElementById("preview-ownership-toggle");
    if (toggleEl) toggleEl.checked = showOwnership;

    const mainCardsOrdered = [];
    const mainOrderRank = { debut: 1, "1st": 2, "2nd": 3, spot: 4, other: 5, support: 6 };
    for (const c of (deck.cards || []).filter((x) => (x.zone || "main") !== "cheer")) {
      mainCardsOrdered.push(c);
    }
    mainCardsOrdered.sort((a, b) => {
      const ra = mainOrderRank[getDeckGroupCategory(a)] || 9;
      const rb = mainOrderRank[getDeckGroupCategory(b)] || 9;
      if (ra !== rb) return ra - rb;
      return String(a.cardNumber || "").localeCompare(String(b.cardNumber || "")) ||
        String(a.name || "").localeCompare(String(b.name || ""));
    });

    const cheerCardsOrdered = (deck.cards || [])
      .filter((x) => x.zone === "cheer")
      .slice()
      .sort((a, b) => String(a.cardNumber || "").localeCompare(String(b.cardNumber || "")) || String(a.name || "").localeCompare(String(b.name || "")));

    sheetHost.innerHTML = `
      <section class="preview-section-block">
        <h3 class="preview-section-title">
          <span>Oshi</span>
          <span class="edition-abbr">${rules.hasOshi ? "1 / 1" : "0 / 1"}</span>
        </h3>
        ${
          deck.oshiCard
            ? `<div class="preview-cards-grid">${renderPreviewCardTile(deck.oshiCard, showOwnership, true)}</div>`
            : `<p class="muted-text" style="margin:0;">Este mazo aún no tiene una carta Oshi asignada.</p>`
        }
      </section>

      <section class="preview-section-block">
        <h3 class="preview-section-title">
          <span>Main Deck</span>
          <span class="edition-abbr">${rules.mainCount} / 50</span>
        </h3>
        ${
          mainCardsOrdered.length
            ? `<div class="preview-cards-grid">${mainCardsOrdered.map((c) => renderPreviewCardTile(c, showOwnership, false)).join("")}</div>`
            : `<p class="muted-text" style="margin:0;">Sin cartas en el Main Deck todavía.</p>`
        }
      </section>

      <section class="preview-section-block">
        <h3 class="preview-section-title">
          <span>Cheer Deck</span>
          <span class="edition-abbr">${rules.cheerCount} / 20</span>
        </h3>
        ${
          cheerCardsOrdered.length
            ? `<div class="preview-cards-grid">${cheerCardsOrdered.map((c) => renderPreviewCardTile(c, showOwnership, false)).join("")}</div>`
            : `<p class="muted-text" style="margin:0;">Sin cartas en el Cheer Deck todavía.</p>`
        }
      </section>`;

    sheetHost.querySelectorAll("[data-preview-zoom]").forEach((el) => {
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        openCardModal(Number(el.getAttribute("data-preview-zoom")));
      });
    });
  }

  function setDeckMobilePane(pane) {
    state.deckBuilder.mobilePane = pane === "deck" ? "deck" : "browser";
    const grid = document.querySelector(".deck-studio-grid");
    if (grid) grid.setAttribute("data-mobile-pane", state.deckBuilder.mobilePane);
    document.querySelectorAll(".deck-mobile-tab").forEach((btn) => {
      btn.classList.toggle("active", btn.getAttribute("data-deck-pane") === state.deckBuilder.mobilePane);
    });
  }

  function setDeckZoneTab(zone) {
    const f = state.deckBuilder.filters;
    f.zone = zone;
    f.page = 1;
    if (zone !== "main") {
      f.card_type = "";
      f.bloom_level = "";
      f.limited_only = false;
      syncDeckChipStates();
    }
    document.querySelectorAll("#deck-zone-tabs .zone-tab-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.getAttribute("data-zone") === zone);
    });
    document.getElementById("deck-main-subfilters")?.classList.toggle("hidden", zone !== "main");
    loadDeckBrowserCards();
  }

  function syncDeckChipStates() {
    const f = state.deckBuilder.filters;
    document.querySelectorAll("#deck-color-chips [data-deck-color]").forEach((btn) => {
      btn.classList.toggle("active", btn.getAttribute("data-deck-color") === f.color);
    });
    document.querySelectorAll("#deck-type-chips [data-deck-type]").forEach((btn) => {
      const val = btn.getAttribute("data-deck-type");
      const active = val === "LIMITED" ? f.limited_only : !f.limited_only && val === f.card_type;
      btn.classList.toggle("active", active);
    });
    document.querySelectorAll("#deck-bloom-chips [data-deck-bloom]").forEach((btn) => {
      btn.classList.toggle("active", btn.getAttribute("data-deck-bloom") === f.bloom_level);
    });
  }

  function resetDeckBrowserFilters() {
    const zone = state.deckBuilder.filters.zone || "main";
    state.deckBuilder.filters = {
      zone,
      q: "",
      color: "",
      card_type: "",
      bloom_level: "",
      limited_only: false,
      group_id: "",
      rarity: "",
      parallel: "all",
      owned_only: false,
      sort: "number_asc",
      page: 1,
      per_page: 40,
    };
    const qEl = document.getElementById("deck-card-search");
    if (qEl) qEl.value = "";
    const edEl = document.getElementById("deck-filter-edition");
    if (edEl) edEl.value = "";
    const rarEl = document.getElementById("deck-filter-rarity");
    if (rarEl) rarEl.value = "";
    const parEl = document.getElementById("deck-filter-parallel");
    if (parEl) parEl.value = "all";
    const sortEl = document.getElementById("deck-filter-sort");
    if (sortEl) sortEl.value = "number_asc";
    const ownEl = document.getElementById("deck-filter-owned-only");
    if (ownEl) ownEl.checked = false;
    syncDeckChipStates();
    loadDeckBrowserCards();
  }

  async function openDeckEditor(deckId) {
    let detail;
    if (!deckId) {
      detail = {
        id: null,
        name: "",
        oshiProductId: null,
        oshiCard: null,
        description: "",
        cards: [],
      };
    } else {
      detail = await apiFetch(`/api/decks/${encodeURIComponent(deckId)}`);
    }

    state.previewDeck = null;
    state.editingDeck = detail;
    setDeckDirty(false);
    document.getElementById("deck-name-input").value = detail.name || "";
    document.getElementById("deck-desc-input").value = detail.description || "";
    document.getElementById("delete-deck-btn").classList.toggle("hidden", !detail.id);
    document.getElementById("duplicate-deck-btn").classList.toggle("hidden", !detail.id);

    setDeckSubView("studio");
    setDeckMobilePane("browser");
    resetDeckBrowserFilters();
    const initialZone = detail.oshiProductId ? "main" : "oshi";
    setDeckZoneTab(initialZone);
    renderDeckPanel();
  }

  function closeDeckEditor() {
    if (state.deckBuilder.isDirty) {
      const ok = window.confirm("Tienes cambios sin guardar en el mazo. ¿Volver a Mis Mazos sin guardar?");
      if (!ok) return;
    }
    state.editingDeck = null;
    setDeckDirty(false);
    setDeckSubView("gallery");
    loadDecks();
  }

  async function loadDeckBrowserCards() {
    const f = state.deckBuilder.filters;
    const params = new URLSearchParams();
    params.set("item_category", "card");
    params.set("deck_zone", f.zone);
    if (f.q.trim()) params.set("q", f.q.trim());
    if (f.color) params.set("color", f.color);
    if (f.card_type && f.zone === "main") params.set("card_type", f.card_type);
    if (f.bloom_level && f.zone === "main") params.set("bloom_level", f.bloom_level);
    if (f.limited_only && f.zone === "main") params.set("limited_only", "true");
    if (f.group_id) params.set("group_id", f.group_id);
    if (f.rarity) params.set("rarity", f.rarity);
    if (f.parallel && f.parallel !== "all") params.set("parallel", f.parallel);
    if (f.owned_only) params.set("ownership", "owned");
    params.set("sort", f.sort);
    params.set("page", String(f.page));
    params.set("per_page", String(f.per_page));

    const metaEl = document.getElementById("deck-browser-meta");
    if (metaEl) metaEl.textContent = "Buscando cartas...";

    try {
      const pageData = await apiFetch(`/api/cards?${params.toString()}`);
      state.deckBuilder.browserPage = pageData;
      renderDeckBrowserGrid(pageData);
    } catch (err) {
      if (metaEl) metaEl.textContent = `Error: ${err.message}`;
    }
  }

  function getDeckQtyForBrowserCard(card) {
    const deck = state.editingDeck;
    if (!deck) return 0;
    if (card.cardType === "Oshi Holomem") {
      return Number(deck.oshiProductId) === Number(card.productId) ? 1 : 0;
    }
    const zone = card.cardType === "Cheer" ? "cheer" : "main";
    const found = (deck.cards || []).find(
      (c) => Number(c.productId) === Number(card.productId) && (c.zone || "main") === zone
    );
    return found ? Number(found.quantity || 0) : 0;
  }

  function renderDeckPickerActionHtml(card) {
    if (card.cardType === "Oshi Holomem") {
      const selected = Number(state.editingDeck?.oshiProductId) === Number(card.productId);
      return `<button class="deck-add-btn ${selected ? "is-oshi-selected" : ""}" data-pick-oshi="${card.productId}" type="button">${selected ? "✓ Oshi elegido" : "★ Elegir Oshi"}</button>`;
    }

    const qty = getDeckQtyForBrowserCard(card);
    if (qty <= 0) {
      return `<button class="deck-add-btn" data-pick-delta="1" data-pick-pid="${card.productId}" type="button">+ Añadir</button>`;
    }

    const zone = card.cardType === "Cheer" ? "cheer" : "main";
    const unlimited = isUnlimitedCopyCard(card);
    const numTotal = unlimited ? qty : getDeckCardNumberCount(state.editingDeck, card.cardNumber, card.productId, zone);
    const rules = evaluateDeckRules(state.editingDeck);
    const zoneFull = zone === "cheer" ? rules.cheerCount >= 20 : rules.mainCount >= 50;
    const atCap = (!unlimited && numTotal >= 4) || zoneFull;
    const capTitle = zoneFull
      ? `Límite de zona alcanzado`
      : !unlimited && numTotal >= 4
        ? `Máximo 4 copias de ${card.cardNumber || card.name}`
        : "Sumar copia";

    return `
      <div class="deck-inline-stepper">
        <button class="deck-inline-btn" data-pick-delta="-1" data-pick-pid="${card.productId}" type="button" aria-label="Quitar copia">−</button>
        <span class="deck-inline-count">${unlimited ? qty : `${qty}/4`}</span>
        <button class="deck-inline-btn" data-pick-delta="1" data-pick-pid="${card.productId}" type="button" aria-label="Sumar copia" title="${escapeHtml(capTitle)}" ${atCap ? "disabled" : ""}>+</button>
      </div>`;
  }

  function syncDeckBrowserCardsInPlace() {
    const grid = document.getElementById("deck-browser-grid");
    const items = state.deckBuilder.browserPage?.items || [];
    if (!grid || !items.length) return;

    const byPid = new Map(items.map((c) => [Number(c.productId), c]));
    grid.querySelectorAll("[data-browser-pid]").forEach((tile) => {
      const pid = Number(tile.getAttribute("data-browser-pid"));
      const card = byPid.get(pid);
      if (!card) return;
      const inDeck = getDeckQtyForBrowserCard(card) > 0;
      tile.classList.toggle("in-deck", inDeck);
      const actionBox = tile.querySelector(".deck-pick-actions");
      if (actionBox) {
        actionBox.innerHTML = renderDeckPickerActionHtml(card);
        bindDeckPickerActionEvents(actionBox, card);
      }
    });
  }

  function bindDeckPickerActionEvents(container, card) {
    container.querySelectorAll("[data-pick-oshi]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        selectOshiForDeck(card);
      });
    });
    container.querySelectorAll("[data-pick-delta]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const delta = Number(btn.getAttribute("data-pick-delta"));
        adjustCardInEditingDeck(card, delta);
      });
    });
  }

  function renderDeckBrowserGrid(pageData) {
    const grid = document.getElementById("deck-browser-grid");
    const meta = document.getElementById("deck-browser-meta");
    const pagHost = document.getElementById("deck-browser-pagination");
    if (!grid || !meta || !pagHost) return;

    const items = pageData.items || [];
    meta.textContent = `Mostrando ${items.length} de ${Number(pageData.total || 0).toLocaleString()} cartas (Pág. ${pageData.page}/${pageData.totalPages})`;

    if (!items.length) {
      grid.innerHTML = `<div class="panel-card" style="grid-column:1/-1;"><p class="muted-text" style="margin:0;">Sin cartas para estos filtros. Prueba limpiar filtros o cambiar de zona.</p></div>`;
      pagHost.innerHTML = "";
      return;
    }

    grid.innerHTML = items
      .map((card) => {
        const price = card.marketPrice ?? card.foilMarketPrice;
        const inDeck = getDeckQtyForBrowserCard(card) > 0;
        const owned = Number(card.totalOwned || 0);
        return `
          <article class="deck-pick-card ${inDeck ? "in-deck" : ""}" data-browser-pid="${card.productId}">
            <div class="deck-pick-art" data-zoom-pid="${card.productId}">
              ${
                card.imageUrl
                  ? `<img src="${escapeHtml(card.imageUrl)}" alt="${escapeHtml(card.name)}" loading="lazy" />`
                  : `<div class="art-fallback">${escapeHtml(card.name)}</div>`
              }
              <span class="deck-owned-pill ${owned > 0 ? "has-owned" : ""}">Tienes: ${owned}</span>
              <button class="deck-zoom-btn" data-zoom-pid="${card.productId}" type="button" title="Ver detalle y colección">🔍</button>
            </div>
            <div class="deck-pick-meta">
              <div class="deck-pick-title" title="${escapeHtml(card.name)}">${escapeHtml(card.name)}</div>
              <div class="deck-pick-sub">
                <span>${escapeHtml(card.cardNumber || "S/N")} · ${escapeHtml(card.rarity || "—")}</span>
                <strong>${fmtMoney(price)}</strong>
              </div>
              <div class="deck-pick-sub">
                <span>${escapeHtml(card.bloomLevel || card.cardType || "")}</span>
                <span>${escapeHtml(card.color || "")}</span>
              </div>
            </div>
            <div class="deck-pick-actions">${renderDeckPickerActionHtml(card)}</div>
          </article>`;
      })
      .join("");

    const byPid = new Map(items.map((c) => [Number(c.productId), c]));
    grid.querySelectorAll("[data-browser-pid]").forEach((tile) => {
      const pid = Number(tile.getAttribute("data-browser-pid"));
      const card = byPid.get(pid);
      if (!card) return;

      tile.querySelector(".deck-pick-art")?.addEventListener("click", (e) => {
        if (e.target.closest(".deck-zoom-btn")) return;
        if (card.cardType === "Oshi Holomem") selectOshiForDeck(card);
        else adjustCardInEditingDeck(card, 1);
      });
      tile.querySelector(".deck-zoom-btn")?.addEventListener("click", (e) => {
        e.stopPropagation();
        openCardModal(card.productId);
      });
      const actionsEl = tile.querySelector(".deck-pick-actions");
      if (actionsEl) bindDeckPickerActionEvents(actionsEl, card);
    });

    if (pageData.totalPages <= 1) {
      pagHost.innerHTML = "";
    } else {
      pagHost.innerHTML = `
        <span class="page-info">Página ${pageData.page} de ${pageData.totalPages}</span>
        <div class="pagination-controls">
          <button class="page-btn" id="deck-page-prev" type="button" ${pageData.page <= 1 ? "disabled" : ""}>Anterior</button>
          <button class="page-btn" id="deck-page-next" type="button" ${pageData.page >= pageData.totalPages ? "disabled" : ""}>Siguiente</button>
        </div>`;
      document.getElementById("deck-page-prev")?.addEventListener("click", () => {
        if (state.deckBuilder.filters.page > 1) {
          state.deckBuilder.filters.page -= 1;
          loadDeckBrowserCards();
        }
      });
      document.getElementById("deck-page-next")?.addEventListener("click", () => {
        if (state.deckBuilder.filters.page < pageData.totalPages) {
          state.deckBuilder.filters.page += 1;
          loadDeckBrowserCards();
        }
      });
    }
  }

  function selectOshiForDeck(card) {
    if (!state.editingDeck || !card) return;
    state.editingDeck.oshiProductId = Number(card.productId);
    state.editingDeck.oshiCard = {
      productId: Number(card.productId),
      zone: "oshi",
      quantity: 1,
      ownedQuantity: card.totalOwned ?? card.ownedQuantity ?? 0,
      name: card.name,
      cardNumber: card.cardNumber || "",
      cardType: card.cardType || "Oshi Holomem",
      bloomLevel: card.bloomLevel || "",
      color: card.color || "",
      rarity: card.rarity || "",
      effectText: card.effectText || "",
      imageUrl: card.imageUrl || "",
      marketPrice: card.marketPrice ?? card.foilMarketPrice ?? null,
    };
    setDeckDirty(true);
    renderDeckPanel();
    if (state.deckBuilder.filters.zone === "oshi") {
      setDeckZoneTab("main");
      showSnackbar(`★ Oshi elegido: ${card.name} — ahora arma tu Main Deck (50)`);
    } else {
      syncDeckBrowserCardsInPlace();
      showSnackbar(`★ Oshi actualizado: ${card.name}`);
    }
  }

  function adjustCardInEditingDeck(cardOrItem, delta) {
    if (!state.editingDeck || !cardOrItem || !delta) return;
    if (cardOrItem.cardType === "Oshi Holomem") {
      if (delta > 0) selectOshiForDeck(cardOrItem);
      else {
        state.editingDeck.oshiProductId = null;
        state.editingDeck.oshiCard = null;
        setDeckDirty(true);
        renderDeckPanel();
        syncDeckBrowserCardsInPlace();
      }
      return;
    }

    const deck = state.editingDeck;
    const pid = Number(cardOrItem.productId);
    const zone = cardOrItem.cardType === "Cheer" || cardOrItem.zone === "cheer" ? "cheer" : "main";
    const idx = deck.cards.findIndex((c) => Number(c.productId) === pid && (c.zone || "main") === zone);
    const existing = idx >= 0 ? deck.cards[idx] : null;
    const unlimited = isUnlimitedCopyCard(cardOrItem);

    if (delta > 0) {
      const rules = evaluateDeckRules(deck);
      if (zone === "cheer" && rules.cheerCount + delta > 20) {
        showSnackbar("Cheer Deck completo (máximo 20 cartas).");
        return;
      }
      if (zone === "main" && rules.mainCount + delta > 50) {
        showSnackbar("Main Deck completo (máximo 50 cartas).");
        return;
      }
      if (!unlimited && zone === "main") {
        const sameNum = getDeckCardNumberCount(deck, cardOrItem.cardNumber, pid, "main");
        if (sameNum + delta > 4) {
          showSnackbar(`Límite oficial: máximo 4 copias de ${cardOrItem.cardNumber || cardOrItem.name}.`);
          return;
        }
      }
    }

    if (existing) {
      const nextQty = Number(existing.quantity || 0) + delta;
      if (nextQty <= 0) {
        deck.cards.splice(idx, 1);
      } else {
        existing.quantity = nextQty;
      }
    } else if (delta > 0) {
      deck.cards.push({
        productId: pid,
        zone,
        quantity: delta,
        ownedQuantity: cardOrItem.totalOwned ?? cardOrItem.ownedQuantity ?? 0,
        name: cardOrItem.name,
        cardNumber: cardOrItem.cardNumber || "",
        cardType: cardOrItem.cardType || "",
        bloomLevel: cardOrItem.bloomLevel || "",
        color: cardOrItem.color || "",
        rarity: cardOrItem.rarity || "",
        effectText: cardOrItem.effectText || "",
        imageUrl: cardOrItem.imageUrl || "",
        marketPrice: cardOrItem.marketPrice ?? cardOrItem.foilMarketPrice ?? null,
      });
    }

    setDeckDirty(true);
    renderDeckPanel();
    syncDeckBrowserCardsInPlace();
    if (!document.getElementById("deck-stats-modal")?.classList.contains("hidden")) {
      renderDeckStatsModal();
    }
  }

  function renderDeckPanel() {
    const deck = state.editingDeck;
    if (!deck) return;

    const rules = evaluateDeckRules(deck);

    // Zone tab badges & mobile counter
    const zOshi = document.getElementById("zone-count-oshi");
    const zMain = document.getElementById("zone-count-main");
    const zCheer = document.getElementById("zone-count-cheer");
    const mobileCount = document.getElementById("mobile-deck-count");
    if (zOshi) zOshi.textContent = `${rules.hasOshi ? 1 : 0}/1`;
    if (zMain) zMain.textContent = `${rules.mainCount}/50`;
    if (zCheer) zCheer.textContent = `${rules.cheerCount}/20`;
    if (mobileCount) mobileCount.textContent = `${rules.totalCount}/71`;

    // Progress bars
    const mainLabel = document.getElementById("deck-main-progress-label");
    const mainBar = document.getElementById("deck-main-progress-bar");
    const cheerLabel = document.getElementById("deck-cheer-progress-label");
    const cheerBar = document.getElementById("deck-cheer-progress-bar");

    if (mainLabel) mainLabel.textContent = `${rules.mainCount} / 50`;
    if (mainBar) {
      mainBar.style.width = `${Math.min(100, (rules.mainCount / 50) * 100)}%`;
      mainBar.classList.toggle("is-complete", rules.mainCount === 50);
      mainBar.classList.toggle("is-over", rules.mainCount > 50);
    }

    if (cheerLabel) cheerLabel.textContent = `${rules.cheerCount} / 20`;
    if (cheerBar) {
      cheerBar.style.width = `${Math.min(100, (rules.cheerCount / 20) * 100)}%`;
      cheerBar.classList.toggle("is-complete", rules.cheerCount === 20);
      cheerBar.classList.toggle("is-over", rules.cheerCount > 20);
    }

    // Legality box
    const statusEl = document.getElementById("deck-legality-status");
    const hintsEl = document.getElementById("deck-validation-hints");
    if (statusEl) {
      statusEl.classList.remove("is-legal", "is-wip", "is-invalid");
      if (rules.violations.length > 0) {
        statusEl.classList.add("is-invalid");
        statusEl.textContent = "Revisar reglas del mazo";
      } else if (rules.isLegal) {
        statusEl.classList.add("is-legal");
        statusEl.textContent = "✓ Mazo legal y listo (1 Oshi · 50 Main · 20 Cheer)";
      } else {
        statusEl.classList.add("is-wip");
        statusEl.textContent = "En construcción (Estándar: 1 Oshi · 50 Main · 20 Cheer)";
      }
    }
    if (hintsEl) {
      const messages = [...rules.violations, ...rules.hints];
      hintsEl.innerHTML = messages.map((m) => `<li>${escapeHtml(m)}</li>`).join("");
    }

    // Collector stats
    const covEl = document.getElementById("deck-coverage-val");
    const totEl = document.getElementById("deck-cost-total");
    const misEl = document.getElementById("deck-cost-missing");
    const wishBtn = document.getElementById("deck-add-missing-wishlist-btn");
    if (covEl) covEl.textContent = `${rules.coveragePct.toFixed(0)}%`;
    if (totEl) totEl.textContent = fmtMoney(rules.totalCostUsd);
    if (misEl) misEl.textContent = fmtMoney(rules.missingCostUsd);
    if (wishBtn) {
      wishBtn.disabled = rules.missingCards.length === 0;
      wishBtn.textContent = rules.missingCards.length
        ? `♥ Faltantes (${rules.missingCards.length})`
        : "♥ Completo";
    }

    // Oshi slot + Quick "match Oshi color" button
    const oshiSlot = document.getElementById("deck-oshi-slot");
    const matchColorBtn = document.getElementById("deck-match-oshi-color-btn");
    const oshi = deck.oshiCard;
    if (oshiSlot) {
      if (deck.oshiProductId && oshi) {
        const oOwned = Number(oshi.ownedQuantity || 0);
        oshiSlot.innerHTML = `
          <div class="deck-oshi-filled">
            ${oshi.imageUrl ? `<img class="deck-oshi-thumb" src="${escapeHtml(oshi.imageUrl)}" alt="${escapeHtml(oshi.name)}" />` : ""}
            <div style="flex:1;min-width:0;">
              <div class="kpi-label">Oshi Holomem</div>
              <div style="font-weight:800;font-size:0.88rem;" class="truncate">${escapeHtml(oshi.name)}</div>
              <div class="deck-list-meta">
                <span>${escapeHtml(oshi.cardNumber || "S/N")} · ${escapeHtml(oshi.color || "—")}</span>
                <span class="owned-tag ${oOwned >= 1 ? "owned-ok" : "owned-short"}">Tienes ${oOwned}/1</span>
              </div>
            </div>
            <div style="display:flex;flex-direction:column;gap:4px;">
              <button class="deck-mini-btn" id="oshi-slot-change-btn" type="button">Cambiar</button>
              <button class="deck-mini-btn danger" id="oshi-slot-remove-btn" type="button">Quitar</button>
            </div>
          </div>`;
        oshiSlot.querySelector(".deck-oshi-thumb")?.addEventListener("click", () => openCardModal(oshi.productId));
        document.getElementById("oshi-slot-change-btn")?.addEventListener("click", () => setDeckZoneTab("oshi"));
        document.getElementById("oshi-slot-remove-btn")?.addEventListener("click", () => {
          state.editingDeck.oshiProductId = null;
          state.editingDeck.oshiCard = null;
          setDeckDirty(true);
          renderDeckPanel();
          syncDeckBrowserCardsInPlace();
        });
      } else {
        oshiSlot.innerHTML = `
          <div class="deck-oshi-empty">
            <div>
              <div class="kpi-label">Oshi Holomem (0/1)</div>
              <div class="muted-text" style="font-size:0.78rem;">Elige tu Oshi para definir la estrategia del mazo.</div>
            </div>
            <button class="tonal-btn" id="oshi-slot-pick-btn" type="button">★ Elegir Oshi</button>
          </div>`;
        document.getElementById("oshi-slot-pick-btn")?.addEventListener("click", () => setDeckZoneTab("oshi"));
      }
    }

    if (matchColorBtn) {
      const oshiColor = String(oshi?.color || "").split("/")[0].trim();
      const validQuickColor = oshiColor && oshiColor !== "Colorless";
      matchColorBtn.classList.toggle("hidden", !validQuickColor);
      if (validQuickColor) {
        matchColorBtn.textContent = `Filtrar color ${oshiColor}`;
        matchColorBtn.setAttribute("data-target-color", oshiColor);
      }
    }

    // Mini curve pills
    const curveEl = document.getElementById("deck-mini-curve");
    if (curveEl) {
      const pills = [
        `Debut: ${rules.bloomCounts.Debut}`,
        `1st: ${rules.bloomCounts["1st"]}`,
        `Buzz: ${rules.bloomCounts.Buzz}`,
        `2nd: ${rules.bloomCounts["2nd"]}`,
        `Spot: ${rules.bloomCounts.Spot}`,
        `Support: ${rules.typeCounts.Support}${rules.typeCounts.LIMITED ? ` (${rules.typeCounts.LIMITED} LIM)` : ""}`,
        `Cheer: ${rules.typeCounts.Cheer}`,
      ];
      curveEl.innerHTML = pills.map((p) => `<span class="mini-curve-pill">${escapeHtml(p)}</span>`).join("");
    }

    // Grouped Deck Cards
    const summaryLabel = document.getElementById("deck-cards-summary-label");
    if (summaryLabel) {
      summaryLabel.textContent = `Main ${rules.mainCount} · Cheer ${rules.cheerCount}`;
    }

    const viewListBtn = document.getElementById("deck-view-list");
    const viewVisualBtn = document.getElementById("deck-view-visual");
    viewListBtn?.classList.toggle("active", state.deckBuilder.deckViewMode === "list");
    viewVisualBtn?.classList.toggle("active", state.deckBuilder.deckViewMode === "visual");

    const listHost = document.getElementById("deck-cards-list");
    if (!listHost) return;
    const groups = groupDeckCards(deck.cards);
    if (!groups.length) {
      listHost.innerHTML = `<p class="muted-text" style="margin:6px 0;">Tu mazo aún no tiene cartas en Main o Cheer. Haz clic en cualquier carta a la izquierda para añadirla.</p>`;
      return;
    }

    const byKey = new Map(deck.cards.map((c) => [`${c.productId}:${c.zone || "main"}`, c]));
    const isVisual = state.deckBuilder.deckViewMode === "visual";

    listHost.innerHTML = groups
      .map((g) => {
        const bodyHtml = isVisual
          ? `<div class="deck-visual-grid">${g.items.map((item) => renderDeckPanelVisualTile(deck, rules, item)).join("")}</div>`
          : g.items.map((item) => renderDeckPanelListRow(deck, rules, item)).join("");
        return `
          <div class="deck-group-section">
            <div class="deck-group-header">
              <span>${escapeHtml(g.label)}</span>
              <span>${g.count}</span>
            </div>
            ${bodyHtml}
          </div>`;
      })
      .join("");

    listHost.querySelectorAll("[data-panel-qty]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const key = btn.getAttribute("data-panel-key");
        const delta = Number(btn.getAttribute("data-panel-qty"));
        const target = byKey.get(key);
        if (target) adjustCardInEditingDeck(target, delta);
      });
    });

    listHost.querySelectorAll("[data-panel-zoom]").forEach((el) => {
      el.addEventListener("click", () => {
        openCardModal(Number(el.getAttribute("data-panel-zoom")));
      });
    });
  }

  function renderDeckPanelListRow(deck, rules, item) {
    const zone = item.zone === "cheer" ? "cheer" : "main";
    const unlimited = isUnlimitedCopyCard(item);
    const sameNumCount = unlimited ? item.quantity : getDeckCardNumberCount(deck, item.cardNumber, item.productId, "main");
    const zoneFull = zone === "cheer" ? rules.cheerCount >= 20 : rules.mainCount >= 50;
    const disablePlus = (!unlimited && sameNumCount >= 4) || zoneFull;
    const owned = Number(item.ownedQuantity || 0);
    const ok = owned >= item.quantity;
    const itemKey = `${item.productId}:${zone}`;

    return `
      <div class="deck-list-item">
        ${
          item.imageUrl
            ? `<img class="deck-list-thumb" data-panel-zoom="${item.productId}" src="${escapeHtml(item.imageUrl)}" alt="${escapeHtml(item.name)}" loading="lazy" />`
            : `<div class="deck-list-thumb"></div>`
        }
        <div class="deck-list-info">
          <div class="deck-list-name" data-panel-zoom="${item.productId}" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</div>
          <div class="deck-list-meta">
            <span>${escapeHtml(item.cardNumber || "S/N")} · ${escapeHtml(item.rarity || "")}</span>
            <span class="owned-tag ${ok ? "owned-ok" : "owned-short"}">${owned}/${item.quantity}</span>
            ${item.marketPrice ? `<span>${fmtMoney(item.marketPrice * item.quantity)}</span>` : ""}
          </div>
        </div>
        <div class="stepper-controls">
          <button class="step-btn" data-panel-key="${escapeHtml(itemKey)}" data-panel-qty="-1" type="button">−</button>
          <span class="step-qty">${unlimited ? item.quantity : `${item.quantity}/4`}</span>
          <button class="step-btn plus" data-panel-key="${escapeHtml(itemKey)}" data-panel-qty="1" type="button" ${disablePlus ? "disabled" : ""}>+</button>
        </div>
      </div>`;
  }

  function renderDeckPanelVisualTile(deck, rules, item) {
    const zone = item.zone === "cheer" ? "cheer" : "main";
    const unlimited = isUnlimitedCopyCard(item);
    const sameNumCount = unlimited ? item.quantity : getDeckCardNumberCount(deck, item.cardNumber, item.productId, "main");
    const zoneFull = zone === "cheer" ? rules.cheerCount >= 20 : rules.mainCount >= 50;
    const disablePlus = (!unlimited && sameNumCount >= 4) || zoneFull;
    const itemKey = `${item.productId}:${zone}`;

    return `
      <div class="deck-visual-tile" title="${escapeHtml(item.name)} (${escapeHtml(item.cardNumber)})">
        ${
          item.imageUrl
            ? `<img data-panel-zoom="${item.productId}" src="${escapeHtml(item.imageUrl)}" alt="${escapeHtml(item.name)}" loading="lazy" />`
            : `<div class="art-fallback">${escapeHtml(item.name)}</div>`
        }
        <span class="deck-visual-qty">×${item.quantity}</span>
        <div class="deck-visual-bar">
          <button data-panel-key="${escapeHtml(itemKey)}" data-panel-qty="-1" type="button">−</button>
          <button data-panel-key="${escapeHtml(itemKey)}" data-panel-qty="1" type="button" ${disablePlus ? "disabled" : ""}>+</button>
        </div>
      </div>`;
  }

  function renderDeckStatsModal() {
    const deck = state.editingDeck;
    const content = document.getElementById("deck-stats-content");
    if (!deck || !content) return;
    const rules = evaluateDeckRules(deck);

    const bloomEntries = [
      ["Debut", rules.bloomCounts.Debut],
      ["1st", rules.bloomCounts["1st"]],
      ["Buzz (1st)", rules.bloomCounts.Buzz],
      ["2nd", rules.bloomCounts["2nd"]],
      ["Spot", rules.bloomCounts.Spot],
    ];
    const maxBloom = Math.max(1, ...bloomEntries.map(([, v]) => v));

    const colorEntries = HOLOLIVE_COLORS.map((c) => [c, rules.colorCounts[c] || 0]).filter(([, v]) => v > 0);
    const maxColor = Math.max(1, ...colorEntries.map(([, v]) => v));
    const colorClassMap = {
      White: "bar-fill-white",
      Green: "bar-fill-green",
      Red: "bar-fill-red",
      Blue: "bar-fill-blue",
      Purple: "bar-fill-purple",
      Yellow: "bar-fill-yellow",
      Colorless: "bar-fill-colorless",
      "Multi-color": "bar-fill-purple",
    };

    const allCards = [];
    if (deck.oshiProductId && deck.oshiCard) allCards.push(deck.oshiCard);
    for (const group of groupDeckCards(deck.cards)) {
      allCards.push(...group.items);
    }
    const byKey = new Map((deck.cards || []).map((c) => [`${c.productId}:${c.zone || "main"}`, c]));

    content.innerHTML = `
      <div class="deck-legality-status ${rules.violations.length ? "is-invalid" : rules.isLegal ? "is-legal" : "is-wip"}" style="margin-bottom:14px;">
        <strong>${escapeHtml(document.getElementById("deck-name-input")?.value.trim() || deck.name || "Mazo sin título")}</strong>
        — ${rules.isLegal ? "Regla Estándar Completa (1 Oshi · 50 Main · 20 Cheer)" : `Estado: ${rules.hasOshi ? 1 : 0}/1 Oshi · ${rules.mainCount}/50 Main · ${rules.cheerCount}/20 Cheer`}
      </div>
      ${
        rules.violations.length || rules.hints.length
          ? `<ul class="deck-validation-hints" style="margin-bottom:14px;">${[...rules.violations, ...rules.hints].map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ul>`
          : ""
      }
      <div class="deck-stats-charts">
        <section class="deck-stats-card">
          <h4 style="margin:0;">Curva de Bloom Level</h4>
          ${bloomEntries
            .map(
              ([label, val]) => `
            <div class="bar-chart-row">
              <span>${escapeHtml(label)}</span>
              <div class="bar-chart-track"><div class="bar-chart-fill" style="width:${(val / maxBloom) * 100}%"></div></div>
              <strong style="text-align:right;">${val}</strong>
            </div>`
            )
            .join("")}
        </section>

        <section class="deck-stats-card">
          <h4 style="margin:0;">Distribución de Color</h4>
          ${
            colorEntries.length
              ? colorEntries
                  .map(
                    ([label, val]) => `
                  <div class="bar-chart-row">
                    <span>${escapeHtml(label)}</span>
                    <div class="bar-chart-track"><div class="bar-chart-fill ${colorClassMap[label] || ""}" style="width:${(val / maxColor) * 100}%"></div></div>
                    <strong style="text-align:right;">${val}</strong>
                  </div>`
                  )
                  .join("")
              : `<p class="muted-text" style="margin:0;">Agrega cartas para ver la distribución de colores.</p>`
          }
        </section>

        <section class="deck-stats-card">
          <h4 style="margin:0;">Tipos &amp; Colección</h4>
          <div class="card-sub-meta"><span>Holomem</span><strong>${rules.typeCounts.Holomem}</strong></div>
          <div class="card-sub-meta"><span>Buzz Holomem</span><strong>${rules.typeCounts["Buzz Holomem"]}</strong></div>
          <div class="card-sub-meta"><span>Support (LIMITED: ${rules.typeCounts.LIMITED})</span><strong>${rules.typeCounts.Support}</strong></div>
          <div class="card-sub-meta"><span>Cheer Deck</span><strong>${rules.typeCounts.Cheer}</strong></div>
          <hr style="border:none;border-top:1px solid var(--md-sys-color-outline-variant);margin:4px 0;" />
          <div class="card-sub-meta"><span>Cobertura</span><strong>${rules.ownedCopies}/${rules.totalRequiredCopies} (${rules.coveragePct.toFixed(0)}%)</strong></div>
          <div class="card-sub-meta"><span>Valor total / Te falta</span><strong>${fmtMoney(rules.totalCostUsd)} / ${fmtMoney(rules.missingCostUsd)}</strong></div>
        </section>
      </div>

      <h3 style="margin:8px 0 10px;">Vista Visual del Mazo (${rules.totalCount} cartas)</h3>
      <div class="stats-visual-sheet">
        ${
          allCards.length
            ? allCards
                .map((item) => {
                  const zone = item.zone || "main";
                  if (zone === "oshi") {
                    return `
                      <div class="deck-visual-tile" title="${escapeHtml(item.name)}">
                        ${item.imageUrl ? `<img data-stats-zoom="${item.productId}" src="${escapeHtml(item.imageUrl)}" alt="${escapeHtml(item.name)}" />` : ""}
                        <span class="deck-visual-qty">★ Oshi</span>
                      </div>`;
                  }
                  const unlimited = isUnlimitedCopyCard(item);
                  const sameNumCount = unlimited ? item.quantity : getDeckCardNumberCount(deck, item.cardNumber, item.productId, "main");
                  const zoneFull = zone === "cheer" ? rules.cheerCount >= 20 : rules.mainCount >= 50;
                  const disablePlus = (!unlimited && sameNumCount >= 4) || zoneFull;
                  const key = `${item.productId}:${zone}`;
                  return `
                    <div class="deck-visual-tile" title="${escapeHtml(item.name)}">
                      ${item.imageUrl ? `<img data-stats-zoom="${item.productId}" src="${escapeHtml(item.imageUrl)}" alt="${escapeHtml(item.name)}" />` : ""}
                      <span class="deck-visual-qty">×${item.quantity}</span>
                      <div class="deck-visual-bar">
                        <button data-stats-key="${escapeHtml(key)}" data-stats-qty="-1" type="button">−</button>
                        <button data-stats-key="${escapeHtml(key)}" data-stats-qty="1" type="button" ${disablePlus ? "disabled" : ""}>+</button>
                      </div>
                    </div>`;
                })
                .join("")
            : `<p class="muted-text">Aún no hay cartas en el mazo.</p>`
        }
      </div>`;

    content.querySelectorAll("[data-stats-qty]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const key = btn.getAttribute("data-stats-key");
        const delta = Number(btn.getAttribute("data-stats-qty"));
        const target = byKey.get(key);
        if (target) adjustCardInEditingDeck(target, delta);
      });
    });

    content.querySelectorAll("[data-stats-zoom]").forEach((img) => {
      img.addEventListener("click", () => openCardModal(Number(img.getAttribute("data-stats-zoom"))));
    });
  }

  async function saveCurrentDeck() {
    if (!state.editingDeck) return false;
    const nameInput = document.getElementById("deck-name-input");
    const name = nameInput.value.trim();
    if (!name) {
      document.getElementById("deck-stats-modal")?.classList.add("hidden");
      showSnackbar("Ingresa un nombre para el mazo");
      nameInput.focus();
      return false;
    }

    const desc = document.getElementById("deck-desc-input")?.value.trim() || "";
    const payload = {
      name,
      oshiProductId: state.editingDeck.oshiProductId ? Number(state.editingDeck.oshiProductId) : null,
      description: desc,
      cards: (state.editingDeck.cards || []).map((c) => ({
        productId: Number(c.productId),
        zone: c.zone === "cheer" ? "cheer" : "main",
        quantity: Number(c.quantity || 1),
      })),
    };

    const saveBtn = document.getElementById("save-deck-btn");
    const statsSaveBtn = document.getElementById("deck-stats-save-btn");
    if (saveBtn) saveBtn.disabled = true;
    if (statsSaveBtn) statsSaveBtn.disabled = true;
    try {
      const saved = state.editingDeck.id
        ? await apiFetch(`/api/decks/${encodeURIComponent(state.editingDeck.id)}`, {
            method: "PUT",
            body: JSON.stringify(payload),
          })
        : await apiFetch("/api/decks", {
            method: "POST",
            body: JSON.stringify(payload),
          });
      document.getElementById("deck-stats-modal")?.classList.add("hidden");
      state.editingDeck = null;
      state.previewDeck = null;
      setDeckDirty(false);
      setDeckSubView("gallery");
      await loadDecks();
      window.scrollTo({ top: 0, behavior: "smooth" });
      const user = window.HololiveCloudBackend?.getCurrentUser();
      const isCloud = window.HololiveCloudBackend?.isCloudMode();
      showSnackbar(
        user && isCloud
          ? `☁ Mazo "${saved.name}" guardado en Firebase Cloud Firestore`
          : `Mazo "${saved.name}" guardado correctamente`
      );
      return true;
    } catch (err) {
      showSnackbar(`Error guardando mazo: ${err.message}`);
      return false;
    } finally {
      if (saveBtn) saveBtn.disabled = false;
      if (statsSaveBtn) statsSaveBtn.disabled = false;
    }
  }

  async function duplicateDeckById(deckId) {
    try {
      const detail = await apiFetch(`/api/decks/${encodeURIComponent(deckId)}`);
      const copyPayload = {
        name: `${detail.name} (Copia)`.slice(0, 120),
        oshiProductId: detail.oshiProductId || null,
        description: detail.description || "",
        cards: (detail.cards || []).map((c) => ({
          productId: c.productId,
          zone: c.zone,
          quantity: c.quantity,
        })),
      };
      const created = await apiFetch("/api/decks", {
        method: "POST",
        body: JSON.stringify(copyPayload),
      });
      await loadDecks();
      showSnackbar(`Mazo duplicado: "${created.name}"`);
    } catch (err) {
      showSnackbar(`Error duplicando mazo: ${err.message}`);
    }
  }

  async function deleteDeckById(deckId) {
    const ok = window.confirm("¿Eliminar este mazo de forma permanente?");
    if (!ok) return;
    try {
      await apiFetch(`/api/decks/${encodeURIComponent(deckId)}`, { method: "DELETE" });
      if (state.editingDeck && String(state.editingDeck.id) === String(deckId)) {
        state.editingDeck = null;
        setDeckDirty(false);
        setDeckSubView("gallery");
      }
      if (state.previewDeck && String(state.previewDeck.id) === String(deckId)) {
        state.previewDeck = null;
        setDeckSubView("gallery");
      }
      await loadDecks();
      showSnackbar("Mazo eliminado");
    } catch (err) {
      showSnackbar(`Error eliminando mazo: ${err.message}`);
    }
  }

  function getResolvedDeckMeta(deck) {
    const inStudio =
      deck === state.editingDeck &&
      !document.getElementById("deck-builder-studio")?.classList.contains("hidden");
    const name = inStudio
      ? document.getElementById("deck-name-input")?.value.trim() || deck?.name || "Hololive OCG Deck"
      : deck?.name || "Hololive OCG Deck";
    const description = inStudio
      ? document.getElementById("deck-desc-input")?.value.trim() || deck?.description || ""
      : deck?.description || "";
    return { name, description };
  }

  function formatDeckAsText(deck) {
    const { name } = getResolvedDeckMeta(deck);
    const lines = [`Nombre: ${name}`];
    if (deck.oshiCard) {
      lines.push(`Oshi: ${deck.oshiCard.cardNumber || deck.oshiCard.productId} ${deck.oshiCard.name}`);
    } else if (deck.oshiProductId) {
      lines.push(`Oshi: ${deck.oshiProductId}`);
    }
    lines.push("", "// Main Deck");
    for (const c of (deck.cards || []).filter((x) => x.zone !== "cheer")) {
      lines.push(`${c.quantity} ${c.cardNumber || c.productId} ${c.name || ""}`.trim());
    }
    const cheers = (deck.cards || []).filter((x) => x.zone === "cheer");
    if (cheers.length) {
      lines.push("", "// Cheer Deck");
      for (const c of cheers) {
        lines.push(`${c.quantity} ${c.cardNumber || c.productId} ${c.name || ""}`.trim());
      }
    }
    return lines.join("\n");
  }

  async function copyDeckTextToClipboard(deck) {
    if (!deck) return;
    const text = formatDeckAsText(deck);
    try {
      await navigator.clipboard.writeText(text);
      showSnackbar("Lista del mazo copiada al portapapeles");
    } catch (_) {
      showSnackbar("No se pudo copiar automáticamente; usa Exportar JSON.");
    }
  }

  function exportDeckAsJson(deck) {
    if (!deck) return;
    const { name, description } = getResolvedDeckMeta(deck);
    const payload = {
      version: "hocg-deck-1.0",
      name,
      oshiProductId: deck.oshiProductId || null,
      oshiCardNumber: deck.oshiCard?.cardNumber || null,
      description,
      cards: (deck.cards || []).map((c) => ({
        productId: c.productId,
        cardNumber: c.cardNumber || "",
        zone: c.zone || "main",
        quantity: c.quantity,
      })),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${name.toLowerCase().replace(/[^a-z0-9_-]+/g, "_") || "deck"}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showSnackbar("Archivo JSON del mazo descargado");
  }

  async function resolveCardForImport(codeOrPid) {
    const token = String(codeOrPid || "").trim();
    if (!token) return null;
    if (/^\d+$/.test(token)) {
      try {
        return await apiFetch(`/api/cards/${token}`);
      } catch (_) {}
    }
    const res = await apiFetch(`/api/cards?q=${encodeURIComponent(token)}&per_page=25`);
    const exact = (res.items || []).filter(
      (c) => String(c.cardNumber || "").toUpperCase() === token.toUpperCase()
    );
    const pool = exact.length ? exact : res.items || [];
    if (!pool.length) return null;
    // Prefer standard non-parallel printings first when multiple rarities share the same code
    const parallelSet = new Set(["SEC", "OUR", "UR", "SR", "S", "SY", "HR"]);
    return pool.find((c) => !parallelSet.has(c.rarity)) || pool[0];
  }

  async function importDeckFromRawInput(rawText) {
    const trimmed = String(rawText || "").trim();
    if (!trimmed) {
      showSnackbar("Pega una lista o carga un archivo primero");
      return;
    }

    let parsedName = "Mazo importado";
    let parsedDesc = "";
    let oshiCard = null;
    const importedEntries = [];

    if (trimmed.startsWith("{")) {
      const json = JSON.parse(trimmed);
      if (json.name) parsedName = String(json.name).slice(0, 120);
      if (json.description) parsedDesc = String(json.description).slice(0, 1000);
      if (json.oshiProductId) {
        oshiCard = await resolveCardForImport(json.oshiProductId);
      } else if (json.oshiCardNumber) {
        oshiCard = await resolveCardForImport(json.oshiCardNumber);
      }
      for (const row of json.cards || []) {
        const card = row.productId
          ? await resolveCardForImport(row.productId)
          : await resolveCardForImport(row.cardNumber);
        if (card) {
          importedEntries.push({
            card,
            quantity: Math.max(1, Number(row.quantity || 1)),
            zone: row.zone === "cheer" || card.cardType === "Cheer" ? "cheer" : "main",
          });
        }
      }
    } else {
      const cache = new Map();
      const cachedResolve = async (code) => {
        const key = String(code).toUpperCase();
        if (!cache.has(key)) cache.set(key, await resolveCardForImport(code));
        return cache.get(key);
      };

      for (const rawLine of trimmed.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith("//") || line.startsWith("#")) continue;
        const nameMatch = line.match(/^Nombre\s*:\s*(.+)$/i);
        if (nameMatch) {
          parsedName = nameMatch[1].trim().slice(0, 120);
          continue;
        }
        const oshiMatch = line.match(/^Oshi\s*:\s*([A-Za-z0-9-]+|\d+)/i);
        if (oshiMatch) {
          oshiCard = await cachedResolve(oshiMatch[1]);
          continue;
        }
        const rowMatch = line.match(/^(\d+)\s*[xX×]?\s+([A-Za-z0-9-]+|\d+)/);
        if (rowMatch) {
          const qty = Math.max(1, Number(rowMatch[1]));
          const card = await cachedResolve(rowMatch[2]);
          if (card) {
            if (card.cardType === "Oshi Holomem") oshiCard = card;
            else {
              importedEntries.push({
                card,
                quantity: qty,
                zone: card.cardType === "Cheer" ? "cheer" : "main",
              });
            }
          }
        }
      }
    }

    await openDeckEditor(null);
    state.editingDeck.name = parsedName;
    state.editingDeck.description = parsedDesc;
    document.getElementById("deck-name-input").value = parsedName;
    document.getElementById("deck-desc-input").value = parsedDesc;
    if (oshiCard) selectOshiForDeck(oshiCard);

    for (const entry of importedEntries) {
      const existing = state.editingDeck.cards.find(
        (c) => Number(c.productId) === Number(entry.card.productId) && c.zone === entry.zone
      );
      if (existing) {
        existing.quantity += entry.quantity;
      } else {
        state.editingDeck.cards.push({
          productId: Number(entry.card.productId),
          zone: entry.zone,
          quantity: entry.quantity,
          ownedQuantity: entry.card.totalOwned ?? 0,
          name: entry.card.name,
          cardNumber: entry.card.cardNumber || "",
          cardType: entry.card.cardType || "",
          bloomLevel: entry.card.bloomLevel || "",
          color: entry.card.color || "",
          rarity: entry.card.rarity || "",
          effectText: entry.card.effectText || "",
          imageUrl: entry.card.imageUrl || "",
          marketPrice: entry.card.marketPrice ?? entry.card.foilMarketPrice ?? null,
        });
      }
    }

    setDeckDirty(true);
    setDeckZoneTab("main");
    renderDeckPanel();
    syncDeckBrowserCardsInPlace();
    document.getElementById("deck-import-modal")?.classList.add("hidden");
    showSnackbar(`Mazo cargado en el editor (${importedEntries.length} líneas). Pulsa Guardar Mazo para conservarlo.`);
  }

  async function addMissingCardsToWishlistForDeck(deck, btnId) {
    if (!deck) return;
    const rules = evaluateDeckRules(deck);
    if (!rules.missingCards.length) {
      showSnackbar("¡Ya tienes todas las cartas de este mazo!");
      return;
    }
    const btn = document.getElementById(btnId);
    if (btn) btn.disabled = true;
    try {
      let updatedCount = 0;
      for (const m of rules.missingCards) {
        await apiFetch(`/api/collection/${m.productId}`, {
          method: "POST",
          body: JSON.stringify({
            isWishlist: true,
            wishlistTargetQty: Math.max(1, m.missingQty),
          }),
        });
        updatedCount += 1;
      }
      await Promise.all([loadKpis(), loadEditions()]);
      showSnackbar(`♥ ${updatedCount} carta(s) faltantes marcadas en tu Wishlist`);
    } catch (err) {
      showSnackbar(`Error al actualizar Wishlist: ${err.message}`);
    } finally {
      if (state.editingDeck) renderDeckPanel();
      if (state.previewDeck) renderDeckPreview(state.previewDeck);
    }
  }

  async function addMissingDeckCardsToWishlist() {
    await addMissingCardsToWishlistForDeck(state.editingDeck, "deck-add-missing-wishlist-btn");
  }

  /* ================= AUDIT VIEW ================= */
  async function loadAudit() {
    try {
      const data = await apiFetch("/api/audit");
      const r = data.report || {};
      const grid = document.getElementById("audit-stats-grid");
      grid.innerHTML = `
        <article class="kpi-card">
          <div class="kpi-label">Ediciones &amp; Productos</div>
          <div class="kpi-value">${r.editionsProcessed || 0} / ${(r.totalProducts || 0).toLocaleString()}</div>
          <div class="kpi-sub">${r.totalCards || 0} cartas · ${r.totalSealed || 0} sellados</div>
        </article>
        <article class="kpi-card">
          <div class="kpi-label">Filas CSV Rotas Evitadas</div>
          <div class="kpi-value">${(r.naiveCsvBrokenRows || 0).toLocaleString()}</div>
          <div class="kpi-sub">${r.csvRowsWithCommasInText || 0} filas con comas en efectos</div>
        </article>
        <article class="kpi-card">
          <div class="kpi-label">Limpieza HTML &amp; Typos</div>
          <div class="kpi-value">${(r.descriptionsHtmlCleaned || 0).toLocaleString()}</div>
          <div class="kpi-sub">${r.spacingBugsFixed || 0} espacios · ${r.typosFixed || 0} typos corregidos</div>
        </article>
        <article class="kpi-card">
          <div class="kpi-label">Atributos Inferidos</div>
          <div class="kpi-value">${(r.missingCardTypeInferred || 0) + (r.missingColorInferred || 0)}</div>
          <div class="kpi-sub">${r.missingCardTypeInferred || 0} tipos · ${r.missingColorInferred || 0} colores</div>
        </article>`;

      const exHost = document.getElementById("audit-examples-list");
      exHost.innerHTML = (r.examples || [])
        .map(
          (ex) => `
        <article class="audit-item">
          <div class="edition-head">
            <strong>${escapeHtml(ex.name)} (${escapeHtml(ex.cardNumber || "S/N")})</strong>
            <div class="card-attr-chips">
              ${(ex.issuesFixed || []).map((t) => `<span class="attr-chip">${escapeHtml(t)}</span>`).join("")}
            </div>
          </div>
          <div class="audit-diff-grid">
            <div>
              <div class="kpi-label" style="margin-bottom:4px;">Antes (Crudo TCGplayer)</div>
              <div class="audit-box">${escapeHtml(ex.rawSnippet)}</div>
            </div>
            <div>
              <div class="kpi-label" style="margin-bottom:4px;">Después (Saneado en SQLite)</div>
              <div class="audit-box">${escapeHtml(ex.cleanedSnippet)}</div>
            </div>
          </div>
        </article>`
        )
        .join("");
    } catch (err) {
      showSnackbar(`Error cargando auditoría: ${err.message}`);
    }
  }

  /* ================= FILTER RESET & BINDINGS ================= */
  function resetFilters() {
    state.filters = {
      q: "",
      group_id: "",
      color: "",
      rarity: "",
      card_type: "",
      bloom_level: "",
      item_category: "card",
      ownership: "all",
      min_price: "",
      max_price: "",
      sort: "price_desc",
      page: 1,
      per_page: 36,
    };
    document.getElementById("filter-q").value = "";
    document.getElementById("filter-edition").value = "";
    document.getElementById("filter-card-type").value = "";
    document.getElementById("filter-rarity").value = "";
    document.getElementById("filter-bloom").value = "";
    document.getElementById("filter-category").value = "card";
    document.getElementById("filter-sort").value = "price_desc";
    document.getElementById("filter-min-price").value = "";
    document.getElementById("filter-max-price").value = "";

    document.querySelectorAll("#ownership-chips .filter-chip").forEach((c) => {
      c.classList.toggle("active", c.getAttribute("data-ownership") === "all");
    });
    document.querySelectorAll("#color-chips .filter-chip").forEach((c) => {
      c.classList.toggle("active", c.getAttribute("data-color") === "");
    });
    loadCards();
  }

  function bindEvents() {
    document.getElementById("theme-toggle-top").addEventListener("click", toggleTheme);
    document.getElementById("theme-toggle-rail").addEventListener("click", toggleTheme);

    document.querySelectorAll("[data-view]").forEach((btn) => {
      btn.addEventListener("click", () => switchView(btn.getAttribute("data-view")));
    });

    document.getElementById("toggle-filters-btn").addEventListener("click", () => {
      document.getElementById("advanced-filters").classList.toggle("open");
    });

    document.getElementById("scroll-mode-paged").addEventListener("click", () => {
      if (state.scrollMode === "paged") return;
      state.scrollMode = "paged";
      localStorage.setItem("hocg-scroll-mode", "paged");
      state.filters.page = 1;
      updateScrollModeUI();
      loadCards();
    });

    document.getElementById("scroll-mode-infinite").addEventListener("click", () => {
      if (state.scrollMode === "infinite") return;
      state.scrollMode = "infinite";
      localStorage.setItem("hocg-scroll-mode", "infinite");
      state.filters.page = 1;
      updateScrollModeUI();
      loadCards();
    });

    document.getElementById("view-mode-grid").addEventListener("click", () => {
      state.viewMode = "grid";
      document.getElementById("view-mode-grid").classList.add("active");
      document.getElementById("view-mode-table").classList.remove("active");
      if (state.cardsPage) renderCards(state.cardsPage);
    });

    document.getElementById("view-mode-table").addEventListener("click", () => {
      state.viewMode = "table";
      document.getElementById("view-mode-table").classList.add("active");
      document.getElementById("view-mode-grid").classList.remove("active");
      if (state.cardsPage) renderCards(state.cardsPage);
    });

    document.getElementById("filter-q").addEventListener("input", (e) => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        state.filters.q = e.target.value;
        state.filters.page = 1;
        loadCards();
      }, 240);
    });

    const selectBindings = [
      ["filter-edition", "group_id"],
      ["filter-card-type", "card_type"],
      ["filter-rarity", "rarity"],
      ["filter-bloom", "bloom_level"],
      ["filter-category", "item_category"],
      ["filter-sort", "sort"],
    ];
    selectBindings.forEach(([id, key]) => {
      document.getElementById(id).addEventListener("change", (e) => {
        state.filters[key] = e.target.value;
        state.filters.page = 1;
        loadCards();
      });
    });

    ["filter-min-price", "filter-max-price"].forEach((id) => {
      document.getElementById(id).addEventListener("change", (e) => {
        const key = id === "filter-min-price" ? "min_price" : "max_price";
        state.filters[key] = e.target.value;
        state.filters.page = 1;
        loadCards();
      });
    });

    document.querySelectorAll("#ownership-chips .filter-chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        document
          .querySelectorAll("#ownership-chips .filter-chip")
          .forEach((c) => c.classList.remove("active"));
        chip.classList.add("active");
        state.filters.ownership = chip.getAttribute("data-ownership");
        state.filters.page = 1;
        loadCards();
      });
    });

    document.querySelectorAll("#color-chips .filter-chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        document
          .querySelectorAll("#color-chips .filter-chip")
          .forEach((c) => c.classList.remove("active"));
        chip.classList.add("active");
        state.filters.color = chip.getAttribute("data-color");
        state.filters.page = 1;
        loadCards();
      });
    });

    document.getElementById("clear-filters-btn").addEventListener("click", resetFilters);

    document.getElementById("modal-close-btn").addEventListener("click", () => {
      document.getElementById("card-modal-backdrop").classList.add("hidden");
    });
    document.getElementById("card-modal-backdrop").addEventListener("click", (e) => {
      if (e.target.id === "card-modal-backdrop") {
        e.target.classList.add("hidden");
      }
    });

    document.getElementById("export-btn-top").addEventListener("click", exportCollection);
    document.getElementById("export-collection-btn").addEventListener("click", exportCollection);
    document.getElementById("import-collection-input").addEventListener("change", (e) => {
      const file = e.target.files[0];
      if (file) importCollectionFile(file);
      e.target.value = "";
    });

    document.getElementById("view-owned-in-catalog-btn").addEventListener("click", () => {
      state.filters.ownership = "owned";
      state.filters.page = 1;
      document.querySelectorAll("#ownership-chips .filter-chip").forEach((c) => {
        c.classList.toggle("active", c.getAttribute("data-ownership") === "owned");
      });
      switchView("catalog");
      loadCards();
    });

    // Deck builder studio events
    const triggerGoogleSignIn = async () => {
      const cloud = window.HololiveCloudBackend;
      if (!cloud) return;
      try {
        const signedIn = await cloud.signInWithGoogle();
        if (signedIn) showSnackbar(`Conectado como ${signedIn.displayName || signedIn.email}`);
      } catch (err) {
        showSnackbar(`Error al iniciar sesión: ${err.message}`);
      }
    };
    document.getElementById("decks-signin-btn")?.addEventListener("click", triggerGoogleSignIn);
    document.getElementById("deck-panel-signin-btn")?.addEventListener("click", triggerGoogleSignIn);

    document.getElementById("new-deck-btn")?.addEventListener("click", () => openDeckEditor(null));
    document.getElementById("close-deck-editor")?.addEventListener("click", closeDeckEditor);
    document.getElementById("close-deck-preview")?.addEventListener("click", closeDeckPreview);
    document.getElementById("preview-edit-btn")?.addEventListener("click", () => {
      if (state.previewDeck?.id) openDeckEditor(state.previewDeck.id);
    });
    document.getElementById("preview-duplicate-btn")?.addEventListener("click", () => {
      if (state.previewDeck?.id) duplicateDeckById(state.previewDeck.id);
    });
    document.getElementById("preview-copy-btn")?.addEventListener("click", () => {
      if (state.previewDeck) copyDeckTextToClipboard(state.previewDeck);
    });
    document.getElementById("preview-export-btn")?.addEventListener("click", () => {
      if (state.previewDeck) exportDeckAsJson(state.previewDeck);
    });
    document.getElementById("preview-delete-btn")?.addEventListener("click", () => {
      if (state.previewDeck?.id) deleteDeckById(state.previewDeck.id);
    });
    document.getElementById("preview-ownership-toggle")?.addEventListener("change", (e) => {
      state.deckBuilder.previewShowOwnership = e.target.checked;
      if (state.previewDeck) renderDeckPreview(state.previewDeck);
    });
    document.getElementById("save-deck-btn")?.addEventListener("click", saveCurrentDeck);
    document.getElementById("delete-deck-btn")?.addEventListener("click", () => {
      if (state.editingDeck?.id) deleteDeckById(state.editingDeck.id);
    });
    document.getElementById("duplicate-deck-btn")?.addEventListener("click", () => {
      if (state.editingDeck?.id) duplicateDeckById(state.editingDeck.id);
    });
    document.getElementById("clear-deck-btn")?.addEventListener("click", () => {
      if (!state.editingDeck) return;
      if (!state.editingDeck.cards.length && !state.editingDeck.oshiProductId) return;
      if (!window.confirm("¿Vaciar todas las cartas de este mazo?")) return;
      state.editingDeck.oshiProductId = null;
      state.editingDeck.oshiCard = null;
      state.editingDeck.cards = [];
      setDeckDirty(true);
      renderDeckPanel();
      syncDeckBrowserCardsInPlace();
    });

    document.getElementById("deck-name-input")?.addEventListener("input", () => setDeckDirty(true));
    document.getElementById("deck-desc-input")?.addEventListener("input", () => setDeckDirty(true));

    document.querySelectorAll(".deck-mobile-tab").forEach((btn) => {
      btn.addEventListener("click", () => setDeckMobilePane(btn.getAttribute("data-deck-pane")));
    });

    document.querySelectorAll("#deck-zone-tabs .zone-tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => setDeckZoneTab(btn.getAttribute("data-zone")));
    });

    document.getElementById("deck-card-search")?.addEventListener("input", (e) => {
      clearTimeout(deckBrowserSearchTimer);
      deckBrowserSearchTimer = setTimeout(() => {
        state.deckBuilder.filters.q = e.target.value;
        state.deckBuilder.filters.page = 1;
        loadDeckBrowserCards();
      }, 220);
    });

    document.getElementById("deck-more-filters-toggle")?.addEventListener("click", () => {
      document.getElementById("deck-more-filters")?.classList.toggle("hidden");
    });
    document.getElementById("deck-clear-filters-btn")?.addEventListener("click", resetDeckBrowserFilters);

    document.querySelectorAll("#deck-color-chips [data-deck-color]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.deckBuilder.filters.color = btn.getAttribute("data-deck-color");
        state.deckBuilder.filters.page = 1;
        syncDeckChipStates();
        loadDeckBrowserCards();
      });
    });

    document.querySelectorAll("#deck-type-chips [data-deck-type]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const val = btn.getAttribute("data-deck-type");
        if (val === "LIMITED") {
          state.deckBuilder.filters.limited_only = !state.deckBuilder.filters.limited_only;
          state.deckBuilder.filters.card_type = "";
        } else {
          state.deckBuilder.filters.limited_only = false;
          state.deckBuilder.filters.card_type = val;
        }
        state.deckBuilder.filters.page = 1;
        syncDeckChipStates();
        loadDeckBrowserCards();
      });
    });

    document.querySelectorAll("#deck-bloom-chips [data-deck-bloom]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.deckBuilder.filters.bloom_level = btn.getAttribute("data-deck-bloom");
        state.deckBuilder.filters.page = 1;
        syncDeckChipStates();
        loadDeckBrowserCards();
      });
    });

    document.getElementById("deck-filter-edition")?.addEventListener("change", (e) => {
      state.deckBuilder.filters.group_id = e.target.value;
      state.deckBuilder.filters.page = 1;
      loadDeckBrowserCards();
    });
    document.getElementById("deck-filter-rarity")?.addEventListener("change", (e) => {
      state.deckBuilder.filters.rarity = e.target.value;
      state.deckBuilder.filters.page = 1;
      loadDeckBrowserCards();
    });
    document.getElementById("deck-filter-parallel")?.addEventListener("change", (e) => {
      state.deckBuilder.filters.parallel = e.target.value;
      state.deckBuilder.filters.page = 1;
      loadDeckBrowserCards();
    });
    document.getElementById("deck-filter-sort")?.addEventListener("change", (e) => {
      state.deckBuilder.filters.sort = e.target.value;
      state.deckBuilder.filters.page = 1;
      loadDeckBrowserCards();
    });
    document.getElementById("deck-filter-owned-only")?.addEventListener("change", (e) => {
      state.deckBuilder.filters.owned_only = e.target.checked;
      state.deckBuilder.filters.page = 1;
      loadDeckBrowserCards();
    });

    document.getElementById("deck-match-oshi-color-btn")?.addEventListener("click", (e) => {
      const col = e.currentTarget.getAttribute("data-target-color") || "";
      state.deckBuilder.filters.color = col;
      state.deckBuilder.filters.page = 1;
      if (state.deckBuilder.filters.zone === "oshi") setDeckZoneTab("main");
      else {
        syncDeckChipStates();
        loadDeckBrowserCards();
      }
    });

    document.getElementById("deck-view-list")?.addEventListener("click", () => {
      state.deckBuilder.deckViewMode = "list";
      localStorage.setItem("hocg-deck-view", "list");
      renderDeckPanel();
    });
    document.getElementById("deck-view-visual")?.addEventListener("click", () => {
      state.deckBuilder.deckViewMode = "visual";
      localStorage.setItem("hocg-deck-view", "visual");
      renderDeckPanel();
    });

    document.getElementById("deck-add-missing-wishlist-btn")?.addEventListener("click", addMissingDeckCardsToWishlist);
    document.getElementById("copy-deck-text-btn")?.addEventListener("click", () => copyDeckTextToClipboard(state.editingDeck));
    document.getElementById("export-deck-json-btn")?.addEventListener("click", () => exportDeckAsJson(state.editingDeck));

    document.getElementById("open-deck-stats-btn")?.addEventListener("click", () => {
      renderDeckStatsModal();
      document.getElementById("deck-stats-modal")?.classList.remove("hidden");
    });
    document.getElementById("deck-stats-close")?.addEventListener("click", () => {
      document.getElementById("deck-stats-modal")?.classList.add("hidden");
    });
    document.getElementById("deck-stats-modal")?.addEventListener("click", (e) => {
      if (e.target.id === "deck-stats-modal") e.target.classList.add("hidden");
    });
    document.getElementById("deck-stats-copy-btn")?.addEventListener("click", () => copyDeckTextToClipboard(state.editingDeck));
    document.getElementById("deck-stats-export-btn")?.addEventListener("click", () => exportDeckAsJson(state.editingDeck));
    document.getElementById("deck-stats-save-btn")?.addEventListener("click", async () => {
      await saveCurrentDeck();
    });

    document.getElementById("open-deck-import-btn")?.addEventListener("click", () => {
      const ta = document.getElementById("deck-import-text");
      if (ta) ta.value = "";
      document.getElementById("deck-import-modal")?.classList.remove("hidden");
    });
    document.getElementById("deck-import-close")?.addEventListener("click", () => {
      document.getElementById("deck-import-modal")?.classList.add("hidden");
    });
    document.getElementById("deck-import-cancel-btn")?.addEventListener("click", () => {
      document.getElementById("deck-import-modal")?.classList.add("hidden");
    });
    document.getElementById("deck-import-modal")?.addEventListener("click", (e) => {
      if (e.target.id === "deck-import-modal") e.target.classList.add("hidden");
    });
    document.getElementById("deck-import-file")?.addEventListener("change", async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      document.getElementById("deck-import-text").value = await file.text();
      e.target.value = "";
    });
    document.getElementById("deck-import-confirm-btn")?.addEventListener("click", async () => {
      const btn = document.getElementById("deck-import-confirm-btn");
      btn.disabled = true;
      btn.textContent = "Importando...";
      try {
        await importDeckFromRawInput(document.getElementById("deck-import-text")?.value || "");
      } catch (err) {
        showSnackbar(`Error al importar mazo: ${err.message}`);
      } finally {
        btn.disabled = false;
        btn.textContent = "Importar en editor";
      }
    });

    document.getElementById("resync-db-btn").addEventListener("click", async () => {
      try {
        showSnackbar("Re-sincronizando /resources hacia SQLite...");
        const res = await apiFetch("/api/resync", { method: "POST" });
        await Promise.all([loadAudit(), loadKpis(), loadEditions(), loadCards()]);
        showSnackbar(`Sincronizadas ${res.editionsSynced} ediciones y ${res.cardsSynced} cartas`);
      } catch (err) {
        showSnackbar(`Error al re-sincronizar: ${err.message}`);
      }
    });

    document.getElementById("currency-usd").addEventListener("click", () => setCurrency("USD"));
    document.getElementById("currency-clp").addEventListener("click", () => setCurrency("CLP"));
    document.getElementById("currency-toggle-rail").addEventListener("click", () => {
      setCurrency(state.currency === "CLP" ? "USD" : "CLP");
    });
    document.getElementById("exchange-rate-chip").addEventListener("click", openExchangeRateModal);
    document.getElementById("exchange-rate-rail").addEventListener("click", openExchangeRateModal);
    document.getElementById("rate-modal-close").addEventListener("click", () => {
      document.getElementById("exchange-rate-modal").classList.add("hidden");
    });
    document.getElementById("exchange-rate-modal").addEventListener("click", (e) => {
      if (e.target.id === "exchange-rate-modal") e.target.classList.add("hidden");
    });
    document.getElementById("refresh-live-rate-btn").addEventListener("click", refreshLiveExchangeRate);
    document.getElementById("manual-rate-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const val = Number(document.getElementById("manual-rate-input").value);
      if (!Number.isFinite(val) || val <= 0) {
        showSnackbar("Ingresa una tasa válida mayor a 0");
        return;
      }
      try {
        await saveExchangeRateToServer(val, "Manual", new Date().toISOString().slice(0, 10));
        document.getElementById("exchange-rate-modal").classList.add("hidden");
        showSnackbar(`Tasa guardada: 1 USD = $${val.toFixed(2)} CLP`);
      } catch (err) {
        showSnackbar(`Error al guardar tasa: ${err.message}`);
      }
    });

    document.getElementById("shutdown-btn-rail").addEventListener("click", () => {
      document.getElementById("shutdown-modal").classList.remove("hidden");
    });
    document.getElementById("shutdown-btn-top").addEventListener("click", () => {
      document.getElementById("shutdown-modal").classList.remove("hidden");
    });
    document.getElementById("shutdown-modal-close").addEventListener("click", () => {
      document.getElementById("shutdown-modal").classList.add("hidden");
    });
    document.getElementById("shutdown-cancel-btn").addEventListener("click", () => {
      document.getElementById("shutdown-modal").classList.add("hidden");
    });
    document.getElementById("shutdown-modal").addEventListener("click", (e) => {
      if (e.target.id === "shutdown-modal") e.target.classList.add("hidden");
    });
    document.getElementById("shutdown-confirm-btn").addEventListener("click", async () => {
      const btn = document.getElementById("shutdown-confirm-btn");
      btn.disabled = true;
      btn.textContent = "Apagando...";
      try {
        await apiFetch("/api/shutdown", { method: "POST" });
      } catch (_) {
        // Server closes immediately after acknowledging shutdown
      }
      document.getElementById("shutdown-modal").classList.add("hidden");
      document.getElementById("shutdown-screen").classList.remove("hidden");
    });

    document.getElementById("firebase-auth-btn")?.addEventListener("click", async () => {
      const cloud = window.HololiveCloudBackend;
      if (!cloud) return;
      const user = cloud.getCurrentUser();
      if (user) {
        openSignOutModal(user);
      } else {
        try {
          const signedIn = await cloud.signInWithGoogle();
          if (signedIn) {
            showSnackbar(`Conectado como ${signedIn.displayName || signedIn.email}`);
          }
        } catch (err) {
          showSnackbar(`Error al iniciar sesión: ${err.message}`);
        }
      }
    });

    document.getElementById("signout-modal-close")?.addEventListener("click", closeSignOutModal);
    document.getElementById("signout-cancel-btn")?.addEventListener("click", closeSignOutModal);
    document.getElementById("signout-modal")?.addEventListener("click", (e) => {
      if (e.target.id === "signout-modal") closeSignOutModal();
    });
    document.getElementById("signout-sync-local-btn")?.addEventListener("click", async () => {
      const cloud = window.HololiveCloudBackend;
      if (!cloud) return;
      const btn = document.getElementById("signout-sync-local-btn");
      btn.disabled = true;
      btn.textContent = "Sincronizando...";
      try {
        const exported = await apiFetch("/api/collection/export");
        const pushed = await cloud.pushLocalCollectionToFirestore(exported.entries || []);
        let pushedDecks = 0;
        if (typeof cloud.pushLocalDecksToFirestore === "function") {
          const deckSummaries = await apiFetch("/api/decks");
          const fullDecks = await Promise.all(
            (deckSummaries || []).map((d) => apiFetch(`/api/decks/${encodeURIComponent(d.id)}`))
          );
          pushedDecks = await cloud.pushLocalDecksToFirestore(fullDecks);
        }
        closeSignOutModal();
        showSnackbar(`Sincronizadas ${pushed} cartas y ${pushedDecks} mazos locales hacia Cloud Firestore`);
      } catch (err) {
        showSnackbar(`Error al sincronizar: ${err.message}`);
      } finally {
        btn.disabled = false;
        btn.textContent = "☁ Sincronizar ahora";
      }
    });
    document.getElementById("signout-confirm-btn")?.addEventListener("click", async () => {
      const cloud = window.HololiveCloudBackend;
      if (!cloud) return;
      const btn = document.getElementById("signout-confirm-btn");
      btn.disabled = true;
      btn.textContent = "Desconectando...";
      try {
        await cloud.signOutUser();
        closeSignOutModal();
        showSnackbar("Sesión de Google cerrada");
      } catch (err) {
        showSnackbar(`Error al cerrar sesión: ${err.message}`);
      } finally {
        btn.disabled = false;
        btn.textContent = "Cerrar sesión";
      }
    });

    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      ["card-modal-backdrop", "exchange-rate-modal", "shutdown-modal", "signout-modal", "deck-stats-modal", "deck-import-modal"].forEach((id) => {
        document.getElementById(id)?.classList.add("hidden");
      });
    });

    const scrollTopBtn = document.getElementById("scroll-top-btn");
    const syncScrollTopVisibility = () => {
      if (window.scrollY > 300) {
        scrollTopBtn.classList.remove("hidden");
      } else {
        scrollTopBtn.classList.add("hidden");
      }
    };
    window.addEventListener("scroll", syncScrollTopVisibility, { passive: true });
    scrollTopBtn.addEventListener("click", () => {
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
    syncScrollTopVisibility();
  }

  let cloudRefreshTimer = null;

  async function init() {
    initTheme();
    if (window.HololiveCloudBackend) {
      await window.HololiveCloudBackend.initPromise;
    }
    configureRuntimeEnvironmentUI();
    window.onFirebaseAuthChanged = (user) => {
      updateFirebaseAuthUI(user);
    };
    window.onCloudDataChanged = () => {
      if (!window.HololiveCloudBackend?.isCloudMode()) return;
      clearTimeout(cloudRefreshTimer);
      cloudRefreshTimer = setTimeout(() => {
        loadKpis();
        loadEditions();
        if (state.activeView === "catalog" && Date.now() >= suppressCloudCardsReloadUntil) loadCards();
        if (state.activeView === "decks") {
          loadDecks();
          if (state.previewDeck && !document.getElementById("deck-preview-view")?.classList.contains("hidden")) {
            apiFetch(`/api/decks/${encodeURIComponent(state.previewDeck.id)}`)
              .then((fresh) => {
                state.previewDeck = fresh;
                renderDeckPreview(fresh);
              })
              .catch(() => {});
          }
          if (state.editingDeck && !document.getElementById("deck-builder-studio")?.classList.contains("hidden")) {
            renderDeckPanel();
            if (state.deckBuilder.browserPage) renderDeckBrowserGrid(state.deckBuilder.browserPage);
          }
        }
      }, 120);
    };
    updateCurrencyUI();
    bindEvents();
    setupInfiniteObserver();
    updateScrollModeUI();
    await Promise.all([loadKpis(), loadEditions(), loadCards()]);
  }

  document.addEventListener("DOMContentLoaded", init);
})();
