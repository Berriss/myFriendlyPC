import { actions } from "../core/actions.js";
import { apiFetch, showSnackbar } from "../core/api.js";
import { HIGH_RARITIES } from "../core/constants.js";
import {
  cardMatchesOwnershipFilter,
  escapeHtml,
  fmtMoney,
  isCardFoil,
  wishHeartSvg,
} from "../core/formatters.js";
import { runtime, state } from "../core/state.js";

export function renderCardTile(c) {
  const isOwned = c.totalOwned > 0;
  const isHigh = HIGH_RARITIES.has(c.rarity);
  const isFoil = isCardFoil(c);
  const displayPrice = c.marketPrice ?? c.foilMarketPrice;
  const subPrice = c.lowPrice !== null && c.lowPrice !== undefined ? `Low ${fmtMoney(c.lowPrice)}` : "";
  const statTag = c.hp ? `HP ${c.hp}` : c.life ? `Life ${c.life}` : "";

  return `
    <article class="card-tile ${isOwned ? "is-owned" : ""} ${c.isWishlist ? "is-wishlisted" : ""}" data-pid="${c.productId}">
      <div class="card-art-wrap" data-open-detail="${c.productId}">
        ${
          c.imageUrl
            ? `<img src="${escapeHtml(c.imageUrl)}" alt="${escapeHtml(c.name)}" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.classList.remove('hidden');" />
               <div class="art-fallback hidden">${escapeHtml(c.name)}</div>`
            : `<div class="art-fallback">${escapeHtml(c.name)}</div>`
        }
        <div class="badge-top-left">
          ${c.rarity ? `<span class="pill-tag ${isHigh ? "rarity-high" : ""}">${escapeHtml(c.rarity)}</span>` : ""}
          ${isFoil ? `<span class="pill-tag foil-tier" title="Rareza con acabado Foil">✦ Foil</span>` : ""}
          ${isOwned ? `<span class="pill-tag owned-pill">x${c.totalOwned}</span>` : ""}
          ${c.isWishlist ? `<span class="pill-tag wish-pill" title="En Wishlist">♥ Wish</span>` : ""}
        </div>
        <div class="badge-top-right">
          <button class="mini-icon-btn ${c.isFavorite ? "fav-active" : ""}" data-toggle-fav="${c.productId}" title="${c.isFavorite ? "Quitar de favoritas" : "Marcar como favorita"}" aria-label="Favorita" type="button">★</button>
        </div>
      </div>
      <div class="card-body">
        <button class="card-title-btn" data-open-detail="${c.productId}" type="button">${escapeHtml(c.name)}</button>
        <div class="card-sub-meta">
          <span>${escapeHtml(c.cardNumber || "S/N")}</span>
          <span class="truncate" title="${escapeHtml(c.editionName)}">${escapeHtml(c.editionAbbr || c.editionName)}</span>
        </div>
        <div class="card-attr-chips">
          ${c.color ? `<span class="attr-chip">${escapeHtml(c.color)}</span>` : ""}
          ${c.cardType ? `<span class="attr-chip">${escapeHtml(c.cardType)}</span>` : ""}
          ${c.bloomLevel ? `<span class="attr-chip">${escapeHtml(c.bloomLevel)}</span>` : ""}
          ${statTag ? `<span class="attr-chip">${escapeHtml(statTag)}</span>` : ""}
        </div>
        <div class="card-price-row">
          <span class="price-main">${fmtMoney(displayPrice)}</span>
          <span class="price-sub">${escapeHtml(subPrice)}</span>
        </div>
        <div class="collection-steppers">
          <div class="stepper-box ${isOwned ? "owned-active" : ""}">
            <span class="stepper-label">En colección</span>
            <div class="stepper-controls">
              <button class="step-btn" data-adjust="${c.productId}" data-delta="-1" type="button" aria-label="Restar copia">−</button>
              <span class="step-qty" data-qty-total="${c.productId}">${c.totalOwned}</span>
              <button class="step-btn plus" data-adjust="${c.productId}" data-delta="1" type="button" aria-label="Sumar copia">+</button>
            </div>
          </div>
          <button class="wish-toggle-btn ${c.isWishlist ? "is-wishlisted" : ""}" data-toggle-wish="${c.productId}" type="button" aria-pressed="${c.isWishlist ? "true" : "false"}" title="${c.isWishlist ? "Quitar de Wishlist" : "Agregar a Wishlist"}">
            ${wishHeartSvg(c.isWishlist)}
            <span>${c.isWishlist ? "En Wishlist" : "+ Wishlist"}</span>
          </button>
        </div>
      </div>
    </article>`;
}

export function renderCardTableRow(c) {
  const isOwned = c.totalOwned > 0;
  const isFoil = isCardFoil(c);
  const price = c.marketPrice ?? c.foilMarketPrice;
  return `
    <tr class="${isOwned ? "is-owned" : ""} ${c.isWishlist ? "is-wishlisted" : ""}" data-pid="${c.productId}">
      <td><button class="card-title-btn" data-open-detail="${c.productId}" type="button">${escapeHtml(c.name)}</button></td>
      <td>${escapeHtml(c.cardNumber || "—")}</td>
      <td>${escapeHtml(c.editionAbbr || c.editionName)}</td>
      <td>${escapeHtml(c.rarity || "—")} ${isFoil ? `<span class="attr-chip">✦ Foil</span>` : ""}</td>
      <td>${escapeHtml(c.color || "—")}</td>
      <td>${escapeHtml(c.cardType || "—")}</td>
      <td><strong>${fmtMoney(price)}</strong></td>
      <td>
        <div class="stepper-controls">
          <button class="step-btn" data-adjust="${c.productId}" data-delta="-1" type="button">−</button>
          <span class="step-qty">${c.totalOwned}</span>
          <button class="step-btn plus" data-adjust="${c.productId}" data-delta="1" type="button">+</button>
        </div>
      </td>
      <td>
        <button class="wish-toggle-btn wish-toggle-compact ${c.isWishlist ? "is-wishlisted" : ""}" data-toggle-wish="${c.productId}" type="button" aria-pressed="${c.isWishlist ? "true" : "false"}" title="${c.isWishlist ? "Quitar de Wishlist" : "Agregar a Wishlist"}">
          ${wishHeartSvg(c.isWishlist)}
          <span>${c.isWishlist ? "En Wishlist" : "+ Wishlist"}</span>
        </button>
      </td>
    </tr>`;
}

export function renderCardsTable(items) {
  const rows = items.map(renderCardTableRow).join("");

  return `
    <table class="cards-table">
      <thead>
        <tr>
          <th>Carta</th>
          <th>Código</th>
          <th>Edición</th>
          <th>Rareza</th>
          <th>Color</th>
          <th>Tipo</th>
          <th>Market</th>
          <th>Cantidad</th>
          <th>Wishlist</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

export function renderPagination(targetId, page, totalPages, onPageChange) {
  const el = document.getElementById(targetId);
  if (!el) return;
  if (onPageChange && totalPages <= 1) {
    el.innerHTML = "";
    return;
  }
  el.innerHTML = `
    <button class="page-btn" ${page <= 1 ? "disabled" : ""} data-page="${page - 1}" type="button">← Anterior</button>
    <span class="page-info">Página ${page} / ${totalPages}</span>
    <button class="page-btn" ${page >= totalPages ? "disabled" : ""} data-page="${page + 1}" type="button">Siguiente →</button>
  `;
  el.querySelectorAll("[data-page]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const nextPage = Number(btn.getAttribute("data-page"));
      if (nextPage >= 1 && nextPage <= totalPages) {
        if (onPageChange) {
          onPageChange(nextPage);
        } else {
          state.filters.page = nextPage;
          actions.loadCards?.();
          window.scrollTo({ top: 0, behavior: "smooth" });
        }
      }
    });
  });
}

export function bindCardInteractions(container) {
  container.querySelectorAll("[data-open-detail]").forEach((el) => {
    el.addEventListener("click", () => {
      actions.openCardModal?.(Number(el.getAttribute("data-open-detail")));
    });
  });

  container.querySelectorAll("[data-adjust]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const pid = Number(btn.getAttribute("data-adjust"));
      const delta = Number(btn.getAttribute("data-delta"));
      await quickAdjustCard(pid, { delta });
    });
  });

  container.querySelectorAll("[data-toggle-fav]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const pid = Number(btn.getAttribute("data-toggle-fav"));
      await quickAdjustCard(pid, { toggleFavorite: true });
    });
  });

  container.querySelectorAll("[data-toggle-wish]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const pid = Number(btn.getAttribute("data-toggle-wish"));
      await quickAdjustCard(pid, { toggleWishlist: true });
    });
  });
}

export async function quickAdjustCard(productId, payload) {
  if (runtime.pendingAdjustments.has(productId)) return null;
  runtime.pendingAdjustments.add(productId);
  runtime.suppressCloudCardsReloadUntil = Date.now() + 700;
  try {
    const updated = await apiFetch(`/api/collection/${productId}/adjust`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    });

    if (state.cardsPage && state.cardsPage.items) {
      const idx = state.cardsPage.items.findIndex((x) => x.productId === productId);
      const stillMatches = cardMatchesOwnershipFilter(updated, state.filters.ownership);
      if (stillMatches) {
        if (idx >= 0) {
          state.cardsPage.items[idx] = updated;
        }
        actions.replaceSingleCardInDom?.(updated);
      } else if (state.scrollMode === "infinite") {
        if (idx >= 0) {
          state.cardsPage.items.splice(idx, 1);
        }
        state.cardsPage.total = Math.max(0, (state.cardsPage.total || 0) - 1);
        document.querySelector(`#cards-container [data-pid="${productId}"]`)?.remove();
        if (!state.cardsPage.items.length) {
          actions.renderCards?.(state.cardsPage);
        } else {
          actions.updateResultsCountLabel?.();
          actions.updateScrollModeUI?.();
        }
      } else {
        await actions.loadCards?.();
      }
    }

    if (state.activeView === "collection") {
      const cvItems = state.collectionView.pageData?.items || [];
      const cIdx = cvItems.findIndex((x) => x.productId === productId);
      const stillMatchesCol = cardMatchesOwnershipFilter(updated, state.collectionView.scope);
      if (cIdx >= 0 && stillMatchesCol) {
        cvItems[cIdx] = updated;
        actions.replaceSingleCardInCollectionDom?.(updated);
      } else {
        await actions.loadCollectionCards?.();
      }
    }

    await Promise.all([actions.loadKpis?.(), actions.loadEditions?.()]);
    actions.syncEditingDeckOwnedCount?.(productId, updated.totalOwned);
    if (payload.toggleWishlist) {
      showSnackbar(
        updated.isWishlist
          ? `♥ ${updated.name} agregada a Wishlist`
          : `${updated.name} quitada de Wishlist`
      );
    } else if (payload.toggleFavorite) {
      showSnackbar(
        updated.isFavorite
          ? `★ ${updated.name} marcada como favorita`
          : `${updated.name} quitada de favoritas`
      );
    } else {
      showSnackbar(`${updated.name}: ${updated.totalOwned} en colección`);
    }
    return updated;
  } catch (err) {
    showSnackbar(`Error al actualizar: ${err.message}`);
    return null;
  } finally {
    runtime.pendingAdjustments.delete(productId);
  }
}
