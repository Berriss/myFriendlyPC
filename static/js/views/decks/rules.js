import { getDeckGroupCategory } from "../../core/formatters.js";

export { getDeckGroupCategory };

export function isUnlimitedCopyCard(card) {
  if (!card) return false;
  if (card.cardType === "Cheer" || card.zone === "cheer") return true;
  return /you may include any number/i.test(String(card.effectText || ""));
}

export function getDeckCardNumberCount(deck, cardNumber, productId, zone) {
  if (!deck || !Array.isArray(deck.cards)) return 0;
  const targetNum = String(cardNumber || "").trim();
  let total = 0;
  for (const item of deck.cards) {
    if ((item.zone || "main") !== zone) continue;
    const itemNum = String(item.cardNumber || "").trim();
    if (targetNum && itemNum) {
      if (itemNum === targetNum) total += Number(item.quantity || 0);
    } else if (Number(item.productId) === Number(productId)) {
      total += Number(item.quantity || 0);
    }
  }
  return total;
}

export function evaluateDeckRules(deck) {
  const cards = Array.isArray(deck?.cards) ? deck.cards : [];
  const hasOshi = Boolean(deck?.oshiProductId);
  const oshi = deck?.oshiCard || null;

  let mainCount = 0;
  let cheerCount = 0;
  const sameNumberMain = new Map();
  const sameNumberLabel = new Map();
  const sameNumberUnlimited = new Map();

  const bloomCounts = { Debut: 0, "1st": 0, Buzz: 0, "2nd": 0, Spot: 0, Otro: 0 };
  const typeCounts = { Holomem: 0, "Buzz Holomem": 0, Support: 0, LIMITED: 0, Cheer: 0 };
  const colorCounts = {
    White: 0, Green: 0, Red: 0, Blue: 0, Purple: 0, Yellow: 0, Colorless: 0, "Multi-color": 0,
  };

  let totalRequiredCopies = hasOshi ? 1 : 0;
  let ownedCopies = 0;
  let totalCostUsd = 0;
  let missingCostUsd = 0;
  const missingCards = [];

  if (hasOshi) {
    const oPrice = Number(oshi?.marketPrice || 0);
    const oHave = Number(oshi?.ownedQuantity || 0);
    totalCostUsd += oPrice;
    if (oHave > 0) {
      ownedCopies += 1;
    } else {
      missingCostUsd += oPrice;
      missingCards.push({
        productId: deck.oshiProductId,
        name: oshi?.name || `Oshi #${deck.oshiProductId}`,
        missingQty: 1,
      });
    }
  }

  for (const item of cards) {
    const qty = Math.max(0, Number(item.quantity || 0));
    if (qty === 0) continue;
    const zone = item.zone === "cheer" ? "cheer" : "main";
    const unlimited = isUnlimitedCopyCard(item);
    const key = String(item.cardNumber || "").trim() || `pid:${item.productId}`;

    if (zone === "cheer") {
      cheerCount += qty;
      typeCounts.Cheer += qty;
    } else {
      mainCount += qty;
      sameNumberMain.set(key, (sameNumberMain.get(key) || 0) + qty);
      sameNumberLabel.set(key, item.name || key);
      if (unlimited) sameNumberUnlimited.set(key, true);

      if (item.cardType === "Buzz Holomem") {
        typeCounts["Buzz Holomem"] += qty;
        bloomCounts.Buzz += qty;
      } else if (item.cardType === "Support") {
        typeCounts.Support += qty;
        if (String(item.effectText || "").includes("LIMITED")) {
          typeCounts.LIMITED += qty;
        }
      } else {
        typeCounts.Holomem += qty;
        const bl = item.bloomLevel || "";
        if (bl === "Debut" || bl === "1st" || bl === "2nd" || bl === "Spot") {
          bloomCounts[bl] += qty;
        } else {
          bloomCounts.Otro += qty;
        }
      }
    }

    const rawColor = String(item.color || "").trim();
    if (!rawColor || rawColor === "Colorless") {
      colorCounts.Colorless += qty;
    } else if (rawColor.includes("/")) {
      colorCounts["Multi-color"] += qty;
    } else if (Object.prototype.hasOwnProperty.call(colorCounts, rawColor)) {
      colorCounts[rawColor] += qty;
    } else {
      colorCounts.Colorless += qty;
    }

    const price = Number(item.marketPrice || 0);
    const have = Number(item.ownedQuantity || 0);
    totalRequiredCopies += qty;
    ownedCopies += Math.min(qty, have);
    totalCostUsd += qty * price;
    if (have < qty) {
      const shortfall = qty - have;
      missingCostUsd += shortfall * price;
      missingCards.push({
        productId: item.productId,
        name: item.name,
        missingQty: shortfall,
      });
    }
  }

  const violations = [];
  const hints = [];

  if (mainCount > 50) violations.push(`Main Deck excede 50 cartas (${mainCount}/50).`);
  if (cheerCount > 20) violations.push(`Cheer Deck excede 20 cartas (${cheerCount}/20).`);
  for (const [key, count] of sameNumberMain.entries()) {
    if (count > 4 && !sameNumberUnlimited.get(key)) {
      violations.push(`${sameNumberLabel.get(key)} (${key}) supera el límite de 4 copias (${count}/4).`);
    }
  }

  if (!hasOshi) hints.push("Falta elegir 1 carta Oshi Holomem.");
  if (mainCount < 50) hints.push(`Faltan ${50 - mainCount} carta(s) en el Main Deck (${mainCount}/50).`);
  if (cheerCount < 20) hints.push(`Faltan ${20 - cheerCount} carta(s) en el Cheer Deck (${cheerCount}/20).`);

  const isLegal = hasOshi && mainCount === 50 && cheerCount === 20 && violations.length === 0;
  const coveragePct = totalRequiredCopies > 0 ? (ownedCopies / totalRequiredCopies) * 100 : 0;

  return {
    hasOshi,
    mainCount,
    cheerCount,
    totalCount: (hasOshi ? 1 : 0) + mainCount + cheerCount,
    isLegal,
    violations,
    hints,
    bloomCounts,
    typeCounts,
    colorCounts,
    totalRequiredCopies,
    ownedCopies,
    coveragePct,
    totalCostUsd,
    missingCostUsd,
    missingCards,
  };
}

export function groupDeckCards(cards) {
  const defs = [
    { id: "debut", label: "Debut Holomem" },
    { id: "1st", label: "1st & Buzz Holomem" },
    { id: "2nd", label: "2nd Holomem" },
    { id: "spot", label: "Spot Holomem" },
    { id: "other", label: "Otros Holomem / Promo" },
    { id: "support", label: "Support (Item / Event / Tool / LIMITED)" },
    { id: "cheer", label: "Cheer Deck" },
  ];
  const buckets = new Map(defs.map((d) => [d.id, []]));
  for (const item of cards || []) {
    const gid = getDeckGroupCategory(item);
    buckets.get(gid).push(item);
  }
  return defs
    .map((d) => {
      const items = buckets.get(d.id).slice().sort((a, b) => {
        return String(a.cardNumber || "").localeCompare(String(b.cardNumber || "")) ||
          String(a.name || "").localeCompare(String(b.name || ""));
      });
      const count = items.reduce((acc, x) => acc + Number(x.quantity || 0), 0);
      return { ...d, items, count };
    })
    .filter((g) => g.items.length > 0);
}
