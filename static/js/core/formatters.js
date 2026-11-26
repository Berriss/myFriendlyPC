import { FOIL_RARITIES } from "./constants.js";
import { state } from "./state.js";

export function isCardFoil(card) {
  if (!card || card.itemCategory === "sealed") return false;
  if (FOIL_RARITIES.has(card.rarity)) return true;
  return card.rarity === "P" && String(card.priceSubtype || "").toLowerCase() === "foil";
}

export function getRarityTierLabel(card) {
  switch (card.rarity) {
    case "SEC":
      return "Secret Rare — Foil con firma estampada";
    case "OUR":
      return "Oshi Ultra Rare — Foil Full-Art";
    case "UR":
      return "Ultra Rare — Foil Full-Art / Alt-Art";
    case "SR":
      return "Super Rare — Foil sin bordes";
    case "S":
      return "Special — Paralela Foil de C/U";
    case "SY":
      return "Special Yell — Cheer Foil Alt-Art";
    case "HR":
      return "Holomem Rare — Foil Especial";
    case "OSR":
      return "Oshi Super Rare — Foil Estándar";
    case "RR":
      return "Double Rare — Foil Estándar";
    case "R":
      return "Rare — Foil Estándar";
    case "P":
      return isCardFoil(card) ? "Promo — Acabado Foil" : "Promo";
    case "C":
    case "U":
    case "OC":
      return "Rareza Base — No-Foil";
    default:
      return card.itemCategory === "sealed" ? "Producto Sellado" : "Estándar";
  }
}

export function wishHeartSvg(filled) {
  if (filled) {
    return `<svg viewBox="0 0 24 24" class="wish-icon" aria-hidden="true"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>`;
  }
  return `<svg viewBox="0 0 24 24" class="wish-icon" aria-hidden="true"><path d="M16.5 3c-1.74 0-3.41.81-4.5 2.09C10.91 3.81 9.24 3 7.5 3 4.42 3 2 5.42 2 8.5c0 3.78 3.4 6.86 8.55 11.54L12 21.35l1.45-1.32C18.6 15.36 22 12.28 22 8.5 22 5.42 19.58 3 16.5 3zm-4.4 15.55l-.1.1-.1-.1C7.14 14.24 4 11.39 4 8.5 4 6.5 5.5 5 7.5 5c1.54 0 3.04.99 3.57 2.36h1.87C13.46 5.99 14.96 5 16.5 5c2 0 3.5 1.5 3.5 3.5 0 2.89-3.14 5.74-7.9 10.05z"/></svg>`;
}

export function cardMatchesOwnershipFilter(card, ownership) {
  if (ownership === "owned") return card.totalOwned > 0;
  if (ownership === "missing") return card.totalOwned <= 0;
  if (ownership === "favorite") return Boolean(card.isFavorite);
  if (ownership === "wishlist") return Boolean(card.isWishlist);
  return true;
}

export function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function fmtUsd(val) {
  if (val === null || val === undefined || Number.isNaN(Number(val))) return "—";
  return "$" + Number(val).toFixed(2);
}

export function fmtClp(usdVal) {
  if (usdVal === null || usdVal === undefined || Number.isNaN(Number(usdVal))) return "—";
  const rate = Number(state.exchangeRate?.rateClpPerUsd || 1);
  const clp = Math.round(Number(usdVal) * rate);
  return "$" + clp.toLocaleString("es-CL") + " CLP";
}

export function fmtMoney(usdVal) {
  return state.currency === "CLP" ? fmtClp(usdVal) : fmtUsd(usdVal);
}

export function getDeckGroupCategory(item) {
  if (item.zone === "cheer") return "cheer";
  if (item.cardType === "Support") return "support";
  if (item.cardType === "Buzz Holomem") return "1st";
  if (item.bloomLevel === "Debut") return "debut";
  if (item.bloomLevel === "1st") return "1st";
  if (item.bloomLevel === "2nd") return "2nd";
  if (item.bloomLevel === "Spot") return "spot";
  return "other";
}

export function downloadJsonFile(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
