import { actions } from "../core/actions.js";
import { apiFetch, showSnackbar } from "../core/api.js";
import {
  escapeHtml,
  fmtClp,
  fmtMoney,
  fmtUsd,
  getRarityTierLabel,
  isCardFoil,
  wishHeartSvg,
} from "../core/formatters.js";
import { state } from "../core/state.js";
import { quickAdjustCard } from "./card-ui.js";

export async function openCardModal(productId) {
  const backdrop = document.getElementById("card-modal-backdrop");
  const body = document.getElementById("modal-body-content");
  backdrop.classList.remove("hidden");
  body.innerHTML = `<p class="muted-text">Cargando información de la carta...</p>`;

  try {
    const c = await apiFetch(`/api/cards/${productId}`);
    document.getElementById("modal-card-title").textContent = c.name;
    document.getElementById("modal-card-meta").textContent =
      `${c.editionName} · ${c.cardNumber || "Sin código"} · ${c.rarityName || c.rarity || "Producto"}`;

    const attrs = [
      ["Tipo", c.cardType],
      ["Subtipo", c.subtype],
      ["Color", c.color],
      ["Bloom Level", c.bloomLevel],
      ["HP", c.hp],
      ["Life", c.life],
      ["Baton Pass", c.batonPass],
      ["Tags", c.tags],
    ]
      .filter(([, val]) => val !== null && val !== undefined && val !== "")
      .map(([k, val]) => `<span class="attr-chip"><strong>${escapeHtml(k)}:</strong> ${escapeHtml(val)}</span>`)
      .join("");

    const sanitizedBadge = c.sanitizedFlag
      ? `<span class="edition-abbr" title="Saneado de comas/HTML/typos en el barrido">✓ Texto saneado TCGCSV</span>`
      : "";
    const rarityTierBadge = `<span class="attr-chip">${isCardFoil(c) ? "✦ " : ""}${escapeHtml(getRarityTierLabel(c))}</span>`;
    const effectiveMarket = c.marketPrice ?? c.foilMarketPrice;

    body.innerHTML = `
      <div class="modal-grid">
        <div>
          ${
            c.imageUrl
              ? `<img class="modal-art" src="${escapeHtml(c.imageUrl)}" alt="${escapeHtml(c.name)}" />`
              : `<div class="art-fallback">Sin imagen</div>`
          }
          <div style="margin-top:10px;display:flex;flex-direction:column;gap:6px;font-size:0.84rem;">
            <div><strong>Market Price (${escapeHtml(state.currency)}):</strong> ${fmtMoney(effectiveMarket)}</div>
            <div><strong>Equivalencia:</strong> ${fmtUsd(effectiveMarket)} USD / ${fmtClp(effectiveMarket)}</div>
            <div><strong>Low / Mid / High:</strong> ${fmtMoney(c.lowPrice)} / ${fmtMoney(c.midPrice)} / ${fmtMoney(c.highPrice)}</div>
            <div><strong>Acabado de rareza:</strong> ${escapeHtml(getRarityTierLabel(c))}</div>
            ${
              c.url
                ? `<a class="outlined-btn" style="margin-top:6px;text-decoration:none;" href="${escapeHtml(c.url)}" target="_blank" rel="noopener noreferrer">Ver en TCGplayer ↗</a>`
                : ""
            }
          </div>
        </div>

        <div>
          <div class="card-attr-chips" style="margin-bottom:10px;">${rarityTierBadge} ${attrs} ${sanitizedBadge}</div>

          ${
            c.effectText
              ? `<div>
                  <strong>Efectos &amp; Reglas</strong>
                  <div class="effect-box">${escapeHtml(c.effectText)}</div>
                  ${
                    c.rawDescription && c.rawDescription !== c.effectText
                      ? `<details style="font-size:0.8rem;margin-bottom:8px;">
                           <summary style="cursor:pointer;color:var(--md-sys-color-primary);">Ver texto crudo original de TCGplayer</summary>
                           <div class="audit-box" style="margin-top:6px;">${escapeHtml(c.rawDescription)}</div>
                         </details>`
                      : ""
                  }
                 </div>`
              : `<p class="muted-text">Sin descripción de efecto registrada.</p>`
          }

          <div class="modal-quick-actions">
            <button id="modal-wish-toggle-btn" class="wish-toggle-btn modal-action-pill ${c.isWishlist ? "is-wishlisted" : ""}" type="button" aria-pressed="${c.isWishlist ? "true" : "false"}">
              ${wishHeartSvg(c.isWishlist)}
              <span>${c.isWishlist ? "En Wishlist" : "Agregar a Wishlist"}</span>
            </button>
            <button id="modal-fav-toggle-btn" class="fav-toggle-btn modal-action-pill ${c.isFavorite ? "is-favorited" : ""}" type="button" aria-pressed="${c.isFavorite ? "true" : "false"}">
              <span>★</span>
              <span>${c.isFavorite ? "En Favoritas" : "Agregar a Favoritas"}</span>
            </button>
            <button id="modal-trade-shortcut-btn" class="tonal-btn modal-action-pill" type="button">
              ⇄ Registrar en Trading
            </button>
          </div>

          <form id="modal-collection-form" class="collection-form-box">
            <strong style="display:block;margin-bottom:10px;">Guardar en Mi Colección</strong>
            <div class="form-grid-3">
              <div class="field-group">
                <label for="m-qty-total">Cantidad en Colección</label>
                <input id="m-qty-total" type="number" min="0" value="${c.totalOwned}" />
              </div>
              <div class="field-group">
                <label for="m-purchase-price">Compra c/u (USD)</label>
                <input id="m-purchase-price" type="number" min="0" step="0.01" value="${c.purchasePrice ?? ""}" placeholder="Opcional" />
              </div>
              <div class="field-group">
                <label for="m-condition">Condición</label>
                <select id="m-condition">
                  ${["NM", "LP", "MP", "HP", "DMG"]
                    .map((cond) => `<option value="${cond}" ${c.condition === cond ? "selected" : ""}>${cond}</option>`)
                    .join("")}
                </select>
              </div>
              <div class="field-group">
                <label for="m-language">Idioma</label>
                <select id="m-language">
                  ${["EN", "JP"]
                    .map((lang) => `<option value="${lang}" ${c.language === lang ? "selected" : ""}>${lang}</option>`)
                    .join("")}
                </select>
              </div>
              <div class="field-group ${c.isWishlist ? "" : "hidden"}" id="m-wish-target-group">
                <label for="m-wish-target">Meta Wishlist</label>
                <input id="m-wish-target" type="number" min="1" value="${c.wishlistTargetQty}" />
              </div>
            </div>
            <div class="field-group" style="margin-top:10px;">
              <label for="m-notes">Notas personales</label>
              <textarea id="m-notes" rows="2" placeholder="Carpeta, intercambio, pull de caja...">${escapeHtml(c.notes)}</textarea>
            </div>
            <div class="action-row end">
              <button class="filled-btn" type="submit">Guardar cambios</button>
            </div>
          </form>
        </div>
      </div>`;

    let modalIsWishlist = Boolean(c.isWishlist);
    let modalIsFavorite = Boolean(c.isFavorite);

    const modalWishBtn = document.getElementById("modal-wish-toggle-btn");
    const modalFavBtn = document.getElementById("modal-fav-toggle-btn");
    const modalTradeBtn = document.getElementById("modal-trade-shortcut-btn");
    const wishTargetGroup = document.getElementById("m-wish-target-group");

    modalTradeBtn?.addEventListener("click", () => {
      backdrop.classList.add("hidden");
      const defaultType = c.totalOwned === 0 || modalIsWishlist ? "buy" : "sell";
      actions.openTradeEditor?.(null, defaultType, { ...c, isWishlist: modalIsWishlist });
    });

    modalWishBtn?.addEventListener("click", async () => {
      modalWishBtn.disabled = true;
      try {
        const updated = await quickAdjustCard(productId, { toggleWishlist: true });
        if (updated) {
          modalIsWishlist = Boolean(updated.isWishlist);
          modalWishBtn.classList.toggle("is-wishlisted", modalIsWishlist);
          modalWishBtn.setAttribute("aria-pressed", modalIsWishlist ? "true" : "false");
          modalWishBtn.innerHTML = `${wishHeartSvg(modalIsWishlist)}<span>${modalIsWishlist ? "En Wishlist" : "Agregar a Wishlist"}</span>`;
          wishTargetGroup?.classList.toggle("hidden", !modalIsWishlist);
        }
      } finally {
        modalWishBtn.disabled = false;
      }
    });

    modalFavBtn?.addEventListener("click", async () => {
      modalFavBtn.disabled = true;
      try {
        const updated = await quickAdjustCard(productId, { toggleFavorite: true });
        if (updated) {
          modalIsFavorite = Boolean(updated.isFavorite);
          modalFavBtn.classList.toggle("is-favorited", modalIsFavorite);
          modalFavBtn.setAttribute("aria-pressed", modalIsFavorite ? "true" : "false");
          modalFavBtn.innerHTML = `<span>★</span><span>${modalIsFavorite ? "En Favoritas" : "Agregar a Favoritas"}</span>`;
        }
      } finally {
        modalFavBtn.disabled = false;
      }
    });

    document.getElementById("modal-collection-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const priceRaw = document.getElementById("m-purchase-price").value.trim();
      const payload = {
        quantity: Number(document.getElementById("m-qty-total").value || 0),
        purchasePrice: priceRaw === "" ? null : Number(priceRaw),
        condition: document.getElementById("m-condition").value,
        language: document.getElementById("m-language").value,
        wishlistTargetQty: Math.max(
          1,
          Number(document.getElementById("m-wish-target")?.value || c.wishlistTargetQty || 1)
        ),
        isFavorite: modalIsFavorite,
        isWishlist: modalIsWishlist,
        notes: document.getElementById("m-notes").value,
      };
      try {
        const savedCol = await apiFetch(`/api/collection/${productId}`, {
          method: "POST",
          body: JSON.stringify(payload),
        });
        backdrop.classList.add("hidden");
        actions.syncEditingDeckOwnedCount?.(productId, savedCol?.totalOwned);
        const tasks = [actions.loadCards?.(), actions.loadKpis?.(), actions.loadEditions?.()];
        if (state.activeView === "collection") tasks.push(actions.loadCollectionCards?.());
        await Promise.all(tasks);
        showSnackbar(`Colección guardada para ${c.name}`);
      } catch (err) {
        showSnackbar(`Error al guardar: ${err.message}`);
      }
    });
  } catch (err) {
    body.innerHTML = `<p class="muted-text">No se pudo cargar la carta: ${escapeHtml(err.message)}</p>`;
  }
}

export function bindCardModalEvents() {
  document.getElementById("modal-close-btn")?.addEventListener("click", () => {
    document.getElementById("card-modal-backdrop")?.classList.add("hidden");
  });
  document.getElementById("card-modal-backdrop")?.addEventListener("click", (e) => {
    if (e.target.id === "card-modal-backdrop") {
      e.target.classList.add("hidden");
    }
  });
}
