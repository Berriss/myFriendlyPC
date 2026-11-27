import { actions } from "../core/actions.js";
import { apiFetch } from "../core/api.js";
import { updateCurrencyUI } from "../core/currency.js";
import { fmtClp, fmtMoney, fmtUsd } from "../core/formatters.js";
import {
  isCollectionValueHidden,
  MASKED_AMOUNT,
  MASKED_AMOUNT_SHORT,
} from "../core/privacy.js";
import { state } from "../core/state.js";

export async function loadKpis() {
  try {
    const kpis = await apiFetch("/api/kpis");
    state.kpis = kpis;
    renderKpis(kpis);
    if (state.activeView === "collection") {
      actions.renderCollectionBalance?.(kpis, state.editions);
    }
  } catch (err) {
    console.error("Error loading KPIs:", err);
  }
}

export function renderKpis(k) {
  if (k.exchangeRate && k.exchangeRate.rateClpPerUsd) {
    state.exchangeRate = k.exchangeRate;
    updateCurrencyUI();
  }

  const isClp = state.currency === "CLP";
  const hideValue = isCollectionValueHidden();
  document.getElementById("kpi-value-title").textContent =
    isClp ? "Valor de Colección (CLP)" : "Valor de Colección (USD)";
  document.getElementById("kpi-value-badge").textContent = isClp ? "CLP" : "Market";

  const marketValueEl = document.getElementById("kpi-market-value");
  marketValueEl.textContent = hideValue
    ? MASKED_AMOUNT
    : fmtMoney(k.collectionMarketValueUsd);
  marketValueEl.classList.toggle("value-masked", hideValue);

  document.getElementById("kpi-value-equiv").textContent = hideValue
    ? isClp
      ? `≈ ${MASKED_AMOUNT} USD`
      : `≈ ${MASKED_AMOUNT} CLP`
    : isClp
      ? `≈ ${fmtUsd(k.collectionMarketValueUsd)} USD (Tasa $${Math.round(state.exchangeRate.rateClpPerUsd).toLocaleString("es-CL")})`
      : `≈ ${fmtClp(k.collectionMarketValueUsd)}`;

  const netSign = k.netGainUsd >= 0 ? "+" : "-";
  const netAbs = Math.abs(k.netGainUsd);
  document.getElementById("kpi-value-sub").textContent = hideValue
    ? `Costo: ${MASKED_AMOUNT_SHORT} · Neto: ${MASKED_AMOUNT_SHORT}`
    : `Costo: ${fmtMoney(k.collectionCostBasisUsd)} · Neto: ${netSign}${fmtMoney(netAbs)}`;

  const uniqueEl = document.getElementById("kpi-unique-owned");
  if (uniqueEl) uniqueEl.textContent = k.ownedUniqueCards.toLocaleString();
  const setsBadgeEl = document.getElementById("kpi-sets-owned-badge");
  if (setsBadgeEl && state.editions.length) {
    const setsWithCards = state.editions.filter((ed) => ed.ownedTotalCopies > 0).length;
    setsBadgeEl.textContent = `${setsWithCards} / ${state.editions.length} sets`;
  } else if (setsBadgeEl) {
    setsBadgeEl.textContent = `${k.totalEditions} sets`;
  }

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

  const wPdfBtn = document.getElementById("open-wishlist-pdf-btn");
  if (wPdfBtn) {
    wPdfBtn.textContent = k.wishlistCount > 0 ? `📄 Wishlist PDF (${k.wishlistCount})` : "📄 Wishlist PDF";
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
