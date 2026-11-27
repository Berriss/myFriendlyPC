import { CHEER_COLORS, DECK_COLOR_META } from "../../core/constants.js";
import { escapeHtml } from "../../core/formatters.js";

const MAIN_COLOR_ORDER = ["White", "Green", "Red", "Blue", "Purple", "Yellow", "Colorless"];

function gcd(a, b) {
  let x = Math.abs(Math.round(a));
  let y = Math.abs(Math.round(b));
  while (y !== 0) {
    const t = y;
    y = x % y;
    x = t;
  }
  return x || 1;
}

function formatCheerRatioSummary(activeRatios) {
  if (!activeRatios.length) return "Sin Cheers";
  if (activeRatios.length === 1) {
    const only = activeRatios[0];
    return `Monocolor · ${only.color} (100%)`;
  }
  const counts = activeRatios.map((r) => r.count);
  const divisor = counts.reduce((acc, val) => gcd(acc, val));
  const simplified = counts.map((c) => Math.round(c / divisor)).join(" : ");
  if (divisor > 1) {
    return `Ratio ${simplified} (${counts.join(" : ")})`;
  }
  return `Ratio ${simplified}`;
}

export function renderMainColorVerticalChartHtml(rules) {
  const counts = rules?.mainColorCounts || {};
  const keys = (counts["Multi-color"] || 0) > 0 ? [...MAIN_COLOR_ORDER, "Multi-color"] : MAIN_COLOR_ORDER;
  const maxColor = Math.max(1, ...keys.map((k) => counts[k] || 0));

  return `
    <section class="vchart-box">
      <div class="vchart-head">
        <h4 class="vchart-title">Color · Main Deck</h4>
        <span class="vchart-subbadge">${Number(rules?.mainCount || 0)}/50</span>
      </div>
      <div class="vchart-surface">
        <div class="vchart-cols">
          ${keys
            .map((key) => {
              const meta = DECK_COLOR_META[key] || DECK_COLOR_META.Colorless;
              const val = counts[key] || 0;
              const pct = val > 0 ? Math.max(8, Math.round((val / maxColor) * 100)) : 0;
              return `
                <div class="vchart-col">
                  <span class="vchart-pill ${val > 0 ? "has-val" : ""}">${val}</span>
                  <div class="vchart-bar-wrap">
                    <div class="vchart-bar" style="height:${pct}%;background:${meta.hex};"></div>
                  </div>
                  <span class="vchart-label">${escapeHtml(meta.label)}</span>
                </div>`;
            })
            .join("")}
        </div>
      </div>
    </section>`;
}

export function renderMainColorHorizontalCardHtml(rules) {
  const counts = rules?.mainColorCounts || {};
  const mainTotal = Math.max(0, Number(rules?.mainCount || 0));
  const allKeys = [...MAIN_COLOR_ORDER, "Multi-color"];
  const entries = allKeys
    .map((key) => ({ key, val: counts[key] || 0 }))
    .filter((entry) => entry.val > 0);
  const maxColor = Math.max(1, ...entries.map((entry) => entry.val));

  return `
    <section class="deck-stats-card">
      <div class="deck-stats-card-head">
        <h4 style="margin:0;">Color · Main Deck</h4>
        <span class="deck-stats-subbadge">${mainTotal}/50</span>
      </div>
      ${
        entries.length
          ? entries
              .map(({ key, val }) => {
                const meta = DECK_COLOR_META[key] || DECK_COLOR_META.Colorless;
                const sharePct = mainTotal > 0 ? Math.round((val / mainTotal) * 100) : 0;
                const barWidth = (val / maxColor) * 100;
                return `
                  <div class="bar-chart-row bar-chart-row-wide">
                    <span class="bar-chart-color-label">
                      <span class="color-dot ${meta.dotClass}"></span>${escapeHtml(key === "Colorless" ? "Colorless" : meta.label)}
                    </span>
                    <div class="bar-chart-track"><div class="bar-chart-fill ${meta.barClass}" style="width:${barWidth}%"></div></div>
                    <strong class="bar-chart-val">${val} <span class="muted-pct">(${sharePct}%)</span></strong>
                  </div>`;
              })
              .join("")
          : `<p class="muted-text" style="margin:0;">Agrega cartas al Main Deck para ver su distribución de color (no incluye Cheers).</p>`
      }
    </section>`;
}

export function renderCheerRatioChartHtml(rules, { variant = "preview" } = {}) {
  const cheerTotal = Math.max(0, Number(rules?.cheerCount || 0));
  const ratios = Array.isArray(rules?.cheerColorRatios)
    ? rules.cheerColorRatios
    : CHEER_COLORS.map((color) => ({ color, count: 0, ratio: 0, pct: 0 }));
  const active = ratios.filter((r) => r.count > 0).sort((a, b) => b.count - a.count);

  const isPreview = variant === "preview";
  const boxClass = isPreview ? "vchart-box" : "deck-stats-card";
  const headHtml = isPreview
    ? `<div class="vchart-head"><h4 class="vchart-title">Cheer · Ratio de Colores</h4><span class="vchart-subbadge">${cheerTotal}/20</span></div>`
    : `<div class="deck-stats-card-head"><h4 style="margin:0;">Cheer Deck · Ratio de Colores</h4><span class="deck-stats-subbadge">${cheerTotal}/20</span></div>`;

  if (cheerTotal === 0 || !active.length) {
    return `
      <section class="${boxClass}">
        ${headHtml}
        <div class="${isPreview ? "vchart-surface cheer-empty-box" : "cheer-empty-box"}">
          <p class="muted-text" style="margin:0;">Sin cartas Cheer todavía. Agrega Cheers para ver el ratio de colores.</p>
        </div>
      </section>`;
  }

  const ratioSummary = formatCheerRatioSummary(active);
  const segsHtml = active
    .map((r) => {
      const meta = DECK_COLOR_META[r.color] || DECK_COLOR_META.Colorless;
      return `<div class="cheer-ratio-seg" style="width:${r.pct.toFixed(2)}%;background:${meta.hex};" title="${escapeHtml(r.color)}: ${r.count} (${Math.round(r.pct)}%)"></div>`;
    })
    .join("");

  const rowsHtml = active
    .map((r) => {
      const meta = DECK_COLOR_META[r.color] || DECK_COLOR_META.Colorless;
      const pctInt = Math.round(r.pct);
      return `
        <div class="cheer-ratio-row">
          <span class="bar-chart-color-label">
            <span class="color-dot ${meta.dotClass}"></span>${escapeHtml(r.color)}
          </span>
          <div class="bar-chart-track"><div class="bar-chart-fill ${meta.barClass}" style="width:${r.pct.toFixed(2)}%"></div></div>
          <span class="cheer-ratio-pct"><strong>${r.count}</strong> · ${pctInt}%</span>
        </div>`;
    })
    .join("");

  return `
    <section class="${boxClass}">
      ${headHtml}
      <div class="${isPreview ? "vchart-surface cheer-ratio-body" : "cheer-ratio-body"}">
        <div class="cheer-ratio-bar" role="img" aria-label="${escapeHtml(ratioSummary)}">${segsHtml}</div>
        <div class="cheer-ratio-summary">${escapeHtml(ratioSummary)}</div>
        <div class="cheer-ratio-list">${rowsHtml}</div>
      </div>
    </section>`;
}

export function renderMiniCheerRatioHtml(rules) {
  const cheerTotal = Math.max(0, Number(rules?.cheerCount || 0));
  if (cheerTotal === 0) return "";
  const active = (rules?.cheerColorRatios || [])
    .filter((r) => r.count > 0)
    .sort((a, b) => b.count - a.count);
  if (!active.length) return "";

  const segsHtml = active
    .map((r) => {
      const meta = DECK_COLOR_META[r.color] || DECK_COLOR_META.Colorless;
      return `<div class="cheer-ratio-seg" style="width:${r.pct.toFixed(2)}%;background:${meta.hex};" title="${escapeHtml(r.color)}: ${r.count} (${Math.round(r.pct)}%)"></div>`;
    })
    .join("");

  const pillsHtml = active
    .map((r) => {
      const meta = DECK_COLOR_META[r.color] || DECK_COLOR_META.Colorless;
      return `<span class="mini-cheer-pill"><span class="color-dot ${meta.dotClass}"></span>${escapeHtml(meta.label)}: ${r.count} (${Math.round(r.pct)}%)</span>`;
    })
    .join("");

  return `
    <div class="mini-cheer-head">
      <span>Ratio Cheer</span>
      <strong>${cheerTotal}/20</strong>
    </div>
    <div class="cheer-ratio-bar is-mini">${segsHtml}</div>
    <div class="mini-cheer-pills">${pillsHtml}</div>`;
}
