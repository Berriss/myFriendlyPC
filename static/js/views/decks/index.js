import { actions } from "../../core/actions.js";
import {
  apiFetch,
  showSnackbar,
  triggerGoogleSignIn,
  updateDecksAuthStatus,
} from "../../core/api.js";
import { HIGH_RARITIES } from "../../core/constants.js";
import { downloadJsonFile, escapeHtml, fmtMoney } from "../../core/formatters.js";
import { state } from "../../core/state.js";
import { closeDeckPreview, openDeckPreview, renderDeckPreview } from "./preview.js";
import { evaluateDeckRules } from "./rules.js";
import {
  bindDeckStudioEvents,
  closeDeckEditor,
  openDeckEditor,
  renderDeckBrowserGrid,
  renderDeckPanel,
  selectOshiForDeck,
  setDeckDirty,
  setDeckSubView,
  setDeckZoneTab,
  syncDeckBrowserCardsInPlace,
} from "./studio.js";

function syncDeckOwnedInCollectionObject(deckObj, productId, nextOwned) {
  if (!deckObj) return false;
  let changed = false;
  if (deckObj.oshiCard && Number(deckObj.oshiCard.productId) === Number(productId)) {
    deckObj.oshiCard.ownedQuantity = nextOwned;
    changed = true;
  }
  for (const item of deckObj.cards || []) {
    if (Number(item.productId) === Number(productId)) {
      item.ownedQuantity = nextOwned;
      changed = true;
    }
  }
  return changed;
}

export function syncEditingDeckOwnedCount(productId, nextOwned) {
  if (nextOwned === undefined || nextOwned === null) return;
  const touchedStudio = syncDeckOwnedInCollectionObject(state.editingDeck, productId, nextOwned);
  const touchedPreview = syncDeckOwnedInCollectionObject(state.previewDeck, productId, nextOwned);
  let touchedBrowser = false;
  if (state.deckBuilder.browserPage?.items) {
    for (const card of state.deckBuilder.browserPage.items) {
      if (Number(card.productId) === Number(productId)) {
        card.totalOwned = nextOwned;
        touchedBrowser = true;
      }
    }
  }
  if (state.activeView === "decks") {
    if ((touchedStudio || touchedBrowser) && state.editingDeck && !document.getElementById("deck-builder-studio")?.classList.contains("hidden")) {
      renderDeckPanel();
      if (state.deckBuilder.browserPage) renderDeckBrowserGrid(state.deckBuilder.browserPage);
    }
    if (touchedPreview && state.previewDeck && !document.getElementById("deck-preview-view")?.classList.contains("hidden")) {
      renderDeckPreview(state.previewDeck);
    }
  }
}

export async function loadDecks() {
  try {
    const decks = await apiFetch("/api/decks");
    state.decks = decks;
    const isCloud = Boolean(window.HololiveCloudBackend?.isCloudMode());
    const user = window.HololiveCloudBackend?.getCurrentUser();
    updateDecksAuthStatus(user, isCloud);
    renderDecksList(decks);
  } catch (err) {
    showSnackbar(`Error cargando mazos: ${err.message}`);
  }
}

export function renderDecksList(decks) {
  const host = document.getElementById("decks-grid");
  if (!host) return;
  if (!decks.length) {
    host.innerHTML = `
      <div class="panel-card" style="grid-column:1/-1;">
        <p class="muted-text" style="margin:0;">Aún no tienes mazos creados. Pulsa <strong>+ Nuevo Mazo</strong> o <strong>Importar lista / JSON</strong> para comenzar a armar tu primer deck.</p>
      </div>`;
    return;
  }

  host.innerHTML = decks
    .map((d) => {
      const isComplete = Boolean(d.oshiProductId) && d.mainCount === 50 && d.cheerCount === 20;
      const cov = Math.min(100, Number(d.ownedCoveragePct || 0));
      return `
        <article class="deck-gallery-card" data-open-deck="${escapeHtml(String(d.id))}">
          <div class="deck-gallery-top">
            ${
              d.oshiImageUrl
                ? `<img class="deck-gallery-thumb" src="${escapeHtml(d.oshiImageUrl)}" alt="${escapeHtml(d.oshiName || d.name)}" loading="lazy" />`
                : `<div class="deck-gallery-thumb-placeholder">Sin Oshi</div>`
            }
            <div class="deck-gallery-info">
              <h3 class="deck-gallery-title" title="${escapeHtml(d.name)}">${escapeHtml(d.name)}</h3>
              <div class="card-sub-meta">
                <span>Oshi: ${escapeHtml(d.oshiName || "Sin elegir")}</span>
              </div>
              <div class="deck-gallery-badges">
                <span class="deck-legality-pill ${isComplete ? "legal-ok" : "legal-wip"}">
                  ${isComplete ? "✓ Completo (1·50·20)" : `${d.oshiProductId ? 1 : 0}/1 · ${d.mainCount}/50 · ${d.cheerCount}/20`}
                </span>
                ${d.oshiColor ? `<span class="attr-chip">${escapeHtml(d.oshiColor)}</span>` : ""}
              </div>
            </div>
          </div>
          <div class="card-sub-meta">
            <span>Cobertura colección: <strong>${cov.toFixed(0)}%</strong></span>
            <span>Valor: <strong>${fmtMoney(d.estimatedCostUsd)}</strong></span>
          </div>
          <div class="md3-progress-track">
            <div class="md3-progress-fill ${cov >= 100 ? "is-complete" : ""}" style="width:${cov}%"></div>
          </div>
          <div class="card-sub-meta">
            <span>Faltante est.: <strong>${fmtMoney(d.missingCostUsd ?? 0)}</strong></span>
            <span>${d.updatedAt ? escapeHtml(String(d.updatedAt).slice(0, 10)) : ""}</span>
          </div>
          <div class="deck-gallery-actions">
            <button class="deck-mini-btn" data-deck-action="preview" data-deck-id="${escapeHtml(String(d.id))}" type="button">Ver</button>
            <button class="deck-mini-btn" data-deck-action="edit" data-deck-id="${escapeHtml(String(d.id))}" type="button">Editar</button>
            <button class="deck-mini-btn" data-deck-action="duplicate" data-deck-id="${escapeHtml(String(d.id))}" type="button">Duplicar</button>
            <button class="deck-mini-btn" data-deck-action="copy" data-deck-id="${escapeHtml(String(d.id))}" type="button">Copiar</button>
            <button class="deck-mini-btn danger" data-deck-action="delete" data-deck-id="${escapeHtml(String(d.id))}" type="button">Eliminar</button>
          </div>
        </article>`;
    })
    .join("");

  host.querySelectorAll("[data-open-deck]").forEach((cardEl) => {
    cardEl.addEventListener("click", (e) => {
      if (e.target.closest("[data-deck-action]")) return;
      openDeckPreview(cardEl.getAttribute("data-open-deck"));
    });
  });

  host.querySelectorAll("[data-deck-action]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const deckId = btn.getAttribute("data-deck-id");
      const action = btn.getAttribute("data-deck-action");
      if (action === "preview") {
        await openDeckPreview(deckId);
      } else if (action === "edit") {
        await openDeckEditor(deckId);
      } else if (action === "duplicate") {
        await duplicateDeckById(deckId);
      } else if (action === "copy") {
        try {
          const detail = await apiFetch(`/api/decks/${encodeURIComponent(deckId)}`);
          await copyDeckTextToClipboard(detail);
        } catch (err) {
          showSnackbar(`Error al copiar mazo: ${err.message}`);
        }
      } else if (action === "delete") {
        await deleteDeckById(deckId);
      }
    });
  });
}

export async function saveCurrentDeck() {
  if (!state.editingDeck) return false;
  const nameInput = document.getElementById("deck-name-input");
  const name = nameInput.value.trim();
  if (!name) {
    document.getElementById("deck-stats-modal")?.classList.add("hidden");
    showSnackbar("Ingresa un nombre para el mazo");
    nameInput.focus();
    return false;
  }

  const desc = document.getElementById("deck-desc-input")?.value.trim() || "";
  const payload = {
    name,
    oshiProductId: state.editingDeck.oshiProductId ? Number(state.editingDeck.oshiProductId) : null,
    description: desc,
    cards: (state.editingDeck.cards || []).map((c) => ({
      productId: Number(c.productId),
      zone: c.zone === "cheer" ? "cheer" : "main",
      quantity: Number(c.quantity || 1),
    })),
  };

  const saveBtn = document.getElementById("save-deck-btn");
  const statsSaveBtn = document.getElementById("deck-stats-save-btn");
  if (saveBtn) saveBtn.disabled = true;
  if (statsSaveBtn) statsSaveBtn.disabled = true;
  try {
    const saved = state.editingDeck.id
      ? await apiFetch(`/api/decks/${encodeURIComponent(state.editingDeck.id)}`, {
          method: "PUT",
          body: JSON.stringify(payload),
        })
      : await apiFetch("/api/decks", {
          method: "POST",
          body: JSON.stringify(payload),
        });
    document.getElementById("deck-stats-modal")?.classList.add("hidden");
    state.editingDeck = null;
    state.previewDeck = null;
    setDeckDirty(false);
    setDeckSubView("gallery");
    await loadDecks();
    window.scrollTo({ top: 0, behavior: "smooth" });
    const user = window.HololiveCloudBackend?.getCurrentUser();
    const isCloud = window.HololiveCloudBackend?.isCloudMode();
    showSnackbar(
      user && isCloud
        ? `☁ Mazo "${saved.name}" guardado en Firebase Cloud Firestore`
        : `Mazo "${saved.name}" guardado correctamente`
    );
    return true;
  } catch (err) {
    showSnackbar(`Error guardando mazo: ${err.message}`);
    return false;
  } finally {
    if (saveBtn) saveBtn.disabled = false;
    if (statsSaveBtn) statsSaveBtn.disabled = false;
  }
}

export async function duplicateDeckById(deckId) {
  try {
    const detail = await apiFetch(`/api/decks/${encodeURIComponent(deckId)}`);
    const copyPayload = {
      name: `${detail.name} (Copia)`.slice(0, 120),
      oshiProductId: detail.oshiProductId || null,
      description: detail.description || "",
      cards: (detail.cards || []).map((c) => ({
        productId: c.productId,
        zone: c.zone,
        quantity: c.quantity,
      })),
    };
    const created = await apiFetch("/api/decks", {
      method: "POST",
      body: JSON.stringify(copyPayload),
    });
    await loadDecks();
    showSnackbar(`Mazo duplicado: "${created.name}"`);
  } catch (err) {
    showSnackbar(`Error duplicando mazo: ${err.message}`);
  }
}

export async function deleteDeckById(deckId) {
  const ok = window.confirm("¿Eliminar este mazo de forma permanente?");
  if (!ok) return;
  try {
    await apiFetch(`/api/decks/${encodeURIComponent(deckId)}`, { method: "DELETE" });
    if (state.editingDeck && String(state.editingDeck.id) === String(deckId)) {
      state.editingDeck = null;
      setDeckDirty(false);
      setDeckSubView("gallery");
    }
    if (state.previewDeck && String(state.previewDeck.id) === String(deckId)) {
      state.previewDeck = null;
      setDeckSubView("gallery");
    }
    await loadDecks();
    showSnackbar("Mazo eliminado");
  } catch (err) {
    showSnackbar(`Error eliminando mazo: ${err.message}`);
  }
}

function getResolvedDeckMeta(deck) {
  const inStudio =
    deck === state.editingDeck &&
    !document.getElementById("deck-builder-studio")?.classList.contains("hidden");
  const name = inStudio
    ? document.getElementById("deck-name-input")?.value.trim() || deck?.name || "Hololive OCG Deck"
    : deck?.name || "Hololive OCG Deck";
  const description = inStudio
    ? document.getElementById("deck-desc-input")?.value.trim() || deck?.description || ""
    : deck?.description || "";
  return { name, description };
}

function formatDeckAsText(deck) {
  const { name } = getResolvedDeckMeta(deck);
  const lines = [`Nombre: ${name}`];
  if (deck.oshiCard) {
    lines.push(`Oshi: ${deck.oshiCard.cardNumber || deck.oshiCard.productId} ${deck.oshiCard.name}`);
  } else if (deck.oshiProductId) {
    lines.push(`Oshi: ${deck.oshiProductId}`);
  }
  lines.push("", "// Main Deck");
  for (const c of (deck.cards || []).filter((x) => x.zone !== "cheer")) {
    lines.push(`${c.quantity} ${c.cardNumber || c.productId} ${c.name || ""}`.trim());
  }
  const cheers = (deck.cards || []).filter((x) => x.zone === "cheer");
  if (cheers.length) {
    lines.push("", "// Cheer Deck");
    for (const c of cheers) {
      lines.push(`${c.quantity} ${c.cardNumber || c.productId} ${c.name || ""}`.trim());
    }
  }
  return lines.join("\n");
}

export async function copyDeckTextToClipboard(deck) {
  if (!deck) return;
  const text = formatDeckAsText(deck);
  try {
    await navigator.clipboard.writeText(text);
    showSnackbar("Lista del mazo copiada al portapapeles");
  } catch (_) {
    showSnackbar("No se pudo copiar automáticamente; usa Exportar JSON.");
  }
}

export function exportDeckAsJson(deck) {
  if (!deck) return;
  const { name, description } = getResolvedDeckMeta(deck);
  const payload = {
    version: "hocg-deck-1.0",
    name,
    oshiProductId: deck.oshiProductId || null,
    oshiCardNumber: deck.oshiCard?.cardNumber || null,
    description,
    cards: (deck.cards || []).map((c) => ({
      productId: c.productId,
      cardNumber: c.cardNumber || "",
      zone: c.zone || "main",
      quantity: c.quantity,
    })),
  };
  downloadJsonFile(`${name.toLowerCase().replace(/[^a-z0-9_-]+/g, "_") || "deck"}.json`, payload);
  showSnackbar("Archivo JSON del mazo descargado");
}

async function resolveCardForImport(codeOrPid) {
  const token = String(codeOrPid || "").trim();
  if (!token) return null;
  if (/^\d+$/.test(token)) {
    try {
      return await apiFetch(`/api/cards/${token}`);
    } catch (_) {}
  }
  const res = await apiFetch(`/api/cards?q=${encodeURIComponent(token)}&per_page=25`);
  const exact = (res.items || []).filter(
    (c) => String(c.cardNumber || "").toUpperCase() === token.toUpperCase()
  );
  const pool = exact.length ? exact : res.items || [];
  if (!pool.length) return null;
  // Prefer standard non-parallel printings first when multiple rarities share the same code
  return pool.find((c) => !HIGH_RARITIES.has(c.rarity)) || pool[0];
}

export async function importDeckFromRawInput(rawText) {
  const trimmed = String(rawText || "").trim();
  if (!trimmed) {
    showSnackbar("Pega una lista o carga un archivo primero");
    return;
  }

  let parsedName = "Mazo importado";
  let parsedDesc = "";
  let oshiCard = null;
  const importedEntries = [];

  if (trimmed.startsWith("{")) {
    const json = JSON.parse(trimmed);
    if (json.name) parsedName = String(json.name).slice(0, 120);
    if (json.description) parsedDesc = String(json.description).slice(0, 1000);
    if (json.oshiProductId) {
      oshiCard = await resolveCardForImport(json.oshiProductId);
    } else if (json.oshiCardNumber) {
      oshiCard = await resolveCardForImport(json.oshiCardNumber);
    }
    for (const row of json.cards || []) {
      const card = row.productId
        ? await resolveCardForImport(row.productId)
        : await resolveCardForImport(row.cardNumber);
      if (card) {
        importedEntries.push({
          card,
          quantity: Math.max(1, Number(row.quantity || 1)),
          zone: row.zone === "cheer" || card.cardType === "Cheer" ? "cheer" : "main",
        });
      }
    }
  } else {
    const cache = new Map();
    const cachedResolve = async (code) => {
      const key = String(code).toUpperCase();
      if (!cache.has(key)) cache.set(key, await resolveCardForImport(code));
      return cache.get(key);
    };

    for (const rawLine of trimmed.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("//") || line.startsWith("#")) continue;
      const nameMatch = line.match(/^Nombre\s*:\s*(.+)$/i);
      if (nameMatch) {
        parsedName = nameMatch[1].trim().slice(0, 120);
        continue;
      }
      const oshiMatch = line.match(/^Oshi\s*:\s*([A-Za-z0-9-]+|\d+)/i);
      if (oshiMatch) {
        oshiCard = await cachedResolve(oshiMatch[1]);
        continue;
      }
      const rowMatch = line.match(/^(\d+)\s*[xX×]?\s+([A-Za-z0-9-]+|\d+)/);
      if (rowMatch) {
        const qty = Math.max(1, Number(rowMatch[1]));
        const card = await cachedResolve(rowMatch[2]);
        if (card) {
          if (card.cardType === "Oshi Holomem") oshiCard = card;
          else {
            importedEntries.push({
              card,
              quantity: qty,
              zone: card.cardType === "Cheer" ? "cheer" : "main",
            });
          }
        }
      }
    }
  }

  await openDeckEditor(null);
  state.editingDeck.name = parsedName;
  state.editingDeck.description = parsedDesc;
  document.getElementById("deck-name-input").value = parsedName;
  document.getElementById("deck-desc-input").value = parsedDesc;
  if (oshiCard) selectOshiForDeck(oshiCard);

  for (const entry of importedEntries) {
    const existing = state.editingDeck.cards.find(
      (c) => Number(c.productId) === Number(entry.card.productId) && c.zone === entry.zone
    );
    if (existing) {
      existing.quantity += entry.quantity;
    } else {
      state.editingDeck.cards.push({
        productId: Number(entry.card.productId),
        zone: entry.zone,
        quantity: entry.quantity,
        ownedQuantity: entry.card.totalOwned ?? 0,
        name: entry.card.name,
        cardNumber: entry.card.cardNumber || "",
        cardType: entry.card.cardType || "",
        bloomLevel: entry.card.bloomLevel || "",
        color: entry.card.color || "",
        rarity: entry.card.rarity || "",
        effectText: entry.card.effectText || "",
        imageUrl: entry.card.imageUrl || "",
        marketPrice: entry.card.marketPrice ?? entry.card.foilMarketPrice ?? null,
      });
    }
  }

  setDeckDirty(true);
  setDeckZoneTab("main");
  renderDeckPanel();
  syncDeckBrowserCardsInPlace();
  document.getElementById("deck-import-modal")?.classList.add("hidden");
  showSnackbar(`Mazo cargado en el editor (${importedEntries.length} líneas). Pulsa Guardar Mazo para conservarlo.`);
}

export async function addMissingCardsToWishlistForDeck(deck, btnId) {
  if (!deck) return;
  const rules = evaluateDeckRules(deck);
  if (!rules.missingCards.length) {
    showSnackbar("¡Ya tienes todas las cartas de este mazo!");
    return;
  }
  const btn = document.getElementById(btnId);
  if (btn) btn.disabled = true;
  try {
    let updatedCount = 0;
    for (const m of rules.missingCards) {
      await apiFetch(`/api/collection/${m.productId}`, {
        method: "POST",
        body: JSON.stringify({
          isWishlist: true,
          wishlistTargetQty: Math.max(1, m.missingQty),
        }),
      });
      updatedCount += 1;
    }
    await Promise.all([actions.loadKpis?.(), actions.loadEditions?.()]);
    showSnackbar(`♥ ${updatedCount} carta(s) faltantes marcadas en tu Wishlist`);
  } catch (err) {
    showSnackbar(`Error al actualizar Wishlist: ${err.message}`);
  } finally {
    if (state.editingDeck) renderDeckPanel();
    if (state.previewDeck) renderDeckPreview(state.previewDeck);
  }
}

export function bindDecksEvents() {
  bindDeckStudioEvents();

  document.getElementById("decks-signin-btn")?.addEventListener("click", triggerGoogleSignIn);
  document.getElementById("deck-panel-signin-btn")?.addEventListener("click", triggerGoogleSignIn);

  document.getElementById("new-deck-btn")?.addEventListener("click", () => openDeckEditor(null));
  document.getElementById("close-deck-editor")?.addEventListener("click", closeDeckEditor);
  document.getElementById("close-deck-preview")?.addEventListener("click", closeDeckPreview);
  document.getElementById("preview-edit-btn")?.addEventListener("click", () => {
    if (state.previewDeck?.id) openDeckEditor(state.previewDeck.id);
  });
  document.getElementById("preview-duplicate-btn")?.addEventListener("click", () => {
    if (state.previewDeck?.id) duplicateDeckById(state.previewDeck.id);
  });
  document.getElementById("preview-copy-btn")?.addEventListener("click", () => {
    if (state.previewDeck) copyDeckTextToClipboard(state.previewDeck);
  });
  document.getElementById("preview-export-btn")?.addEventListener("click", () => {
    if (state.previewDeck) exportDeckAsJson(state.previewDeck);
  });
  document.getElementById("preview-delete-btn")?.addEventListener("click", () => {
    if (state.previewDeck?.id) deleteDeckById(state.previewDeck.id);
  });
  document.getElementById("preview-ownership-toggle")?.addEventListener("change", (e) => {
    state.deckBuilder.previewShowOwnership = e.target.checked;
    if (state.previewDeck) renderDeckPreview(state.previewDeck);
  });
  document.getElementById("save-deck-btn")?.addEventListener("click", saveCurrentDeck);
  document.getElementById("delete-deck-btn")?.addEventListener("click", () => {
    if (state.editingDeck?.id) deleteDeckById(state.editingDeck.id);
  });
  document.getElementById("duplicate-deck-btn")?.addEventListener("click", () => {
    if (state.editingDeck?.id) duplicateDeckById(state.editingDeck.id);
  });

  document.getElementById("deck-add-missing-wishlist-btn")?.addEventListener("click", () => {
    addMissingCardsToWishlistForDeck(state.editingDeck, "deck-add-missing-wishlist-btn");
  });
  document.getElementById("copy-deck-text-btn")?.addEventListener("click", () => {
    copyDeckTextToClipboard(state.editingDeck);
  });
  document.getElementById("export-deck-json-btn")?.addEventListener("click", () => {
    exportDeckAsJson(state.editingDeck);
  });

  document.getElementById("deck-stats-copy-btn")?.addEventListener("click", () => {
    copyDeckTextToClipboard(state.editingDeck);
  });
  document.getElementById("deck-stats-export-btn")?.addEventListener("click", () => {
    exportDeckAsJson(state.editingDeck);
  });
  document.getElementById("deck-stats-save-btn")?.addEventListener("click", async () => {
    await saveCurrentDeck();
  });

  document.getElementById("open-deck-import-btn")?.addEventListener("click", () => {
    const ta = document.getElementById("deck-import-text");
    if (ta) ta.value = "";
    document.getElementById("deck-import-modal")?.classList.remove("hidden");
  });
  document.getElementById("deck-import-close")?.addEventListener("click", () => {
    document.getElementById("deck-import-modal")?.classList.add("hidden");
  });
  document.getElementById("deck-import-cancel-btn")?.addEventListener("click", () => {
    document.getElementById("deck-import-modal")?.classList.add("hidden");
  });
  document.getElementById("deck-import-modal")?.addEventListener("click", (e) => {
    if (e.target.id === "deck-import-modal") e.target.classList.add("hidden");
  });
  document.getElementById("deck-import-file")?.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    document.getElementById("deck-import-text").value = await file.text();
    e.target.value = "";
  });
  document.getElementById("deck-import-confirm-btn")?.addEventListener("click", async () => {
    const btn = document.getElementById("deck-import-confirm-btn");
    btn.disabled = true;
    btn.textContent = "Importando...";
    try {
      await importDeckFromRawInput(document.getElementById("deck-import-text")?.value || "");
    } catch (err) {
      showSnackbar(`Error al importar mazo: ${err.message}`);
    } finally {
      btn.disabled = false;
      btn.textContent = "Importar en editor";
    }
  });
}
