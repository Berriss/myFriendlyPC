import { actions } from "../core/actions.js";
import { apiFetch, showSnackbar } from "../core/api.js";
import { MAIN_GROUP_ORDER_RANK, WPDF_SECTIONS } from "../core/constants.js";
import { escapeHtml, getDeckGroupCategory } from "../core/formatters.js";
import { state } from "../core/state.js";

function classifyWishlistSection(card) {
  if (!card) return "main";
  if (card.itemCategory === "sealed") return "sealed";
  if (card.cardType === "Oshi Holomem") return "oshi";
  if (card.cardType === "Cheer") return "cheer";
  return "main";
}

function sortWishlistGroupCards(sectionId, items, getCard = (x) => x) {
  return (items || []).slice().sort((a, b) => {
    const ca = getCard(a);
    const cb = getCard(b);
    if (sectionId === "main") {
      const ra = MAIN_GROUP_ORDER_RANK[getDeckGroupCategory(ca)] || 9;
      const rb = MAIN_GROUP_ORDER_RANK[getDeckGroupCategory(cb)] || 9;
      if (ra !== rb) return ra - rb;
    }
    return (
      String(ca.cardNumber || "").localeCompare(String(cb.cardNumber || "")) ||
      String(ca.name || "").localeCompare(String(cb.name || ""))
    );
  });
}

function defaultWishlistDesiredQty(card) {
  const target = Number(card?.wishlistTargetQty || 1);
  const owned = Number(card?.totalOwned || 0);
  return Math.max(1, Math.min(99, target > owned ? target - owned : target));
}

async function fetchAllWishlistCards() {
  const first = await apiFetch("/api/cards?ownership=wishlist&item_category=all&sort=number_asc&per_page=250&page=1");
  const all = Array.isArray(first.items) ? first.items.slice() : [];
  const totalPages = Number(first.totalPages || 1);
  for (let p = 2; p <= totalPages; p += 1) {
    const next = await apiFetch(`/api/cards?ownership=wishlist&item_category=all&sort=number_asc&per_page=250&page=${p}`);
    if (Array.isArray(next.items)) all.push(...next.items);
  }
  return all;
}

function getFilteredWishlistChecklistItems() {
  const { items, category, q } = state.wishlistPdf;
  const query = (q || "").trim().toLowerCase();
  return (items || []).filter((c) => {
    if (category !== "all" && classifyWishlistSection(c) !== category) return false;
    if (query) {
      const hay = `${c.name} ${c.cardNumber} ${c.editionName} ${c.editionAbbr} ${c.cardType} ${c.color} ${c.tags}`.toLowerCase();
      if (!hay.includes(query)) return false;
    }
    return true;
  });
}

function updateWishlistPdfSummary() {
  const sel = state.wishlistPdf.selected;
  let copies = 0;
  for (const qty of sel.values()) copies += Number(qty || 0);
  const count = sel.size;

  const sumEl = document.getElementById("wpdf-selection-summary");
  if (sumEl) {
    sumEl.textContent = `${count} ${count === 1 ? "carta seleccionada" : "cartas seleccionadas"} · ${copies} ${copies === 1 ? "copia" : "copias"}`;
  }
  const expBtn = document.getElementById("wpdf-export-btn");
  if (expBtn) expBtn.disabled = count === 0;
}

function setWishlistPdfStep(step) {
  const nextStep = step === "preview" ? "preview" : "select";
  state.wishlistPdf.step = nextStep;
  document.querySelectorAll("#wpdf-step-switch [data-wpdf-step]").forEach((btn) => {
    btn.classList.toggle("active", btn.getAttribute("data-wpdf-step") === nextStep);
  });
  document.getElementById("wpdf-select-pane")?.classList.toggle("hidden", nextStep !== "select");
  document.getElementById("wpdf-preview-pane")?.classList.toggle("hidden", nextStep !== "preview");
  const toggleBtn = document.getElementById("wpdf-toggle-step-btn");
  if (toggleBtn) {
    toggleBtn.textContent = nextStep === "preview" ? "← Volver a seleccionar" : "Ver vista previa";
  }
  if (nextStep === "preview") {
    renderWishlistPdfPreview();
  }
}

function renderWishlistPdfChecklist() {
  const host = document.getElementById("wpdf-checklist-container");
  if (!host) return;

  if (!state.wishlistPdf.items.length) {
    host.innerHTML = `
      <div class="panel-card" style="text-align:center;padding:28px;">
        <h3 style="margin:0 0 8px;">Tu Wishlist está vacía</h3>
        <p class="muted-text" style="margin:0 0 14px;">Marca con ♥ las cartas que buscas desde el Catálogo o tus Mazos y vuelve aquí para generar tu PDF.</p>
        <button id="wpdf-goto-catalog-btn" class="tonal-btn" type="button">Ir al Catálogo</button>
      </div>`;
    document.getElementById("wpdf-goto-catalog-btn")?.addEventListener("click", () => {
      document.getElementById("wishlist-pdf-modal")?.classList.add("hidden");
      actions.jumpToCatalogForAdding?.();
    });
    updateWishlistPdfSummary();
    return;
  }

  const filtered = getFilteredWishlistChecklistItems();
  if (!filtered.length) {
    host.innerHTML = `<div class="muted-text" style="padding:20px;text-align:center;">No hay cartas de tu wishlist que coincidan con ese filtro.</div>`;
    updateWishlistPdfSummary();
    return;
  }

  const buckets = new Map(WPDF_SECTIONS.map((s) => [s.id, []]));
  for (const card of filtered) {
    buckets.get(classifyWishlistSection(card)).push(card);
  }

  const sel = state.wishlistPdf.selected;
  host.innerHTML = WPDF_SECTIONS.map((sec) => {
    const groupItems = sortWishlistGroupCards(sec.id, buckets.get(sec.id));
    if (!groupItems.length) return "";
    return `
      <section class="wpdf-checklist-group">
        <div class="wpdf-checklist-group-title">
          <span>${escapeHtml(sec.label)}</span>
          <span class="edition-abbr">${groupItems.length}</span>
        </div>
        <div class="wpdf-check-rows">
          ${groupItems
            .map((c) => {
              const pid = Number(c.productId);
              const isSel = sel.has(pid);
              const qty = isSel ? sel.get(pid) : defaultWishlistDesiredQty(c);
              return `
                <div class="wpdf-check-row ${isSel ? "is-selected" : ""}" data-wpdf-pid="${pid}">
                  <label class="wpdf-check-label">
                    <input type="checkbox" data-wpdf-check="${pid}" ${isSel ? "checked" : ""} />
                    ${
                      c.imageUrl
                        ? `<img class="trade-item-thumb" src="${escapeHtml(c.imageUrl)}" alt="" loading="lazy" />`
                        : `<div class="trade-item-thumb-ph">?</div>`
                    }
                    <span class="wpdf-check-meta">
                      <strong class="truncate">${escapeHtml(c.name)}</strong>
                      <span class="muted-text">
                        ${escapeHtml(c.cardNumber || "S/N")} · ${escapeHtml(c.editionAbbr || c.editionName)} · ${escapeHtml(c.rarity || "—")}
                        ${c.cardType ? ` · ${escapeHtml(c.cardType)}` : ""}
                      </span>
                    </span>
                  </label>
                  <div class="wpdf-row-qty" aria-label="Cantidad deseada">
                    <button class="step-btn" data-wpdf-step-qty="${pid}:-1" type="button" aria-label="Restar cantidad">−</button>
                    <input class="wpdf-qty-input" type="number" min="1" max="99" value="${qty}" data-wpdf-qty-input="${pid}" aria-label="Cantidad de ${escapeHtml(c.name)}" />
                    <button class="step-btn plus" data-wpdf-step-qty="${pid}:1" type="button" aria-label="Sumar cantidad">+</button>
                  </div>
                </div>`;
            })
            .join("")}
        </div>
      </section>`;
  }).join("");

  const itemById = new Map(filtered.map((c) => [Number(c.productId), c]));

  host.querySelectorAll("[data-wpdf-check]").forEach((cb) => {
    cb.addEventListener("change", () => {
      const pid = Number(cb.getAttribute("data-wpdf-check"));
      const row = host.querySelector(`[data-wpdf-pid="${pid}"]`);
      const inp = row?.querySelector(`[data-wpdf-qty-input="${pid}"]`);
      if (cb.checked) {
        const qVal = Math.max(1, Math.min(99, Math.trunc(Number(inp?.value || defaultWishlistDesiredQty(itemById.get(pid))))));
        sel.set(pid, qVal);
        if (inp) inp.value = String(qVal);
      } else {
        sel.delete(pid);
      }
      row?.classList.toggle("is-selected", sel.has(pid));
      updateWishlistPdfSummary();
    });
  });

  host.querySelectorAll("[data-wpdf-step-qty]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const [pidStr, dStr] = btn.getAttribute("data-wpdf-step-qty").split(":");
      const pid = Number(pidStr);
      const delta = Number(dStr);
      const row = host.querySelector(`[data-wpdf-pid="${pid}"]`);
      const inp = row?.querySelector(`[data-wpdf-qty-input="${pid}"]`);
      const cb = row?.querySelector(`[data-wpdf-check="${pid}"]`);
      const current = sel.has(pid) ? sel.get(pid) : Number(inp?.value || defaultWishlistDesiredQty(itemById.get(pid)));
      const nextQty = Math.max(1, Math.min(99, Math.trunc(current + delta)));
      sel.set(pid, nextQty);
      if (inp) inp.value = String(nextQty);
      if (cb) cb.checked = true;
      row?.classList.add("is-selected");
      updateWishlistPdfSummary();
    });
  });

  host.querySelectorAll("[data-wpdf-qty-input]").forEach((inp) => {
    inp.addEventListener("click", (e) => e.stopPropagation());
    inp.addEventListener("input", () => {
      const pid = Number(inp.getAttribute("data-wpdf-qty-input"));
      const parsed = Math.trunc(Number(inp.value || 0));
      if (!Number.isFinite(parsed) || parsed <= 0) return;
      const clamped = Math.max(1, Math.min(99, parsed));
      sel.set(pid, clamped);
      const row = host.querySelector(`[data-wpdf-pid="${pid}"]`);
      const cb = row?.querySelector(`[data-wpdf-check="${pid}"]`);
      if (cb) cb.checked = true;
      row?.classList.add("is-selected");
      updateWishlistPdfSummary();
    });
  });

  updateWishlistPdfSummary();
}

export function buildWishlistPdfSheetHtml(selectedEntries, titleText, contactText) {
  if (!selectedEntries.length) {
    return `
      <div class="wpdf-pages-stack">
        <section class="wpdf-page wpdf-sheet">
          <div class="wpdf-empty-preview">
            <p style="margin:0 0 8px;font-weight:700;">Todavía no seleccionaste ninguna carta.</p>
            <p class="muted-text" style="margin:0;">Vuelve al paso 1 para elegir qué cartas de tu Wishlist y qué cantidades incluir en el PDF.</p>
          </div>
        </section>
      </div>`;
  }

  const buckets = new Map(WPDF_SECTIONS.map((s) => [s.id, []]));
  for (const entry of selectedEntries) {
    buckets.get(classifyWishlistSection(entry.card)).push(entry);
  }

  const totalCopies = selectedEntries.reduce((s, e) => s + Number(e.qty || 1), 0);
  const today = new Date().toISOString().slice(0, 10);
  const title = String(titleText || "").trim() || "Busco / Wishlist — Hololive OCG";
  const contact = String(contactText || "").trim();

  const secById = {};
  for (const s of WPDF_SECTIONS) {
    secById[s.id] = {
      sec: s,
      list: sortWishlistGroupCards(s.id, buckets.get(s.id), (e) => e.card),
    };
  }

  const ROW_MAX_COLS = 5;
  // Conservative mm height budget safe for both US Letter (279.4mm) and A4 (297mm) with 7mm padding.
  const PAGE_USABLE_MM = 256;
  const HEADER_FIRST_MM = contact ? 16 : 12;
  const HEADER_CONT_MM = 10;
  const ZONE_CHROME_MM = 13.2;
  const CARD_ROW_MM = 61.8;
  const CARD_ROW_GAP_MM = 2.0;
  const BLOCK_GAP_MM = 2.6;

  const estimateZoneHeightMm = (cardRows) =>
    ZONE_CHROME_MM +
    cardRows * CARD_ROW_MM +
    Math.max(0, cardRows - 1) * CARD_ROW_GAP_MM;

  // Equalize card widths across zones on a row and align 5-col rows flush edge-to-edge.
  const buildRowTrackExpr = (colCount, zoneCount, totalCols) => {
    if (totalCols >= ROW_MAX_COLS && zoneCount === 1) return "1fr";
    const overhead =
      totalCols >= ROW_MAX_COLS
        ? `(${zoneCount} * var(--wpdf-z-chrome) + ${ROW_MAX_COLS - zoneCount} * var(--wpdf-card-gap) + ${zoneCount - 1} * var(--wpdf-row-gap))`
        : `(var(--wpdf-z-chrome) + ${ROW_MAX_COLS - 1} * var(--wpdf-card-gap))`;
    const cardUnit = `((100% - ${overhead}) / ${ROW_MAX_COLS})`;
    const gapPart =
      colCount > 1 ? ` + ${colCount - 1} * var(--wpdf-card-gap)` : "";
    return `calc(${colCount} * ${cardUnit}${gapPart} + var(--wpdf-z-chrome))`;
  };

  const renderZone = (sec, list, cols, opts = {}) => {
    if (!list || !list.length) return "";
    const chunkCopies = list.reduce((s, e) => s + Number(e.qty || 1), 0);
    const secCopies = Number.isFinite(opts.totalSectionCopies)
      ? opts.totalSectionCopies
      : chunkCopies;
    const baseTitle =
      cols <= 2
        ? sec.id === "main"
          ? "Cartas"
          : sec.id === "sealed"
            ? "Sellados"
            : sec.label
        : sec.label;
    const titleLabel = opts.isContinuation ? `${baseTitle} (cont.)` : baseTitle;
    const hasParts = Number(opts.totalParts || 1) > 1 && Number(opts.partIndex || 0) >= 1;
    const countLabel = hasParts
      ? cols === 1
        ? `×${secCopies} (${opts.partIndex}/${opts.totalParts})`
        : `${secCopies} ${secCopies === 1 ? "copia" : "copias"} · ${opts.partIndex}/${opts.totalParts}`
      : cols === 1
        ? `×${secCopies}`
        : `${secCopies} ${secCopies === 1 ? "copia" : "copias"}`;

    return `
      <section class="wpdf-section-block wpdf-zone-${sec.id}" style="--zone-cols:${cols}">
        <h3 class="wpdf-section-title">
          <span>${escapeHtml(titleLabel)}</span>
          <span class="wpdf-section-count">${countLabel}</span>
        </h3>
        <div class="wpdf-cards-grid">
          ${list
            .map(({ card: c, qty }) => {
              const subCode = [c.cardNumber, c.rarity].filter(Boolean).join(" · ") || "—";
              return `
                <article class="wpdf-card-item">
                  <div class="wpdf-card-art-wrap">
                    ${
                      c.imageUrl
                        ? `<img src="${escapeHtml(c.imageUrl)}" alt="${escapeHtml(c.name)}" loading="eager" />`
                        : `<div class="art-fallback">${escapeHtml(c.name)}</div>`
                    }
                    <span class="wpdf-qty-box">×${Number(qty || 1)}</span>
                  </div>
                  <div class="wpdf-card-caption">
                    <div class="wpdf-card-name">${escapeHtml(c.name)}</div>
                    <div class="wpdf-card-code">${escapeHtml(subCode)}</div>
                  </div>
                </article>`;
            })
            .join("")}
        </div>
      </section>`;
  };

  const renderAlignedRow = (zoneSpecs) => {
    if (!zoneSpecs.length) return "";
    const totalCols = zoneSpecs.reduce((s, z) => s + z.cols, 0);
    const tracks = zoneSpecs
      .map((z) => buildRowTrackExpr(z.cols, zoneSpecs.length, totalCols))
      .join(" ");
    return `
      <div class="wpdf-playmat-row" style="grid-template-columns:${tracks}">
        ${zoneSpecs.map((z) => renderZone(z.sec, z.list, z.cols)).join("")}
      </div>`;
  };

  const packFlowRowSpecs = (zoneSpecs) => {
    const rows = [];
    let currentRow = [];
    let currentCols = 0;

    for (const item of zoneSpecs) {
      if (!item || !item.list || !item.list.length) continue;
      const cols = Math.min(item.list.length, ROW_MAX_COLS);
      const spec = { sec: item.sec, list: item.list, cols };
      if (currentRow.length > 0 && currentCols + cols > ROW_MAX_COLS) {
        rows.push(currentRow);
        currentRow = [spec];
        currentCols = cols;
      } else {
        currentRow.push(spec);
        currentCols += cols;
      }
    }
    if (currentRow.length > 0) rows.push(currentRow);
    return rows;
  };

  const pages = [{ blocks: [], usedMm: HEADER_FIRST_MM }];
  const startNewPage = () => {
    const next = { blocks: [], usedMm: HEADER_CONT_MM };
    pages.push(next);
    return next;
  };

  const appendAtomicBlock = (html, heightMm) => {
    let page = pages[pages.length - 1];
    if (page.blocks.length > 0 && page.usedMm + BLOCK_GAP_MM + heightMm > PAGE_USABLE_MM) {
      page = startNewPage();
    }
    const hadBlocks = page.blocks.length > 0;
    page.blocks.push({ html });
    page.usedMm += (hadBlocks ? BLOCK_GAP_MM : 0) + heightMm;
  };

  const appendFlowRows = (zoneSpecs) => {
    const rows = packFlowRowSpecs(zoneSpecs);
    for (const row of rows) {
      if (row.length > 1 || row[0].list.length <= row[0].cols) {
        appendAtomicBlock(renderAlignedRow(row), estimateZoneHeightMm(1));
        continue;
      }

      const { sec, list, cols } = row[0];
      const totalSectionCopies = list.reduce((s, e) => s + Number(e.qty || 1), 0);
      const chunks = [];
      let offset = 0;

      while (offset < list.length) {
        let page = pages[pages.length - 1];
        let availMm = PAGE_USABLE_MM - page.usedMm - (page.blocks.length ? BLOCK_GAP_MM : 0);
        let maxFitRows = Math.floor(
          (availMm - ZONE_CHROME_MM + CARD_ROW_GAP_MM) / (CARD_ROW_MM + CARD_ROW_GAP_MM)
        );

        if (maxFitRows < 1 && page.blocks.length > 0) {
          page = startNewPage();
          availMm = PAGE_USABLE_MM - page.usedMm;
          maxFitRows = Math.floor(
            (availMm - ZONE_CHROME_MM + CARD_ROW_GAP_MM) / (CARD_ROW_MM + CARD_ROW_GAP_MM)
          );
        }

        maxFitRows = Math.max(1, maxFitRows);
        const remainingRows = Math.ceil((list.length - offset) / cols);
        const takeRows = Math.min(remainingRows, maxFitRows);
        const chunkList = list.slice(offset, offset + takeRows * cols);
        const hadBlocks = page.blocks.length > 0;
        const chunkBlock = {
          sec,
          list: chunkList,
          cols,
          totalSectionCopies,
          partIndex: chunks.length + 1,
          totalParts: 1,
          html: "",
        };
        page.blocks.push(chunkBlock);
        page.usedMm += (hadBlocks ? BLOCK_GAP_MM : 0) + estimateZoneHeightMm(takeRows);
        chunks.push(chunkBlock);
        offset += chunkList.length;
      }

      const totalParts = chunks.length;
      for (const c of chunks) {
        c.totalParts = totalParts;
        c.html = `
          <div class="wpdf-playmat-row" style="grid-template-columns:1fr">
            ${renderZone(c.sec, c.list, c.cols, {
              isContinuation: c.partIndex > 1,
              totalSectionCopies: c.totalSectionCopies,
              partIndex: c.partIndex,
              totalParts: c.totalParts,
            })}
          </div>`;
      }
    }
  };

  const oshiList = secById.oshi.list;
  const mainList = secById.main.list;
  const cheerList = secById.cheer.list;
  const sealedList = secById.sealed.list;

  const splitMainCols = ROW_MAX_COLS - oshiList.length;
  const useSplit =
    oshiList.length >= 1 &&
    oshiList.length <= 2 &&
    mainList.length > splitMainCols &&
    mainList.length <= splitMainCols * 2;

  if (useSplit) {
    const railCols = oshiList.length;
    const mainCols = Math.min(mainList.length, ROW_MAX_COLS - railCols);
    const cheerInRail = cheerList.length > 0 && cheerList.length === railCols;
    const sealedInRail =
      !cheerInRail && sealedList.length > 0 && sealedList.length === railCols && mainList.length >= ROW_MAX_COLS;

    const railHtml = [
      renderZone(secById.oshi.sec, oshiList, railCols),
      cheerInRail ? renderZone(secById.cheer.sec, cheerList, railCols) : "",
      sealedInRail ? renderZone(secById.sealed.sec, sealedList, railCols) : "",
    ]
      .filter(Boolean)
      .join("");

    const mainHtml = renderZone(secById.main.sec, mainList, mainCols);
    const totalSplitCols = railCols + mainCols;
    const splitTracks = [
      buildRowTrackExpr(railCols, 2, totalSplitCols),
      buildRowTrackExpr(mainCols, 2, totalSplitCols),
    ].join(" ");

    const railZonesCount = 1 + (cheerInRail ? 1 : 0) + (sealedInRail ? 1 : 0);
    const splitClass = railZonesCount >= 2 ? "wpdf-playmat-split wpdf-split-stretch" : "wpdf-playmat-split";
    const railHeightMm =
      railZonesCount * estimateZoneHeightMm(1) + Math.max(0, railZonesCount - 1) * BLOCK_GAP_MM;
    const mainRows = Math.ceil(mainList.length / mainCols);
    const splitHeightMm = Math.max(railHeightMm, estimateZoneHeightMm(mainRows));

    appendAtomicBlock(
      `<div class="${splitClass}" style="grid-template-columns:${splitTracks}">
        <div class="wpdf-playmat-rail">${railHtml}</div>
        ${mainHtml}
      </div>`,
      splitHeightMm
    );

    const tailSpecs = [];
    if (!cheerInRail && cheerList.length > 0) {
      tailSpecs.push({ sec: secById.cheer.sec, list: cheerList });
    }
    if (!sealedInRail && sealedList.length > 0) {
      tailSpecs.push({ sec: secById.sealed.sec, list: sealedList });
    }
    if (tailSpecs.length) appendFlowRows(tailSpecs);
  } else {
    const hasSecondary = oshiList.length > 0 || cheerList.length > 0 || sealedList.length > 0;
    const flowSpecs = [];
    if (mainList.length >= ROW_MAX_COLS && hasSecondary) {
      if (oshiList.length) flowSpecs.push({ sec: secById.oshi.sec, list: oshiList });
      if (cheerList.length) flowSpecs.push({ sec: secById.cheer.sec, list: cheerList });
      if (sealedList.length) flowSpecs.push({ sec: secById.sealed.sec, list: sealedList });
      flowSpecs.push({ sec: secById.main.sec, list: mainList });
    } else {
      for (const s of WPDF_SECTIONS) {
        const list = secById[s.id].list;
        if (list.length) flowSpecs.push({ sec: s, list });
      }
    }
    appendFlowRows(flowSpecs);
  }

  const totalPages = pages.length;
  const renderFirstHeader = () => `
    <header class="wpdf-sheet-header">
      <div>
        <h2 class="wpdf-sheet-title">${escapeHtml(title)}</h2>
        ${contact ? `<p class="wpdf-sheet-contact">${escapeHtml(contact)}</p>` : ""}
      </div>
      <div class="wpdf-sheet-meta">
        <div class="wpdf-sheet-meta-row">
          <span class="wpdf-sheet-pill">${totalCopies} ${totalCopies === 1 ? "copia" : "copias"} · ${selectedEntries.length} ${selectedEntries.length === 1 ? "carta" : "cartas"}</span>
          ${totalPages > 1 ? `<span class="wpdf-page-badge">Pág. 1 / ${totalPages}</span>` : ""}
        </div>
        <span class="wpdf-sheet-date">${escapeHtml(today)}</span>
      </div>
    </header>`;

  const renderContHeader = (pageNum) => `
    <header class="wpdf-sheet-header wpdf-sheet-header-cont">
      <h2 class="wpdf-sheet-title">${escapeHtml(title)}</h2>
      <span class="wpdf-page-badge">Pág. ${pageNum} / ${totalPages}</span>
    </header>`;

  return `
    <div class="wpdf-pages-stack">
      ${pages
        .map(
          (p, idx) => `
            <section class="wpdf-page wpdf-sheet" data-wpdf-page="${idx + 1}">
              ${idx === 0 ? renderFirstHeader() : renderContHeader(idx + 1)}
              <div class="wpdf-playmat-board">${p.blocks.map((b) => b.html).join("")}</div>
            </section>`
        )
        .join("")}
    </div>`;
}

function getSelectedWishlistEntries() {
  const sel = state.wishlistPdf.selected;
  const out = [];
  for (const card of state.wishlistPdf.items || []) {
    const pid = Number(card.productId);
    if (sel.has(pid)) {
      out.push({ card, qty: Math.max(1, Math.min(99, Number(sel.get(pid) || 1))) });
    }
  }
  return out;
}

export function renderWishlistPdfPreview() {
  const host = document.getElementById("wpdf-preview-sheet");
  if (!host) return;
  const title = document.getElementById("wpdf-title-input")?.value || state.wishlistPdf.title;
  const contact = document.getElementById("wpdf-contact-input")?.value || state.wishlistPdf.contact;
  host.innerHTML = buildWishlistPdfSheetHtml(getSelectedWishlistEntries(), title, contact);
}

export async function openWishlistPdfModal() {
  const modal = document.getElementById("wishlist-pdf-modal");
  const checklistEl = document.getElementById("wpdf-checklist-container");
  if (!modal || !checklistEl) return;

  state.wishlistPdf.selected = new Map();
  state.wishlistPdf.category = "all";
  state.wishlistPdf.q = "";
  const searchInp = document.getElementById("wpdf-search-input");
  if (searchInp) searchInp.value = "";
  document.querySelectorAll("#wpdf-cat-chips [data-wpdf-cat]").forEach((b) =>
    b.classList.toggle("active", b.getAttribute("data-wpdf-cat") === "all")
  );
  setWishlistPdfStep("select");
  checklistEl.innerHTML = `<div class="muted-text" style="padding:24px;text-align:center;">Cargando cartas de tu Wishlist...</div>`;
  updateWishlistPdfSummary();
  modal.classList.remove("hidden");

  try {
    state.wishlistPdf.items = await fetchAllWishlistCards();
    renderWishlistPdfChecklist();
  } catch (err) {
    checklistEl.innerHTML = `<div class="panel-card">Error cargando wishlist: ${escapeHtml(err.message)}</div>`;
  }
}

function waitForContainerImages(container, timeoutMs = 4000) {
  const imgs = Array.from(container.querySelectorAll("img"));
  const pending = imgs.filter((img) => !img.complete);
  if (!pending.length) return Promise.resolve();
  return Promise.race([
    Promise.all(
      pending.map(
        (img) =>
          new Promise((resolve) => {
            img.addEventListener("load", resolve, { once: true });
            img.addEventListener("error", resolve, { once: true });
          })
      )
    ),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

export async function exportWishlistToPdf() {
  const entries = getSelectedWishlistEntries();
  if (!entries.length) {
    showSnackbar("Selecciona al menos 1 carta de tu Wishlist");
    return;
  }

  const printRoot = document.getElementById("wishlist-pdf-print-root");
  const exportBtn = document.getElementById("wpdf-export-btn");
  if (!printRoot) return;

  const title = (document.getElementById("wpdf-title-input")?.value || state.wishlistPdf.title || "").trim();
  const contact = (document.getElementById("wpdf-contact-input")?.value || state.wishlistPdf.contact || "").trim();

  if (exportBtn) {
    exportBtn.disabled = true;
    exportBtn.textContent = "Preparando imágenes...";
  }

  printRoot.innerHTML = buildWishlistPdfSheetHtml(entries, title, contact);
  await waitForContainerImages(printRoot, 4000);

  const prevTitle = document.title;
  const slug = (title || "Wishlist_Hololive_OCG")
    .replace(/[^\w\- ]+/g, "")
    .trim()
    .replace(/\s+/g, "_")
    .slice(0, 48);
  const today = new Date().toISOString().slice(0, 10);

  let cleaned = false;
  let fallbackTimer = null;
  const cleanupPrint = () => {
    if (cleaned) return;
    cleaned = true;
    if (fallbackTimer) clearTimeout(fallbackTimer);
    document.body.classList.remove("printing-wishlist");
    document.title = prevTitle;
    printRoot.innerHTML = "";
  };

  window.addEventListener("afterprint", cleanupPrint, { once: true });
  document.title = `${slug || "Wishlist_Hololive_OCG"}_${today}`;
  document.body.classList.add("printing-wishlist");

  try {
    window.print();
    showSnackbar("Elige 'Guardar como PDF' en el diálogo de impresión");
  } finally {
    if (exportBtn) {
      exportBtn.disabled = state.wishlistPdf.selected.size === 0;
      exportBtn.textContent = "📄 Exportar / Guardar PDF";
    }
    fallbackTimer = setTimeout(cleanupPrint, 1200);
  }
}

export function bindWishlistPdfEvents() {
  const closeWishlistPdfModal = () => {
    document.getElementById("wishlist-pdf-modal")?.classList.add("hidden");
  };
  document.getElementById("wpdf-modal-close")?.addEventListener("click", closeWishlistPdfModal);
  document.getElementById("wpdf-cancel-btn")?.addEventListener("click", closeWishlistPdfModal);
  document.getElementById("wishlist-pdf-modal")?.addEventListener("click", (e) => {
    if (e.target.id === "wishlist-pdf-modal") closeWishlistPdfModal();
  });
  document.querySelectorAll("#wpdf-step-switch [data-wpdf-step]").forEach((btn) => {
    btn.addEventListener("click", () => setWishlistPdfStep(btn.getAttribute("data-wpdf-step")));
  });
  document.getElementById("wpdf-toggle-step-btn")?.addEventListener("click", () => {
    setWishlistPdfStep(state.wishlistPdf.step === "preview" ? "select" : "preview");
  });
  document.getElementById("wpdf-title-input")?.addEventListener("input", (e) => {
    state.wishlistPdf.title = e.target.value;
  });
  document.getElementById("wpdf-contact-input")?.addEventListener("input", (e) => {
    state.wishlistPdf.contact = e.target.value;
  });
  document.getElementById("wpdf-search-input")?.addEventListener("input", (e) => {
    state.wishlistPdf.q = e.target.value;
    renderWishlistPdfChecklist();
  });
  document.querySelectorAll("#wpdf-cat-chips [data-wpdf-cat]").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#wpdf-cat-chips .filter-chip").forEach((c) => c.classList.remove("active"));
      btn.classList.add("active");
      state.wishlistPdf.category = btn.getAttribute("data-wpdf-cat") || "all";
      renderWishlistPdfChecklist();
    });
  });
  document.getElementById("wpdf-select-visible-btn")?.addEventListener("click", () => {
    const visible = getFilteredWishlistChecklistItems();
    for (const c of visible) {
      const pid = Number(c.productId);
      if (!state.wishlistPdf.selected.has(pid)) {
        state.wishlistPdf.selected.set(pid, defaultWishlistDesiredQty(c));
      }
    }
    renderWishlistPdfChecklist();
  });
  document.getElementById("wpdf-clear-selection-btn")?.addEventListener("click", () => {
    state.wishlistPdf.selected.clear();
    renderWishlistPdfChecklist();
  });
  document.getElementById("wpdf-export-btn")?.addEventListener("click", exportWishlistToPdf);
}
