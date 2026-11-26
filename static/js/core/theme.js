import { showSnackbar } from "./api.js";

export function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem("hocg-theme", theme);
}

export function initTheme() {
  const saved = localStorage.getItem("hocg-theme");
  const prefersDark =
    window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  const theme = saved || (prefersDark ? "dark" : "light");
  applyTheme(theme);
}

export function toggleTheme() {
  const current = document.documentElement.getAttribute("data-theme") || "light";
  const next = current === "dark" ? "light" : "dark";
  applyTheme(next);
  showSnackbar(next === "dark" ? "Modo nocturno activado" : "Modo claro activado");
}

export function bindThemeEvents() {
  document.getElementById("theme-toggle-top")?.addEventListener("click", toggleTheme);
  document.getElementById("theme-toggle-rail")?.addEventListener("click", toggleTheme);
}
