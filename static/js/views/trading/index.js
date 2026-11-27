import { apiFetch, showSnackbar, triggerGoogleSignIn } from "../../core/api.js";
import { downloadJsonFile, escapeHtml, fmtMoney } from "../../core/formatters.js";
import { state } from "../../core/state.js";
import {
  bindTradeEditorEvents,
  openTradeDeleteModal,
  openTradeEditor,
  renderTradeEditorLiveVerdict,
  renderTradeEditorSideItems,
} from "./editor.js";
import { fmtSignedAltMoney, fmtSignedMoney, getTradeTypeMeta, getVerdictMeta } from "./rules.js";

export { openTradeEditor, renderTradeEditorLiveVerdict, renderTradeEditorSideItems };

let tradingEventsBound = false;

export async function loadTrades() {
  const host = document.getElementById("trading-list-container");
  if (!host) return;
  try {
    const data = await apiFetch("/api/trades");
    state.trading.summary = data.summary || null;
    state.trading.items = Array.isArray(data.items) ? data.items : [];
    syncTradingBasisUI();
    renderTradesSummary(state.trading.summary);
    renderTradesList();
  } catch (err) {
    host.innerHTML = `<div class="panel-card">Error cargando Trading: ${escapeHtml(err.message)}</div>`;
  }
}

export function syncTradingBasisUI() {
  const basis = state.trading.basis === "deal" ? "deal" : "now";
  document.querySelectorAll("#trading-basis-switch [data-trade-basis]").forEach((btn) => {
    btn.classList.toggle("active", btn.getAttribute("data-trade-basis") === basis);
  });
  const desc = document.getElementById("trading-basis-desc");
  if (desc) {
    desc.textContent =
      basis === "now"
        ? "Comparando cartas según los precios de mercado diarios actuales (si subieron o bajaron)."
        : "Evaluando cada operación con el valor que tenían las cartas el día que cerraste el trato.";
  }
}

export function renderTradesSummary(summary) {
  const strip = document.getElementById("trading-summary-strip");
  if (!strip) return;
  const s = summary || {
    totalTrades: 0,
    buyCount: 0,
    sellCount: 0,
    tradeCount: 0,
    totalCashPaidUsd: 0,
    totalCashReceivedUsd: 0,
    netCashflowUsd: 0,
    netWorthAtDealUsd: 0,
    netWorthNowUsd: 0,
    worthCountNow: 0,
    fairCountNow: 0,
    notWorthCountNow: 0,
    worthCountAtDeal: 0,
    fairCountAtDeal: 0,
    notWorthCountAtDeal: 0,
    worthRateNowPct: 0,
    worthRateAtDealPct: 0,
    wishlistFulfilledTotal: 0,
    bestTradeLabel: null,
    bestTradeGainUsd: null,
  };

  const isNow = state.trading.basis !== "deal";
  const netWorth = isNow ? Number(s.netWorthNowUsd || 0) : Number(s.netWorthAtDealUsd || 0);
  const otherWorth = isNow ? Number(s.netWorthAtDealUsd || 0) : Number(s.netWorthNowUsd || 0);
  const wCount = isNow ? Number(s.worthCountNow || 0) : Number(s.worthCountAtDeal || 0);
  const fCount = isNow ? Number(s.fairCountNow || 0) : Number(s.fairCountAtDeal || 0);
  const nwCount = isNow ? Number(s.notWorthCountNow || 0) : Number(s.notWorthCountAtDeal || 0);
  const wRate = isNow ? Number(s.worthRateNowPct || 0) : Number(s.worthRateAtDealPct || 0);
  const total = Math.max(0, Number(s.totalTrades || 0));

  const wPctBar = total > 0 ? (wCount / total) * 100 : 0;
  const fPctBar = total > 0 ? (fCount / total) * 100 : 0;
  const nwPctBar = total > 0 ? (nwCount / total) * 100 : 0;

  const netCash = Number(s.netCashflowUsd || 0);
  const cashSignClass = netWorth > 0.004 ? "is-gain" : netWorth < -0.004 ? "is-loss" : "";

  strip.innerHTML = `
    <article class="collection-balance-card is-primary">
      <div class="kpi-head">
        <span class="kpi-label">${isNow ? "Balance Neto Hoy" : "Balance Neto al Cierre"}</span>
        <span class="kpi-badge">${isNow ? "Precios Live" : "Al cierre"}</span>
      </div>
      <div class="kpi-value ${cashSignClass}">${fmtSignedMoney(netWorth)}</div>
      <div class="kpi-sub">≈ ${fmtSignedAltMoney(netWorth)}</div>
      <div class="kpi-sub">${isNow ? "Al cerrar tratos" : "A precios de hoy"}: ${fmtSignedMoney(otherWorth)}</div>
    </article>

    <article class="collection-balance-card">
      <div class="kpi-head">
        <span class="kpi-label">Índice Worth</span>
        <span class="kpi-badge">${wRate.toFixed(0)}% WORTH</span>
      </div>
      <div class="kpi-value">${wCount} / ${total}</div>
      <div class="trading-worth-bar" aria-hidden="true">
        ${
          total > 0
            ? `<span class="worth-seg-win" style="width:${wPctBar}%"></span>
               <span class="worth-seg-fair" style="width:${fPctBar}%"></span>
               <span class="worth-seg-loss" style="width:${nwPctBar}%"></span>`
            : `<span class="worth-seg-empty" style="width:100%"></span>`
        }
      </div>
      <div class="kpi-sub">${wCount} Worth · ${fCount} Parejo · ${nwCount} No Worth</div>
    </article>

    <article class="collection-balance-card">
      <div class="kpi-head">
        <span class="kpi-label">Flujo de Dinero</span>
        <span class="kpi-badge">Efectivo</span>
      </div>
      <div class="kpi-value">${fmtSignedMoney(netCash)}</div>
      <div class="kpi-sub">Recibido: ${fmtMoney(s.totalCashReceivedUsd)}</div>
      <div class="kpi-sub">Pagado: ${fmtMoney(s.totalCashPaidUsd)}</div>
    </article>

    <article class="collection-balance-card">
      <div class="kpi-head">
        <span class="kpi-label">Actividad &amp; Wishlist</span>
        <span class="kpi-badge">${s.wishlistFulfilledTotal} cumplidas</span>
      </div>
      <div class="kpi-value">${total} movs</div>
      <div class="kpi-sub">${s.buyCount} compras · ${s.sellCount} ventas · ${s.tradeCount} swaps</div>
      <div class="kpi-sub truncate" title="${escapeHtml(s.bestTradeLabel || "")}">
        ${s.bestTradeLabel ? `Top: ${escapeHtml(s.bestTradeLabel)} (${fmtSignedMoney(s.bestTradeGainUsd)})` : "Registra tu primer movimiento"}
      </div>
    </article>`;
}

function getFilteredTrades() {
  const { items, basis, filterType, filterVerdict, q, sort } = state.trading;
  const query = (q || "").trim().toLowerCase();
  const isNow = basis !== "deal";

  const filtered = (items || []).filter((t) => {
    if (filterType !== "all" && t.type !== filterType) return false;
    const verdict = isNow ? t.verdictNow : t.verdictAtDeal;
    if (filterVerdict !== "all" && verdict !== filterVerdict) return false;
    if (query) {
      const cardsHay = [...(t.itemsIn || []), ...(t.itemsOut || [])]
        .map((i) => `${i.name} ${i.cardNumber} ${i.editionName}`)
        .join(" ");
      const hay = `${t.counterparty} ${t.notes} ${t.date} ${cardsHay}`.toLowerCase();
      if (!hay.includes(query)) return false;
    }
    return true;
  });

  filtered.sort((a, b) => {
    const balA = isNow ? Number(a.currentBalanceUsd || 0) : Number(a.dealBalanceUsd || 0);
    const balB = isNow ? Number(b.currentBalanceUsd || 0) : Number(b.dealBalanceUsd || 0);
    const roiA = isNow ? Number(a.currentRoiPct || 0) : Number(a.dealRoiPct || 0);
    const roiB = isNow ? Number(b.currentRoiPct || 0) : Number(b.dealRoiPct || 0);
    if (sort === "balance_desc") return balB - balA;
    if (sort === "balance_asc") return balA - balB;
    if (sort === "roi_desc") return roiB - roiA;
    const dCmp = String(b.date || "").localeCompare(String(a.date || ""));
    if (dCmp !== 0) return dCmp;
    return String(b.createdAt || "").localeCompare(String(a.createdAt || ""));
  });

  return filtered;
}

function renderTradeSideColumn(title, items, cashUsd, currencyInput, cashOrig, isInSide, fulfilledSet) {
  const cardsHtml = (items || [])
    .map((item) => {
      const liveUnit = item.currentMarketUsd ?? item.unitMarketUsd;
      const unitShown = state.trading.basis === "deal" ? item.unitMarketUsd : liveUnit;
      const lineShown = item.quantity * unitShown;
      const priceDiffPct =
        item.unitMarketUsd > 0 && item.currentMarketUsd !== null && item.currentMarketUsd !== undefined
          ? ((item.currentMarketUsd - item.unitMarketUsd) / item.unitMarketUsd) * 100
          : 0;
      const fulfilled = isInSide && fulfilledSet.has(Number(item.productId));
      return `
        <div class="trade-item-chip ${fulfilled ? "is-fulfilled-wish" : ""}">
          ${
            item.imageUrl
              ? `<img class="trade-item-thumb" src="${escapeHtml(item.imageUrl)}" alt="" loading="lazy" />`
              : `<div class="trade-item-thumb-ph">?</div>`
          }
          <div class="trade-item-info">
            <div class="trade-item-name">
              <strong>${item.quantity}x</strong> ${escapeHtml(item.name)}
            </div>
            <div class="trade-item-meta">
              <span>${escapeHtml(item.cardNumber || "S/N")}</span>
              <span>· ${escapeHtml(item.condition || "NM")}</span>
              ${item.rarity ? `<span>· ${escapeHtml(item.rarity)}</span>` : ""}
              ${fulfilled ? `<span class="trade-wishlist-pill">★ Wishlist cumplida</span>` : ""}
            </div>
          </div>
          <div class="trade-item-val">
            <strong>${fmtMoney(lineShown)}</strong>
            ${
              state.trading.basis === "now" && Math.abs(priceDiffPct) >= 5
                ? `<span class="trade-delta-note ${priceDiffPct > 0 ? "up" : "down"}">${priceDiffPct > 0 ? "↑" : "↓"} ${Math.abs(priceDiffPct).toFixed(0)}%</span>`
                : `<span class="muted-text" style="font-size:0.72rem;">c/u ${fmtMoney(unitShown)}</span>`
            }
          </div>
        </div>`;
    })
    .join("");

  const cashRow =
    cashUsd > 0
      ? `<div class="trade-cash-pill">
           <span>💵 Efectivo ${isInSide ? "recibido" : "pagado"}</span>
           <strong>${fmtMoney(cashUsd)}${
             currencyInput === "CLP" && state.currency === "USD" && cashOrig > 0
               ? ` <span class="muted-text" style="font-weight:500;">($${Math.round(cashOrig).toLocaleString("es-CL")} CLP)</span>`
               : ""
           }</strong>
         </div>`
      : "";

  if (!cardsHtml && !cashRow) return "";
  return `
    <div class="trade-side-col ${isInSide ? "is-in" : "is-out"}">
      <div class="trade-side-col-title">${escapeHtml(title)}</div>
      <div class="trade-items-stack">${cardsHtml}${cashRow}</div>
    </div>`;
}

function syncTradingFilterControls() {
  const qInput = document.getElementById("trading-filter-q");
  const clearSearchBtn = document.getElementById("trading-filter-q-clear");
  const typeSel = document.getElementById("trading-filter-type");
  const sortSel = document.getElementById("trading-filter-sort");
  const clearAllBtn = document.getElementById("trading-clear-filters-btn");

  const query = (qInput ? qInput.value : state.trading.q || "").trim();
  clearSearchBtn?.classList.toggle("hidden", !query);

  if (typeSel && typeSel.value !== state.trading.filterType) {
    typeSel.value = state.trading.filterType || "all";
  }
  if (sortSel && sortSel.value !== state.trading.sort) {
    sortSel.value = state.trading.sort || "date_desc";
  }

  document.querySelectorAll("#trading-verdict-chips [data-trade-verdict]").forEach((btn) => {
    btn.classList.toggle("active", btn.getAttribute("data-trade-verdict") === state.trading.filterVerdict);
  });

  const hasActiveFilter =
    Boolean(query) ||
    (state.trading.filterType && state.trading.filterType !== "all") ||
    (state.trading.filterVerdict && state.trading.filterVerdict !== "all");
  clearAllBtn?.classList.toggle("hidden", !hasActiveFilter);
}

function resetTradingListFilters() {
  state.trading.filterType = "all";
  state.trading.filterVerdict = "all";
  state.trading.q = "";
  const qInput = document.getElementById("trading-filter-q");
  if (qInput) qInput.value = "";
  syncTradingFilterControls();
  renderTradesList();
}

export function renderTradesList() {
  const host = document.getElementById("trading-list-container");
  if (!host) return;
  syncTradingFilterControls();

  const list = getFilteredTrades();
  if (!state.trading.items.length) {
    host.innerHTML = `
      <div class="panel-card" style="text-align:center;padding:36px 20px;">
        <h3 style="margin:0 0 8px;">Aún no registras compras, ventas ni intercambios</h3>
        <p class="muted-text" style="max-width:560px;margin:0 auto 18px;">
          Lleva aquí el historial de tus tratos para saber al instante si fueron <strong>WORTH ✓</strong> y actualizar automáticamente tu Colección y Wishlist.
        </p>
        <div class="action-row" style="justify-content:center;">
          <button id="empty-trade-buy-btn" class="filled-btn" type="button">+ Registrar Compra</button>
          <button id="empty-trade-swap-btn" class="tonal-btn" type="button">⇄ Registrar Intercambio</button>
        </div>
      </div>`;
    document.getElementById("empty-trade-buy-btn")?.addEventListener("click", () => openTradeEditor(null, "buy"));
    document.getElementById("empty-trade-swap-btn")?.addEventListener("click", () => openTradeEditor(null, "trade"));
    return;
  }

  if (!list.length) {
    host.innerHTML = `
      <div class="panel-card" style="text-align:center;padding:28px;">
        <p class="muted-text" style="margin:0 0 12px;">No hay operaciones que coincidan con los filtros actuales.</p>
        <button id="reset-trade-filters-btn" class="tonal-btn" type="button">Limpiar filtros</button>
      </div>`;
    document.getElementById("reset-trade-filters-btn")?.addEventListener("click", resetTradingListFilters);
    return;
  }

  const isNow = state.trading.basis !== "deal";
  host.innerHTML = list
    .map((t) => {
      const tMeta = getTradeTypeMeta(t.type);
      const bal = isNow ? t.currentBalanceUsd : t.dealBalanceUsd;
      const roi = isNow ? t.currentRoiPct : t.dealRoiPct;
      const verdict = isNow ? t.verdictNow : t.verdictAtDeal;
      const vMeta = getVerdictMeta(verdict);
      const fulfilledSet = new Set((t.wishlistFulfilledIds || []).map((id) => Number(id)));

      const outCol = renderTradeSideColumn(
        t.type === "buy" ? "Entregaste (Efectivo)" : "Entregaste",
        t.itemsOut,
        t.cashPaidUsd,
        t.currencyInput,
        t.cashPaidOriginal,
        false,
        fulfilledSet
      );
      const inCol = renderTradeSideColumn(
        t.type === "sell" ? "Recibiste (Efectivo)" : "Recibiste",
        t.itemsIn,
        t.cashReceivedUsd,
        t.currencyInput,
        t.cashReceivedOriginal,
        true,
        fulfilledSet
      );

      const driftUsd = t.currentBalanceUsd - t.dealBalanceUsd;
      const showDrift = Math.abs(driftUsd) >= 0.5 && (t.itemsIn.length > 0 || t.itemsOut.length > 0);
      const driftHint = showDrift
        ? `Al cerrar: ${fmtSignedMoney(t.dealBalanceUsd)} → Hoy: ${fmtSignedMoney(t.currentBalanceUsd)} (${driftUsd > 0 ? "↑" : "↓"} ${fmtSignedMoney(driftUsd)})`
        : "";

      return `
        <article class="trade-card" data-trade-id="${escapeHtml(String(t.id))}">
          <div class="trade-card-head">
            <div class="trade-card-badges">
              <span class="trade-type-pill ${tMeta.cls}">${tMeta.label}</span>
              <span class="trade-date-label">${escapeHtml(t.date || "")}</span>
              ${t.counterparty ? `<span class="trade-counterparty-label">con <strong>${escapeHtml(t.counterparty)}</strong></span>` : ""}
              ${t.appliedToCollection ? `<span class="attr-chip" title="Aplicado automáticamente a tu colección">✓ En colección</span>` : `<span class="attr-chip">Solo registro</span>`}
              ${fulfilledSet.size > 0 ? `<span class="trade-wishlist-pill">★ Cumplió Wishlist (${fulfilledSet.size})</span>` : ""}
            </div>
            <div class="verdict-badge ${vMeta.cls}">
              <span class="verdict-pill-title">${vMeta.label}</span>
              <span class="verdict-pill-nums">${fmtSignedMoney(bal)} (${roi >= 0 ? "+" : ""}${Number(roi).toFixed(1)}%)</span>
            </div>
          </div>

          <div class="trade-sides-grid ${!outCol || !inCol ? "is-single-col" : ""}">
            ${outCol}
            ${inCol}
          </div>

          ${
            driftHint || (t.realizedProfitUsd !== null && t.realizedProfitUsd !== undefined)
              ? `<div class="trade-analytics-row">
                   ${driftHint ? `<span class="muted-text">${escapeHtml(driftHint)}</span>` : ""}
                   ${
                     t.realizedProfitUsd !== null && t.realizedProfitUsd !== undefined
                       ? `<span class="trade-realized-chip ${t.realizedProfitUsd >= 0 ? "is-gain" : "is-loss"}">Ganancia real vs costo: ${fmtSignedMoney(t.realizedProfitUsd)} (Costo: ${fmtMoney(t.outCostBasisUsd)})</span>`
                       : ""
                   }
                 </div>`
              : ""
          }

          <div class="trade-card-footer">
            <div class="trade-notes-preview muted-text">${t.notes ? escapeHtml(t.notes) : ""}</div>
            <div class="action-row">
              <button class="outlined-btn" data-edit-trade="${escapeHtml(String(t.id))}" type="button">Editar</button>
              <button class="text-btn danger" data-delete-trade="${escapeHtml(String(t.id))}" type="button">Eliminar</button>
            </div>
          </div>
        </article>`;
    })
    .join("");

  host.querySelectorAll("[data-edit-trade]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-edit-trade");
      const found = state.trading.items.find((x) => String(x.id) === String(id));
      if (found) openTradeEditor(found);
    });
  });

  host.querySelectorAll("[data-delete-trade]").forEach((btn) => {
    btn.addEventListener("click", () => {
      openTradeDeleteModal(btn.getAttribute("data-delete-trade"));
    });
  });
}

export async function exportTradesJson() {
  try {
    const data = state.trading.summary
      ? { summary: state.trading.summary, items: state.trading.items }
      : await apiFetch("/api/trades");
    const payload = {
      exportedAt: new Date().toISOString(),
      version: "1.0",
      ...data,
    };
    downloadJsonFile(`hololive_ocg_trades_${new Date().toISOString().slice(0, 10)}.json`, payload);
    showSnackbar(`Exportados ${payload.items?.length || 0} movimientos de Trading`);
  } catch (err) {
    showSnackbar(`Error al exportar trading: ${err.message}`);
  }
}

export function bindTradingEvents() {
  bindTradeEditorEvents({ onTradesMutated: loadTrades });
  if (tradingEventsBound) return;
  tradingEventsBound = true;

  document.getElementById("trades-signin-btn")?.addEventListener("click", triggerGoogleSignIn);

  document.getElementById("new-trade-buy-btn")?.addEventListener("click", () => openTradeEditor(null, "buy"));
  document.getElementById("new-trade-sell-btn")?.addEventListener("click", () => openTradeEditor(null, "sell"));
  document.getElementById("new-trade-swap-btn")?.addEventListener("click", () => openTradeEditor(null, "trade"));
  document.getElementById("export-trades-btn")?.addEventListener("click", exportTradesJson);

  document.querySelectorAll("#trading-basis-switch [data-trade-basis]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.trading.basis = btn.getAttribute("data-trade-basis") || "now";
      localStorage.setItem("hocg-trade-basis", state.trading.basis);
      syncTradingBasisUI();
      renderTradesSummary(state.trading.summary);
      renderTradesList();
    });
  });

  document.getElementById("trading-filter-type")?.addEventListener("change", (e) => {
    state.trading.filterType = e.target.value || "all";
    renderTradesList();
  });

  document.querySelectorAll("#trading-verdict-chips [data-trade-verdict]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const val = btn.getAttribute("data-trade-verdict") || "all";
      state.trading.filterVerdict = state.trading.filterVerdict === val ? "all" : val;
      renderTradesList();
    });
  });

  document.getElementById("trading-clear-filters-btn")?.addEventListener("click", resetTradingListFilters);

  document.getElementById("trading-filter-q")?.addEventListener("input", (e) => {
    state.trading.q = e.target.value;
    renderTradesList();
  });

  document.getElementById("trading-filter-q-clear")?.addEventListener("click", () => {
    const qInput = document.getElementById("trading-filter-q");
    if (!qInput) return;
    qInput.value = "";
    state.trading.q = "";
    renderTradesList();
    qInput.focus();
  });

  document.getElementById("trading-filter-sort")?.addEventListener("change", (e) => {
    state.trading.sort = e.target.value;
    renderTradesList();
  });
}
