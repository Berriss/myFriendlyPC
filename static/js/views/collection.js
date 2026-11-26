import {
  bindCardInteractions,
  renderCardTile,
  renderPagination,
} from "../components/card-ui.js";
import { actions } from "../core/actions.js";
import { apiFetch, showSnackbar } from "../core/api.js";
import { downloadJsonFile, escapeHtml, fmtClp, fmtMoney, fmtUsd } from "../core/formatters.js";
import { state } from "../core/state.js";

let colSearchTimer = null;

export async function loadEditions() {
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
      const ownTag = ed.ownedTotalCopies > 0 ? ` (${ed.ownedTotalCopies})` : "";
      opt.textContent = `${abbr}${ed.name}${ownTag}`;
      select.appendChild(opt);
    });
    if (currentVal) select.value = currentVal;

    const colEdSelect = document.getElementById("collection-filter-edition");
    if (colEdSelect) {
      const curColVal = colEdSelect.value;
      colEdSelect.innerHTML = `<option value="">Todos los sets (${editions.length})</option>`;
      editions.forEach((ed) => {
        const opt = document.createElement("option");
        opt.value = String(ed.groupId);
        const abbr = ed.abbreviation ? `[${ed.abbreviation}] ` : "";
        const ownTag = ed.ownedTotalCopies > 0 ? ` (${ed.ownedTotalCopies})` : "";
        opt.textContent = `${abbr}${ed.name}${ownTag}`;
        colEdSelect.appendChild(opt);
      });
      if (curColVal) colEdSelect.value = curColVal;
    }

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

    const setsBadgeEl = document.getElementById("kpi-sets-owned-badge");
    if (setsBadgeEl) {
      const setsWithCards = editions.filter((ed) => ed.ownedTotalCopies > 0).length;
      setsBadgeEl.textContent = `${setsWithCards} / ${editions.length} sets`;
    }

    if (state.activeView === "collection") {
      renderCollectionBalance(state.kpis, editions);
      renderEditionsGrid(editions);
    }
  } catch (err) {
    console.error("Error loading editions:", err);
  }
}

export async function loadEditionsAndCollection() {
  await Promise.all([loadEditions(), actions.loadKpis?.(), loadCollectionCards()]);
  renderCollectionBalance(state.kpis, state.editions);
  renderEditionsGrid(state.editions);
}

export function formatReleaseMeta(publishedOn) {
  const raw = String(publishedOn || "").slice(0, 10);
  if (!raw) return { label: "Fecha s/d", isUpcoming: false };
  const today = new Date().toISOString().slice(0, 10);
  const isUpcoming = raw > today;
  const months = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];
  const parts = raw.split("-");
  const year = parts[0];
  const monIdx = Number(parts[1]) - 1;
  const label = months[monIdx] ? `${months[monIdx]} ${year}` : raw;
  return { label, isUpcoming };
}

export function renderCollectionBalance(kpis, editions) {
  const k = kpis || {};
  const eds = Array.isArray(editions) ? editions : [];
  const isClp = state.currency === "CLP";
  const mkt = Number(k.collectionMarketValueUsd || 0);
  const cost = Number(k.collectionCostBasisUsd || 0);
  const net = Number(k.netGainUsd || 0);

  const balTitle = document.getElementById("col-balance-title");
  const balMain = document.getElementById("col-balance-main");
  const balEquiv = document.getElementById("col-balance-equiv");
  const balNet = document.getElementById("col-balance-net");
  if (balTitle) balTitle.textContent = isClp ? "Total a Favor (CLP)" : "Total a Favor (USD)";
  if (balMain) balMain.textContent = fmtMoney(mkt);
  if (balEquiv) {
    balEquiv.textContent = isClp
      ? `≈ ${fmtUsd(mkt)} USD (Tasa $${Math.round(state.exchangeRate.rateClpPerUsd).toLocaleString("es-CL")})`
      : `≈ ${fmtClp(mkt)}`;
  }
  if (balNet) {
    if (cost > 0) {
      const netSign = net >= 0 ? "+" : "-";
      balNet.textContent = `Costo registrado: ${fmtMoney(cost)} · Neto: ${netSign}${fmtMoney(Math.abs(net))}`;
      balNet.classList.remove("hidden");
    } else {
      balNet.classList.add("hidden");
    }
  }

  const totalCopies = Number(k.ownedTotalCopies || 0);
  const uniqueOwned = Number(k.ownedUniqueCards || 0);
  const favs = Number(k.favoritesCount || 0);
  const wish = Number(k.wishlistCount || 0);
  const copiesMain = document.getElementById("col-copies-main");
  const copiesSub = document.getElementById("col-copies-sub");
  if (copiesMain) copiesMain.textContent = `${totalCopies.toLocaleString()} copias`;
  if (copiesSub) copiesSub.textContent = `${uniqueOwned.toLocaleString()} distintas · ${favs} fav · ${wish} wishlist`;

  const setsWithCards = eds.filter((ed) => ed.ownedTotalCopies > 0).length;
  const totalSets = eds.length || Number(k.totalEditions || 0);
  const releasedCount = eds.filter((ed) => !formatReleaseMeta(ed.publishedOn).isUpcoming).length;
  const setsMain = document.getElementById("col-sets-main");
  const setsSub = document.getElementById("col-sets-sub");
  if (setsMain) setsMain.textContent = `${setsWithCards} / ${totalSets}`;
  if (setsSub) setsSub.textContent = `${releasedCount} sets ya liberados · ${setsWithCards} con cartas`;

  const setsTitle = document.getElementById("collection-sets-title");
  if (setsTitle) setsTitle.textContent = `Sets liberados hasta la fecha (${totalSets})`;

  const filterBar = document.getElementById("collection-sets-filter");
  if (filterBar) {
    filterBar.querySelectorAll("[data-sets-filter]").forEach((btn) => {
      const mode = btn.getAttribute("data-sets-filter");
      btn.classList.toggle("active", mode === state.collectionView.setsFilter);
      if (mode === "all") btn.textContent = `Todos (${totalSets})`;
      else if (mode === "owned") btn.textContent = `Con cartas (${setsWithCards})`;
    });
  }
}

export async function loadCollectionCards() {
  const container = document.getElementById("collection-cards-container");
  const metaEl = document.getElementById("collection-results-meta");
  if (!container || !metaEl) return;

  const cv = state.collectionView;
  const params = new URLSearchParams();
  params.set("item_category", "card");
  params.set("ownership", cv.scope);
  if (cv.q.trim()) params.set("q", cv.q.trim());
  if (cv.group_id) params.set("group_id", cv.group_id);
  params.set("sort", cv.sort);
  params.set("page", String(cv.page));
  params.set("per_page", String(cv.per_page));

  const clearBtn = document.getElementById("collection-clear-filters-btn");
  if (clearBtn) {
    clearBtn.classList.toggle("hidden", !cv.q.trim() && !cv.group_id);
  }

  document.getElementById("collection-wishlist-pdf-bar")?.classList.toggle("hidden", cv.scope !== "wishlist");

  metaEl.textContent = "Cargando cartas...";
  try {
    const data = await apiFetch(`/api/cards?${params.toString()}`);
    state.collectionView.pageData = data;
    renderCollectionCards(data);
  } catch (err) {
    container.innerHTML = `<div class="panel-card">Error cargando cartas: ${escapeHtml(err.message)}</div>`;
    metaEl.textContent = "Error al cargar";
  }
}

export function renderCollectionCards(data) {
  const container = document.getElementById("collection-cards-container");
  const metaEl = document.getElementById("collection-results-meta");
  if (!container || !metaEl) return;

  const items = data.items || [];
  const total = Number(data.total || 0);
  metaEl.textContent = `${total.toLocaleString()} resultado(s)${data.totalPages > 1 ? ` · Pág. ${data.page}/${data.totalPages}` : ""}`;

  renderPagination("collection-pagination", data.page, data.totalPages, (nextPage) => {
    state.collectionView.page = nextPage;
    loadCollectionCards();
  });

  if (!items.length) {
    container.className = "";
    const scopeLabel =
      state.collectionView.scope === "favorite"
        ? "favoritas"
        : state.collectionView.scope === "wishlist"
          ? "en tu wishlist"
          : "registradas en tu colección";
    const hasSearchFilter = Boolean(state.collectionView.q.trim() || state.collectionView.group_id);
    container.innerHTML = `
      <div class="panel-card" style="text-align:center;padding:28px;">
        <p class="muted-text" style="margin:0 0 12px;">
          ${
            hasSearchFilter
              ? "No hay cartas que coincidan con los filtros actuales."
              : `Todavía no tienes cartas ${scopeLabel}.`
          }
        </p>
        <button id="collection-empty-action-btn" class="tonal-btn" type="button">
          ${hasSearchFilter ? "Limpiar filtros" : "Ir al Catálogo a registrar cartas"}
        </button>
      </div>`;
    document.getElementById("collection-empty-action-btn")?.addEventListener("click", () => {
      if (hasSearchFilter) {
        resetCollectionFilters();
      } else {
        jumpToCatalogForAdding();
      }
    });
    return;
  }

  container.className = "cards-grid";
  container.innerHTML = items.map(renderCardTile).join("");
  bindCardInteractions(container);
}

export function resetCollectionFilters() {
  state.collectionView.q = "";
  state.collectionView.group_id = "";
  state.collectionView.page = 1;
  const qEl = document.getElementById("collection-filter-q");
  if (qEl) qEl.value = "";
  const edEl = document.getElementById("collection-filter-edition");
  if (edEl) edEl.value = "";
  loadCollectionCards();
}

export function jumpToCatalogForAdding(groupId) {
  state.filters.ownership = "all";
  state.filters.group_id = groupId ? String(groupId) : "";
  state.filters.page = 1;
  const edEl = document.getElementById("filter-edition");
  if (edEl) edEl.value = state.filters.group_id;
  document.querySelectorAll("#ownership-chips .filter-chip").forEach((c) => {
    c.classList.toggle("active", c.getAttribute("data-ownership") === "all");
  });
  actions.switchView?.("catalog");
  actions.loadCards?.();
}

export function renderEditionsGrid(editions) {
  const host = document.getElementById("editions-progress-grid");
  if (!host) return;
  const onlyOwned = state.collectionView.setsFilter === "owned";
  const list = onlyOwned ? editions.filter((ed) => ed.ownedTotalCopies > 0) : editions;

  if (!list.length) {
    host.innerHTML = `
      <div class="panel-card" style="grid-column:1/-1;">
        <p class="muted-text" style="margin:0;">Aún no tienes cartas registradas en ningún set. Cambia a <strong>Todos</strong> o agrega cartas desde el Catálogo.</p>
      </div>`;
    return;
  }

  host.innerHTML = list
    .map((ed) => {
      const hasCards = Number(ed.ownedTotalCopies || 0) > 0;
      const rel = formatReleaseMeta(ed.publishedOn);
      return `
        <article class="set-simple-card ${hasCards ? "has-cards" : ""}" data-set-card="${ed.groupId}" data-has-cards="${hasCards ? "1" : "0"}">
          <div class="edition-head">
            <div class="edition-title">${escapeHtml(ed.name)}</div>
            <span class="edition-abbr">${escapeHtml(ed.abbreviation || "SET")}</span>
          </div>
          <div class="set-release-row">
            <span>${escapeHtml(rel.label)}</span>
            <span class="set-release-badge ${rel.isUpcoming ? "is-upcoming" : ""}">${rel.isUpcoming ? "Próximo" : "Liberado"}</span>
          </div>
          <div class="set-status-row">
            ${
              hasCards
                ? `<span class="set-owned-pill">✓ ${ed.ownedTotalCopies} ${ed.ownedTotalCopies === 1 ? "copia" : "copias"} · ${fmtMoney(ed.collectionValueUsd)}</span>`
                : `<span class="set-empty-label">Sin cartas registradas</span>`
            }
            <button class="set-catalog-link" data-jump-catalog-set="${ed.groupId}" type="button">Catálogo ↗</button>
          </div>
        </article>`;
    })
    .join("");

  host.querySelectorAll("[data-jump-catalog-set]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      jumpToCatalogForAdding(btn.getAttribute("data-jump-catalog-set"));
    });
  });

  host.querySelectorAll("[data-set-card]").forEach((el) => {
    el.addEventListener("click", () => {
      const gid = el.getAttribute("data-set-card");
      const hasCards = el.getAttribute("data-has-cards") === "1";
      if (hasCards) {
        state.collectionView.scope = "owned";
        state.collectionView.group_id = String(gid);
        state.collectionView.page = 1;
        const edSel = document.getElementById("collection-filter-edition");
        if (edSel) edSel.value = String(gid);
        document.querySelectorAll("#collection-scope-chips .filter-chip").forEach((c) => {
          c.classList.toggle("active", c.getAttribute("data-col-scope") === "owned");
        });
        loadCollectionCards();
        document.getElementById("collection-cards-section")?.scrollIntoView({ behavior: "smooth" });
      } else {
        jumpToCatalogForAdding(gid);
      }
    });
  });
}

export function replaceSingleCardInCollectionDom(updated) {
  const existingCol = document.querySelector(`#collection-cards-container [data-pid="${updated.productId}"]`);
  if (!existingCol) return;
  const wrapper = document.createElement("div");
  wrapper.innerHTML = renderCardTile(updated);
  const nextEl = wrapper.firstElementChild;
  if (nextEl) {
    existingCol.replaceWith(nextEl);
    bindCardInteractions(nextEl);
  }
}

export async function exportCollection() {
  try {
    const payload = await apiFetch("/api/collection/export");
    downloadJsonFile(
      `hololive_ocg_collection_${new Date().toISOString().slice(0, 10)}.json`,
      payload
    );
    showSnackbar(`Exportadas ${payload.entries.length} entradas de colección`);
  } catch (err) {
    showSnackbar(`Error al exportar: ${err.message}`);
  }
}

export async function importCollectionFile(file) {
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    const entries = Array.isArray(parsed) ? parsed : parsed.entries;
    if (!Array.isArray(entries)) throw new Error("Formato de JSON inválido");
    const res = await apiFetch("/api/collection/import", {
      method: "POST",
      body: JSON.stringify({ entries, replaceExisting: false }),
    });
    const tasks = [actions.loadKpis?.(), loadEditions(), actions.loadCards?.()];
    if (state.activeView === "collection") tasks.push(loadCollectionCards());
    await Promise.all(tasks);
    showSnackbar(`Importadas ${res.imported} cartas (${res.skipped} omitidas)`);
  } catch (err) {
    showSnackbar(`Error al importar: ${err.message}`);
  }
}

export function bindCollectionEvents() {
  document.getElementById("export-btn-top")?.addEventListener("click", exportCollection);
  document.getElementById("export-collection-btn")?.addEventListener("click", exportCollection);
  document.getElementById("open-wishlist-pdf-btn")?.addEventListener("click", () => {
    actions.openWishlistPdfModal?.();
  });
  document.getElementById("collection-inline-wishlist-pdf-btn")?.addEventListener("click", () => {
    actions.openWishlistPdfModal?.();
  });

  document.getElementById("import-collection-input")?.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (file) importCollectionFile(file);
    e.target.value = "";
  });

  document.getElementById("view-owned-in-catalog-btn")?.addEventListener("click", () => {
    jumpToCatalogForAdding();
  });

  document.querySelectorAll("#collection-scope-chips [data-col-scope]").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#collection-scope-chips .filter-chip").forEach((c) => c.classList.remove("active"));
      btn.classList.add("active");
      state.collectionView.scope = btn.getAttribute("data-col-scope");
      state.collectionView.page = 1;
      loadCollectionCards();
    });
  });

  document.getElementById("collection-filter-q")?.addEventListener("input", (e) => {
    clearTimeout(colSearchTimer);
    colSearchTimer = setTimeout(() => {
      state.collectionView.q = e.target.value;
      state.collectionView.page = 1;
      loadCollectionCards();
    }, 220);
  });

  document.getElementById("collection-filter-edition")?.addEventListener("change", (e) => {
    state.collectionView.group_id = e.target.value;
    state.collectionView.page = 1;
    loadCollectionCards();
  });

  document.getElementById("collection-filter-sort")?.addEventListener("change", (e) => {
    state.collectionView.sort = e.target.value;
    state.collectionView.page = 1;
    loadCollectionCards();
  });

  document.getElementById("collection-clear-filters-btn")?.addEventListener("click", resetCollectionFilters);

  document.querySelectorAll("#collection-sets-filter [data-sets-filter]").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#collection-sets-filter .filter-chip").forEach((c) => c.classList.remove("active"));
      btn.classList.add("active");
      state.collectionView.setsFilter = btn.getAttribute("data-sets-filter") || "all";
      renderEditionsGrid(state.editions);
    });
  });
}
