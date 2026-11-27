import { actions } from "../../core/actions.js";
import { apiFetch, showSnackbar } from "../../core/api.js";
import { escapeHtml, fmtMoney } from "../../core/formatters.js";
import { state } from "../../core/state.js";
import {
  renderCheerRatioChartHtml,
  renderMainColorHorizontalCardHtml,
  renderMiniCheerRatioHtml,
} from "./charts.js";
import {
  evaluateDeckRules,
  getDeckCardNumberCount,
  groupDeckCards,
  isLimitedSupportCard,
  isUnlimitedCopyCard,
} from "./rules.js";

let deckBrowserSearchTimer = null;
let deckStudioEventsBound = false;

function countActiveAdvancedDeckFilters(f) {
  let count = 0;
  if (f.group_id) count += 1;
  if (f.rarity) count += 1;
  if (f.parallel && f.parallel !== "all") count += 1;
  if (f.owned_only) count += 1;
  if (f.sort && f.sort !== "number_asc") count += 1;
  return count;
}

function syncDeckFilterVisibility() {
  const f = state.deckBuilder.filters;
  const isMain = f.zone === "main";
  const isSupportFilter = isMain && (f.card_type === "Support" || f.limited_only);
  const hideColorless = f.zone === "cheer" || f.zone === "oshi";

  if (hideColorless && f.color === "Colorless") {
    f.color = "";
  }
  if (isSupportFilter) {
    f.color = "";
    f.bloom_level = "";
  }

  const colorlessChip = document.querySelector('#deck-color-chips [data-deck-color="Colorless"]');
  colorlessChip?.classList.toggle("hidden", hideColorless);
  document.getElementById("deck-color-chips")?.classList.toggle("hidden", isSupportFilter);
  document.getElementById("deck-main-subfilters")?.classList.toggle("hidden", !isMain);
  document.getElementById("deck-bloom-chips")?.classList.toggle("hidden", !isMain || isSupportFilter);
  document.getElementById("deck-support-filter-note")?.classList.toggle("hidden", !isSupportFilter);

  const moreBtn = document.getElementById("deck-more-filters-toggle");
  if (moreBtn) {
    const activeAdv = countActiveAdvancedDeckFilters(f);
    moreBtn.textContent = activeAdv > 0 ? `Más filtros (${activeAdv})` : "Más filtros";
    moreBtn.classList.toggle("has-active-filters", activeAdv > 0);
  }
}

export function setDeckSubView(mode) {
  document.getElementById("decks-gallery-view")?.classList.toggle("hidden", mode !== "gallery");
  document.getElementById("deck-preview-view")?.classList.toggle("hidden", mode !== "preview");
  document.getElementById("deck-builder-studio")?.classList.toggle("hidden", mode !== "studio");
}

export function setDeckDirty(dirty) {
  state.deckBuilder.isDirty = Boolean(dirty);
  updateDeckDirtyBadge();
}

export function updateDeckDirtyBadge() {
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

export function setDeckMobilePane(pane) {
  state.deckBuilder.mobilePane = pane === "deck" ? "deck" : "browser";
  const grid = document.querySelector(".deck-studio-grid");
  if (grid) grid.setAttribute("data-mobile-pane", state.deckBuilder.mobilePane);
  document.querySelectorAll(".deck-mobile-tab").forEach((btn) => {
    btn.classList.toggle("active", btn.getAttribute("data-deck-pane") === state.deckBuilder.mobilePane);
  });
}

export function setDeckZoneTab(zone) {
  const f = state.deckBuilder.filters;
  f.zone = zone;
  f.page = 1;
  if (zone !== "main") {
    f.card_type = "";
    f.bloom_level = "";
    f.limited_only = false;
  }
  if ((zone === "cheer" || zone === "oshi") && f.color === "Colorless") {
    f.color = "";
  }
  document.querySelectorAll("#deck-zone-tabs .zone-tab-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.getAttribute("data-zone") === zone);
  });
  syncDeckChipStates();
  loadDeckBrowserCards();
}

export function syncDeckChipStates() {
  syncDeckFilterVisibility();
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

export function resetDeckBrowserFilters({ reload = true } = {}) {
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
  if (reload) loadDeckBrowserCards();
}

export async function openDeckEditor(deckId) {
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
  resetDeckBrowserFilters({ reload: false });
  const initialZone = detail.oshiProductId ? "main" : "oshi";
  setDeckZoneTab(initialZone);
  renderDeckPanel();
}

export function closeDeckEditor() {
  if (state.deckBuilder.isDirty) {
    const ok = window.confirm("Tienes cambios sin guardar en el mazo. ¿Volver a Mis Mazos sin guardar?");
    if (!ok) return;
  }
  state.editingDeck = null;
  setDeckDirty(false);
  setDeckSubView("gallery");
  actions.loadDecks?.();
}

export async function loadDeckBrowserCards() {
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
  const zone = card.cardType === "Cheer" ? "cheer" : "main";
  const rules = evaluateDeckRules(state.editingDeck);
  const zoneFull = zone === "cheer" ? rules.cheerCount >= 20 : rules.mainCount >= 50;

  if (qty <= 0) {
    if (zone === "cheer") {
      return `
        <div class="deck-cheer-add-row">
          <button class="deck-add-btn" data-pick-delta="1" data-pick-pid="${card.productId}" type="button" ${zoneFull ? "disabled" : ""}>+ Añadir</button>
          <button class="deck-quick-cheer-btn" data-pick-delta="5" data-pick-pid="${card.productId}" type="button" title="Añadir hasta 5 copias de este Cheer" ${zoneFull ? "disabled" : ""}>+5</button>
        </div>`;
    }
    return `<button class="deck-add-btn" data-pick-delta="1" data-pick-pid="${card.productId}" type="button" ${zoneFull ? "disabled" : ""}>+ Añadir</button>`;
  }

  const unlimited = isUnlimitedCopyCard(card);
  const numTotal = unlimited ? qty : getDeckCardNumberCount(state.editingDeck, card.cardNumber, card.productId, zone);
  const atCap = (!unlimited && numTotal >= 4) || zoneFull;
  const capTitle = zoneFull
    ? "Límite de zona alcanzado"
    : !unlimited && numTotal >= 4
      ? `Máximo 4 copias de ${card.cardNumber || card.name}`
      : "Sumar copia";

  if (zone === "cheer") {
    return `
      <div class="deck-inline-stepper is-cheer-stepper">
        <button class="deck-inline-btn" data-pick-delta="-1" data-pick-pid="${card.productId}" type="button" aria-label="Quitar copia">−</button>
        <span class="deck-inline-count">${qty}</span>
        <button class="deck-inline-btn" data-pick-delta="1" data-pick-pid="${card.productId}" type="button" aria-label="Sumar copia" title="${escapeHtml(capTitle)}" ${atCap ? "disabled" : ""}>+</button>
        <button class="deck-quick-cheer-btn is-inline" data-pick-delta="5" data-pick-pid="${card.productId}" type="button" aria-label="Sumar 5 copias" title="Añadir hasta 5 Cheers" ${zoneFull ? "disabled" : ""}>+5</button>
      </div>`;
  }

  return `
    <div class="deck-inline-stepper">
      <button class="deck-inline-btn" data-pick-delta="-1" data-pick-pid="${card.productId}" type="button" aria-label="Quitar copia">−</button>
      <span class="deck-inline-count">${unlimited ? qty : `${qty}/4`}</span>
      <button class="deck-inline-btn" data-pick-delta="1" data-pick-pid="${card.productId}" type="button" aria-label="Sumar copia" title="${escapeHtml(capTitle)}" ${atCap ? "disabled" : ""}>+</button>
    </div>`;
}

export function syncDeckBrowserCardsInPlace() {
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

export function renderDeckBrowserGrid(pageData) {
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
      const isLimited = isLimitedSupportCard(card);
      return `
        <article class="deck-pick-card ${inDeck ? "in-deck" : ""}" data-browser-pid="${card.productId}">
          <div class="deck-pick-art" data-zoom-pid="${card.productId}">
            ${
              card.imageUrl
                ? `<img src="${escapeHtml(card.imageUrl)}" alt="${escapeHtml(card.name)}" loading="lazy" />`
                : `<div class="art-fallback">${escapeHtml(card.name)}</div>`
            }
            <span class="deck-owned-pill ${owned > 0 ? "has-owned" : ""}">Tienes: ${owned}</span>
            ${isLimited ? `<span class="deck-limited-badge" title="Regla LIMITED: máximo 1 por turno">LIMITED</span>` : ""}
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
      actions.openCardModal?.(card.productId);
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

export function selectOshiForDeck(card) {
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

export function adjustCardInEditingDeck(cardOrItem, delta) {
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
    if (zone === "cheer") {
      if (rules.cheerCount >= 20) {
        showSnackbar("Cheer Deck completo (máximo 20 cartas).");
        return;
      }
      delta = Math.min(delta, 20 - rules.cheerCount);
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

export function renderDeckPanel() {
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

  // Oshi slot
  const oshiSlot = document.getElementById("deck-oshi-slot");
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
      oshiSlot.querySelector(".deck-oshi-thumb")?.addEventListener("click", () => actions.openCardModal?.(oshi.productId));
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

  // Mini curve pills + Live Cheer Color Ratio strip
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

  const miniCheerEl = document.getElementById("deck-mini-cheer-ratio");
  if (miniCheerEl) {
    const cheerHtml = renderMiniCheerRatioHtml(rules);
    miniCheerEl.innerHTML = cheerHtml;
    miniCheerEl.classList.toggle("hidden", !cheerHtml);
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
      actions.openCardModal?.(Number(el.getAttribute("data-panel-zoom")));
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
  const isLimited = isLimitedSupportCard(item);
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
          ${isLimited ? `<span class="deck-limited-inline">LIMITED</span>` : ""}
          <span class="owned-tag ${ok ? "owned-ok" : "owned-short"}">${owned}/${item.quantity}</span>
          ${item.marketPrice ? `<span>${fmtMoney(item.marketPrice * item.quantity)}</span>` : ""}
        </div>
      </div>
      <div class="stepper-controls">
        <button class="step-btn" data-panel-key="${escapeHtml(itemKey)}" data-panel-qty="-1" type="button">−</button>
        <span class="step-qty">${unlimited ? item.quantity : `${item.quantity}/4`}</span>
        <button class="step-btn plus" data-panel-key="${escapeHtml(itemKey)}" data-panel-qty="1" type="button" ${disablePlus ? "disabled" : ""}>+</button>
        ${
          zone === "cheer"
            ? `<button class="deck-quick-cheer-btn is-panel" data-panel-key="${escapeHtml(itemKey)}" data-panel-qty="5" type="button" title="Añadir hasta 5 Cheers" ${zoneFull ? "disabled" : ""}>+5</button>`
            : ""
        }
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

export function renderDeckStatsModal() {
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
        <div class="deck-stats-card-head">
          <h4 style="margin:0;">Curva de Bloom Level · Main</h4>
          <span class="deck-stats-subbadge">${rules.typeCounts.Holomem + rules.typeCounts["Buzz Holomem"]} Holomem</span>
        </div>
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

      ${renderMainColorHorizontalCardHtml(rules)}

      ${renderCheerRatioChartHtml(rules, { variant: "modal" })}

      <section class="deck-stats-card">
        <div class="deck-stats-card-head">
          <h4 style="margin:0;">Tipos &amp; Colección</h4>
          <span class="deck-stats-subbadge">${rules.totalCount}/71</span>
        </div>
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
    img.addEventListener("click", () => actions.openCardModal?.(Number(img.getAttribute("data-stats-zoom"))));
  });
}

export function bindDeckStudioEvents() {
  if (deckStudioEventsBound) return;
  deckStudioEventsBound = true;

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
  document.getElementById("deck-clear-filters-btn")?.addEventListener("click", () => resetDeckBrowserFilters());

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
      const f = state.deckBuilder.filters;
      const val = btn.getAttribute("data-deck-type");
      if (val === "LIMITED") {
        f.limited_only = !f.limited_only;
        f.card_type = "";
        if (f.limited_only) {
          f.color = "";
          f.bloom_level = "";
        }
      } else {
        f.limited_only = false;
        f.card_type = val;
        if (val === "Support") {
          f.color = "";
          f.bloom_level = "";
        }
      }
      f.page = 1;
      syncDeckChipStates();
      loadDeckBrowserCards();
    });
  });

  document.querySelectorAll("#deck-bloom-chips [data-deck-bloom]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const f = state.deckBuilder.filters;
      const bloomVal = btn.getAttribute("data-deck-bloom");
      f.bloom_level = bloomVal;
      if (bloomVal) {
        f.limited_only = false;
        if (f.card_type === "Support") f.card_type = "";
      }
      f.page = 1;
      syncDeckChipStates();
      loadDeckBrowserCards();
    });
  });

  document.getElementById("deck-filter-edition")?.addEventListener("change", (e) => {
    state.deckBuilder.filters.group_id = e.target.value;
    state.deckBuilder.filters.page = 1;
    syncDeckFilterVisibility();
    loadDeckBrowserCards();
  });
  document.getElementById("deck-filter-rarity")?.addEventListener("change", (e) => {
    state.deckBuilder.filters.rarity = e.target.value;
    state.deckBuilder.filters.page = 1;
    syncDeckFilterVisibility();
    loadDeckBrowserCards();
  });
  document.getElementById("deck-filter-parallel")?.addEventListener("change", (e) => {
    state.deckBuilder.filters.parallel = e.target.value;
    state.deckBuilder.filters.page = 1;
    syncDeckFilterVisibility();
    loadDeckBrowserCards();
  });
  document.getElementById("deck-filter-sort")?.addEventListener("change", (e) => {
    state.deckBuilder.filters.sort = e.target.value;
    state.deckBuilder.filters.page = 1;
    syncDeckFilterVisibility();
    loadDeckBrowserCards();
  });
  document.getElementById("deck-filter-owned-only")?.addEventListener("change", (e) => {
    state.deckBuilder.filters.owned_only = e.target.checked;
    state.deckBuilder.filters.page = 1;
    syncDeckFilterVisibility();
    loadDeckBrowserCards();
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
}
