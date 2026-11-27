import { actions } from "../core/actions.js";
import { apiFetch, showSnackbar } from "../core/api.js";
import { escapeHtml } from "../core/formatters.js";
import { hasPermission } from "../core/roles.js";

export function clearAuditView() {
  const syncMetaEl = document.getElementById("audit-sync-meta");
  if (syncMetaEl) {
    syncMetaEl.textContent = "";
    syncMetaEl.classList.add("hidden");
  }
  const grid = document.getElementById("audit-stats-grid");
  if (grid) grid.innerHTML = "";
  const exHost = document.getElementById("audit-examples-list");
  if (exHost) exHost.innerHTML = "";
}

export async function loadAudit() {
  if (!hasPermission("audit:access")) {
    clearAuditView();
    return;
  }
  try {
    const data = await apiFetch("/api/audit");
    const r = data.report || {};
    const syncMetaEl = document.getElementById("audit-sync-meta");
    if (syncMetaEl) {
      if (data.source) {
        const priceTs = data.pricesUpdatedAt
          ? ` · Precios: ${String(data.pricesUpdatedAt).replace("T", " ").slice(0, 19)} UTC`
          : "";
        syncMetaEl.textContent = `Origen activo: ${data.source}${priceTs}`;
        syncMetaEl.classList.remove("hidden");
      } else {
        syncMetaEl.classList.add("hidden");
      }
    }
    const grid = document.getElementById("audit-stats-grid");
    grid.innerHTML = `
        <article class="kpi-card">
          <div class="kpi-label">Ediciones &amp; Productos</div>
          <div class="kpi-value">${r.editionsProcessed || 0} / ${(r.totalProducts || 0).toLocaleString()}</div>
          <div class="kpi-sub">${r.totalCards || 0} cartas · ${r.totalSealed || 0} sellados</div>
        </article>
        <article class="kpi-card">
          <div class="kpi-label">Filas CSV Rotas Evitadas</div>
          <div class="kpi-value">${(r.naiveCsvBrokenRows || 0).toLocaleString()}</div>
          <div class="kpi-sub">${r.csvRowsWithCommasInText || 0} filas con comas en efectos</div>
        </article>
        <article class="kpi-card">
          <div class="kpi-label">Limpieza HTML &amp; Typos</div>
          <div class="kpi-value">${(r.descriptionsHtmlCleaned || 0).toLocaleString()}</div>
          <div class="kpi-sub">${r.spacingBugsFixed || 0} espacios · ${r.typosFixed || 0} typos corregidos</div>
        </article>
        <article class="kpi-card">
          <div class="kpi-label">Atributos Inferidos</div>
          <div class="kpi-value">${(r.missingCardTypeInferred || 0) + (r.missingColorInferred || 0)}</div>
          <div class="kpi-sub">${r.missingCardTypeInferred || 0} tipos · ${r.missingColorInferred || 0} colores</div>
        </article>`;

    const exHost = document.getElementById("audit-examples-list");
    exHost.innerHTML = (r.examples || [])
      .map(
        (ex) => `
        <article class="audit-item">
          <div class="edition-head">
            <strong>${escapeHtml(ex.name)} (${escapeHtml(ex.cardNumber || "S/N")})</strong>
            <div class="card-attr-chips">
              ${(ex.issuesFixed || []).map((t) => `<span class="attr-chip">${escapeHtml(t)}</span>`).join("")}
            </div>
          </div>
          <div class="audit-diff-grid">
            <div>
              <div class="kpi-label" style="margin-bottom:4px;">Antes (Crudo TCGplayer)</div>
              <div class="audit-box">${escapeHtml(ex.rawSnippet)}</div>
            </div>
            <div>
              <div class="kpi-label" style="margin-bottom:4px;">Después (Saneado en SQLite)</div>
              <div class="audit-box">${escapeHtml(ex.cleanedSnippet)}</div>
            </div>
          </div>
        </article>`
      )
      .join("");
  } catch (err) {
    showSnackbar(`Error cargando auditoría: ${err.message}`);
  }
}

export function bindAuditEvents() {
  document.getElementById("resync-db-btn")?.addEventListener("click", async () => {
    if (!hasPermission("audit:resync")) {
      showSnackbar("Acceso denegado: se requieren privilegios de administrador.");
      return;
    }
    const isCloud = window.HololiveCloudBackend?.isCloudMode();
    try {
      showSnackbar(
        isCloud
          ? "Actualizando catálogo y precios desde Cloud Firestore..."
          : "Re-sincronizando /resources hacia SQLite..."
      );
      const res = await apiFetch("/api/resync", { method: "POST" });
      await Promise.all([
        loadAudit(),
        actions.loadKpis?.(),
        actions.loadEditions?.(),
        actions.loadCards?.(),
      ]);
      showSnackbar(`Sincronizadas ${res.editionsSynced} ediciones y ${res.cardsSynced} cartas`);
    } catch (err) {
      showSnackbar(`Error al re-sincronizar: ${err.message}`);
    }
  });
}
