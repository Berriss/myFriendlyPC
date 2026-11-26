import { actions } from "../core/actions.js";
import { apiFetch, showSnackbar, triggerGoogleSignIn } from "../core/api.js";
import { downloadJsonFile, escapeHtml, fmtClp, fmtMoney, fmtUsd } from "../core/formatters.js";
import { state } from "../core/state.js";

let tradeOutSearchTimer = null;
let tradeInSearchTimer = null;

function round2Local(val) {
  const n = Number(val);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

function fmtSignedMoney(usdVal) {
  const n = Number(usdVal || 0);
  const sign = n > 0.004 ? "+" : n < -0.004 ? "-" : "";
  return `${sign}${fmtMoney(Math.abs(n))}`;
}

function fmtSignedAltMoney(usdVal) {
  const n = Number(usdVal || 0);
  const sign = n > 0.004 ? "+" : n < -0.004 ? "-" : "";
  return state.currency === "CLP"
    ? `${sign}${fmtUsd(Math.abs(n))} USD`
    : `${sign}${fmtClp(Math.abs(n))}`;
}

function classifyTradeVerdictLocal(balanceUsd, roiPct) {
  if (Math.abs(balanceUsd) < 0.5 && Math.abs(roiPct) < 5.0) return "fair";
  if (balanceUsd > 0 && (roiPct >= 5.0 || balanceUsd >= 5.0)) return "worth";
  if (balanceUsd < 0 && (roiPct <= -5.0 || balanceUsd <= -5.0)) return "not_worth";
  return "fair";
}

function getVerdictMeta(verdict) {
  if (verdict === "worth") return { label: "WORTH ✓", cls: "verdict-worth" };
  if (verdict === "not_worth") return { label: "No Worth ✕", cls: "verdict-not-worth" };
  return { label: "Parejo ≈", cls: "verdict-fair" };
}

function getTradeTypeMeta(type) {
  if (type === "buy") return { label: "Compra", cls: "is-buy" };
  if (type === "sell") return { label: "Venta", cls: "is-sell" };
  return { label: "Intercambio", cls: "is-trade" };
}

function toTradeEditorUsd(amountRaw, currencyInput, rate) {
  const num = Math.max(0, Number(amountRaw || 0));
  if (!Number.isFinite(num) || num <= 0) return { usd: 0, orig: 0 };
  if (currencyInput === "CLP") {
    return {
      usd: round2Local(num / Math.max(1, rate)),
      orig: Math.round(num),
    };
  }
  const r = round2Local(num);
  return { usd: r, orig: r };
}

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

export function renderTradesList() {
  const host = document.getElementById("trading-list-container");
  if (!host) return;

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
    document.getElementById("reset-trade-filters-btn")?.addEventListener("click", () => {
      state.trading.filterType = "all";
      state.trading.filterVerdict = "all";
      state.trading.q = "";
      const qInput = document.getElementById("trading-filter-q");
      if (qInput) qInput.value = "";
      document.querySelectorAll("#trading-type-chips [data-trade-type]").forEach((b) =>
        b.classList.toggle("active", b.getAttribute("data-trade-type") === "all")
      );
      document.querySelectorAll("#trading-verdict-chips [data-trade-verdict]").forEach((b) =>
        b.classList.toggle("active", b.getAttribute("data-trade-verdict") === "all")
      );
      renderTradesList();
    });
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

function makeEditorItemFromCard(c) {
  const mkt = round2Local(c.marketPrice ?? c.foilMarketPrice ?? 0);
  return {
    productId: Number(c.productId),
    quantity: 1,
    unitMarketUsd: mkt,
    unitCostUsd: null,
    condition: c.condition || "NM",
    name: c.name || `#${c.productId}`,
    cardNumber: c.cardNumber || "",
    editionAbbr: c.editionAbbr || c.editionName || "",
    rarity: c.rarity || "",
    imageUrl: c.imageUrl || "",
    currentMarketUsd: mkt,
    ownedQuantity: Number(c.totalOwned ?? c.ownedQuantity ?? 0),
    isWishlist: Boolean(c.isWishlist),
    wishlistTargetQty: Number(c.wishlistTargetQty || 1),
  };
}

export function openTradeEditor(existingTrade = null, initialType = "buy", prefillCard = null) {
  const rate = Number(state.exchangeRate?.rateClpPerUsd || 1000);
  const curInput = existingTrade?.currencyInput || (state.currency === "CLP" ? "CLP" : "USD");
  const toInputStr = (usdVal, origVal, cInput, usedRate) => {
    if (existingTrade && origVal > 0 && cInput === existingTrade.currencyInput) {
      return cInput === "CLP" ? String(Math.round(origVal)) : Number(origVal).toFixed(2);
    }
    if (!usdVal || usdVal <= 0) return "";
    return cInput === "CLP"
      ? String(Math.round(usdVal * usedRate))
      : Number(usdVal).toFixed(2);
  };

  const editorType = existingTrade?.type || initialType || "buy";
  const cloneItems = (arr) =>
    (arr || []).map((i) => ({
      productId: Number(i.productId),
      quantity: Number(i.quantity || 1),
      unitMarketUsd: round2Local(i.unitMarketUsd || 0),
      unitCostUsd: i.unitCostUsd ?? null,
      condition: i.condition || "NM",
      name: i.name || `#${i.productId}`,
      cardNumber: i.cardNumber || "",
      editionAbbr: i.editionAbbr || i.editionName || "",
      rarity: i.rarity || "",
      imageUrl: i.imageUrl || "",
      currentMarketUsd: i.currentMarketUsd ?? i.unitMarketUsd ?? 0,
      ownedQuantity: Number(i.ownedQuantity || 0),
      isWishlist: Boolean(i.isWishlist),
      wishlistTargetQty: Number(i.wishlistTargetQty || 1),
    }));

  const editor = {
    id: existingTrade ? existingTrade.id : null,
    type: editorType,
    date: existingTrade?.date || new Date().toISOString().slice(0, 10),
    counterparty: existingTrade?.counterparty || "",
    notes: existingTrade?.notes || "",
    currencyInput: curInput,
    exchangeRateUsed: existingTrade?.exchangeRateUsed || rate,
    cashPaidStr: existingTrade
      ? toInputStr(existingTrade.cashPaidUsd, existingTrade.cashPaidOriginal, curInput, existingTrade.exchangeRateUsed || rate)
      : "",
    cashReceivedStr: existingTrade
      ? toInputStr(existingTrade.cashReceivedUsd, existingTrade.cashReceivedOriginal, curInput, existingTrade.exchangeRateUsed || rate)
      : "",
    itemsIn: existingTrade ? cloneItems(existingTrade.itemsIn) : [],
    itemsOut: existingTrade ? cloneItems(existingTrade.itemsOut) : [],
    applyToCollection: existingTrade ? Boolean(existingTrade.appliedToCollection) : true,
    inSearchScope: "all",
  };

  if (prefillCard && !existingTrade) {
    const item = makeEditorItemFromCard(prefillCard);
    if (editorType === "sell") {
      editor.itemsOut.push(item);
    } else {
      editor.itemsIn.push(item);
    }
  }

  state.trading.editor = editor;

  document.getElementById("trade-editor-title").textContent = existingTrade
    ? "Editar Operación de Trading"
    : "Registrar Operación de Trading";
  document.getElementById("trade-date-input").value = editor.date;
  document.getElementById("trade-counterparty-input").value = editor.counterparty;
  document.getElementById("trade-currency-input").value = editor.currencyInput;
  document.getElementById("trade-cash-paid-input").value = editor.cashPaidStr;
  document.getElementById("trade-cash-received-input").value = editor.cashReceivedStr;
  document.getElementById("trade-notes-input").value = editor.notes;
  document.getElementById("trade-apply-collection-checkbox").checked = editor.applyToCollection;
  document.getElementById("trade-out-search").value = "";
  document.getElementById("trade-in-search").value = "";
  document.getElementById("trade-out-results")?.classList.add("hidden");
  document.getElementById("trade-in-results")?.classList.add("hidden");
  document.querySelectorAll("#trade-in-scope-chips [data-trade-in-scope]").forEach((b) =>
    b.classList.toggle("active", b.getAttribute("data-trade-in-scope") === "all")
  );

  const rateHint = document.getElementById("trade-rate-hint");
  if (rateHint) {
    rateHint.textContent = `1 USD = $${Math.round(editor.exchangeRateUsed).toLocaleString("es-CL")} CLP`;
  }

  syncTradeEditorLayout();
  renderTradeEditorSideItems("out");
  renderTradeEditorSideItems("in");
  renderTradeEditorLiveVerdict();
  document.getElementById("trade-editor-modal")?.classList.remove("hidden");
}

function syncTradeEditorLayout() {
  const ed = state.trading.editor;
  if (!ed) return;
  document.querySelectorAll("#trade-type-switch [data-editor-type]").forEach((btn) => {
    btn.classList.toggle("active", btn.getAttribute("data-editor-type") === ed.type);
  });

  const outSec = document.getElementById("trade-out-section");
  const inSec = document.getElementById("trade-in-section");
  const paidWrap = document.getElementById("trade-cash-paid-wrap");
  const recWrap = document.getElementById("trade-cash-received-wrap");
  const sidesGrid = document.getElementById("trade-editor-sides");

  const showOut = ed.type === "sell" || ed.type === "trade";
  const showIn = ed.type === "buy" || ed.type === "trade";
  const showPaid = ed.type === "buy" || ed.type === "trade";
  const showRec = ed.type === "sell" || ed.type === "trade";

  outSec?.classList.toggle("hidden", !showOut);
  inSec?.classList.toggle("hidden", !showIn);
  paidWrap?.classList.toggle("hidden", !showPaid);
  recWrap?.classList.toggle("hidden", !showRec);
  sidesGrid?.classList.toggle("is-single", !(showOut && showIn));

  const paidLabel = document.getElementById("trade-cash-paid-label");
  const recLabel = document.getElementById("trade-cash-received-label");
  const unitTag = ed.currencyInput === "CLP" ? "(CLP)" : "(USD)";
  if (paidLabel) {
    paidLabel.textContent =
      ed.type === "buy" ? `Efectivo pagado por la compra ${unitTag}` : `Efectivo adicional entregado ${unitTag}`;
  }
  if (recLabel) {
    recLabel.textContent =
      ed.type === "sell" ? `Efectivo recibido por la venta ${unitTag}` : `Efectivo recibido a favor ${unitTag}`;
  }
}

export function renderTradeEditorSideItems(side) {
  const ed = state.trading.editor;
  if (!ed) return;
  const isOut = side === "out";
  const list = isOut ? ed.itemsOut : ed.itemsIn;
  const container = document.getElementById(isOut ? "trade-out-items" : "trade-in-items");
  const subtotalEl = document.getElementById(isOut ? "trade-out-subtotal" : "trade-in-subtotal");
  if (!container) return;

  const totalUsd = list.reduce((s, i) => s + Number(i.quantity || 0) * Number(i.unitMarketUsd || 0), 0);
  if (subtotalEl) subtotalEl.textContent = fmtMoney(totalUsd);

  if (!list.length) {
    container.innerHTML = `<div class="muted-text trade-empty-hint">${
      isOut ? "Busca y selecciona las cartas que entregas." : "Busca y selecciona las cartas que recibes."
    }</div>`;
    return;
  }

  container.innerHTML = list
    .map((item) => {
      const lineUsd = Number(item.quantity || 1) * Number(item.unitMarketUsd || 0);
      const stockWarn = isOut && !ed.id && item.quantity > item.ownedQuantity;
      return `
          <div class="trade-selected-row" data-editor-side="${side}" data-editor-pid="${item.productId}">
            <div class="trade-selected-head">
              ${
                item.imageUrl
                  ? `<img class="trade-item-thumb" src="${escapeHtml(item.imageUrl)}" alt="" />`
                  : `<div class="trade-item-thumb-ph">?</div>`
              }
              <div style="min-width:0;flex:1;">
                <div class="truncate" style="font-weight:700;font-size:0.86rem;">${escapeHtml(item.name)}</div>
                <div class="muted-text" style="font-size:0.74rem;">
                  ${escapeHtml(item.cardNumber || "S/N")} · ${escapeHtml(item.rarity || "—")}
                  ${isOut ? ` · Tienes: ${item.ownedQuantity}` : ""}
                  ${!isOut && item.isWishlist ? ` · ♥ En Wishlist` : ""}
                </div>
                ${stockWarn ? `<div class="trade-stock-warn">Tienes ${item.ownedQuantity} en colección (quedarías en 0)</div>` : ""}
              </div>
              <button class="icon-btn" style="width:30px;height:30px;" data-trade-remove="${side}:${item.productId}" type="button" aria-label="Quitar carta">✕</button>
            </div>
            <div class="trade-selected-controls">
              <div class="stepper-controls">
                <button class="step-btn" data-trade-qty="${side}:${item.productId}:-1" type="button">−</button>
                <span class="step-qty">${item.quantity}</span>
                <button class="step-btn plus" data-trade-qty="${side}:${item.productId}:1" type="button">+</button>
              </div>
              <select class="trade-mini-select" data-trade-cond="${side}:${item.productId}" aria-label="Condición">
                ${["NM", "LP", "MP", "HP", "DMG"]
                  .map((cond) => `<option value="${cond}" ${item.condition === cond ? "selected" : ""}>${cond}</option>`)
                  .join("")}
              </select>
              <label class="trade-unit-price-wrap" title="Valor de mercado unitario al momento del trato (USD)">
                <span>USD c/u</span>
                <input class="trade-unit-price-input" type="number" min="0" step="0.01" data-trade-price="${side}:${item.productId}" value="${Number(item.unitMarketUsd || 0).toFixed(2)}" />
              </label>
              <strong class="trade-selected-subtotal">${fmtMoney(lineUsd)}</strong>
            </div>
          </div>`;
    })
    .join("");

  container.querySelectorAll("[data-trade-remove]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const [, pidStr] = btn.getAttribute("data-trade-remove").split(":");
      const pid = Number(pidStr);
      if (isOut) ed.itemsOut = ed.itemsOut.filter((i) => i.productId !== pid);
      else ed.itemsIn = ed.itemsIn.filter((i) => i.productId !== pid);
      renderTradeEditorSideItems(side);
      renderTradeEditorLiveVerdict();
    });
  });

  container.querySelectorAll("[data-trade-qty]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const [, pidStr, dStr] = btn.getAttribute("data-trade-qty").split(":");
      const pid = Number(pidStr);
      const delta = Number(dStr);
      const target = list.find((i) => i.productId === pid);
      if (!target) return;
      target.quantity = Math.max(1, Math.min(999, target.quantity + delta));
      renderTradeEditorSideItems(side);
      renderTradeEditorLiveVerdict();
    });
  });

  container.querySelectorAll("[data-trade-cond]").forEach((sel) => {
    sel.addEventListener("change", () => {
      const [, pidStr] = sel.getAttribute("data-trade-cond").split(":");
      const target = list.find((i) => i.productId === Number(pidStr));
      if (target) target.condition = sel.value;
    });
  });

  container.querySelectorAll("[data-trade-price]").forEach((inp) => {
    inp.addEventListener("input", () => {
      const [, pidStr] = inp.getAttribute("data-trade-price").split(":");
      const target = list.find((i) => i.productId === Number(pidStr));
      if (!target) return;
      const val = Number(inp.value);
      target.unitMarketUsd = Number.isFinite(val) && val >= 0 ? round2Local(val) : 0;
      const rowEl = inp.closest(".trade-selected-row");
      const subEl = rowEl?.querySelector(".trade-selected-subtotal");
      if (subEl) subEl.textContent = fmtMoney(target.quantity * target.unitMarketUsd);
      const totEl = document.getElementById(isOut ? "trade-out-subtotal" : "trade-in-subtotal");
      if (totEl) {
        totEl.textContent = fmtMoney(list.reduce((s, i) => s + i.quantity * i.unitMarketUsd, 0));
      }
      renderTradeEditorLiveVerdict();
    });
  });
}

export function renderTradeEditorLiveVerdict() {
  const box = document.getElementById("trade-live-verdict-box");
  const ed = state.trading.editor;
  if (!box || !ed) return;

  const showOut = ed.type === "sell" || ed.type === "trade";
  const showIn = ed.type === "buy" || ed.type === "trade";
  const showPaid = ed.type === "buy" || ed.type === "trade";
  const showRec = ed.type === "sell" || ed.type === "trade";

  const paid = showPaid ? toTradeEditorUsd(ed.cashPaidStr, ed.currencyInput, ed.exchangeRateUsed).usd : 0;
  const rec = showRec ? toTradeEditorUsd(ed.cashReceivedStr, ed.currencyInput, ed.exchangeRateUsed).usd : 0;
  const cardsInVal = showIn ? ed.itemsIn.reduce((s, i) => s + i.quantity * i.unitMarketUsd, 0) : 0;
  const cardsOutVal = showOut ? ed.itemsOut.reduce((s, i) => s + i.quantity * i.unitMarketUsd, 0) : 0;

  const inTotal = round2Local(cardsInVal + rec);
  const outTotal = round2Local(cardsOutVal + paid);
  const balance = round2Local(inTotal - outTotal);
  const roi = outTotal > 0 ? round2Local((balance / outTotal) * 100) : inTotal > 0 ? 100 : 0;
  const verdict = classifyTradeVerdictLocal(balance, roi);
  const vMeta = getVerdictMeta(verdict);

  const qtyInCount = showIn ? ed.itemsIn.reduce((s, i) => s + i.quantity, 0) : 0;
  const qtyOutCount = showOut ? ed.itemsOut.reduce((s, i) => s + i.quantity, 0) : 0;
  const wishHits = showIn
    ? ed.itemsIn.filter((i) => i.isWishlist && i.ownedQuantity + i.quantity >= (i.wishlistTargetQty || 1)).length
    : 0;

  const impactParts = [];
  if (ed.applyToCollection) {
    if (qtyInCount > 0) impactParts.push(`+${qtyInCount} carta(s) a tu colección`);
    if (qtyOutCount > 0) impactParts.push(`−${qtyOutCount} carta(s) salen de colección`);
    if (wishHits > 0) impactParts.push(`★ ${wishHits} carta(s) de Wishlist cumplida(s)`);
  } else {
    impactParts.push("Solo historial (no modifica tu colección)");
  }

  box.innerHTML = `
      <div class="trade-live-verdict-main">
        <div>
          <div class="kpi-label">Evaluación instantánea</div>
          <div class="trade-live-nums">
            <span>Entra: <strong>${fmtMoney(inTotal)}</strong></span>
            <span>· Sale: <strong>${fmtMoney(outTotal)}</strong></span>
            <span>· Balance: <strong>${fmtSignedMoney(balance)}</strong></span>
          </div>
          <div class="muted-text" style="font-size:0.78rem;margin-top:4px;">${escapeHtml(impactParts.join(" · ") || "Selecciona cartas para calcular el trato.")}</div>
        </div>
        <div class="verdict-badge ${vMeta.cls}">
          <span class="verdict-pill-title">${vMeta.label}</span>
          <span class="verdict-pill-nums">${roi >= 0 ? "+" : ""}${roi.toFixed(1)}%</span>
        </div>
      </div>`;
}

async function searchTradePicker(side) {
  const ed = state.trading.editor;
  if (!ed) return;
  const isOut = side === "out";
  const resultsEl = document.getElementById(isOut ? "trade-out-results" : "trade-in-results");
  const qInput = document.getElementById(isOut ? "trade-out-search" : "trade-in-search");
  if (!resultsEl || !qInput) return;

  const q = qInput.value.trim();
  const ownedOnly = isOut ? document.getElementById("trade-out-owned-only")?.checked : false;
  const params = new URLSearchParams();
  params.set("per_page", "12");
  params.set("page", "1");
  if (q) params.set("q", q);

  if (isOut) {
    params.set("item_category", "all");
    if (ownedOnly) params.set("ownership", "owned");
    params.set("sort", "owned_desc");
  } else if (ed.inSearchScope === "wishlist") {
    params.set("item_category", "all");
    params.set("ownership", "wishlist");
    params.set("sort", "price_desc");
  } else if (ed.inSearchScope === "sealed") {
    params.set("item_category", "sealed");
    params.set("sort", "price_desc");
  } else {
    params.set("item_category", "card");
    params.set("sort", "price_desc");
  }

  try {
    const data = await apiFetch(`/api/cards?${params.toString()}`);
    const items = data.items || [];
    resultsEl.classList.remove("hidden");
    if (!items.length) {
      resultsEl.innerHTML = `<div class="muted-text" style="padding:10px;font-size:0.82rem;">Sin resultados con este filtro.</div>`;
      return;
    }

    resultsEl.innerHTML = items
      .map((c) => {
        const p = c.marketPrice ?? c.foilMarketPrice ?? 0;
        return `
            <button class="trade-picker-option" type="button" data-pick-side="${side}" data-pick-pid="${c.productId}">
              ${
                c.imageUrl
                  ? `<img class="trade-item-thumb" src="${escapeHtml(c.imageUrl)}" alt="" />`
                  : `<div class="trade-item-thumb-ph">?</div>`
              }
              <span style="min-width:0;flex:1;text-align:left;">
                <strong style="display:block;font-size:0.84rem;" class="truncate">${escapeHtml(c.name)}</strong>
                <span class="muted-text" style="font-size:0.74rem;">
                  ${escapeHtml(c.cardNumber || "S/N")} · ${escapeHtml(c.editionAbbr || c.editionName)} · ${escapeHtml(c.rarity || "—")}
                  ${c.totalOwned > 0 ? ` · Tienes: ${c.totalOwned}` : ""}
                  ${c.isWishlist ? ` · ♥ Wishlist` : ""}
                </span>
              </span>
              <span style="font-weight:700;font-size:0.82rem;white-space:nowrap;">${fmtMoney(p)}</span>
            </button>`;
      })
      .join("");

    const cardMap = new Map(items.map((c) => [Number(c.productId), c]));
    resultsEl.querySelectorAll("[data-pick-pid]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const pid = Number(btn.getAttribute("data-pick-pid"));
        const card = cardMap.get(pid);
        if (!card) return;
        const targetArr = isOut ? ed.itemsOut : ed.itemsIn;
        const existing = targetArr.find((i) => i.productId === pid);
        if (existing) {
          existing.quantity = Math.min(999, existing.quantity + 1);
        } else {
          targetArr.push(makeEditorItemFromCard(card));
        }
        resultsEl.classList.add("hidden");
        renderTradeEditorSideItems(side);
        renderTradeEditorLiveVerdict();
      });
    });
  } catch (err) {
    resultsEl.classList.remove("hidden");
    resultsEl.innerHTML = `<div class="muted-text" style="padding:10px;">Error buscando: ${escapeHtml(err.message)}</div>`;
  }
}

async function submitTradeEditor() {
  const ed = state.trading.editor;
  if (!ed) return;
  const saveBtn = document.getElementById("trade-editor-save-btn");

  const showOut = ed.type === "sell" || ed.type === "trade";
  const showIn = ed.type === "buy" || ed.type === "trade";
  const itemsIn = showIn ? ed.itemsIn : [];
  const itemsOut = showOut ? ed.itemsOut : [];

  if (ed.type === "buy" && !itemsIn.length) {
    showSnackbar("Agrega al menos 1 carta que recibes en la compra");
    return;
  }
  if (ed.type === "sell" && !itemsOut.length) {
    showSnackbar("Agrega al menos 1 carta que entregas en la venta");
    return;
  }
  if (!itemsIn.length && !itemsOut.length) {
    showSnackbar("Agrega al menos 1 carta al movimiento");
    return;
  }

  const paid =
    ed.type === "buy" || ed.type === "trade"
      ? toTradeEditorUsd(ed.cashPaidStr, ed.currencyInput, ed.exchangeRateUsed)
      : { usd: 0, orig: 0 };
  const rec =
    ed.type === "sell" || ed.type === "trade"
      ? toTradeEditorUsd(ed.cashReceivedStr, ed.currencyInput, ed.exchangeRateUsed)
      : { usd: 0, orig: 0 };

  const mapItemPayload = (i) => ({
    productId: Number(i.productId),
    quantity: Math.max(1, Math.min(999, Number(i.quantity || 1))),
    unitMarketUsd: round2Local(i.unitMarketUsd || 0),
    unitCostUsd: i.unitCostUsd ?? null,
    condition: i.condition || "NM",
  });

  const payload = {
    type: ed.type,
    date: document.getElementById("trade-date-input")?.value || ed.date,
    counterparty: document.getElementById("trade-counterparty-input")?.value || "",
    notes: document.getElementById("trade-notes-input")?.value || "",
    currencyInput: ed.currencyInput,
    exchangeRateUsed: Number(ed.exchangeRateUsed || 1000),
    cashPaidUsd: paid.usd,
    cashReceivedUsd: rec.usd,
    cashPaidOriginal: paid.orig,
    cashReceivedOriginal: rec.orig,
    itemsIn: itemsIn.map(mapItemPayload),
    itemsOut: itemsOut.map(mapItemPayload),
    applyToCollection: Boolean(document.getElementById("trade-apply-collection-checkbox")?.checked),
  };

  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.textContent = "Guardando...";
  }
  try {
    const url = ed.id ? `/api/trades/${encodeURIComponent(ed.id)}` : "/api/trades";
    const res = await apiFetch(url, {
      method: ed.id ? "PUT" : "POST",
      body: JSON.stringify(payload),
    });
    document.getElementById("trade-editor-modal")?.classList.add("hidden");
    state.trading.editor = null;

    const tasks = [loadTrades(), actions.loadKpis?.(), actions.loadEditions?.(), actions.loadCards?.()];
    if (state.activeView === "collection") tasks.push(actions.loadCollectionCards?.());
    await Promise.all(tasks);

    const wishMsg =
      res.wishlistFulfilledCount > 0 ? ` · ★ ${res.wishlistFulfilledCount} de Wishlist cumplida` : "";
    showSnackbar(`Operación guardada${wishMsg}`);
  } catch (err) {
    showSnackbar(`Error al guardar operación: ${err.message}`);
  } finally {
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.textContent = "Guardar Operación";
    }
  }
}

function openTradeDeleteModal(tradeId) {
  const trade = state.trading.items.find((t) => String(t.id) === String(tradeId));
  if (!trade) return;
  state.trading.deleteTargetId = trade.id;
  const tMeta = getTradeTypeMeta(trade.type);
  const labelEl = document.getElementById("trade-delete-summary");
  if (labelEl) {
    const cardNames = [...(trade.itemsIn || []), ...(trade.itemsOut || [])]
      .slice(0, 2)
      .map((i) => i.name)
      .join(", ");
    labelEl.textContent = `${tMeta.label} (${trade.date}): ${cardNames || "Movimiento"}`;
  }
  const revBox = document.getElementById("trade-delete-revert-checkbox");
  if (revBox) revBox.checked = Boolean(trade.appliedToCollection);
  document.getElementById("trade-delete-modal")?.classList.remove("hidden");
}

async function confirmDeleteTrade() {
  const id = state.trading.deleteTargetId;
  if (!id) return;
  const btn = document.getElementById("trade-delete-confirm-btn");
  const revert = Boolean(document.getElementById("trade-delete-revert-checkbox")?.checked);
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Eliminando...";
  }
  try {
    const res = await apiFetch(`/api/trades/${encodeURIComponent(id)}?revert=${revert}`, {
      method: "DELETE",
    });
    document.getElementById("trade-delete-modal")?.classList.add("hidden");
    state.trading.deleteTargetId = null;

    const tasks = [loadTrades(), actions.loadKpis?.(), actions.loadEditions?.(), actions.loadCards?.()];
    if (state.activeView === "collection") tasks.push(actions.loadCollectionCards?.());
    await Promise.all(tasks);

    showSnackbar(
      res.reverted
        ? "Movimiento eliminado y cambios revertidos en colección/wishlist"
        : "Movimiento eliminado del historial"
    );
  } catch (err) {
    showSnackbar(`Error al eliminar movimiento: ${err.message}`);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Eliminar";
    }
  }
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

  document.querySelectorAll("#trading-type-chips [data-trade-type]").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#trading-type-chips .filter-chip").forEach((c) => c.classList.remove("active"));
      btn.classList.add("active");
      state.trading.filterType = btn.getAttribute("data-trade-type") || "all";
      renderTradesList();
    });
  });

  document.querySelectorAll("#trading-verdict-chips [data-trade-verdict]").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#trading-verdict-chips .filter-chip").forEach((c) => c.classList.remove("active"));
      btn.classList.add("active");
      state.trading.filterVerdict = btn.getAttribute("data-trade-verdict") || "all";
      renderTradesList();
    });
  });

  document.getElementById("trading-filter-q")?.addEventListener("input", (e) => {
    state.trading.q = e.target.value;
    renderTradesList();
  });

  document.getElementById("trading-filter-sort")?.addEventListener("change", (e) => {
    state.trading.sort = e.target.value;
    renderTradesList();
  });

  const closeTradeEditorModal = () => {
    document.getElementById("trade-editor-modal")?.classList.add("hidden");
  };
  document.getElementById("trade-editor-close")?.addEventListener("click", closeTradeEditorModal);
  document.getElementById("trade-editor-cancel-btn")?.addEventListener("click", closeTradeEditorModal);
  document.getElementById("trade-editor-modal")?.addEventListener("click", (e) => {
    if (e.target.id === "trade-editor-modal") {
      closeTradeEditorModal();
      return;
    }
    if (!e.target.closest(".trade-picker-results") && !e.target.closest(".trade-picker-toolbar")) {
      document.getElementById("trade-out-results")?.classList.add("hidden");
      document.getElementById("trade-in-results")?.classList.add("hidden");
    }
  });
  document.getElementById("trade-editor-save-btn")?.addEventListener("click", submitTradeEditor);

  document.querySelectorAll("#trade-type-switch [data-editor-type]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (!state.trading.editor) return;
      state.trading.editor.type = btn.getAttribute("data-editor-type") || "trade";
      syncTradeEditorLayout();
      renderTradeEditorLiveVerdict();
    });
  });

  document.getElementById("trade-currency-input")?.addEventListener("change", (e) => {
    const ed = state.trading.editor;
    if (!ed) return;
    const nextCur = e.target.value === "CLP" ? "CLP" : "USD";
    if (nextCur !== ed.currencyInput) {
      const rate = Math.max(1, Number(ed.exchangeRateUsed || 1000));
      const convertStr = (strVal) => {
        const num = Number(strVal || 0);
        if (!Number.isFinite(num) || num <= 0) return "";
        return nextCur === "CLP" ? String(Math.round(num * rate)) : (num / rate).toFixed(2);
      };
      ed.cashPaidStr = convertStr(ed.cashPaidStr);
      ed.cashReceivedStr = convertStr(ed.cashReceivedStr);
      ed.currencyInput = nextCur;
      document.getElementById("trade-cash-paid-input").value = ed.cashPaidStr;
      document.getElementById("trade-cash-received-input").value = ed.cashReceivedStr;
    }
    syncTradeEditorLayout();
    renderTradeEditorLiveVerdict();
  });

  document.getElementById("trade-cash-paid-input")?.addEventListener("input", (e) => {
    if (!state.trading.editor) return;
    state.trading.editor.cashPaidStr = e.target.value;
    renderTradeEditorLiveVerdict();
  });

  document.getElementById("trade-cash-received-input")?.addEventListener("input", (e) => {
    if (!state.trading.editor) return;
    state.trading.editor.cashReceivedStr = e.target.value;
    renderTradeEditorLiveVerdict();
  });

  document.getElementById("trade-apply-collection-checkbox")?.addEventListener("change", (e) => {
    if (!state.trading.editor) return;
    state.trading.editor.applyToCollection = e.target.checked;
    renderTradeEditorSideItems("out");
    renderTradeEditorLiveVerdict();
  });

  document.getElementById("trade-out-search")?.addEventListener("input", () => {
    clearTimeout(tradeOutSearchTimer);
    tradeOutSearchTimer = setTimeout(() => searchTradePicker("out"), 180);
  });
  document.getElementById("trade-out-search")?.addEventListener("focus", () => searchTradePicker("out"));
  document.getElementById("trade-out-owned-only")?.addEventListener("change", () => searchTradePicker("out"));

  document.getElementById("trade-in-search")?.addEventListener("input", () => {
    clearTimeout(tradeInSearchTimer);
    tradeInSearchTimer = setTimeout(() => searchTradePicker("in"), 180);
  });
  document.getElementById("trade-in-search")?.addEventListener("focus", () => searchTradePicker("in"));

  document.querySelectorAll("#trade-in-scope-chips [data-trade-in-scope]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (!state.trading.editor) return;
      document.querySelectorAll("#trade-in-scope-chips .filter-chip").forEach((c) => c.classList.remove("active"));
      btn.classList.add("active");
      state.trading.editor.inSearchScope = btn.getAttribute("data-trade-in-scope") || "all";
      searchTradePicker("in");
    });
  });

  const closeTradeDeleteModal = () => {
    document.getElementById("trade-delete-modal")?.classList.add("hidden");
  };
  document.getElementById("trade-delete-close")?.addEventListener("click", closeTradeDeleteModal);
  document.getElementById("trade-delete-cancel-btn")?.addEventListener("click", closeTradeDeleteModal);
  document.getElementById("trade-delete-modal")?.addEventListener("click", (e) => {
    if (e.target.id === "trade-delete-modal") closeTradeDeleteModal();
  });
  document.getElementById("trade-delete-confirm-btn")?.addEventListener("click", confirmDeleteTrade);
}
