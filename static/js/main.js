import { registerActions } from "./core/actions.js";
import {
  apiFetch,
  bindAuthAndShutdownEvents,
  configureRuntimeEnvironmentUI,
  updateFirebaseAuthUI,
} from "./core/api.js";
import { bindCurrencyEvents, updateCurrencyUI } from "./core/currency.js";
import { runtime, state } from "./core/state.js";
import { bindThemeEvents, initTheme } from "./core/theme.js";
import { bindCardModalEvents, openCardModal } from "./components/card-modal.js";
import { loadAudit, bindAuditEvents } from "./views/audit.js";
import {
  bindCatalogEvents,
  loadCards,
  renderCards,
  replaceSingleCardInDom,
  setupInfiniteObserver,
  updateResultsCountLabel,
  updateScrollModeUI,
} from "./views/catalog.js";
import {
  bindCollectionEvents,
  jumpToCatalogForAdding,
  loadCollectionCards,
  loadEditions,
  loadEditionsAndCollection,
  renderCollectionBalance,
  renderCollectionCards,
  renderEditionsGrid,
  replaceSingleCardInCollectionDom,
} from "./views/collection.js";
import {
  addMissingCardsToWishlistForDeck,
  bindDecksEvents,
  loadDecks,
  renderDecksList,
  syncEditingDeckOwnedCount,
} from "./views/decks/index.js";
import { renderDeckPreview } from "./views/decks/preview.js";
import {
  bindDeckStudioEvents,
  renderDeckBrowserGrid,
  renderDeckPanel,
  renderDeckStatsModal,
  setDeckSubView,
  updateDeckDirtyBadge,
} from "./views/decks/studio.js";
import { loadKpis, renderKpis } from "./views/kpis.js";
import { bindTradingEvents, loadTrades, openTradeEditor, renderTradeEditorLiveVerdict, renderTradeEditorSideItems, renderTradesList, renderTradesSummary } from "./views/trading.js";
import { bindWishlistPdfEvents, openWishlistPdfModal } from "./views/wishlist-pdf.js";

function switchView(viewName) {
  state.activeView = viewName;
  document.querySelectorAll(".view-section").forEach((sec) => {
    sec.classList.toggle("active", sec.id === `view-${viewName}`);
  });
  document.querySelectorAll("[data-view]").forEach((btn) => {
    btn.classList.toggle("active", btn.getAttribute("data-view") === viewName);
  });

  if (viewName === "collection") {
    loadEditionsAndCollection();
  } else if (viewName === "decks") {
    loadDecks();
  } else if (viewName === "trading") {
    loadTrades();
  } else if (viewName === "audit") {
    loadAudit();
  }
}

function rerenderCurrencyViews({ skipKpis = false } = {}) {
  if (!skipKpis && state.kpis) renderKpis(state.kpis);
  if (state.activeView === "collection") {
    renderCollectionBalance(state.kpis, state.editions);
    renderEditionsGrid(state.editions);
    if (state.collectionView.pageData) renderCollectionCards(state.collectionView.pageData);
  }
  if (state.activeView === "decks") {
    renderDecksList(state.decks);
    if (state.previewDeck && !document.getElementById("deck-preview-view")?.classList.contains("hidden")) {
      renderDeckPreview(state.previewDeck);
    }
    if (state.editingDeck && !document.getElementById("deck-builder-studio")?.classList.contains("hidden")) {
      renderDeckPanel();
      if (state.deckBuilder.browserPage) renderDeckBrowserGrid(state.deckBuilder.browserPage);
      if (!document.getElementById("deck-stats-modal")?.classList.contains("hidden")) renderDeckStatsModal();
    }
  }
  if (state.activeView === "trading") {
    renderTradesSummary(state.trading.summary);
    renderTradesList();
  }
  if (!document.getElementById("trade-editor-modal")?.classList.contains("hidden")) {
    renderTradeEditorSideItems("out");
    renderTradeEditorSideItems("in");
    renderTradeEditorLiveVerdict();
  }
  if (state.cardsPage) renderCards(state.cardsPage);
}

registerActions({
  updateDeckDirtyBadge,
  onCurrencyUpdated: rerenderCurrencyViews,
  loadKpis,
  loadCards,
  renderCards,
  replaceSingleCardInDom,
  updateResultsCountLabel,
  updateScrollModeUI,
  loadEditions,
  loadCollectionCards,
  renderCollectionBalance,
  replaceSingleCardInCollectionDom,
  jumpToCatalogForAdding,
  openCardModal,
  openWishlistPdfModal,
  openTradeEditor,
  syncEditingDeckOwnedCount,
  loadDecks,
  setDeckSubView,
  addMissingCardsToWishlistForDeck,
  switchView,
});

function bindGlobalEvents() {
  bindThemeEvents();
  bindCurrencyEvents();
  bindAuthAndShutdownEvents();
  bindCardModalEvents();
  bindCatalogEvents();
  bindCollectionEvents();
  bindWishlistPdfEvents();
  bindDeckStudioEvents();
  bindDecksEvents();
  bindTradingEvents();
  bindAuditEvents();

  document.querySelectorAll("[data-view]").forEach((btn) => {
    btn.addEventListener("click", () => switchView(btn.getAttribute("data-view")));
  });

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    [
      "card-modal-backdrop",
      "exchange-rate-modal",
      "shutdown-modal",
      "signout-modal",
      "deck-stats-modal",
      "deck-import-modal",
      "trade-editor-modal",
      "trade-delete-modal",
      "wishlist-pdf-modal",
    ].forEach((id) => {
      document.getElementById(id)?.classList.add("hidden");
    });
  });

  const scrollTopBtn = document.getElementById("scroll-top-btn");
  if (scrollTopBtn) {
    const syncScrollTopVisibility = () => {
      if (window.scrollY > 300) {
        scrollTopBtn.classList.remove("hidden");
      } else {
        scrollTopBtn.classList.add("hidden");
      }
    };
    window.addEventListener("scroll", syncScrollTopVisibility, { passive: true });
    scrollTopBtn.addEventListener("click", () => {
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
    syncScrollTopVisibility();
  }
}

let cloudRefreshTimer = null;

async function init() {
  initTheme();
  if (window.HololiveCloudBackend) {
    await window.HololiveCloudBackend.initPromise;
  }
  configureRuntimeEnvironmentUI();
  window.onFirebaseAuthChanged = (user) => {
    updateFirebaseAuthUI(user);
  };
  window.onCloudDataChanged = () => {
    if (!window.HololiveCloudBackend?.isCloudMode()) return;
    clearTimeout(cloudRefreshTimer);
    cloudRefreshTimer = setTimeout(() => {
      loadKpis();
      loadEditions();
      if (state.activeView === "catalog" && Date.now() >= runtime.suppressCloudCardsReloadUntil) loadCards();
      if (state.activeView === "collection" && Date.now() >= runtime.suppressCloudCardsReloadUntil) {
        loadCollectionCards();
      }
      if (state.activeView === "decks") {
        loadDecks();
        if (state.previewDeck && !document.getElementById("deck-preview-view")?.classList.contains("hidden")) {
          apiFetch(`/api/decks/${encodeURIComponent(state.previewDeck.id)}`)
            .then((fresh) => {
              state.previewDeck = fresh;
              renderDeckPreview(fresh);
            })
            .catch(() => {});
        }
        if (state.editingDeck && !document.getElementById("deck-builder-studio")?.classList.contains("hidden")) {
          renderDeckPanel();
          if (state.deckBuilder.browserPage) renderDeckBrowserGrid(state.deckBuilder.browserPage);
        }
      }
      if (state.activeView === "trading") {
        loadTrades();
      }
    }, 120);
  };
  updateCurrencyUI();
  bindGlobalEvents();
  setupInfiniteObserver();
  updateScrollModeUI();
  await Promise.all([loadKpis(), loadEditions(), loadCards()]);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
