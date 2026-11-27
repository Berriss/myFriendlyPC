import { actions } from "./actions.js";
import { showSnackbar } from "./api.js";
import { state } from "./state.js";

export const PRIVACY_STORAGE_KEY = "hocg-hide-collection-value";
export const MASKED_AMOUNT = "••••••";
export const MASKED_AMOUNT_SHORT = "••••";

export function isCollectionValueHidden() {
  return Boolean(state.hideCollectionValue);
}

export function updatePrivacyUI() {
  const hidden = isCollectionValueHidden();
  document.documentElement.setAttribute(
    "data-hide-collection-value",
    hidden ? "true" : "false"
  );

  const btn = document.getElementById("privacy-value-toggle-btn");
  if (btn) {
    const label = hidden
      ? "Mostrar valor de colección"
      : "Ocultar valor de colección";
    btn.setAttribute("aria-pressed", hidden ? "true" : "false");
    btn.classList.toggle("is-active", hidden);
    btn.title = label;
    btn.setAttribute("aria-label", label);
  }

  if (hidden && !state.kpis) {
    const mktEl = document.getElementById("kpi-market-value");
    if (mktEl) {
      mktEl.textContent = MASKED_AMOUNT;
      mktEl.classList.add("value-masked");
    }
    const equivEl = document.getElementById("kpi-value-equiv");
    if (equivEl) {
      equivEl.textContent =
        state.currency === "CLP"
          ? `≈ ${MASKED_AMOUNT} USD`
          : `≈ ${MASKED_AMOUNT} CLP`;
    }
    const subEl = document.getElementById("kpi-value-sub");
    if (subEl) {
      subEl.textContent = `Costo: ${MASKED_AMOUNT_SHORT} · Neto: ${MASKED_AMOUNT_SHORT}`;
    }
  }
}

export function setCollectionValueHidden(hidden, { silent = false } = {}) {
  state.hideCollectionValue = Boolean(hidden);
  localStorage.setItem(
    PRIVACY_STORAGE_KEY,
    state.hideCollectionValue ? "true" : "false"
  );
  updatePrivacyUI();
  actions.onPrivacyUpdated?.();
  if (!silent) {
    showSnackbar(
      state.hideCollectionValue
        ? "Valor de colección ocultado"
        : "Valor de colección visible"
    );
  }
}

export function initPrivacy() {
  state.hideCollectionValue =
    localStorage.getItem(PRIVACY_STORAGE_KEY) === "true";
  updatePrivacyUI();
}

export function toggleCollectionValuePrivacy() {
  setCollectionValueHidden(!state.hideCollectionValue);
}

export function bindPrivacyEvents() {
  document
    .getElementById("privacy-value-toggle-btn")
    ?.addEventListener("click", toggleCollectionValuePrivacy);
}
