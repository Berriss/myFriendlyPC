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
    if (state.activeView === "decks") renderDecksList(state.decks);
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
    if (state.activeView === "decks") renderDecksList(state.decks);
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
    if (!authBtn || !authLabel) return;

    const isCloud = window.HololiveCloudBackend?.isCloudMode();
    if (user) {
      const name = user.displayName || user.email || "Cuenta Google";
      authBtn.classList.add("is-signed-in");
      authLabel.textContent = `☁ ${name}`;
      authBtn.title = `Conectado como ${name} (Click para ver cuenta o cerrar sesión)`;
    } else {
      authBtn.classList.remove("is-signed-in");
      authLabel.textContent = isCloud ? "Iniciar sesión con Google" : "☁ Sync Google";
      authBtn.title = isCloud
        ? "Inicia sesión con Google para guardar tu colección en Cloud Firestore"
        : "Conectar cuenta Google para respaldar en Cloud Firestore";
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
          await apiFetch(`/api/collection/${productId}`, {
            method: "POST",
            body: JSON.stringify(payload),
          });
          backdrop.classList.add("hidden");
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

  /* ================= DECK BUILDER (SCALABLE) ================= */
  async function loadDecks() {
    try {
      const [decks, oshiPage] = await Promise.all([
        apiFetch("/api/decks"),
        apiFetch("/api/cards?card_type=Oshi+Holomem&per_page=120"),
      ]);
      state.decks = decks;
      const oshiSelect = document.getElementById("deck-oshi-select");
      oshiSelect.innerHTML = `<option value="">-- Seleccionar Oshi --</option>`;
      (oshiPage.items || []).forEach((card) => {
        const opt = document.createElement("option");
        opt.value = String(card.productId);
        opt.textContent = `${card.name} (${card.cardNumber}) [${card.color || "—"}]`;
        oshiSelect.appendChild(opt);
      });
      renderDecksList(decks);
    } catch (err) {
      showSnackbar(`Error cargando mazos: ${err.message}`);
    }
  }

  function renderDecksList(decks) {
    const host = document.getElementById("decks-grid");
    if (!decks.length) {
      host.innerHTML = `
        <div class="panel-card" style="grid-column:1/-1;">
          <p class="muted-text">Aún no has creado mazos. Pulsa <strong>+ Nuevo Mazo</strong> para armar tu primer deck conectado a tu colección.</p>
        </div>`;
      return;
    }
    host.innerHTML = decks
      .map(
        (d) => `
      <article class="edition-card" data-open-deck="${d.id}">
        <div class="edition-head">
          <div class="edition-title">${escapeHtml(d.name)}</div>
          <span class="edition-abbr">${d.mainCount} Main · ${d.cheerCount} Cheer</span>
        </div>
        <div class="card-sub-meta">
          <span>Oshi: ${escapeHtml(d.oshiName || "Sin definir")}</span>
          <span>Cobertura: ${d.ownedCoveragePct.toFixed(0)}%</span>
        </div>
        <div class="md3-progress-track">
          <div class="md3-progress-fill" style="width:${Math.min(100, d.ownedCoveragePct)}%"></div>
        </div>
        <div class="card-sub-meta">
          <span>Valor est.: <strong>${fmtMoney(d.estimatedCostUsd)}</strong></span>
          <span>Click para editar</span>
        </div>
      </article>`
      )
      .join("");

    host.querySelectorAll("[data-open-deck]").forEach((el) => {
      el.addEventListener("click", () => openDeckEditor(Number(el.getAttribute("data-open-deck"))));
    });
  }

  async function openDeckEditor(deckId) {
    const panel = document.getElementById("deck-editor-panel");
    panel.classList.remove("hidden");
    const delBtn = document.getElementById("delete-deck-btn");

    if (!deckId) {
      state.editingDeck = { id: null, name: "", oshiProductId: null, description: "", cards: [] };
      document.getElementById("deck-editor-title").textContent = "Nuevo Mazo";
      document.getElementById("deck-name-input").value = "";
      document.getElementById("deck-oshi-select").value = "";
      document.getElementById("deck-desc-input").value = "";
      delBtn.classList.add("hidden");
      renderDeckCardsEditor();
      return;
    }

    const detail = await apiFetch(`/api/decks/${deckId}`);
    state.editingDeck = detail;
    document.getElementById("deck-editor-title").textContent = `Editando: ${detail.name}`;
    document.getElementById("deck-name-input").value = detail.name;
    document.getElementById("deck-oshi-select").value = detail.oshiProductId
      ? String(detail.oshiProductId)
      : "";
    document.getElementById("deck-desc-input").value = detail.description || "";
    delBtn.classList.remove("hidden");
    renderDeckCardsEditor();
  }

  function renderDeckCardsEditor() {
    const host = document.getElementById("deck-cards-list");
    const cards = state.editingDeck?.cards || [];
    if (!cards.length) {
      host.innerHTML = `<p class="muted-text">Busca cartas arriba para agregarlas a este mazo.</p>`;
      return;
    }
    host.innerHTML = cards
      .map(
        (item, idx) => `
      <div class="deck-card-row">
        <div>
          <strong>${escapeHtml(item.name)}</strong>
          <span class="muted-text" style="margin-left:8px;">${escapeHtml(item.cardNumber)} · ${escapeHtml(item.zone.toUpperCase())} · Tienes: ${item.ownedQuantity ?? 0}</span>
        </div>
        <div class="stepper-controls">
          <button class="step-btn" data-deck-qty="${idx}" data-delta="-1" type="button">−</button>
          <span class="step-qty">${item.quantity}</span>
          <button class="step-btn plus" data-deck-qty="${idx}" data-delta="1" type="button">+</button>
        </div>
      </div>`
      )
      .join("");

    host.querySelectorAll("[data-deck-qty]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = Number(btn.getAttribute("data-deck-qty"));
        const delta = Number(btn.getAttribute("data-delta"));
        const item = state.editingDeck.cards[idx];
        item.quantity += delta;
        if (item.quantity <= 0) state.editingDeck.cards.splice(idx, 1);
        renderDeckCardsEditor();
      });
    });
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

    // Deck builder events
    document.getElementById("new-deck-btn").addEventListener("click", () => openDeckEditor(null));
    document.getElementById("close-deck-editor").addEventListener("click", () => {
      document.getElementById("deck-editor-panel").classList.add("hidden");
    });

    let deckSearchTimer = null;
    document.getElementById("deck-card-search").addEventListener("input", (e) => {
      clearTimeout(deckSearchTimer);
      const q = e.target.value.trim();
      if (!q) {
        document.getElementById("deck-search-results").innerHTML = "";
        return;
      }
      deckSearchTimer = setTimeout(async () => {
        const res = await apiFetch(`/api/cards?q=${encodeURIComponent(q)}&per_page=8`);
        const host = document.getElementById("deck-search-results");
        host.innerHTML = (res.items || [])
          .map(
            (card) => `
          <div class="deck-search-hit">
            <span class="truncate">${escapeHtml(card.name)} (${escapeHtml(card.cardNumber)})</span>
            <button class="tonal-btn" style="height:28px;padding:0 10px;" data-add-deck-card="${card.productId}" type="button">+ Añadir</button>
          </div>`
          )
          .join("");
        host.querySelectorAll("[data-add-deck-card]").forEach((btn) => {
          btn.addEventListener("click", () => {
            const pid = Number(btn.getAttribute("data-add-deck-card"));
            const card = res.items.find((x) => x.productId === pid);
            if (!card || !state.editingDeck) return;
            const zone = card.cardType === "Cheer" ? "cheer" : "main";
            const existing = state.editingDeck.cards.find(
              (x) => x.productId === pid && x.zone === zone
            );
            if (existing) {
              existing.quantity += 1;
            } else {
              state.editingDeck.cards.push({
                productId: card.productId,
                zone,
                quantity: 1,
                ownedQuantity: card.totalOwned,
                name: card.name,
                cardNumber: card.cardNumber,
                cardType: card.cardType,
                color: card.color,
                rarity: card.rarity,
                imageUrl: card.imageUrl,
                marketPrice: card.marketPrice,
              });
            }
            renderDeckCardsEditor();
          });
        });
      }, 220);
    });

    document.getElementById("save-deck-btn").addEventListener("click", async () => {
      if (!state.editingDeck) return;
      const name = document.getElementById("deck-name-input").value.trim();
      if (!name) {
        showSnackbar("Ingresa un nombre para el mazo");
        return;
      }
      const oshiRaw = document.getElementById("deck-oshi-select").value;
      const payload = {
        name,
        oshiProductId: oshiRaw ? Number(oshiRaw) : null,
        description: document.getElementById("deck-desc-input").value.trim(),
        cards: state.editingDeck.cards.map((c) => ({
          productId: c.productId,
          zone: c.zone,
          quantity: c.quantity,
        })),
      };
      try {
        if (state.editingDeck.id) {
          await apiFetch(`/api/decks/${state.editingDeck.id}`, {
            method: "PUT",
            body: JSON.stringify(payload),
          });
        } else {
          await apiFetch("/api/decks", {
            method: "POST",
            body: JSON.stringify(payload),
          });
        }
        document.getElementById("deck-editor-panel").classList.add("hidden");
        await loadDecks();
        showSnackbar("Mazo guardado correctamente");
      } catch (err) {
        showSnackbar(`Error guardando mazo: ${err.message}`);
      }
    });

    document.getElementById("delete-deck-btn").addEventListener("click", async () => {
      if (!state.editingDeck?.id) return;
      await apiFetch(`/api/decks/${state.editingDeck.id}`, { method: "DELETE" });
      document.getElementById("deck-editor-panel").classList.add("hidden");
      await loadDecks();
      showSnackbar("Mazo eliminado");
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
        closeSignOutModal();
        showSnackbar(`Sincronizadas ${pushed} cartas locales hacia Cloud Firestore`);
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
      ["card-modal-backdrop", "exchange-rate-modal", "shutdown-modal", "signout-modal"].forEach((id) => {
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
        if (state.activeView === "decks") loadDecks();
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
