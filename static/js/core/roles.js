import { actions } from "./actions.js";
import { state } from "./state.js";

export const ROLES = Object.freeze({
  ADMIN: "admin",
  USER: "user",
  GUEST: "guest",
});

export const ADMIN_EMAILS = Object.freeze(["sebastianberr@gmail.com"]);

export const VIEW_PERMISSIONS = Object.freeze({
  catalog: null,
  collection: null,
  decks: null,
  trading: null,
  audit: "audit:access",
});

const ROLE_PERMISSIONS = Object.freeze({
  [ROLES.ADMIN]: new Set(["audit:access", "audit:resync"]),
  [ROLES.USER]: new Set(),
  [ROLES.GUEST]: new Set(),
});

export function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

export function isAdminEmail(user) {
  return Boolean(
    user &&
      user.emailVerified === true &&
      ADMIN_EMAILS.includes(normalizeEmail(user.email))
  );
}

export function resolveUserRole(user, { isCloudMode = false } = {}) {
  if (user) {
    return isAdminEmail(user) ? ROLES.ADMIN : ROLES.USER;
  }
  return isCloudMode ? ROLES.GUEST : ROLES.ADMIN;
}

export function getCurrentRole() {
  return state.auth?.role || ROLES.GUEST;
}

export function isAdmin(role = getCurrentRole()) {
  return role === ROLES.ADMIN;
}

export function hasPermission(permission, role = getCurrentRole()) {
  if (!permission) return true;
  const perms = ROLE_PERMISSIONS[role];
  return Boolean(perms && perms.has(permission));
}

export function canAccessView(viewName, role = getCurrentRole()) {
  const perm = VIEW_PERMISSIONS[viewName] ?? null;
  return hasPermission(perm, role);
}

export function getRoleLabel(role = getCurrentRole()) {
  if (role === ROLES.ADMIN) return "Admin";
  if (role === ROLES.USER) return "Usuario";
  return "Invitado";
}

export function applyRoleAccessUI(role = getCurrentRole()) {
  if (typeof document === "undefined") return;
  document.querySelectorAll("[data-requires-permission]").forEach((el) => {
    const perm = el.getAttribute("data-requires-permission");
    const allowed = hasPermission(perm, role);
    el.classList.toggle("hidden", !allowed);
  });

  if (!canAccessView(state.activeView, role)) {
    actions.clearAuditView?.();
    actions.switchView?.("catalog");
  }
}

export function syncAuthState(user) {
  const isCloudMode = Boolean(
    typeof window !== "undefined" && window.HololiveCloudBackend?.isCloudMode()
  );
  const role = resolveUserRole(user, { isCloudMode });
  state.auth = {
    user: user || null,
    role,
    isAdmin: role === ROLES.ADMIN,
  };
  applyRoleAccessUI(role);
  return state.auth;
}
