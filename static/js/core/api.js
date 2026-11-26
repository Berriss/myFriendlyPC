import { actions } from "./actions.js";

let snackbarTimer = null;

export function showSnackbar(msg) {
  const el = document.getElementById("snackbar");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(snackbarTimer);
  snackbarTimer = setTimeout(() => {
    el.classList.add("hidden");
  }, 3000);
}

export async function apiFetch(url, options = {}) {
  if (window.HololiveCloudBackend && window.HololiveCloudBackend.isCloudMode()) {
    return window.HololiveCloudBackend.handleRequest(url, options);
  }
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  if (!res.ok) {
    let msg = `Error HTTP ${res.status}`;
    try {
      const err = await res.json();
      if (err && err.error) msg = err.error;
    } catch (_) {}
    throw new Error(msg);
  }
  return res.json();
}

export async function triggerGoogleSignIn() {
  const cloud = window.HololiveCloudBackend;
  if (!cloud) return;
  try {
    const signedIn = await cloud.signInWithGoogle();
    if (signedIn) showSnackbar(`Conectado como ${signedIn.displayName || signedIn.email}`);
  } catch (err) {
    showSnackbar(`Error al iniciar sesión: ${err.message}`);
  }
}

export function updateFirebaseAuthUI(user) {
  const authBtn = document.getElementById("firebase-auth-btn");
  const authLabel = document.getElementById("firebase-auth-label");
  const isCloud = Boolean(window.HololiveCloudBackend?.isCloudMode());

  if (authBtn && authLabel) {
    if (user) {
      const name = user.displayName || user.email || "Cuenta Google";
      authBtn.classList.add("is-signed-in");
      authLabel.textContent = `☁ ${name}`;
      authBtn.title = `Conectado como ${name} (Click para ver cuenta o cerrar sesión)`;
    } else {
      authBtn.classList.remove("is-signed-in");
      authLabel.textContent = isCloud ? "Iniciar sesión con Google" : "☁ Sync Google";
      authBtn.title = isCloud
        ? "Inicia sesión con Google para guardar tu colección y mazos en Cloud Firestore"
        : "Conectar cuenta Google para respaldar colección y mazos en Cloud Firestore";
    }
  }

  updateDecksAuthStatus(user, isCloud);
  updateTradesAuthStatus(user, isCloud);
  actions.updateDeckDirtyBadge?.();
}

export function updateTradesAuthStatus(user, isCloud) {
  const banner = document.getElementById("trades-auth-banner");
  const bannerText = document.getElementById("trades-auth-banner-text");
  const signInBtn = document.getElementById("trades-signin-btn");
  if (!banner || !bannerText) return;
  if (user) {
    const label = user.email || user.displayName || "Cuenta Google";
    banner.classList.remove("hidden");
    banner.classList.add("is-synced");
    bannerText.textContent = isCloud
      ? `☁ Tu historial de Trading está sincronizado en Firebase Cloud Firestore (${label}).`
      : `☁ Cuenta Google conectada (${label}). Usa "☁ Sync Google" para respaldar tu historial.`;
    signInBtn?.classList.add("hidden");
  } else if (isCloud) {
    banner.classList.remove("hidden", "is-synced");
    bannerText.textContent =
      "Modo invitado local: inicia sesión con Google para respaldar tus compras, ventas e intercambios en Firebase.";
    signInBtn?.classList.remove("hidden");
  } else {
    banner.classList.add("hidden");
    banner.classList.remove("is-synced");
    signInBtn?.classList.add("hidden");
  }
}

export function updateDecksAuthStatus(user, isCloud) {
  const banner = document.getElementById("decks-auth-banner");
  const bannerText = document.getElementById("decks-auth-banner-text");
  const signInBtn = document.getElementById("decks-signin-btn");
  const nudge = document.getElementById("deck-panel-auth-nudge");

  if (banner && bannerText) {
    if (user) {
      const label = user.email || user.displayName || "Cuenta Google";
      banner.classList.remove("hidden");
      banner.classList.add("is-synced");
      bannerText.textContent = isCloud
        ? `☁ Tus mazos están sincronizados en Firebase Cloud Firestore (${label}).`
        : `☁ Cuenta Google conectada (${label}). Usa "☁ Sync Google" para respaldar mazos en la nube.`;
      signInBtn?.classList.add("hidden");
    } else if (isCloud) {
      banner.classList.remove("hidden", "is-synced");
      bannerText.textContent =
        "Modo invitado local: inicia sesión con Google para guardar y sincronizar tus mazos en Firebase.";
      signInBtn?.classList.remove("hidden");
    } else {
      banner.classList.add("hidden");
      banner.classList.remove("is-synced");
      signInBtn?.classList.add("hidden");
    }
  }

  if (nudge) {
    nudge.classList.toggle("hidden", !isCloud || Boolean(user));
  }
}

export function openSignOutModal(user) {
  if (!user) return;
  const modal = document.getElementById("signout-modal");
  const nameEl = document.getElementById("signout-account-name");
  const emailEl = document.getElementById("signout-account-email");
  const syncLocalBtn = document.getElementById("signout-sync-local-btn");
  const confirmBtn = document.getElementById("signout-confirm-btn");

  const name = user.displayName || user.email || "Cuenta Google";
  if (nameEl) nameEl.textContent = name;
  if (emailEl) {
    if (user.email && user.email !== user.displayName) {
      emailEl.textContent = user.email;
      emailEl.classList.remove("hidden");
    } else {
      emailEl.textContent = "";
      emailEl.classList.add("hidden");
    }
  }
  if (syncLocalBtn) {
    const isCloud = Boolean(window.HololiveCloudBackend?.isCloudMode());
    syncLocalBtn.classList.toggle("hidden", isCloud);
    syncLocalBtn.disabled = false;
    syncLocalBtn.textContent = "☁ Sincronizar ahora";
  }
  if (confirmBtn) {
    confirmBtn.disabled = false;
    confirmBtn.textContent = "Cerrar sesión";
  }
  modal?.classList.remove("hidden");
}

export function closeSignOutModal() {
  document.getElementById("signout-modal")?.classList.add("hidden");
}

export function configureRuntimeEnvironmentUI() {
  const isCloud = window.HololiveCloudBackend?.isCloudMode();
  const subtitle = document.getElementById("header-subtitle");
  const resyncBtn = document.getElementById("resync-db-btn");
  const auditSubtitle = document.getElementById("audit-subtitle");
  if (isCloud) {
    if (subtitle) {
      subtitle.textContent = "Tracker online · Firebase Hosting + Cloud Firestore · Datos TCGCSV";
    }
    if (resyncBtn) {
      resyncBtn.textContent = "↻ Actualizar catálogo desde Firebase";
    }
    if (auditSubtitle) {
      auditSubtitle.textContent =
        "Reporte del saneamiento TCGCSV y estado de sincronización automática diaria hacia Cloud Firestore.";
    }
    document.getElementById("shutdown-btn-rail")?.classList.add("hidden");
    document.getElementById("shutdown-btn-top")?.classList.add("hidden");
  }
  updateFirebaseAuthUI(window.HololiveCloudBackend?.getCurrentUser() || null);
}

export function bindAuthAndShutdownEvents() {
  document.getElementById("shutdown-btn-rail")?.addEventListener("click", () => {
    document.getElementById("shutdown-modal")?.classList.remove("hidden");
  });
  document.getElementById("shutdown-btn-top")?.addEventListener("click", () => {
    document.getElementById("shutdown-modal")?.classList.remove("hidden");
  });
  document.getElementById("shutdown-modal-close")?.addEventListener("click", () => {
    document.getElementById("shutdown-modal")?.classList.add("hidden");
  });
  document.getElementById("shutdown-cancel-btn")?.addEventListener("click", () => {
    document.getElementById("shutdown-modal")?.classList.add("hidden");
  });
  document.getElementById("shutdown-modal")?.addEventListener("click", (e) => {
    if (e.target.id === "shutdown-modal") e.target.classList.add("hidden");
  });
  document.getElementById("shutdown-confirm-btn")?.addEventListener("click", async () => {
    const btn = document.getElementById("shutdown-confirm-btn");
    btn.disabled = true;
    btn.textContent = "Apagando...";
    try {
      await apiFetch("/api/shutdown", { method: "POST" });
    } catch (_) {
      // Server closes immediately after acknowledging shutdown
    }
    document.getElementById("shutdown-modal").classList.add("hidden");
    document.getElementById("shutdown-screen").classList.remove("hidden");
  });

  document.getElementById("firebase-auth-btn")?.addEventListener("click", async () => {
    const cloud = window.HololiveCloudBackend;
    if (!cloud) return;
    const user = cloud.getCurrentUser();
    if (user) {
      openSignOutModal(user);
    } else {
      await triggerGoogleSignIn();
    }
  });

  document.getElementById("signout-modal-close")?.addEventListener("click", closeSignOutModal);
  document.getElementById("signout-cancel-btn")?.addEventListener("click", closeSignOutModal);
  document.getElementById("signout-modal")?.addEventListener("click", (e) => {
    if (e.target.id === "signout-modal") closeSignOutModal();
  });
  document.getElementById("signout-sync-local-btn")?.addEventListener("click", async () => {
    const cloud = window.HololiveCloudBackend;
    if (!cloud) return;
    const btn = document.getElementById("signout-sync-local-btn");
    btn.disabled = true;
    btn.textContent = "Sincronizando...";
    try {
      const exported = await apiFetch("/api/collection/export");
      const pushed = await cloud.pushLocalCollectionToFirestore(exported.entries || []);
      let pushedDecks = 0;
      if (typeof cloud.pushLocalDecksToFirestore === "function") {
        const deckSummaries = await apiFetch("/api/decks");
        const fullDecks = await Promise.all(
          (deckSummaries || []).map((d) => apiFetch(`/api/decks/${encodeURIComponent(d.id)}`))
        );
        pushedDecks = await cloud.pushLocalDecksToFirestore(fullDecks);
      }
      let pushedTrades = 0;
      if (typeof cloud.pushLocalTradesToFirestore === "function") {
        const tradesPayload = await apiFetch("/api/trades");
        pushedTrades = await cloud.pushLocalTradesToFirestore(tradesPayload?.items || []);
      }
      closeSignOutModal();
      showSnackbar(
        `Sincronizadas ${pushed} cartas, ${pushedDecks} mazos y ${pushedTrades} movs de Trading hacia Cloud Firestore`
      );
    } catch (err) {
      showSnackbar(`Error al sincronizar: ${err.message}`);
    } finally {
      btn.disabled = false;
      btn.textContent = "☁ Sincronizar ahora";
    }
  });
  document.getElementById("signout-confirm-btn")?.addEventListener("click", async () => {
    const cloud = window.HololiveCloudBackend;
    if (!cloud) return;
    const btn = document.getElementById("signout-confirm-btn");
    btn.disabled = true;
    btn.textContent = "Desconectando...";
    try {
      await cloud.signOutUser();
      closeSignOutModal();
      showSnackbar("Sesión de Google cerrada");
    } catch (err) {
      showSnackbar(`Error al cerrar sesión: ${err.message}`);
    } finally {
      btn.disabled = false;
      btn.textContent = "Cerrar sesión";
    }
  });
}
