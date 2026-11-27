import { apiFetch } from "../../core/api.js";
import { escapeHtml, fmtMoney } from "../../core/formatters.js";
import { state } from "../../core/state.js";

const PICKER_PER_PAGE = 24;

let outSearchTimer = null;
let inSearchTimer = null;
let pickerEventsBound = false;
let pickCardHandler = null;

function createInitialSideState() {
  return {
    page: 0,
    totalPages: 1,
    total: 0,
    items: [],
    cardMap: new Map(),
    isLoading: false,
    requestSeq: 0,
    isOpen: false,
    lastQueryKey: null,
  };
}

const pickerState = {
  out: createInitialSideState(),
  in: createInitialSideState(),
};

function getPickerEls(side) {
  const isOut = side === "out";
  return {
    isOut,
    resultsEl: document.getElementById(isOut ? "trade-out-results" : "trade-in-results"),
    qInput: document.getElementById(isOut ? "trade-out-search" : "trade-in-search"),
    clearBtn: document.getElementById(isOut ? "trade-out-search-clear" : "trade-in-search-clear"),
  };
}

function getSelectedQtyMap(side) {
  const ed = state.trading.editor;
  const list = side === "out" ? ed?.itemsOut : ed?.itemsIn;
  const map = new Map();
  for (const item of list || []) {
    const pid = Number(item.productId);
    map.set(pid, (map.get(pid) || 0) + Number(item.quantity || 0));
  }
  return map;
}

function buildPickerQuery(side, page) {
  const ed = state.trading.editor;
  const { isOut, qInput } = getPickerEls(side);
  const q = (qInput?.value || "").trim();
  const ownedOnly = isOut ? Boolean(document.getElementById("trade-out-owned-only")?.checked) : false;
  const scope = isOut ? (ownedOnly ? "out-owned" : "out-all") : ed?.inSearchScope || "all";

  const params = new URLSearchParams();
  params.set("per_page", String(PICKER_PER_PAGE));
  params.set("page", String(page));
  if (q) params.set("q", q);

  if (isOut) {
    params.set("item_category", "all");
    if (ownedOnly) params.set("ownership", "owned");
    params.set("sort", "owned_desc");
  } else if (scope === "wishlist") {
    params.set("item_category", "all");
    params.set("ownership", "wishlist");
    params.set("sort", "price_desc");
  } else if (scope === "sealed") {
    params.set("item_category", "sealed");
    params.set("sort", "price_desc");
  } else if (scope === "cards") {
    params.set("item_category", "card");
    params.set("sort", "price_desc");
  } else {
    params.set("item_category", "all");
    params.set("sort", "price_desc");
  }

  return {
    params,
    queryKey: `${side}|${scope}|${q.toLowerCase()}`,
  };
}

function renderPickerOptionHtml(side, card, qtyMap) {
  const p = card.marketPrice ?? card.foilMarketPrice ?? 0;
  const pid = Number(card.productId);
  const pickedQty = qtyMap.get(pid) || 0;
  return `
    <button class="trade-picker-option ${pickedQty > 0 ? "is-picked" : ""}" type="button" data-pick-side="${side}" data-pick-pid="${pid}">
      ${
        card.imageUrl
          ? `<img class="trade-item-thumb" src="${escapeHtml(card.imageUrl)}" alt="" loading="lazy" />`
          : `<div class="trade-item-thumb-ph">?</div>`
      }
      <span class="trade-picker-option-info">
        <strong class="trade-picker-option-name">${escapeHtml(card.name)}</strong>
        <span class="trade-picker-option-meta muted-text">
          ${escapeHtml(card.cardNumber || "S/N")} · ${escapeHtml(card.editionAbbr || card.editionName || "—")} · ${escapeHtml(card.rarity || "—")}
          ${card.totalOwned > 0 ? ` · Tienes: ${card.totalOwned}` : ""}
          ${card.isWishlist ? ` · ♥ Wishlist` : ""}
        </span>
      </span>
      <span class="trade-picker-option-right">
        <span class="trade-picker-price">${fmtMoney(p)}</span>
        <span class="trade-picker-in-badge ${pickedQty > 0 ? "" : "hidden"}">${pickedQty > 0 ? `×${pickedQty}` : ""}</span>
      </span>
    </button>`;
}

function ensurePickerShell(resultsEl, side) {
  if (!resultsEl.querySelector(".trade-picker-header")) {
    resultsEl.innerHTML = `
      <div class="trade-picker-header">
        <span class="trade-picker-count">Buscando...</span>
        <button class="trade-picker-done-btn" data-picker-done="${side}" type="button">✓ Listo</button>
      </div>
      <div class="trade-picker-items"></div>
      <div class="trade-picker-footer"></div>`;
  }
  return {
    countEl: resultsEl.querySelector(".trade-picker-count"),
    itemsEl: resultsEl.querySelector(".trade-picker-items"),
    footerEl: resultsEl.querySelector(".trade-picker-footer"),
  };
}

function updatePickerMetaAndFooter(side, { errorMsg = null } = {}) {
  const st = pickerState[side];
  const { resultsEl } = getPickerEls(side);
  if (!resultsEl) return;

  const { countEl, footerEl } = ensurePickerShell(resultsEl, side);
  if (countEl) {
    if (errorMsg) {
      countEl.textContent = "Error al buscar";
    } else if (st.isLoading && st.items.length === 0) {
      countEl.textContent = "Buscando cartas...";
    } else {
      countEl.textContent = `Mostrando ${st.items.length.toLocaleString()} de ${Number(st.total || 0).toLocaleString()}`;
    }
  }

  if (!footerEl) return;
  if (errorMsg) {
    footerEl.innerHTML = `<div class="muted-text trade-picker-end-msg">${escapeHtml(errorMsg)}</div>`;
    return;
  }

  const remaining = Math.max(0, Number(st.total || 0) - st.items.length);
  if (st.page < st.totalPages && remaining > 0) {
    footerEl.innerHTML = `
      <button class="trade-picker-load-more" data-picker-more="${side}" type="button" ${st.isLoading ? "disabled" : ""}>
        ${st.isLoading ? "Cargando más..." : `Cargar más (${remaining.toLocaleString()} restantes)`}
      </button>`;
  } else if (st.items.length > 0) {
    footerEl.innerHTML = `<div class="trade-picker-end-msg">Mostrando todas (${st.items.length.toLocaleString()})</div>`;
  } else {
    footerEl.innerHTML = "";
  }
}

export function resetTradePicker(side) {
  const targets = side ? [side] : ["out", "in"];
  for (const s of targets) {
    const prevSeq = pickerState[s]?.requestSeq || 0;
    pickerState[s] = {
      ...createInitialSideState(),
      requestSeq: prevSeq + 1,
    };
    const { resultsEl } = getPickerEls(s);
    if (resultsEl) {
      resultsEl.classList.add("hidden");
      resultsEl.innerHTML = "";
    }
  }
  syncSearchClearButtons();
}

export function closeTradePicker(side) {
  const st = pickerState[side];
  if (st) st.isOpen = false;
  getPickerEls(side).resultsEl?.classList.add("hidden");
}

export function closeAllTradePickers() {
  closeTradePicker("out");
  closeTradePicker("in");
}

export function syncSearchClearButtons() {
  for (const side of ["out", "in"]) {
    const { qInput, clearBtn } = getPickerEls(side);
    if (!qInput || !clearBtn) continue;
    clearBtn.classList.toggle("hidden", !qInput.value.trim());
  }
}

export function syncTradePickerSelectionBadges(side) {
  const { resultsEl } = getPickerEls(side);
  if (!resultsEl) return;
  const qtyMap = getSelectedQtyMap(side);
  resultsEl.querySelectorAll(".trade-picker-option[data-pick-pid]").forEach((btn) => {
    const pid = Number(btn.getAttribute("data-pick-pid"));
    const qty = qtyMap.get(pid) || 0;
    btn.classList.toggle("is-picked", qty > 0);
    const badge = btn.querySelector(".trade-picker-in-badge");
    if (badge) {
      badge.textContent = qty > 0 ? `×${qty}` : "";
      badge.classList.toggle("hidden", qty <= 0);
    }
  });
}

async function fetchPickerPage(side, page, { reset }) {
  const st = pickerState[side];
  const { resultsEl } = getPickerEls(side);
  if (!st || !resultsEl || !state.trading.editor) return;

  const { params, queryKey } = buildPickerQuery(side, page);
  const seq = reset ? st.requestSeq + 1 : st.requestSeq;
  st.requestSeq = seq;
  st.isLoading = true;
  st.isOpen = true;
  st.lastQueryKey = queryKey;
  resultsEl.classList.remove("hidden");

  const { itemsEl } = ensurePickerShell(resultsEl, side);
  if (reset && itemsEl) {
    st.page = 0;
    st.total = 0;
    st.totalPages = 1;
    st.items = [];
    st.cardMap = new Map();
    itemsEl.innerHTML = "";
    resultsEl.scrollTop = 0;
  }
  updatePickerMetaAndFooter(side);

  try {
    const data = await apiFetch(`/api/cards?${params.toString()}`);
    if (pickerState[side].requestSeq !== seq) return;

    const batch = Array.isArray(data.items) ? data.items : [];
    st.page = Number(data.page || page);
    st.totalPages = Math.max(1, Number(data.totalPages || 1));
    st.total = Number(data.total || batch.length);

    const qtyMap = getSelectedQtyMap(side);
    const newHtmlParts = [];
    for (const c of batch) {
      const pid = Number(c.productId);
      if (reset || !st.cardMap.has(pid)) {
        st.items.push(c);
        st.cardMap.set(pid, c);
        newHtmlParts.push(renderPickerOptionHtml(side, c, qtyMap));
      }
    }

    if (!st.items.length && itemsEl) {
      itemsEl.innerHTML = `<div class="muted-text trade-picker-empty">Sin resultados con este filtro.</div>`;
    } else if (itemsEl && newHtmlParts.length) {
      itemsEl.insertAdjacentHTML("beforeend", newHtmlParts.join(""));
    }

    st.isLoading = false;
    updatePickerMetaAndFooter(side);
  } catch (err) {
    if (pickerState[side].requestSeq !== seq) return;
    st.isLoading = false;
    updatePickerMetaAndFooter(side, { errorMsg: `Error buscando: ${err.message}` });
  }
}

export async function searchTradePicker(side, { reset = true, preserveIfSame = false } = {}) {
  const st = pickerState[side];
  const { resultsEl } = getPickerEls(side);
  if (!st || !resultsEl || !state.trading.editor) return;

  const { queryKey } = buildPickerQuery(side, 1);
  if (preserveIfSame && st.lastQueryKey === queryKey && st.items.length > 0) {
    st.isOpen = true;
    resultsEl.classList.remove("hidden");
    syncTradePickerSelectionBadges(side);
    return;
  }

  await fetchPickerPage(side, 1, { reset });
}

export async function loadMoreTradePicker(side) {
  const st = pickerState[side];
  if (!st || st.isLoading || st.page >= st.totalPages) return;
  await fetchPickerPage(side, st.page + 1, { reset: false });
}

function wireSidePickerDomEvents(side) {
  const { resultsEl, qInput, clearBtn } = getPickerEls(side);

  resultsEl?.addEventListener("click", (e) => {
    e.stopPropagation();

    const doneBtn = e.target.closest("[data-picker-done]");
    if (doneBtn) {
      closeTradePicker(side);
      return;
    }

    const moreBtn = e.target.closest("[data-picker-more]");
    if (moreBtn) {
      loadMoreTradePicker(side);
      return;
    }

    const optBtn = e.target.closest(".trade-picker-option[data-pick-pid]");
    if (optBtn) {
      const pid = Number(optBtn.getAttribute("data-pick-pid"));
      const card = pickerState[side]?.cardMap.get(pid);
      if (card) {
        pickCardHandler?.(side, card);
        syncTradePickerSelectionBadges(side);
      }
    }
  });

  resultsEl?.addEventListener("scroll", () => {
    const st = pickerState[side];
    if (!st || !st.isOpen || st.isLoading || st.page >= st.totalPages) return;
    const distanceToBottom = resultsEl.scrollHeight - resultsEl.scrollTop - resultsEl.clientHeight;
    if (distanceToBottom <= 110) {
      loadMoreTradePicker(side);
    }
  });

  qInput?.addEventListener("input", () => {
    syncSearchClearButtons();
    if (side === "out") {
      clearTimeout(outSearchTimer);
      outSearchTimer = setTimeout(() => searchTradePicker("out", { reset: true }), 180);
    } else {
      clearTimeout(inSearchTimer);
      inSearchTimer = setTimeout(() => searchTradePicker("in", { reset: true }), 180);
    }
  });

  qInput?.addEventListener("focus", () => {
    searchTradePicker(side, { reset: true, preserveIfSame: true });
  });

  clearBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!qInput) return;
    qInput.value = "";
    syncSearchClearButtons();
    searchTradePicker(side, { reset: true });
    qInput.focus();
  });
}

export function bindTradePickerEvents({ onPickCard } = {}) {
  pickCardHandler = onPickCard || null;
  if (pickerEventsBound) return;
  pickerEventsBound = true;

  wireSidePickerDomEvents("out");
  wireSidePickerDomEvents("in");

  document.getElementById("trade-out-owned-only")?.addEventListener("change", () => {
    searchTradePicker("out", { reset: true });
  });

  document.querySelectorAll("#trade-in-scope-chips [data-trade-in-scope]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (!state.trading.editor) return;
      document.querySelectorAll("#trade-in-scope-chips .filter-chip").forEach((c) => c.classList.remove("active"));
      btn.classList.add("active");
      state.trading.editor.inSearchScope = btn.getAttribute("data-trade-in-scope") || "all";
      searchTradePicker("in", { reset: true });
    });
  });
}
