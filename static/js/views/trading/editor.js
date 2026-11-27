import { actions } from "../../core/actions.js";
import { apiFetch, showSnackbar } from "../../core/api.js";
import { escapeHtml, fmtMoney } from "../../core/formatters.js";
import { state } from "../../core/state.js";
import {
  bindTradePickerEvents,
  closeAllTradePickers,
  closeTradePicker,
  resetTradePicker,
  syncSearchClearButtons,
  syncTradePickerSelectionBadges,
} from "./picker.js";
import {
  computeTradeEditorVerdict,
  fmtSignedMoney,
  getTradeTypeMeta,
  makeEditorItemFromCard,
  round2Local,
  toTradeEditorUsd,
} from "./rules.js";

let editorEventsBound = false;
let tradesMutatedCallback = null;

function cloneTradeItems(arr) {
  return (arr || []).map((i) => ({
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
}

function toInputMoneyStr(existingTrade, usdVal, origVal, cInput, usedRate) {
  if (existingTrade && origVal > 0 && cInput === existingTrade.currencyInput) {
    return cInput === "CLP" ? String(Math.round(origVal)) : Number(origVal).toFixed(2);
  }
  if (!usdVal || usdVal <= 0) return "";
  return cInput === "CLP" ? String(Math.round(usdVal * usedRate)) : Number(usdVal).toFixed(2);
}

export function syncTradeMobileSideTabs() {
  const ed = state.trading.editor;
  if (!ed) return;
  const tabsHost = document.getElementById("trade-mobile-side-tabs");
  const sidesGrid = document.getElementById("trade-editor-sides");
  const isTradeMode = ed.type === "trade";

  if (!isTradeMode) {
    ed.mobileSide = ed.type === "sell" ? "out" : "in";
  } else if (ed.mobileSide !== "in" && ed.mobileSide !== "out") {
    ed.mobileSide = "out";
  }

  tabsHost?.classList.toggle("hidden", !isTradeMode);
  if (sidesGrid) {
    sidesGrid.classList.toggle("is-trade-mode", isTradeMode);
    sidesGrid.setAttribute("data-mobile-side", ed.mobileSide);
  }

  tabsHost?.querySelectorAll("[data-trade-mobile-side]").forEach((btn) => {
    btn.classList.toggle("active", btn.getAttribute("data-trade-mobile-side") === ed.mobileSide);
  });

  const outMetaEl = document.getElementById("trade-tab-out-meta");
  const inMetaEl = document.getElementById("trade-tab-in-meta");
  if (outMetaEl) {
    const outQty = (ed.itemsOut || []).reduce((s, i) => s + Number(i.quantity || 0), 0);
    const outUsd = (ed.itemsOut || []).reduce((s, i) => s + Number(i.quantity || 0) * Number(i.unitMarketUsd || 0), 0);
    outMetaEl.textContent = `${outQty} · ${fmtMoney(outUsd)}`;
  }
  if (inMetaEl) {
    const inQty = (ed.itemsIn || []).reduce((s, i) => s + Number(i.quantity || 0), 0);
    const inUsd = (ed.itemsIn || []).reduce((s, i) => s + Number(i.quantity || 0) * Number(i.unitMarketUsd || 0), 0);
    inMetaEl.textContent = `${inQty} · ${fmtMoney(inUsd)}`;
  }
}

export function setTradeMobileSide(side) {
  const ed = state.trading.editor;
  if (!ed) return;
  ed.mobileSide = side === "in" ? "in" : "out";
  closeTradePicker(ed.mobileSide === "in" ? "out" : "in");
  syncTradeMobileSideTabs();
}

export function syncTradeEditorLayout() {
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

  syncTradeMobileSideTabs();
}

export function openTradeEditor(existingTrade = null, initialType = "buy", prefillCard = null) {
  const rate = Number(state.exchangeRate?.rateClpPerUsd || 1000);
  const curInput = existingTrade?.currencyInput || (state.currency === "CLP" ? "CLP" : "USD");
  const editorType = existingTrade?.type || initialType || "buy";

  const editor = {
    id: existingTrade ? existingTrade.id : null,
    type: editorType,
    mobileSide: editorType === "buy" ? "in" : "out",
    date: existingTrade?.date || new Date().toISOString().slice(0, 10),
    counterparty: existingTrade?.counterparty || "",
    notes: existingTrade?.notes || "",
    currencyInput: curInput,
    exchangeRateUsed: existingTrade?.exchangeRateUsed || rate,
    cashPaidStr: existingTrade
      ? toInputMoneyStr(
          existingTrade,
          existingTrade.cashPaidUsd,
          existingTrade.cashPaidOriginal,
          curInput,
          existingTrade.exchangeRateUsed || rate
        )
      : "",
    cashReceivedStr: existingTrade
      ? toInputMoneyStr(
          existingTrade,
          existingTrade.cashReceivedUsd,
          existingTrade.cashReceivedOriginal,
          curInput,
          existingTrade.exchangeRateUsed || rate
        )
      : "",
    itemsIn: existingTrade ? cloneTradeItems(existingTrade.itemsIn) : [],
    itemsOut: existingTrade ? cloneTradeItems(existingTrade.itemsOut) : [],
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
  document.querySelectorAll("#trade-in-scope-chips [data-trade-in-scope]").forEach((b) =>
    b.classList.toggle("active", b.getAttribute("data-trade-in-scope") === "all")
  );
  resetTradePicker();

  const rateHint = document.getElementById("trade-rate-hint");
  if (rateHint) {
    rateHint.textContent = `1 USD = $${Math.round(editor.exchangeRateUsed).toLocaleString("es-CL")} CLP`;
  }

  syncTradeEditorLayout();
  renderTradeEditorSideItems("out");
  renderTradeEditorSideItems("in");
  renderTradeEditorLiveVerdict();
  document.getElementById("trade-editor-modal")?.classList.remove("hidden");
  syncSearchClearButtons();
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
  syncTradeMobileSideTabs();
  syncTradePickerSelectionBadges(side);

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
            <button class="icon-btn" style="width:32px;height:32px;" data-trade-remove="${side}:${item.productId}" type="button" aria-label="Quitar carta">✕</button>
          </div>
          <div class="trade-selected-controls">
            <div class="trade-controls-top">
              <div class="stepper-controls">
                <button class="step-btn" data-trade-qty="${side}:${item.productId}:-1" type="button" aria-label="Restar copia">−</button>
                <span class="step-qty">${item.quantity}</span>
                <button class="step-btn plus" data-trade-qty="${side}:${item.productId}:1" type="button" aria-label="Sumar copia">+</button>
              </div>
              <strong class="trade-selected-subtotal">${fmtMoney(lineUsd)}</strong>
            </div>
            <div class="trade-controls-inputs">
              <select class="trade-mini-select" data-trade-cond="${side}:${item.productId}" aria-label="Condición">
                ${["NM", "LP", "MP", "HP", "DMG"]
                  .map((cond) => `<option value="${cond}" ${item.condition === cond ? "selected" : ""}>${cond}</option>`)
                  .join("")}
              </select>
              <label class="trade-unit-price-wrap" title="Valor de mercado unitario al momento del trato (USD)">
                <span>USD c/u</span>
                <input class="trade-unit-price-input" type="number" inputmode="decimal" min="0" step="0.01" data-trade-price="${side}:${item.productId}" value="${Number(item.unitMarketUsd || 0).toFixed(2)}" />
              </label>
            </div>
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
      syncTradeMobileSideTabs();
      renderTradeEditorLiveVerdict();
    });
  });
}

export function renderTradeEditorLiveVerdict() {
  const box = document.getElementById("trade-live-verdict-box");
  const ed = state.trading.editor;
  if (!box || !ed) return;

  const { inTotal, outTotal, balance, roi, vMeta, qtyInCount, qtyOutCount, wishHits } =
    computeTradeEditorVerdict(ed);

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
        <div class="muted-text" style="font-size:0.78rem;margin-top:4px;">${escapeHtml(
          impactParts.join(" · ") || "Selecciona cartas para calcular el trato."
        )}</div>
      </div>
      <div class="verdict-badge ${vMeta.cls}">
        <span class="verdict-pill-title">${vMeta.label}</span>
        <span class="verdict-pill-nums">${roi >= 0 ? "+" : ""}${roi.toFixed(1)}%</span>
      </div>
    </div>`;
}

async function refreshAppAfterTradeChange() {
  const tasks = [
    tradesMutatedCallback?.(),
    actions.loadKpis?.(),
    actions.loadEditions?.(),
    actions.loadCards?.(),
  ];
  if (state.activeView === "collection") tasks.push(actions.loadCollectionCards?.());
  await Promise.all(tasks);
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
    closeAllTradePickers();

    await refreshAppAfterTradeChange();

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

export function openTradeDeleteModal(tradeId) {
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

    await refreshAppAfterTradeChange();

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

function handlePickedCardForSide(side, card) {
  const ed = state.trading.editor;
  if (!ed || !card) return;
  const pid = Number(card.productId);
  const targetArr = side === "out" ? ed.itemsOut : ed.itemsIn;
  const existing = targetArr.find((i) => i.productId === pid);
  if (existing) {
    existing.quantity = Math.min(999, existing.quantity + 1);
  } else {
    targetArr.push(makeEditorItemFromCard(card));
  }
  renderTradeEditorSideItems(side);
  renderTradeEditorLiveVerdict();
}

export function bindTradeEditorEvents({ onTradesMutated } = {}) {
  tradesMutatedCallback = onTradesMutated || null;
  bindTradePickerEvents({ onPickCard: handlePickedCardForSide });

  if (editorEventsBound) return;
  editorEventsBound = true;

  const closeTradeEditorModal = () => {
    closeAllTradePickers();
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
      closeAllTradePickers();
    }
  });
  document.getElementById("trade-editor-save-btn")?.addEventListener("click", submitTradeEditor);

  document.querySelectorAll("#trade-type-switch [data-editor-type]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (!state.trading.editor) return;
      state.trading.editor.type = btn.getAttribute("data-editor-type") || "trade";
      closeAllTradePickers();
      syncTradeEditorLayout();
      renderTradeEditorLiveVerdict();
    });
  });

  document.querySelectorAll("#trade-mobile-side-tabs [data-trade-mobile-side]").forEach((btn) => {
    btn.addEventListener("click", () => {
      setTradeMobileSide(btn.getAttribute("data-trade-mobile-side"));
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
