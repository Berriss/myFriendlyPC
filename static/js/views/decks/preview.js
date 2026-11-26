import { actions } from "../../core/actions.js";
import { apiFetch, showSnackbar } from "../../core/api.js";
import { MAIN_GROUP_ORDER_RANK } from "../../core/constants.js";
import { escapeHtml, fmtMoney, getDeckGroupCategory } from "../../core/formatters.js";
import { state } from "../../core/state.js";
import { evaluateDeckRules } from "./rules.js";

export async function openDeckPreview(deckId) {
  try {
    const detail = await apiFetch(`/api/decks/${encodeURIComponent(deckId)}`);
    state.previewDeck = detail;
    actions.setDeckSubView?.("preview");
    renderDeckPreview(detail);
    window.scrollTo({ top: 0, behavior: "smooth" });
  } catch (err) {
    showSnackbar(`Error cargando vista previa: ${err.message}`);
  }
}

export function closeDeckPreview() {
  state.previewDeck = null;
  actions.setDeckSubView?.("gallery");
}

export function renderPreviewCardTile(card, showOwnership, isOshi) {
  const owned = Number(card.ownedQuantity || 0);
  const req = isOshi ? 1 : Number(card.quantity || 1);
  const ok = owned >= req;
  return `
    <div class="preview-card-tile" title="${escapeHtml(card.name)} (${escapeHtml(card.cardNumber || "S/N")})">
      ${
        card.imageUrl
          ? `<img data-preview-zoom="${card.productId}" src="${escapeHtml(card.imageUrl)}" alt="${escapeHtml(card.name)}" loading="lazy" />`
          : `<div class="art-fallback">${escapeHtml(card.name)}</div>`
      }
      ${
        showOwnership
          ? `<span class="preview-owned-badge ${ok ? "owned-ok" : "owned-short"}">${ok ? "✓ " : ""}${owned}/${req}</span>`
          : ""
      }
      <button class="preview-zoom-btn" data-preview-zoom="${card.productId}" type="button" title="Ver detalle de carta">🔍</button>
      ${isOshi ? "" : `<span class="preview-qty-box">${req}</span>`}
    </div>`;
}

export function renderDeckPreview(deck) {
  if (!deck) return;
  const rules = evaluateDeckRules(deck);

  const titleEl = document.getElementById("preview-deck-title");
  if (titleEl) titleEl.textContent = deck.name || "Mazo";

  const pillEl = document.getElementById("preview-deck-legality-pill");
  if (pillEl) {
    pillEl.className = `deck-legality-pill ${rules.isLegal ? "legal-ok" : "legal-wip"}`;
    pillEl.textContent = rules.isLegal
      ? "✓ Completo (1 · 50 · 20)"
      : `${rules.hasOshi ? 1 : 0}/1 Oshi · ${rules.mainCount}/50 Main · ${rules.cheerCount}/20 Cheer`;
  }

  const ruleMeta = document.getElementById("preview-rule-meta");
  if (ruleMeta) {
    ruleMeta.textContent = `Cobertura: ${rules.coveragePct.toFixed(0)}% · Valor: ${fmtMoney(rules.totalCostUsd)} · Faltan: ${fmtMoney(rules.missingCostUsd)}`;
  }

  const notesEl = document.getElementById("preview-deck-notes");
  if (notesEl) {
    const desc = String(deck.description || "").trim();
    notesEl.textContent = desc;
    notesEl.classList.toggle("hidden", !desc);
  }

  // 3-Column Analytics Band (Bloom Level, Color, Types & Totals)
  const analyticsHost = document.getElementById("preview-analytics-band");
  if (analyticsHost) {
    const bloomBars = [
      { label: "Debut", count: rules.bloomCounts.Debut },
      { label: "1st", count: rules.bloomCounts["1st"] + rules.bloomCounts.Buzz },
      { label: "2nd", count: rules.bloomCounts["2nd"] },
      { label: "Spot", count: rules.bloomCounts.Spot },
    ];
    const maxBloom = Math.max(1, ...bloomBars.map((b) => b.count));

    const colorBarMeta = [
      { key: "White", label: "White", color: "#cbd5e1" },
      { key: "Green", label: "Green", color: "#22c55e" },
      { key: "Red", label: "Red", color: "#ef4444" },
      { key: "Blue", label: "Blue", color: "#3b82f6" },
      { key: "Purple", label: "Purple", color: "#a855f7" },
      { key: "Yellow", label: "Yellow", color: "#eab308" },
      { key: "Colorless", label: "Neutral", color: "#64748b" },
    ];
    const maxColor = Math.max(1, ...colorBarMeta.map((c) => rules.colorCounts[c.key] || 0));

    const holomemTotal = rules.typeCounts.Holomem + rules.typeCounts["Buzz Holomem"];
    const buzzTotal = rules.typeCounts["Buzz Holomem"];
    const supportTotal = rules.typeCounts.Support;
    const limitedTotal = rules.typeCounts.LIMITED;
    const cheerTotal = rules.typeCounts.Cheer;

    analyticsHost.innerHTML = `
      <section class="vchart-box">
        <h4 class="vchart-title">Bloom Level</h4>
        <div class="vchart-surface">
          <div class="vchart-cols">
            ${bloomBars
              .map((b) => {
                const pct = b.count > 0 ? Math.max(8, Math.round((b.count / maxBloom) * 100)) : 0;
                return `
                  <div class="vchart-col">
                    <span class="vchart-pill ${b.count > 0 ? "has-val" : ""}">${b.count}</span>
                    <div class="vchart-bar-wrap">
                      <div class="vchart-bar" style="height:${pct}%"></div>
                    </div>
                    <span class="vchart-label">${escapeHtml(b.label)}</span>
                  </div>`;
              })
              .join("")}
          </div>
        </div>
      </section>

      <section class="vchart-box">
        <h4 class="vchart-title">Color</h4>
        <div class="vchart-surface">
          <div class="vchart-cols">
            ${colorBarMeta
              .map((c) => {
                const val = rules.colorCounts[c.key] || 0;
                const pct = val > 0 ? Math.max(8, Math.round((val / maxColor) * 100)) : 0;
                return `
                  <div class="vchart-col">
                    <span class="vchart-pill ${val > 0 ? "has-val" : ""}">${val}</span>
                    <div class="vchart-bar-wrap">
                      <div class="vchart-bar" style="height:${pct}%;background:${c.color};"></div>
                    </div>
                    <span class="vchart-label">${escapeHtml(c.label)}</span>
                  </div>`;
              })
              .join("")}
          </div>
        </div>
      </section>

      <section class="preview-type-panel">
        <div class="preview-type-band">
          <div class="preview-type-list">
            <div class="preview-type-accent"><span>Holomem</span><strong>${holomemTotal}</strong></div>
            <div class="preview-type-sub"><span>└ Buzz holomem</span><strong>${buzzTotal}</strong></div>
            <div class="preview-type-accent"><span>Support</span><strong>${supportTotal}</strong></div>
            <div class="preview-type-sub"><span>└ LIMITED</span><strong>${limitedTotal}</strong></div>
          </div>
          <div class="preview-type-big">${rules.mainCount} / 50</div>
        </div>
        <hr style="border:none;border-top:1px solid var(--md-sys-color-outline-variant);margin:2px 0;" />
        <div class="preview-type-band">
          <div class="preview-type-list">
            <div class="preview-type-accent"><span>Cheer</span><strong>${cheerTotal}</strong></div>
          </div>
          <div class="preview-type-big">${rules.cheerCount} / 20</div>
        </div>
        <div class="preview-collector-row">
          <span>Tienes <strong>${rules.ownedCopies}/${rules.totalRequiredCopies}</strong> (${rules.coveragePct.toFixed(0)}%)</span>
          <button id="preview-add-missing-wishlist-btn" class="outlined-btn" style="height:32px;padding:0 12px;font-size:0.76rem;" type="button" title="Agregar cartas faltantes a Wishlist" ${rules.missingCards.length === 0 ? "disabled" : ""}>
            ${rules.missingCards.length ? `♥ Faltantes (${rules.missingCards.length})` : "♥ Completo"}
          </button>
        </div>
      </section>`;

    document.getElementById("preview-add-missing-wishlist-btn")?.addEventListener("click", () => {
      actions.addMissingCardsToWishlistForDeck?.(state.previewDeck, "preview-add-missing-wishlist-btn");
    });
  }

  // Visual Card Sheet (Oshi, Main Deck, Cheer Deck)
  const sheetHost = document.getElementById("preview-deck-sheet");
  if (!sheetHost) return;
  const showOwnership = Boolean(state.deckBuilder.previewShowOwnership);
  const toggleEl = document.getElementById("preview-ownership-toggle");
  if (toggleEl) toggleEl.checked = showOwnership;

  const mainCardsOrdered = [];
  for (const c of (deck.cards || []).filter((x) => (x.zone || "main") !== "cheer")) {
    mainCardsOrdered.push(c);
  }
  mainCardsOrdered.sort((a, b) => {
    const ra = MAIN_GROUP_ORDER_RANK[getDeckGroupCategory(a)] || 9;
    const rb = MAIN_GROUP_ORDER_RANK[getDeckGroupCategory(b)] || 9;
    if (ra !== rb) return ra - rb;
    return String(a.cardNumber || "").localeCompare(String(b.cardNumber || "")) ||
      String(a.name || "").localeCompare(String(b.name || ""));
  });

  const cheerCardsOrdered = (deck.cards || [])
    .filter((x) => x.zone === "cheer")
    .slice()
    .sort(
      (a, b) =>
        String(a.cardNumber || "").localeCompare(String(b.cardNumber || "")) ||
        String(a.name || "").localeCompare(String(b.name || ""))
    );

  sheetHost.innerHTML = `
    <section class="preview-section-block">
      <h3 class="preview-section-title">
        <span>Oshi</span>
        <span class="edition-abbr">${rules.hasOshi ? "1 / 1" : "0 / 1"}</span>
      </h3>
      ${
        deck.oshiCard
          ? `<div class="preview-cards-grid">${renderPreviewCardTile(deck.oshiCard, showOwnership, true)}</div>`
          : `<p class="muted-text" style="margin:0;">Este mazo aún no tiene una carta Oshi asignada.</p>`
      }
    </section>

    <section class="preview-section-block">
      <h3 class="preview-section-title">
        <span>Main Deck</span>
        <span class="edition-abbr">${rules.mainCount} / 50</span>
      </h3>
      ${
        mainCardsOrdered.length
          ? `<div class="preview-cards-grid">${mainCardsOrdered.map((c) => renderPreviewCardTile(c, showOwnership, false)).join("")}</div>`
          : `<p class="muted-text" style="margin:0;">Sin cartas en el Main Deck todavía.</p>`
      }
    </section>

    <section class="preview-section-block">
      <h3 class="preview-section-title">
        <span>Cheer Deck</span>
        <span class="edition-abbr">${rules.cheerCount} / 20</span>
      </h3>
      ${
        cheerCardsOrdered.length
          ? `<div class="preview-cards-grid">${cheerCardsOrdered.map((c) => renderPreviewCardTile(c, showOwnership, false)).join("")}</div>`
          : `<p class="muted-text" style="margin:0;">Sin cartas en el Cheer Deck todavía.</p>`
      }
    </section>`;

  sheetHost.querySelectorAll("[data-preview-zoom]").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      actions.openCardModal?.(Number(el.getAttribute("data-preview-zoom")));
    });
  });
}
