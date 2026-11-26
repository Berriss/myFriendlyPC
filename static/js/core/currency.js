import { actions } from "./actions.js";
import { apiFetch, showSnackbar } from "./api.js";
import { state } from "./state.js";

export function updateCurrencyUI() {
  const isClp = state.currency === "CLP";
  document.getElementById("currency-usd").classList.toggle("active", !isClp);
  document.getElementById("currency-clp").classList.toggle("active", isClp);
  const rate = Number(state.exchangeRate?.rateClpPerUsd || 0);
  const roundedRate = Math.round(rate).toLocaleString("es-CL");
  document.getElementById("exchange-rate-label").textContent = `1 USD = $${roundedRate} CLP`;

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

export function setCurrency(nextCurrency) {
  if (state.currency === nextCurrency) return;
  state.currency = nextCurrency;
  localStorage.setItem("hocg-currency", nextCurrency);
  updateCurrencyUI();
  actions.onCurrencyUpdated?.();
  showSnackbar(
    nextCurrency === "CLP"
      ? `Montos mostrados en CLP (1 USD = $${state.exchangeRate.rateClpPerUsd.toFixed(2)} CLP)`
      : "Montos mostrados en USD"
  );
}

export function openExchangeRateModal() {
  const modal = document.getElementById("exchange-rate-modal");
  const r = state.exchangeRate;
  document.getElementById("rate-modal-current").textContent =
    `$${Number(r.rateClpPerUsd).toLocaleString("es-CL", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} CLP`;
  document.getElementById("rate-modal-meta").textContent =
    `Fuente: ${r.source || "Local"} · Fecha: ${r.observedDate || "—"}`;
  document.getElementById("manual-rate-input").value = Number(r.rateClpPerUsd).toFixed(2);
  modal.classList.remove("hidden");
}

export async function saveExchangeRateToServer(rate, source, observedDate) {
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
  await actions.loadKpis?.();
  actions.onCurrencyUpdated?.({ skipKpis: true });
  return updated;
}

export async function refreshLiveExchangeRate() {
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
      await actions.loadKpis?.();
      actions.onCurrencyUpdated?.({ skipKpis: true });
      showSnackbar(`Tasa sincronizada: 1 USD = $${backendRate.rateClpPerUsd.toFixed(2)} CLP`);
    }
  } catch (err) {
    showSnackbar(`No se pudo consultar tasa online: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = "↻ Actualizar tasa oficial del día";
  }
}

export function bindCurrencyEvents() {
  document.getElementById("currency-usd")?.addEventListener("click", () => setCurrency("USD"));
  document.getElementById("currency-clp")?.addEventListener("click", () => setCurrency("CLP"));
  document.getElementById("currency-toggle-rail")?.addEventListener("click", () => {
    setCurrency(state.currency === "CLP" ? "USD" : "CLP");
  });
  document.getElementById("exchange-rate-chip")?.addEventListener("click", openExchangeRateModal);
  document.getElementById("exchange-rate-rail")?.addEventListener("click", openExchangeRateModal);
  document.getElementById("rate-modal-close")?.addEventListener("click", () => {
    document.getElementById("exchange-rate-modal")?.classList.add("hidden");
  });
  document.getElementById("exchange-rate-modal")?.addEventListener("click", (e) => {
    if (e.target.id === "exchange-rate-modal") e.target.classList.add("hidden");
  });
  document.getElementById("refresh-live-rate-btn")?.addEventListener("click", refreshLiveExchangeRate);
  document.getElementById("manual-rate-form")?.addEventListener("submit", async (e) => {
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
}
