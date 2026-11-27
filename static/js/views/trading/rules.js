import { fmtClp, fmtMoney, fmtUsd } from "../../core/formatters.js";
import { state } from "../../core/state.js";

export function round2Local(val) {
  const n = Number(val);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

export function fmtSignedMoney(usdVal) {
  const n = Number(usdVal || 0);
  const sign = n > 0.004 ? "+" : n < -0.004 ? "-" : "";
  return `${sign}${fmtMoney(Math.abs(n))}`;
}

export function fmtSignedAltMoney(usdVal) {
  const n = Number(usdVal || 0);
  const sign = n > 0.004 ? "+" : n < -0.004 ? "-" : "";
  return state.currency === "CLP"
    ? `${sign}${fmtUsd(Math.abs(n))} USD`
    : `${sign}${fmtClp(Math.abs(n))}`;
}

export function classifyTradeVerdictLocal(balanceUsd, roiPct) {
  if (Math.abs(balanceUsd) < 0.5 && Math.abs(roiPct) < 5.0) return "fair";
  if (balanceUsd > 0 && (roiPct >= 5.0 || balanceUsd >= 5.0)) return "worth";
  if (balanceUsd < 0 && (roiPct <= -5.0 || balanceUsd <= -5.0)) return "not_worth";
  return "fair";
}

export function getVerdictMeta(verdict) {
  if (verdict === "worth") return { label: "WORTH ✓", cls: "verdict-worth" };
  if (verdict === "not_worth") return { label: "No Worth ✕", cls: "verdict-not-worth" };
  return { label: "Parejo ≈", cls: "verdict-fair" };
}

export function getTradeTypeMeta(type) {
  if (type === "buy") return { label: "Compra", cls: "is-buy" };
  if (type === "sell") return { label: "Venta", cls: "is-sell" };
  return { label: "Intercambio", cls: "is-trade" };
}

export function toTradeEditorUsd(amountRaw, currencyInput, rate) {
  const num = Math.max(0, Number(amountRaw || 0));
  if (!Number.isFinite(num) || num <= 0) return { usd: 0, orig: 0 };
  if (currencyInput === "CLP") {
    return {
      usd: round2Local(num / Math.max(1, rate)),
      orig: Math.round(num),
    };
  }
  const r = round2Local(num);
  return { usd: r, orig: r };
}

export function makeEditorItemFromCard(c) {
  const mkt = round2Local(c.marketPrice ?? c.foilMarketPrice ?? 0);
  return {
    productId: Number(c.productId),
    quantity: 1,
    unitMarketUsd: mkt,
    unitCostUsd: null,
    condition: c.condition || "NM",
    name: c.name || `#${c.productId}`,
    cardNumber: c.cardNumber || "",
    editionAbbr: c.editionAbbr || c.editionName || "",
    rarity: c.rarity || "",
    imageUrl: c.imageUrl || "",
    currentMarketUsd: mkt,
    ownedQuantity: Number(c.totalOwned ?? c.ownedQuantity ?? 0),
    isWishlist: Boolean(c.isWishlist),
    wishlistTargetQty: Number(c.wishlistTargetQty || 1),
  };
}

export function computeTradeEditorVerdict(ed) {
  const showOut = ed.type === "sell" || ed.type === "trade";
  const showIn = ed.type === "buy" || ed.type === "trade";
  const showPaid = ed.type === "buy" || ed.type === "trade";
  const showRec = ed.type === "sell" || ed.type === "trade";

  const paid = showPaid ? toTradeEditorUsd(ed.cashPaidStr, ed.currencyInput, ed.exchangeRateUsed).usd : 0;
  const rec = showRec ? toTradeEditorUsd(ed.cashReceivedStr, ed.currencyInput, ed.exchangeRateUsed).usd : 0;
  const cardsInVal = showIn ? (ed.itemsIn || []).reduce((s, i) => s + Number(i.quantity || 0) * Number(i.unitMarketUsd || 0), 0) : 0;
  const cardsOutVal = showOut ? (ed.itemsOut || []).reduce((s, i) => s + Number(i.quantity || 0) * Number(i.unitMarketUsd || 0), 0) : 0;

  const inTotal = round2Local(cardsInVal + rec);
  const outTotal = round2Local(cardsOutVal + paid);
  const balance = round2Local(inTotal - outTotal);
  const roi = outTotal > 0 ? round2Local((balance / outTotal) * 100) : inTotal > 0 ? 100 : 0;
  const verdict = classifyTradeVerdictLocal(balance, roi);
  const vMeta = getVerdictMeta(verdict);

  const qtyInCount = showIn ? (ed.itemsIn || []).reduce((s, i) => s + Number(i.quantity || 0), 0) : 0;
  const qtyOutCount = showOut ? (ed.itemsOut || []).reduce((s, i) => s + Number(i.quantity || 0), 0) : 0;
  const wishHits = showIn
    ? (ed.itemsIn || []).filter(
        (i) => i.isWishlist && Number(i.ownedQuantity || 0) + Number(i.quantity || 0) >= Number(i.wishlistTargetQty || 1)
      ).length
    : 0;

  return {
    showOut,
    showIn,
    showPaid,
    showRec,
    paid,
    rec,
    cardsInVal: round2Local(cardsInVal),
    cardsOutVal: round2Local(cardsOutVal),
    inTotal,
    outTotal,
    balance,
    roi,
    verdict,
    vMeta,
    qtyInCount,
    qtyOutCount,
    wishHits,
  };
}
