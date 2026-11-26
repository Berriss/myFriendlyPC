import {
  bindCardInteractions,
  renderCardTableRow,
  renderCardTile,
  renderCardsTable,
  renderPagination,
} from "../components/card-ui.js";
import { actions } from "../core/actions.js";
import { apiFetch, showSnackbar } from "../core/api.js";
import { escapeHtml } from "../core/formatters.js";
import { state } from "../core/state.js";

let searchTimer = null;
let infiniteObserver = null;

export function buildCardsQueryString() {
  const params = new URLSearchParams();
  Object.entries(state.filters).forEach(([k, v]) => {
    if (v !== "" && v !== null && v !== undefined) {
      params.set(k, String(v));
    }
  });
  return params.toString();
}

export function updateScrollModeUI() {
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

export function setupInfiniteObserver() {
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

export async function loadCards() {
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

export async function loadMoreCards() {
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

export function updateResultsCountLabel() {
  if (!state.cardsPage) return;
  const countLabel = document.getElementById("results-count-label");
  if (state.scrollMode === "infinite") {
    countLabel.textContent = `Mostrando ${state.cardsPage.items.length} de ${state.cardsPage.total.toLocaleString()} resultados (Scroll infinito)`;
  } else {
    countLabel.textContent = `Mostrando ${state.cardsPage.items.length} de ${state.cardsPage.total.toLocaleString()} resultados (Página ${state.cardsPage.page} de ${state.cardsPage.totalPages})`;
  }
}

export function appendCardsToDom(newItems) {
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

export function renderCards(data) {
  const container = document.getElementById("cards-container");
  updateResultsCountLabel();

  document
    .getElementById("catalog-wishlist-pdf-btn")
    ?.classList.toggle("hidden", state.filters.ownership !== "wishlist");

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

export function replaceSingleCardInDom(updated) {
  const existingEl = document.querySelector(`#cards-container [data-pid="${updated.productId}"]`);
  if (existingEl) {
    const wrapper = document.createElement(state.viewMode === "grid" ? "div" : "tbody");
    wrapper.innerHTML =
      state.viewMode === "grid" ? renderCardTile(updated) : renderCardTableRow(updated);
    const nextEl = wrapper.firstElementChild;
    if (nextEl) {
      existingEl.replaceWith(nextEl);
      bindCardInteractions(nextEl);
    }
  }
}

export function resetFilters() {
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

export function bindCatalogEvents() {
  document.getElementById("toggle-filters-btn")?.addEventListener("click", () => {
    document.getElementById("advanced-filters")?.classList.toggle("open");
  });

  document.getElementById("scroll-mode-paged")?.addEventListener("click", () => {
    if (state.scrollMode === "paged") return;
    state.scrollMode = "paged";
    localStorage.setItem("hocg-scroll-mode", "paged");
    state.filters.page = 1;
    updateScrollModeUI();
    loadCards();
  });

  document.getElementById("scroll-mode-infinite")?.addEventListener("click", () => {
    if (state.scrollMode === "infinite") return;
    state.scrollMode = "infinite";
    localStorage.setItem("hocg-scroll-mode", "infinite");
    state.filters.page = 1;
    updateScrollModeUI();
    loadCards();
  });

  document.getElementById("view-mode-grid")?.addEventListener("click", () => {
    state.viewMode = "grid";
    document.getElementById("view-mode-grid").classList.add("active");
    document.getElementById("view-mode-table").classList.remove("active");
    if (state.cardsPage) renderCards(state.cardsPage);
  });

  document.getElementById("view-mode-table")?.addEventListener("click", () => {
    state.viewMode = "table";
    document.getElementById("view-mode-table").classList.add("active");
    document.getElementById("view-mode-grid").classList.remove("active");
    if (state.cardsPage) renderCards(state.cardsPage);
  });

  document.getElementById("filter-q")?.addEventListener("input", (e) => {
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
    document.getElementById(id)?.addEventListener("change", (e) => {
      state.filters[key] = e.target.value;
      state.filters.page = 1;
      loadCards();
    });
  });

  ["filter-min-price", "filter-max-price"].forEach((id) => {
    document.getElementById(id)?.addEventListener("change", (e) => {
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

  document.getElementById("clear-filters-btn")?.addEventListener("click", resetFilters);
  document.getElementById("catalog-wishlist-pdf-btn")?.addEventListener("click", () => {
    actions.openWishlistPdfModal?.();
  });
}
