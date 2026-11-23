use crate::db::sqlite::{Database, Row, SqlValue};
use crate::importer;
use crate::models::{
    AdjustCollectionRequest, AuditReport, CardFilterParams, CardRecord, CardWithCollection,
    CardsPageResponse, CollectionEntry, CollectionExportPayload, ColorBreakdown, DeckCardItem,
    DeckDetail, DeckSummary, EditionStats, ExchangeRateConfig, FacetCount, FilterFacets,
    KpiSummary, RarityBreakdown, SaveDeckRequest, SaveTradeItemInput, SaveTradeRequest,
    SaveTradeResponse, TopCardHighlight, TradeDetail, TradeItemEnriched, TradeItemStored,
    TradeSummary, TradesListResponse, UpdateExchangeRateRequest, UpsertCollectionRequest,
};
use anyhow::Result;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post, put};
use axum::{Json, Router};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::Notify;

#[derive(Clone)]
pub struct AppState {
    pub db: Database,
    pub resources_dir: PathBuf,
    pub shutdown_notify: Arc<Notify>,
}

#[derive(Debug)]
pub struct ApiError {
    status: StatusCode,
    message: String,
}

impl ApiError {
    fn not_found(msg: impl Into<String>) -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            message: msg.into(),
        }
    }

    fn bad_request(msg: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            message: msg.into(),
        }
    }
}

impl From<anyhow::Error> for ApiError {
    fn from(err: anyhow::Error) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            message: err.to_string(),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let body = serde_json::json!({ "error": self.message });
        (self.status, Json(body)).into_response()
    }
}

pub fn build_api_router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health_handler))
        .route("/shutdown", post(shutdown_server))
        .route("/kpis", get(get_kpis))
        .route("/editions", get(get_editions))
        .route("/cards", get(get_cards))
        .route("/cards/{product_id}", get(get_card_detail))
        .route("/collection/{product_id}", post(upsert_collection))
        .route("/collection/{product_id}/adjust", patch(adjust_collection))
        .route("/collection/export", get(export_collection))
        .route("/collection/import", post(import_collection))
        .route("/audit", get(get_audit_report))
        .route("/resync", post(resync_resources))
        .route(
            "/exchange-rate",
            get(get_exchange_rate).put(update_exchange_rate),
        )
        .route("/exchange-rate/refresh", post(refresh_exchange_rate))
        .route("/decks", get(list_decks).post(create_deck))
        .route(
            "/decks/{deck_id}",
            get(get_deck).put(update_deck).delete(delete_deck),
        )
        .route("/trades", get(list_trades).post(create_trade))
        .route(
            "/trades/{trade_id}",
            put(update_trade).delete(delete_trade),
        )
        .with_state(state)
}

async fn health_handler() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "status": "ok", "engine": "rust-axum-sqlite3" }))
}

async fn shutdown_server(State(state): State<AppState>) -> Json<serde_json::Value> {
    let _ = state.db.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
    let _ = std::fs::remove_file(".hocg.pid");
    let notify = state.shutdown_notify.clone();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        notify.notify_waiters();
    });
    Json(serde_json::json!({ "status": "shutting_down" }))
}

const CARD_WITH_COLLECTION_SELECT: &str = "
    c.product_id, c.group_id, c.edition_name, c.edition_abbr, c.name, c.clean_name,
    c.image_url, c.url, c.item_category, c.card_number, c.rarity, c.rarity_name,
    c.card_type, c.subtype, c.color, c.bloom_level, c.hp, c.life, c.baton_pass, c.tags,
    c.oshi_skill, c.sp_oshi_skill, c.keyword_text, c.arts1, c.arts2, c.special_rules,
    c.description_text, c.effect_text, c.raw_description,
    c.market_price, c.low_price, c.mid_price, c.high_price, c.direct_low_price,
    c.foil_market_price, c.foil_low_price, c.price_subtype,
    c.sanitized_flag, c.had_comma_or_html, c.modified_on,
    COALESCE(col.quantity_normal, 0) AS quantity_normal,
    COALESCE(col.quantity_foil, 0) AS quantity_foil,
    COALESCE(col.condition, 'NM') AS condition,
    COALESCE(col.language, 'EN') AS language,
    col.purchase_price,
    COALESCE(col.is_favorite, 0) AS is_favorite,
    COALESCE(col.is_wishlist, 0) AS is_wishlist,
    COALESCE(col.wishlist_target_qty, 1) AS wishlist_target_qty,
    COALESCE(col.notes, '') AS notes,
    col.updated_at
";

fn map_card_with_collection(row: &Row) -> Result<CardWithCollection> {
    let quantity_normal = row.get_i64(40);
    let quantity_foil = row.get_i64(41);
    Ok(CardWithCollection {
        card: CardRecord {
            product_id: row.get_i64(0),
            group_id: row.get_i64(1),
            edition_name: row.get_string(2),
            edition_abbr: row.get_string(3),
            name: row.get_string(4),
            clean_name: row.get_string(5),
            image_url: row.get_string(6),
            url: row.get_string(7),
            item_category: row.get_string(8),
            card_number: row.get_string(9),
            rarity: row.get_string(10),
            rarity_name: row.get_string(11),
            card_type: row.get_string(12),
            subtype: row.get_string(13),
            color: row.get_string(14),
            bloom_level: row.get_string(15),
            hp: row.get_opt_i64(16),
            life: row.get_opt_i64(17),
            baton_pass: row.get_string(18),
            tags: row.get_string(19),
            oshi_skill: row.get_string(20),
            sp_oshi_skill: row.get_string(21),
            keyword_text: row.get_string(22),
            arts1: row.get_string(23),
            arts2: row.get_string(24),
            special_rules: row.get_string(25),
            description_text: row.get_string(26),
            effect_text: row.get_string(27),
            raw_description: row.get_string(28),
            market_price: row.get_opt_f64(29),
            low_price: row.get_opt_f64(30),
            mid_price: row.get_opt_f64(31),
            high_price: row.get_opt_f64(32),
            direct_low_price: row.get_opt_f64(33),
            foil_market_price: row.get_opt_f64(34),
            foil_low_price: row.get_opt_f64(35),
            price_subtype: row.get_string(36),
            sanitized_flag: row.get_bool(37),
            had_comma_or_html: row.get_bool(38),
            modified_on: row.get_string(39),
        },
        quantity_normal,
        quantity_foil,
        total_owned: quantity_normal + quantity_foil,
        condition: row.get_string(42),
        language: row.get_string(43),
        purchase_price: row.get_opt_f64(44),
        is_favorite: row.get_bool(45),
        is_wishlist: row.get_bool(46),
        wishlist_target_qty: row.get_i64(47),
        notes: row.get_string(48),
        updated_at: row.get_opt_string(49),
    })
}

fn fetch_single_card_with_collection(
    db: &Database,
    product_id: i64,
) -> Result<Option<CardWithCollection>> {
    let sql = format!(
        "SELECT {CARD_WITH_COLLECTION_SELECT}
         FROM cards c
         LEFT JOIN collection col ON col.product_id = c.product_id
         WHERE c.product_id = ?1"
    );
    db.query_row_opt(&sql, &[SqlValue::from(product_id)], map_card_with_collection)
}

async fn get_kpis(State(state): State<AppState>) -> Result<Json<KpiSummary>, ApiError> {
    let kpis = compute_kpis(&state.db)?;
    Ok(Json(kpis))
}

pub fn compute_kpis(db: &Database) -> Result<KpiSummary> {
    let total_editions: i64 = db
        .query_row_opt("SELECT COUNT(*) FROM editions", &[], |r| Ok(r.get_i64(0)))?
        .unwrap_or(0);

    let (catalog_total_cards, catalog_total_sealed) = db
        .query_row_opt(
            "SELECT
               COALESCE(SUM(CASE WHEN item_category = 'card' THEN 1 ELSE 0 END), 0),
               COALESCE(SUM(CASE WHEN item_category = 'sealed' THEN 1 ELSE 0 END), 0)
             FROM cards",
            &[],
            |r| Ok((r.get_i64(0), r.get_i64(1))),
        )?
        .unwrap_or((0, 0));

    let (
        owned_unique_cards,
        owned_normal_copies,
        owned_foil_copies,
        collection_market_value_usd,
        collection_cost_basis_usd,
        favorites_count,
        wishlist_count,
        high_rarity_owned_copies,
    ) = db
        .query_row_opt(
            "SELECT
               COALESCE(SUM(CASE WHEN c.item_category = 'card' AND (col.quantity_normal + col.quantity_foil) > 0 THEN 1 ELSE 0 END), 0),
               COALESCE(SUM(CASE
                 WHEN NOT (c.rarity IN ('R','RR','OSR','S','SY','SR','UR','OUR','HR','SEC') OR (c.rarity = 'P' AND LOWER(c.price_subtype) = 'foil'))
                 THEN (col.quantity_normal + col.quantity_foil) ELSE 0 END), 0),
               COALESCE(SUM(CASE
                 WHEN (c.rarity IN ('R','RR','OSR','S','SY','SR','UR','OUR','HR','SEC') OR (c.rarity = 'P' AND LOWER(c.price_subtype) = 'foil'))
                 THEN (col.quantity_normal + col.quantity_foil) ELSE 0 END), 0),
               COALESCE(SUM(
                 (col.quantity_normal + col.quantity_foil) * COALESCE(c.market_price, c.foil_market_price, 0.0)
               ), 0.0),
               COALESCE(SUM(
                 COALESCE(col.purchase_price, 0.0) * (col.quantity_normal + col.quantity_foil)
               ), 0.0),
               COALESCE(SUM(CASE WHEN col.is_favorite = 1 THEN 1 ELSE 0 END), 0),
               COALESCE(SUM(CASE WHEN col.is_wishlist = 1 THEN 1 ELSE 0 END), 0),
               COALESCE(SUM(CASE WHEN c.rarity IN ('SEC','OUR','UR','SR','S','SY','HR') THEN (col.quantity_normal + col.quantity_foil) ELSE 0 END), 0)
             FROM collection col
             JOIN cards c ON c.product_id = col.product_id",
            &[],
            |r| {
                Ok((
                    r.get_i64(0),
                    r.get_i64(1),
                    r.get_i64(2),
                    r.get_f64(3),
                    r.get_f64(4),
                    r.get_i64(5),
                    r.get_i64(6),
                    r.get_i64(7),
                ))
            },
        )?
        .unwrap_or((0, 0, 0, 0.0, 0.0, 0, 0, 0));

    let owned_total_copies = owned_normal_copies + owned_foil_copies;
    let completion_pct = if catalog_total_cards > 0 {
        (owned_unique_cards as f64 / catalog_total_cards as f64) * 100.0
    } else {
        0.0
    };
    let net_gain_usd = if collection_cost_basis_usd > 0.0 {
        collection_market_value_usd - collection_cost_basis_usd
    } else {
        0.0
    };

    let top_owned_card = db.query_row_opt(
        "SELECT
           c.product_id,
           c.name,
           c.card_number,
           c.rarity,
           COALESCE(c.market_price, c.foil_market_price, 0.0) AS effective_price,
           c.image_url
         FROM collection col
         JOIN cards c ON c.product_id = col.product_id
         WHERE (col.quantity_normal + col.quantity_foil) > 0
         ORDER BY effective_price DESC
         LIMIT 1",
        &[],
        |r| {
            Ok(TopCardHighlight {
                product_id: r.get_i64(0),
                name: r.get_string(1),
                card_number: r.get_string(2),
                rarity: r.get_string(3),
                market_price: r.get_f64(4),
                image_url: r.get_string(5),
            })
        },
    )?;

    let color_breakdown = db.query_map(
        "SELECT
           CASE
             WHEN c.color = '' THEN 'Sin color'
             WHEN INSTR(c.color, '/') > 0 THEN 'Multi-color'
             ELSE c.color
           END AS color_group,
           COUNT(*) AS catalog_count,
           COALESCE(SUM(CASE WHEN (COALESCE(col.quantity_normal,0) + COALESCE(col.quantity_foil,0)) > 0 THEN 1 ELSE 0 END), 0),
           COALESCE(SUM(COALESCE(col.quantity_normal,0) + COALESCE(col.quantity_foil,0)), 0)
         FROM cards c
         LEFT JOIN collection col ON col.product_id = c.product_id
         WHERE c.item_category = 'card'
         GROUP BY color_group
         ORDER BY catalog_count DESC",
        &[],
        |r| {
            Ok(ColorBreakdown {
                color: r.get_string(0),
                catalog_count: r.get_i64(1),
                owned_unique: r.get_i64(2),
                owned_copies: r.get_i64(3),
            })
        },
    )?;

    let rarity_breakdown = db.query_map(
        "SELECT
           c.rarity,
           c.rarity_name,
           COUNT(*) AS catalog_count,
           COALESCE(SUM(CASE WHEN (COALESCE(col.quantity_normal,0) + COALESCE(col.quantity_foil,0)) > 0 THEN 1 ELSE 0 END), 0),
           COALESCE(SUM(COALESCE(col.quantity_normal,0) + COALESCE(col.quantity_foil,0)), 0)
         FROM cards c
         LEFT JOIN collection col ON col.product_id = c.product_id
         WHERE c.item_category = 'card' AND c.rarity != ''
         GROUP BY c.rarity, c.rarity_name
         ORDER BY
           CASE c.rarity
             WHEN 'SEC' THEN 1
             WHEN 'OUR' THEN 2
             WHEN 'OSR' THEN 3
             WHEN 'UR' THEN 4
             WHEN 'SR' THEN 5
             WHEN 'RR' THEN 6
             WHEN 'S' THEN 7
             WHEN 'SY' THEN 8
             WHEN 'HR' THEN 9
             WHEN 'R' THEN 10
             WHEN 'U' THEN 11
             WHEN 'C' THEN 12
             WHEN 'OC' THEN 13
             WHEN 'P' THEN 14
             ELSE 99
           END ASC",
        &[],
        |r| {
            Ok(RarityBreakdown {
                rarity: r.get_string(0),
                rarity_name: r.get_string(1),
                catalog_count: r.get_i64(2),
                owned_unique: r.get_i64(3),
                owned_copies: r.get_i64(4),
            })
        },
    )?;

    let last_synced_at = db.query_row_opt(
        "SELECT synced_at FROM audit_summary WHERE id = 1",
        &[],
        |r| Ok(r.get_string(0)),
    )?;

    let exchange_rate = read_exchange_rate_config(db)?;

    Ok(KpiSummary {
        total_editions,
        catalog_total_cards,
        catalog_total_sealed,
        owned_unique_cards,
        completion_pct,
        owned_total_copies,
        owned_normal_copies,
        owned_foil_copies,
        collection_market_value_usd,
        collection_cost_basis_usd,
        net_gain_usd,
        favorites_count,
        wishlist_count,
        high_rarity_owned_copies,
        top_owned_card,
        color_breakdown,
        rarity_breakdown,
        exchange_rate,
        last_synced_at,
    })
}

async fn get_editions(State(state): State<AppState>) -> Result<Json<Vec<EditionStats>>, ApiError> {
    let rows = state.db.query_map(
        "SELECT
           e.group_id,
           e.name,
           e.abbreviation,
           e.is_supplemental,
           e.published_on,
           COALESCE(SUM(CASE WHEN c.item_category = 'card' THEN 1 ELSE 0 END), 0) AS total_cards,
           COALESCE(SUM(CASE WHEN c.item_category = 'sealed' THEN 1 ELSE 0 END), 0) AS total_sealed,
           COALESCE(SUM(CASE WHEN c.item_category = 'card' AND (COALESCE(col.quantity_normal,0) + COALESCE(col.quantity_foil,0)) > 0 THEN 1 ELSE 0 END), 0) AS owned_unique,
           COALESCE(SUM(CASE WHEN c.item_category = 'card' THEN (COALESCE(col.quantity_normal,0) + COALESCE(col.quantity_foil,0)) ELSE 0 END), 0) AS owned_copies,
           COALESCE(SUM(
             (COALESCE(col.quantity_normal, 0) + COALESCE(col.quantity_foil, 0)) * COALESCE(c.market_price, c.foil_market_price, 0.0)
           ), 0.0) AS collection_val,
           COALESCE(SUM(CASE WHEN c.item_category = 'card' THEN COALESCE(c.market_price, c.foil_market_price, 0.0) ELSE 0.0 END), 0.0) AS set_val
         FROM editions e
         LEFT JOIN cards c ON c.group_id = e.group_id
         LEFT JOIN collection col ON col.product_id = c.product_id
         GROUP BY e.group_id
         ORDER BY e.published_on DESC, e.group_id DESC",
        &[],
        |r| {
            let total_cards = r.get_i64(5);
            let owned_unique = r.get_i64(7);
            let completion_pct = if total_cards > 0 {
                (owned_unique as f64 / total_cards as f64) * 100.0
            } else {
                0.0
            };
            Ok(EditionStats {
                group_id: r.get_i64(0),
                name: r.get_string(1),
                abbreviation: r.get_string(2),
                is_supplemental: r.get_bool(3),
                published_on: r.get_string(4),
                total_cards,
                total_sealed: r.get_i64(6),
                owned_unique_cards: owned_unique,
                owned_total_copies: r.get_i64(8),
                completion_pct,
                collection_value_usd: r.get_f64(9),
                set_total_value_usd: r.get_f64(10),
            })
        },
    )?;

    Ok(Json(rows))
}

async fn get_cards(
    State(state): State<AppState>,
    Query(params): Query<CardFilterParams>,
) -> Result<Json<CardsPageResponse>, ApiError> {
    let mut clauses: Vec<String> = Vec::new();
    let mut bind_vals: Vec<SqlValue> = Vec::new();
    let mut next_param = |val: SqlValue| -> String {
        bind_vals.push(val);
        format!("?{}", bind_vals.len())
    };

    let item_cat = params
        .item_category
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("card");

    if item_cat != "all" {
        let p = next_param(SqlValue::from(item_cat));
        clauses.push(format!("c.item_category = {p}"));
    }

    if let Some(gid) = params.group_id {
        let p = next_param(SqlValue::from(gid));
        clauses.push(format!("c.group_id = {p}"));
    }

    if let Some(q) = params.q.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        let like_pat = format!("%{q}%");
        let p1 = next_param(SqlValue::from(like_pat.clone()));
        let p2 = next_param(SqlValue::from(like_pat.clone()));
        let p3 = next_param(SqlValue::from(like_pat.clone()));
        let p4 = next_param(SqlValue::from(like_pat.clone()));
        let p5 = next_param(SqlValue::from(like_pat));
        clauses.push(format!(
            "(c.name LIKE {p1} OR c.card_number LIKE {p2} OR c.effect_text LIKE {p3} OR c.tags LIKE {p4} OR c.edition_name LIKE {p5})"
        ));
    }

    if let Some(color) = params.color.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        if color.eq_ignore_ascii_case("Colorless") {
            clauses.push("(c.color = 'Colorless' OR c.color = '')".to_string());
        } else {
            let p = next_param(SqlValue::from(format!("%{color}%")));
            clauses.push(format!("c.color LIKE {p}"));
        }
    }

    if let Some(rarity) = params.rarity.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        let p = next_param(SqlValue::from(rarity));
        clauses.push(format!("c.rarity = {p}"));
    }

    if let Some(ct) = params.card_type.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        let p = next_param(SqlValue::from(ct));
        clauses.push(format!("c.card_type = {p}"));
    }

    if let Some(bl) = params.bloom_level.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        let p = next_param(SqlValue::from(bl));
        clauses.push(format!("c.bloom_level = {p}"));
    }

    match params.deck_zone.as_deref().map(str::trim) {
        Some("oshi") => clauses.push("c.card_type = 'Oshi Holomem'".to_string()),
        Some("main") => {
            clauses.push("c.card_type IN ('Holomem', 'Buzz Holomem', 'Support')".to_string())
        }
        Some("cheer") => clauses.push("c.card_type = 'Cheer'".to_string()),
        _ => {}
    }

    match params.parallel.as_deref().map(str::trim) {
        Some("base") => {
            clauses.push("c.rarity NOT IN ('SEC', 'OUR', 'UR', 'SR', 'S', 'SY', 'HR')".to_string())
        }
        Some("only") => {
            clauses.push("c.rarity IN ('SEC', 'OUR', 'UR', 'SR', 'S', 'SY', 'HR')".to_string())
        }
        _ => {}
    }

    if params.limited_only == Some(true) {
        clauses.push("(c.card_type = 'Support' AND c.effect_text LIKE '%LIMITED%')".to_string());
    }

    if let Some(min_p) = params.min_price {
        let p = next_param(SqlValue::from(min_p));
        clauses.push(format!(
            "COALESCE(c.market_price, c.foil_market_price, 0.0) >= {p}"
        ));
    }

    if let Some(max_p) = params.max_price {
        let p = next_param(SqlValue::from(max_p));
        clauses.push(format!(
            "COALESCE(c.market_price, c.foil_market_price, 0.0) <= {p}"
        ));
    }

    match params.ownership.as_deref().unwrap_or("all") {
        "owned" => clauses.push("(COALESCE(col.quantity_normal, 0) + COALESCE(col.quantity_foil, 0)) > 0".to_string()),
        "missing" => clauses.push("(COALESCE(col.quantity_normal, 0) + COALESCE(col.quantity_foil, 0)) = 0".to_string()),
        "favorite" => clauses.push("COALESCE(col.is_favorite, 0) = 1".to_string()),
        "wishlist" => clauses.push("COALESCE(col.is_wishlist, 0) = 1".to_string()),
        _ => {}
    }

    let where_sql = if clauses.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", clauses.join(" AND "))
    };

    let order_sql = match params.sort.as_deref().unwrap_or("price_desc") {
        "price_asc" => "COALESCE(c.market_price, c.foil_market_price, 9999999.0) ASC, c.name ASC",
        "number_asc" => "CASE WHEN c.card_number = '' THEN 1 ELSE 0 END ASC, c.card_number ASC, c.name ASC",
        "number_desc" => "c.card_number DESC, c.name ASC",
        "name_asc" => "c.name ASC, c.card_number ASC",
        "owned_desc" => "(COALESCE(col.quantity_normal, 0) + COALESCE(col.quantity_foil, 0)) DESC, COALESCE(c.market_price, c.foil_market_price, -1.0) DESC",
        "rarity_desc" => "CASE c.rarity WHEN 'SEC' THEN 1 WHEN 'OUR' THEN 2 WHEN 'OSR' THEN 3 WHEN 'UR' THEN 4 WHEN 'SR' THEN 5 WHEN 'RR' THEN 6 WHEN 'S' THEN 7 WHEN 'SY' THEN 8 WHEN 'HR' THEN 9 WHEN 'R' THEN 10 WHEN 'U' THEN 11 WHEN 'C' THEN 12 WHEN 'OC' THEN 13 WHEN 'P' THEN 14 ELSE 99 END ASC, COALESCE(c.market_price, c.foil_market_price, -1.0) DESC",
        _ => "COALESCE(c.market_price, c.foil_market_price, -1.0) DESC, c.card_number ASC, c.name ASC",
    };

    let count_sql = format!(
        "SELECT COUNT(*)
         FROM cards c
         LEFT JOIN collection col ON col.product_id = c.product_id
         {where_sql}"
    );
    let total = state
        .db
        .query_row_opt(&count_sql, &bind_vals, |r| Ok(r.get_i64(0)))?
        .unwrap_or(0);

    let per_page = params.per_page.unwrap_or(36).clamp(1, 250);
    let total_pages = ((total + per_page - 1) / per_page).max(1);
    let page = params.page.unwrap_or(1).clamp(1, total_pages);
    let offset = (page - 1) * per_page;

    let mut page_binds = bind_vals.clone();
    let limit_ph = format!("?{}", page_binds.len() + 1);
    page_binds.push(SqlValue::from(per_page));
    let offset_ph = format!("?{}", page_binds.len() + 1);
    page_binds.push(SqlValue::from(offset));

    let items_sql = format!(
        "SELECT {CARD_WITH_COLLECTION_SELECT}
         FROM cards c
         LEFT JOIN collection col ON col.product_id = c.product_id
         {where_sql}
         ORDER BY {order_sql}
         LIMIT {limit_ph} OFFSET {offset_ph}"
    );
    let items = state
        .db
        .query_map(&items_sql, &page_binds, map_card_with_collection)?;

    let facets = compute_facets(&state.db, item_cat, params.group_id)?;

    Ok(Json(CardsPageResponse {
        items,
        total,
        page,
        per_page,
        total_pages,
        facets,
    }))
}

fn compute_facets(
    db: &Database,
    item_category: &str,
    group_id: Option<i64>,
) -> Result<FilterFacets> {
    let mut conds = Vec::new();
    let mut binds = Vec::new();
    if item_category != "all" {
        binds.push(SqlValue::from(item_category));
        conds.push(format!("item_category = ?{}", binds.len()));
    }
    if let Some(gid) = group_id {
        binds.push(SqlValue::from(gid));
        conds.push(format!("group_id = ?{}", binds.len()));
    }
    let where_sql = if conds.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", conds.join(" AND "))
    };

    let query_col = |col_name: &str| -> Result<Vec<FacetCount>> {
        let sql = format!(
            "SELECT {col_name}, COUNT(*) AS cnt
             FROM cards
             {where_sql}
             GROUP BY {col_name}
             HAVING {col_name} != ''
             ORDER BY cnt DESC, {col_name} ASC"
        );
        db.query_map(&sql, &binds, |r| {
            Ok(FacetCount {
                value: r.get_string(0),
                count: r.get_i64(1),
            })
        })
    };

    Ok(FilterFacets {
        colors: query_col("color")?,
        rarities: query_col("rarity")?,
        card_types: query_col("card_type")?,
        bloom_levels: query_col("bloom_level")?,
    })
}

async fn get_card_detail(
    State(state): State<AppState>,
    Path(product_id): Path<i64>,
) -> Result<Json<CardWithCollection>, ApiError> {
    let card = fetch_single_card_with_collection(&state.db, product_id)?
        .ok_or_else(|| ApiError::not_found(format!("Card {product_id} not found")))?;
    Ok(Json(card))
}

async fn upsert_collection(
    State(state): State<AppState>,
    Path(product_id): Path<i64>,
    Json(body): Json<UpsertCollectionRequest>,
) -> Result<Json<CardWithCollection>, ApiError> {
    let existing = fetch_single_card_with_collection(&state.db, product_id)?
        .ok_or_else(|| ApiError::not_found(format!("Card {product_id} not found")))?;

    let qty_normal = if let Some(q) = body.quantity {
        q.max(0)
    } else if body.quantity_normal.is_some() || body.quantity_foil.is_some() {
        (body.quantity_normal.unwrap_or(0) + body.quantity_foil.unwrap_or(0)).max(0)
    } else {
        existing.total_owned.max(0)
    };
    let qty_foil = 0;
    let condition = body
        .condition
        .unwrap_or(existing.condition)
        .trim()
        .to_string();
    let language = body.language.unwrap_or(existing.language).trim().to_string();
    let purchase_price = body.purchase_price.or(existing.purchase_price);
    let is_favorite = body.is_favorite.unwrap_or(existing.is_favorite);
    let is_wishlist = body.is_wishlist.unwrap_or(existing.is_wishlist);
    let wishlist_target_qty = body
        .wishlist_target_qty
        .unwrap_or(existing.wishlist_target_qty)
        .max(1);
    let notes = body.notes.unwrap_or(existing.notes);

    persist_collection_state(
        &state.db,
        product_id,
        qty_normal,
        qty_foil,
        &condition,
        &language,
        purchase_price,
        is_favorite,
        is_wishlist,
        wishlist_target_qty,
        &notes,
    )?;

    let updated = fetch_single_card_with_collection(&state.db, product_id)?
        .ok_or_else(|| ApiError::not_found("Card vanished"))?;
    Ok(Json(updated))
}

async fn adjust_collection(
    State(state): State<AppState>,
    Path(product_id): Path<i64>,
    Json(body): Json<AdjustCollectionRequest>,
) -> Result<Json<CardWithCollection>, ApiError> {
    let existing = fetch_single_card_with_collection(&state.db, product_id)?
        .ok_or_else(|| ApiError::not_found(format!("Card {product_id} not found")))?;

    let delta = body
        .delta
        .unwrap_or_else(|| body.delta_normal.unwrap_or(0) + body.delta_foil.unwrap_or(0));
    let qty_normal = (existing.total_owned + delta).max(0);
    let qty_foil = 0;
    let is_favorite = if body.toggle_favorite.unwrap_or(false) {
        !existing.is_favorite
    } else {
        existing.is_favorite
    };
    let is_wishlist = if body.toggle_wishlist.unwrap_or(false) {
        !existing.is_wishlist
    } else {
        existing.is_wishlist
    };

    persist_collection_state(
        &state.db,
        product_id,
        qty_normal,
        qty_foil,
        &existing.condition,
        &existing.language,
        existing.purchase_price,
        is_favorite,
        is_wishlist,
        existing.wishlist_target_qty,
        &existing.notes,
    )?;

    let updated = fetch_single_card_with_collection(&state.db, product_id)?
        .ok_or_else(|| ApiError::not_found("Card vanished"))?;
    Ok(Json(updated))
}

#[allow(clippy::too_many_arguments)]
fn persist_collection_state(
    db: &Database,
    product_id: i64,
    qty_normal: i64,
    qty_foil: i64,
    condition: &str,
    language: &str,
    purchase_price: Option<f64>,
    is_favorite: bool,
    is_wishlist: bool,
    wishlist_target_qty: i64,
    notes: &str,
) -> Result<()> {
    if qty_normal == 0 && qty_foil == 0 && !is_favorite && !is_wishlist && notes.trim().is_empty() {
        db.execute(
            "DELETE FROM collection WHERE product_id = ?1",
            &[SqlValue::from(product_id)],
        )?;
        return Ok(());
    }

    let now = Utc::now().to_rfc3339();
    db.execute(
        "INSERT INTO collection (
            product_id, quantity_normal, quantity_foil, condition, language,
            purchase_price, is_favorite, is_wishlist, wishlist_target_qty, notes, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
         ON CONFLICT(product_id) DO UPDATE SET
            quantity_normal = excluded.quantity_normal,
            quantity_foil = excluded.quantity_foil,
            condition = excluded.condition,
            language = excluded.language,
            purchase_price = excluded.purchase_price,
            is_favorite = excluded.is_favorite,
            is_wishlist = excluded.is_wishlist,
            wishlist_target_qty = excluded.wishlist_target_qty,
            notes = excluded.notes,
            updated_at = excluded.updated_at",
        &[
            SqlValue::from(product_id),
            SqlValue::from(qty_normal),
            SqlValue::from(qty_foil),
            SqlValue::from(if condition.is_empty() { "NM" } else { condition }),
            SqlValue::from(if language.is_empty() { "EN" } else { language }),
            SqlValue::from(purchase_price),
            SqlValue::from(is_favorite),
            SqlValue::from(is_wishlist),
            SqlValue::from(wishlist_target_qty),
            SqlValue::from(notes),
            SqlValue::from(now.as_str()),
        ],
    )?;
    Ok(())
}

async fn export_collection(
    State(state): State<AppState>,
) -> Result<Json<CollectionExportPayload>, ApiError> {
    let entries = state.db.query_map(
        "SELECT product_id, quantity_normal, quantity_foil, condition, language,
                purchase_price, is_favorite, is_wishlist, wishlist_target_qty, notes, updated_at
         FROM collection
         ORDER BY updated_at DESC",
        &[],
        |r| {
            Ok(CollectionEntry {
                product_id: r.get_i64(0),
                quantity_normal: r.get_i64(1),
                quantity_foil: r.get_i64(2),
                condition: r.get_string(3),
                language: r.get_string(4),
                purchase_price: r.get_opt_f64(5),
                is_favorite: r.get_bool(6),
                is_wishlist: r.get_bool(7),
                wishlist_target_qty: r.get_i64(8),
                notes: r.get_string(9),
                updated_at: r.get_string(10),
            })
        },
    )?;

    Ok(Json(CollectionExportPayload {
        exported_at: Utc::now().to_rfc3339(),
        version: "1.0".to_string(),
        entries,
    }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportCollectionRequest {
    entries: Vec<CollectionEntry>,
    #[serde(default)]
    replace_existing: bool,
}

async fn import_collection(
    State(state): State<AppState>,
    Json(body): Json<ImportCollectionRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let mut imported = 0usize;
    let mut skipped = 0usize;

    state.db.with_transaction(|tx| {
        if body.replace_existing {
            tx.execute("DELETE FROM collection", &[])?;
        }
        for entry in &body.entries {
            let changes = tx.execute(
                "INSERT INTO collection (
                    product_id, quantity_normal, quantity_foil, condition, language,
                    purchase_price, is_favorite, is_wishlist, wishlist_target_qty, notes, updated_at
                 )
                 SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11
                 WHERE EXISTS (SELECT 1 FROM cards WHERE product_id = ?1)
                 ON CONFLICT(product_id) DO UPDATE SET
                    quantity_normal = excluded.quantity_normal,
                    quantity_foil = excluded.quantity_foil,
                    condition = excluded.condition,
                    language = excluded.language,
                    purchase_price = excluded.purchase_price,
                    is_favorite = excluded.is_favorite,
                    is_wishlist = excluded.is_wishlist,
                    wishlist_target_qty = excluded.wishlist_target_qty,
                    notes = excluded.notes,
                    updated_at = excluded.updated_at",
                &[
                    SqlValue::from(entry.product_id),
                    SqlValue::from(entry.quantity_normal.max(0)),
                    SqlValue::from(entry.quantity_foil.max(0)),
                    SqlValue::from(entry.condition.as_str()),
                    SqlValue::from(entry.language.as_str()),
                    SqlValue::from(entry.purchase_price),
                    SqlValue::from(entry.is_favorite),
                    SqlValue::from(entry.is_wishlist),
                    SqlValue::from(entry.wishlist_target_qty.max(1)),
                    SqlValue::from(entry.notes.as_str()),
                    SqlValue::from(entry.updated_at.as_str()),
                ],
            )?;
            if changes > 0 {
                imported += 1;
            } else {
                skipped += 1;
            }
        }
        Ok(())
    })?;

    Ok(Json(serde_json::json!({
        "imported": imported,
        "skipped": skipped
    })))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AuditApiResponse {
    synced_at: String,
    report: AuditReport,
}

async fn get_audit_report(State(state): State<AppState>) -> Result<Json<AuditApiResponse>, ApiError> {
    let row = state.db.query_row_opt(
        "SELECT report_json, synced_at FROM audit_summary WHERE id = 1",
        &[],
        |r| Ok((r.get_string(0), r.get_string(1))),
    )?;

    match row {
        Some((json_str, synced_at)) => {
            let report: AuditReport = serde_json::from_str(&json_str).unwrap_or_default();
            Ok(Json(AuditApiResponse { synced_at, report }))
        }
        None => Ok(Json(AuditApiResponse {
            synced_at: String::new(),
            report: AuditReport::default(),
        })),
    }
}

async fn resync_resources(
    State(state): State<AppState>,
) -> Result<Json<importer::SyncSummary>, ApiError> {
    let summary = importer::sync_resources_to_db(&state.db, &state.resources_dir, true)?;
    Ok(Json(summary))
}

async fn list_decks(State(state): State<AppState>) -> Result<Json<Vec<DeckSummary>>, ApiError> {
    let decks = state.db.query_map(
        "SELECT
           d.id,
           d.name,
           d.oshi_product_id,
           oc.name AS oshi_name,
           oc.card_number AS oshi_card_number,
           oc.color AS oshi_color,
           oc.image_url AS oshi_image_url,
           d.description,
           COALESCE(SUM(CASE WHEN dc.zone = 'main' THEN dc.quantity ELSE 0 END), 0) AS main_count,
           COALESCE(SUM(CASE WHEN dc.zone = 'cheer' THEN dc.quantity ELSE 0 END), 0) AS cheer_count,
           COALESCE(SUM(dc.quantity), 0) + MAX(CASE WHEN oc.product_id IS NOT NULL THEN 1 ELSE 0 END) AS total_cards,
           COALESCE(SUM(MIN(dc.quantity, COALESCE(col.quantity_normal, 0) + COALESCE(col.quantity_foil, 0))), 0)
             + MAX(CASE WHEN oc.product_id IS NOT NULL AND (COALESCE(ocol.quantity_normal, 0) + COALESCE(ocol.quantity_foil, 0)) > 0 THEN 1 ELSE 0 END) AS owned_cards,
           COALESCE(SUM(dc.quantity * COALESCE(c.market_price, c.foil_market_price, 0.0)), 0.0)
             + MAX(CASE WHEN oc.product_id IS NOT NULL THEN COALESCE(oc.market_price, oc.foil_market_price, 0.0) ELSE 0.0 END) AS est_cost,
           COALESCE(SUM(MAX(0, dc.quantity - (COALESCE(col.quantity_normal, 0) + COALESCE(col.quantity_foil, 0))) * COALESCE(c.market_price, c.foil_market_price, 0.0)), 0.0)
             + MAX(CASE WHEN oc.product_id IS NOT NULL AND (COALESCE(ocol.quantity_normal, 0) + COALESCE(ocol.quantity_foil, 0)) = 0 THEN COALESCE(oc.market_price, oc.foil_market_price, 0.0) ELSE 0.0 END) AS missing_cost,
           d.created_at,
           d.updated_at
         FROM decks d
         LEFT JOIN cards oc ON oc.product_id = d.oshi_product_id
         LEFT JOIN collection ocol ON ocol.product_id = d.oshi_product_id
         LEFT JOIN deck_cards dc ON dc.deck_id = d.id
         LEFT JOIN cards c ON c.product_id = dc.product_id
         LEFT JOIN collection col ON col.product_id = dc.product_id
         GROUP BY d.id
         ORDER BY d.updated_at DESC, d.id DESC",
        &[],
        |r| {
            let total_cards = r.get_i64(10);
            let owned_cards = r.get_i64(11);
            let coverage = if total_cards > 0 {
                (owned_cards as f64 / total_cards as f64) * 100.0
            } else {
                0.0
            };
            Ok(DeckSummary {
                id: r.get_i64(0),
                name: r.get_string(1),
                oshi_product_id: r.get_opt_i64(2),
                oshi_name: r.get_opt_string(3),
                oshi_card_number: r.get_opt_string(4),
                oshi_color: r.get_opt_string(5),
                oshi_image_url: r.get_opt_string(6),
                description: r.get_string(7),
                main_count: r.get_i64(8),
                cheer_count: r.get_i64(9),
                owned_coverage_pct: coverage,
                estimated_cost_usd: r.get_f64(12),
                missing_cost_usd: r.get_f64(13),
                created_at: r.get_string(14),
                updated_at: r.get_string(15),
            })
        },
    )?;

    Ok(Json(decks))
}

async fn create_deck(
    State(state): State<AppState>,
    Json(body): Json<SaveDeckRequest>,
) -> Result<(StatusCode, Json<DeckDetail>), ApiError> {
    let name = body.name.trim();
    if name.is_empty() {
        return Err(ApiError::bad_request("Deck name cannot be empty"));
    }
    let now = Utc::now().to_rfc3339();
    let desc = body.description.unwrap_or_default();

    let deck_id = state.db.with_transaction(|tx| {
        tx.execute(
            "INSERT INTO decks (name, oshi_product_id, description, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            &[
                SqlValue::from(name),
                SqlValue::from(body.oshi_product_id),
                SqlValue::from(desc.as_str()),
                SqlValue::from(now.as_str()),
                SqlValue::from(now.as_str()),
            ],
        )?;
        let id = tx.last_insert_rowid();
        if let Some(cards) = &body.cards {
            for item in cards {
                if item.quantity > 0 {
                    tx.execute(
                        "INSERT INTO deck_cards (deck_id, product_id, zone, quantity)
                         SELECT ?1, ?2, ?3, ?4
                         WHERE EXISTS (SELECT 1 FROM cards WHERE product_id = ?2)
                         ON CONFLICT(deck_id, product_id, zone) DO UPDATE SET quantity = excluded.quantity",
                        &[
                            SqlValue::from(id),
                            SqlValue::from(item.product_id),
                            SqlValue::from(item.zone.as_str()),
                            SqlValue::from(item.quantity),
                        ],
                    )?;
                }
            }
        }
        Ok(id)
    })?;

    let detail = fetch_deck_detail(&state.db, deck_id)?
        .ok_or_else(|| ApiError::not_found("Created deck not found"))?;
    Ok((StatusCode::CREATED, Json(detail)))
}

async fn get_deck(
    State(state): State<AppState>,
    Path(deck_id): Path<i64>,
) -> Result<Json<DeckDetail>, ApiError> {
    let detail = fetch_deck_detail(&state.db, deck_id)?
        .ok_or_else(|| ApiError::not_found(format!("Deck {deck_id} not found")))?;
    Ok(Json(detail))
}

async fn update_deck(
    State(state): State<AppState>,
    Path(deck_id): Path<i64>,
    Json(body): Json<SaveDeckRequest>,
) -> Result<Json<DeckDetail>, ApiError> {
    let name = body.name.trim();
    if name.is_empty() {
        return Err(ApiError::bad_request("Deck name cannot be empty"));
    }
    let now = Utc::now().to_rfc3339();
    let desc = body.description.unwrap_or_default();

    let updated_rows = state.db.with_transaction(|tx| {
        let changed = tx.execute(
            "UPDATE decks SET name = ?1, oshi_product_id = ?2, description = ?3, updated_at = ?4
             WHERE id = ?5",
            &[
                SqlValue::from(name),
                SqlValue::from(body.oshi_product_id),
                SqlValue::from(desc.as_str()),
                SqlValue::from(now.as_str()),
                SqlValue::from(deck_id),
            ],
        )?;
        if changed == 0 {
            return Ok(0);
        }
        if let Some(cards) = &body.cards {
            tx.execute("DELETE FROM deck_cards WHERE deck_id = ?1", &[SqlValue::from(deck_id)])?;
            for item in cards {
                if item.quantity > 0 {
                    tx.execute(
                        "INSERT INTO deck_cards (deck_id, product_id, zone, quantity)
                         SELECT ?1, ?2, ?3, ?4
                         WHERE EXISTS (SELECT 1 FROM cards WHERE product_id = ?2)",
                        &[
                            SqlValue::from(deck_id),
                            SqlValue::from(item.product_id),
                            SqlValue::from(item.zone.as_str()),
                            SqlValue::from(item.quantity),
                        ],
                    )?;
                }
            }
        }
        Ok(changed)
    })?;

    if updated_rows == 0 {
        return Err(ApiError::not_found(format!("Deck {deck_id} not found")));
    }

    let detail = fetch_deck_detail(&state.db, deck_id)?
        .ok_or_else(|| ApiError::not_found("Deck not found"))?;
    Ok(Json(detail))
}

async fn delete_deck(
    State(state): State<AppState>,
    Path(deck_id): Path<i64>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let changed = state.db.execute(
        "DELETE FROM decks WHERE id = ?1",
        &[SqlValue::from(deck_id)],
    )?;
    if changed == 0 {
        return Err(ApiError::not_found(format!("Deck {deck_id} not found")));
    }
    Ok(Json(serde_json::json!({ "deleted": true })))
}

fn fetch_deck_detail(db: &Database, deck_id: i64) -> Result<Option<DeckDetail>> {
    let header = db.query_row_opt(
        "SELECT id, name, oshi_product_id, description, created_at, updated_at
         FROM decks WHERE id = ?1",
        &[SqlValue::from(deck_id)],
        |r| {
            Ok((
                r.get_i64(0),
                r.get_string(1),
                r.get_opt_i64(2),
                r.get_string(3),
                r.get_string(4),
                r.get_string(5),
            ))
        },
    )?;

    let Some((id, name, oshi_product_id, description, created_at, updated_at)) = header else {
        return Ok(None);
    };

    let cards = db.query_map(
        "SELECT
           dc.product_id,
           dc.zone,
           dc.quantity,
           COALESCE(col.quantity_normal, 0) + COALESCE(col.quantity_foil, 0) AS owned_qty,
           c.name,
           c.card_number,
           c.card_type,
           c.bloom_level,
           c.color,
           c.rarity,
           c.effect_text,
           c.image_url,
           COALESCE(c.market_price, c.foil_market_price)
         FROM deck_cards dc
         JOIN cards c ON c.product_id = dc.product_id
         LEFT JOIN collection col ON col.product_id = dc.product_id
         WHERE dc.deck_id = ?1
         ORDER BY dc.zone ASC, c.card_number ASC, c.name ASC",
        &[SqlValue::from(deck_id)],
        |r| {
            Ok(DeckCardItem {
                product_id: r.get_i64(0),
                zone: r.get_string(1),
                quantity: r.get_i64(2),
                owned_quantity: r.get_i64(3),
                name: r.get_string(4),
                card_number: r.get_string(5),
                card_type: r.get_string(6),
                bloom_level: r.get_string(7),
                color: r.get_string(8),
                rarity: r.get_string(9),
                effect_text: r.get_string(10),
                image_url: r.get_string(11),
                market_price: r.get_opt_f64(12),
            })
        },
    )?;

    let oshi_card = if let Some(oshi_pid) = oshi_product_id {
        db.query_row_opt(
            "SELECT
               c.product_id,
               COALESCE(col.quantity_normal, 0) + COALESCE(col.quantity_foil, 0) AS owned_qty,
               c.name,
               c.card_number,
               c.card_type,
               c.bloom_level,
               c.color,
               c.rarity,
               c.effect_text,
               c.image_url,
               COALESCE(c.market_price, c.foil_market_price)
             FROM cards c
             LEFT JOIN collection col ON col.product_id = c.product_id
             WHERE c.product_id = ?1",
            &[SqlValue::from(oshi_pid)],
            |r| {
                Ok(DeckCardItem {
                    product_id: r.get_i64(0),
                    zone: "oshi".to_string(),
                    quantity: 1,
                    owned_quantity: r.get_i64(1),
                    name: r.get_string(2),
                    card_number: r.get_string(3),
                    card_type: r.get_string(4),
                    bloom_level: r.get_string(5),
                    color: r.get_string(6),
                    rarity: r.get_string(7),
                    effect_text: r.get_string(8),
                    image_url: r.get_string(9),
                    market_price: r.get_opt_f64(10),
                })
            },
        )?
    } else {
        None
    };

    Ok(Some(DeckDetail {
        id,
        name,
        oshi_product_id,
        oshi_card,
        description,
        cards,
        created_at,
        updated_at,
    }))
}

pub fn read_exchange_rate_config(db: &Database) -> Result<ExchangeRateConfig> {
    let existing = db.query_row_opt(
        "SELECT rate_clp_per_usd, source, observed_date, updated_at
         FROM exchange_rate_config WHERE id = 1",
        &[],
        |r| {
            Ok(ExchangeRateConfig {
                rate_clp_per_usd: r.get_f64(0),
                source: r.get_string(1),
                observed_date: r.get_string(2),
                updated_at: r.get_string(3),
            })
        },
    )?;

    if let Some(cfg) = existing {
        return Ok(cfg);
    }

    let now = Utc::now().to_rfc3339();
    Ok(ExchangeRateConfig {
        rate_clp_per_usd: 1007.79,
        source: "Referencia local".to_string(),
        observed_date: now.chars().take(10).collect(),
        updated_at: now,
    })
}

pub fn save_exchange_rate_config(
    db: &Database,
    resources_dir: &std::path::Path,
    rate_clp_per_usd: f64,
    source: String,
    observed_date: String,
) -> Result<ExchangeRateConfig> {
    let now = Utc::now().to_rfc3339();
    let cfg = ExchangeRateConfig {
        rate_clp_per_usd,
        source,
        observed_date,
        updated_at: now,
    };

    db.execute(
        "INSERT INTO exchange_rate_config (id, rate_clp_per_usd, source, observed_date, updated_at)
         VALUES (1, ?1, ?2, ?3, ?4)
         ON CONFLICT(id) DO UPDATE SET
           rate_clp_per_usd = excluded.rate_clp_per_usd,
           source = excluded.source,
           observed_date = excluded.observed_date,
           updated_at = excluded.updated_at",
        &[
            SqlValue::from(cfg.rate_clp_per_usd),
            SqlValue::from(cfg.source.as_str()),
            SqlValue::from(cfg.observed_date.as_str()),
            SqlValue::from(cfg.updated_at.as_str()),
        ],
    )?;

    if resources_dir.is_dir() {
        let rate_path = resources_dir.join("exchange_rate.json");
        if let Ok(json_str) = serde_json::to_string_pretty(&cfg) {
            let _ = std::fs::write(rate_path, json_str);
        }
    }

    Ok(cfg)
}

async fn get_exchange_rate(
    State(state): State<AppState>,
) -> Result<Json<ExchangeRateConfig>, ApiError> {
    let cfg = read_exchange_rate_config(&state.db)?;
    Ok(Json(cfg))
}

async fn update_exchange_rate(
    State(state): State<AppState>,
    Json(body): Json<UpdateExchangeRateRequest>,
) -> Result<Json<ExchangeRateConfig>, ApiError> {
    if !body.rate_clp_per_usd.is_finite() || body.rate_clp_per_usd <= 0.0 {
        return Err(ApiError::bad_request(
            "La tasa CLP por USD debe ser mayor a 0",
        ));
    }
    let now = Utc::now().to_rfc3339();
    let source = body
        .source
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "Manual".to_string());
    let observed_date = body
        .observed_date
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| now.chars().take(10).collect());

    let cfg = save_exchange_rate_config(
        &state.db,
        &state.resources_dir,
        (body.rate_clp_per_usd * 100.0).round() / 100.0,
        source,
        observed_date,
    )?;
    Ok(Json(cfg))
}

async fn refresh_exchange_rate(
    State(state): State<AppState>,
) -> Result<Json<ExchangeRateConfig>, ApiError> {
    let script_path = state
        .resources_dir
        .parent()
        .unwrap_or_else(|| std::path::Path::new("."))
        .join("scripts")
        .join("fetch_clp_rate.py");

    if script_path.is_file() {
        let _ = tokio::process::Command::new("python3")
            .arg(&script_path)
            .output()
            .await;
    }

    let rate_path = state.resources_dir.join("exchange_rate.json");
    if rate_path.is_file() {
        if let Ok(raw) = std::fs::read_to_string(&rate_path) {
            if let Ok(parsed) = serde_json::from_str::<ExchangeRateConfig>(&raw) {
                if parsed.rate_clp_per_usd.is_finite() && parsed.rate_clp_per_usd > 0.0 {
                    let saved = save_exchange_rate_config(
                        &state.db,
                        &state.resources_dir,
                        parsed.rate_clp_per_usd,
                        parsed.source,
                        parsed.observed_date,
                    )?;
                    return Ok(Json(saved));
                }
            }
        }
    }

    let existing = read_exchange_rate_config(&state.db)?;
    Ok(Json(existing))
}

/* ================= TRADING / BUY / SELL / SWAP ================= */

#[derive(Debug, Deserialize)]
struct DeleteTradeQuery {
    revert: Option<bool>,
}

fn round2(val: f64) -> f64 {
    if !val.is_finite() {
        0.0
    } else {
        (val * 100.0).round() / 100.0
    }
}

fn clamp_usd(val: f64) -> f64 {
    if !val.is_finite() {
        0.0
    } else {
        round2(val.clamp(0.0, 1_000_000.0))
    }
}

fn clamp_original_cash(val: f64) -> f64 {
    if !val.is_finite() {
        0.0
    } else {
        round2(val.clamp(0.0, 1_000_000_000.0))
    }
}

fn normalize_condition(cond: Option<&str>) -> String {
    match cond.unwrap_or("NM").trim() {
        "NM" | "LP" | "MP" | "HP" | "DMG" => cond.unwrap_or("NM").trim().to_string(),
        _ => "NM".to_string(),
    }
}

pub fn classify_trade_verdict(balance_usd: f64, roi_pct: f64) -> &'static str {
    if balance_usd.abs() < 0.50 && roi_pct.abs() < 5.0 {
        "fair"
    } else if balance_usd > 0.0 && (roi_pct >= 5.0 || balance_usd >= 5.0) {
        "worth"
    } else if balance_usd < 0.0 && (roi_pct <= -5.0 || balance_usd <= -5.0) {
        "not_worth"
    } else {
        "fair"
    }
}

fn compute_roi_pct(balance_usd: f64, in_total: f64, out_total: f64) -> f64 {
    if out_total > 0.0 {
        round2((balance_usd / out_total) * 100.0)
    } else if in_total > 0.0 {
        100.0
    } else {
        0.0
    }
}

fn normalize_trade_items(
    db: &Database,
    raw_items: Option<&[SaveTradeItemInput]>,
) -> Result<Vec<TradeItemStored>> {
    let mut order: Vec<i64> = Vec::new();
    let mut by_pid: HashMap<i64, TradeItemStored> = HashMap::new();

    for raw in raw_items.unwrap_or(&[]) {
        if raw.product_id <= 0 || raw.quantity <= 0 {
            continue;
        }
        let card_opt = db.query_row_opt(
            "SELECT COALESCE(market_price, foil_market_price, 0.0) FROM cards WHERE product_id = ?1",
            &[SqlValue::from(raw.product_id)],
            |r| Ok(r.get_f64(0)),
        )?;
        let Some(default_market) = card_opt else {
            continue;
        };

        let qty = raw.quantity.clamp(1, 999);
        let unit_market = raw
            .unit_market_usd
            .filter(|v| v.is_finite() && *v >= 0.0)
            .map(clamp_usd)
            .unwrap_or_else(|| clamp_usd(default_market));
        let unit_cost = raw
            .unit_cost_usd
            .filter(|v| v.is_finite() && *v >= 0.0)
            .map(clamp_usd);
        let condition = normalize_condition(raw.condition.as_deref());

        if let Some(existing) = by_pid.get_mut(&raw.product_id) {
            let prev_q = existing.quantity;
            let new_q = (prev_q + qty).clamp(1, 999);
            existing.unit_market_usd = round2(
                ((existing.unit_market_usd * prev_q as f64) + (unit_market * qty as f64))
                    / (prev_q + qty) as f64,
            );
            if let (Some(old_c), Some(new_c)) = (existing.unit_cost_usd, unit_cost) {
                existing.unit_cost_usd = Some(round2(
                    ((old_c * prev_q as f64) + (new_c * qty as f64)) / (prev_q + qty) as f64,
                ));
            } else if existing.unit_cost_usd.is_none() {
                existing.unit_cost_usd = unit_cost;
            }
            existing.quantity = new_q;
        } else {
            if order.len() >= 50 {
                continue;
            }
            order.push(raw.product_id);
            by_pid.insert(
                raw.product_id,
                TradeItemStored {
                    product_id: raw.product_id,
                    quantity: qty,
                    unit_market_usd: unit_market,
                    unit_cost_usd: unit_cost,
                    condition,
                },
            );
        }
    }

    Ok(order
        .into_iter()
        .filter_map(|pid| by_pid.remove(&pid))
        .collect())
}

fn apply_trade_to_collection(
    db: &Database,
    trade_type: &str,
    cash_paid_usd: f64,
    items_in: &mut [TradeItemStored],
    items_out: &mut [TradeItemStored],
) -> Result<Vec<i64>> {
    if trade_type == "buy" && cash_paid_usd > 0.0 {
        let total_in_market: f64 = items_in
            .iter()
            .map(|i| i.quantity as f64 * i.unit_market_usd)
            .sum();
        let total_in_units: i64 = items_in.iter().map(|i| i.quantity).sum();
        for item in items_in.iter_mut() {
            if item.unit_cost_usd.is_none() {
                if total_in_market > 0.0 {
                    item.unit_cost_usd =
                        Some(clamp_usd(item.unit_market_usd * (cash_paid_usd / total_in_market)));
                } else if total_in_units > 0 {
                    item.unit_cost_usd = Some(clamp_usd(cash_paid_usd / total_in_units as f64));
                }
            }
        }
    }

    let mut wishlist_fulfilled_ids = Vec::new();
    for item in items_in.iter() {
        let Some(existing) = fetch_single_card_with_collection(db, item.product_id)? else {
            continue;
        };
        let prev_qty = existing.total_owned.max(0);
        let next_qty = (prev_qty + item.quantity).clamp(0, 9999);
        let next_purchase_price = match item.unit_cost_usd {
            Some(cost) => {
                if prev_qty > 0 {
                    if let Some(old_cost) = existing.purchase_price {
                        Some(clamp_usd(
                            ((old_cost * prev_qty as f64) + (cost * item.quantity as f64))
                                / next_qty as f64,
                        ))
                    } else {
                        Some(clamp_usd(cost))
                    }
                } else {
                    Some(clamp_usd(cost))
                }
            }
            None => existing.purchase_price,
        };

        let mut next_wishlist = existing.is_wishlist;
        if existing.is_wishlist && next_qty >= existing.wishlist_target_qty {
            next_wishlist = false;
            wishlist_fulfilled_ids.push(item.product_id);
        }

        let next_condition = if prev_qty == 0 && existing.updated_at.is_none() {
            item.condition.as_str()
        } else {
            existing.condition.as_str()
        };

        persist_collection_state(
            db,
            item.product_id,
            next_qty,
            0,
            next_condition,
            &existing.language,
            next_purchase_price,
            existing.is_favorite,
            next_wishlist,
            existing.wishlist_target_qty,
            &existing.notes,
        )?;
    }

    for item in items_out.iter_mut() {
        let Some(existing) = fetch_single_card_with_collection(db, item.product_id)? else {
            continue;
        };
        if item.unit_cost_usd.is_none() && existing.purchase_price.is_some() {
            item.unit_cost_usd = existing.purchase_price;
        }
        let prev_qty = existing.total_owned.max(0);
        let next_qty = (prev_qty - item.quantity).max(0);

        persist_collection_state(
            db,
            item.product_id,
            next_qty,
            0,
            &existing.condition,
            &existing.language,
            existing.purchase_price,
            existing.is_favorite,
            existing.is_wishlist,
            existing.wishlist_target_qty,
            &existing.notes,
        )?;
    }

    Ok(wishlist_fulfilled_ids)
}

fn revert_trade_from_collection(
    db: &Database,
    applied: bool,
    items_in: &[TradeItemStored],
    items_out: &[TradeItemStored],
    wishlist_fulfilled_ids: &[i64],
) -> Result<bool> {
    if !applied {
        return Ok(false);
    }
    let fulfilled_set: HashSet<i64> = wishlist_fulfilled_ids.iter().copied().collect();

    for item in items_in {
        let Some(existing) = fetch_single_card_with_collection(db, item.product_id)? else {
            continue;
        };
        let next_qty = (existing.total_owned.max(0) - item.quantity).max(0);
        let next_wishlist = if fulfilled_set.contains(&item.product_id) {
            true
        } else {
            existing.is_wishlist
        };
        persist_collection_state(
            db,
            item.product_id,
            next_qty,
            0,
            &existing.condition,
            &existing.language,
            existing.purchase_price,
            existing.is_favorite,
            next_wishlist,
            existing.wishlist_target_qty,
            &existing.notes,
        )?;
    }

    for item in items_out {
        let Some(existing) = fetch_single_card_with_collection(db, item.product_id)? else {
            continue;
        };
        let next_qty = (existing.total_owned.max(0) + item.quantity).clamp(0, 9999);
        let next_purchase_price = if existing.purchase_price.is_none() && item.unit_cost_usd.is_some() {
            item.unit_cost_usd
        } else {
            existing.purchase_price
        };
        persist_collection_state(
            db,
            item.product_id,
            next_qty,
            0,
            &existing.condition,
            &existing.language,
            next_purchase_price,
            existing.is_favorite,
            existing.is_wishlist,
            existing.wishlist_target_qty,
            &existing.notes,
        )?;
    }

    Ok(true)
}

struct StoredTradeRow {
    id: i64,
    trade_type: String,
    date: String,
    counterparty: String,
    notes: String,
    currency_input: String,
    exchange_rate_used: f64,
    cash_paid_usd: f64,
    cash_received_usd: f64,
    cash_paid_original: f64,
    cash_received_original: f64,
    items_in: Vec<TradeItemStored>,
    items_out: Vec<TradeItemStored>,
    applied_to_collection: bool,
    wishlist_fulfilled_ids: Vec<i64>,
    created_at: String,
    updated_at: String,
}

fn read_trade_row(r: &Row) -> Result<StoredTradeRow> {
    let items_in_json = r.get_string(11);
    let items_out_json = r.get_string(12);
    let wishlist_json = r.get_string(14);
    Ok(StoredTradeRow {
        id: r.get_i64(0),
        trade_type: r.get_string(1),
        date: r.get_string(2),
        counterparty: r.get_string(3),
        notes: r.get_string(4),
        currency_input: r.get_string(5),
        exchange_rate_used: r.get_f64(6),
        cash_paid_usd: r.get_f64(7),
        cash_received_usd: r.get_f64(8),
        cash_paid_original: r.get_f64(9),
        cash_received_original: r.get_f64(10),
        items_in: serde_json::from_str(&items_in_json).unwrap_or_default(),
        items_out: serde_json::from_str(&items_out_json).unwrap_or_default(),
        applied_to_collection: r.get_bool(13),
        wishlist_fulfilled_ids: serde_json::from_str(&wishlist_json).unwrap_or_default(),
        created_at: r.get_string(15),
        updated_at: r.get_string(16),
    })
}

fn load_card_lookup_map(
    db: &Database,
    product_ids: &HashSet<i64>,
) -> Result<HashMap<i64, CardWithCollection>> {
    if product_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let placeholders: Vec<String> = (1..=product_ids.len()).map(|i| format!("?{i}")).collect();
    let binds: Vec<SqlValue> = product_ids.iter().copied().map(SqlValue::from).collect();
    let sql = format!(
        "SELECT {CARD_WITH_COLLECTION_SELECT}
         FROM cards c
         LEFT JOIN collection col ON col.product_id = c.product_id
         WHERE c.product_id IN ({})",
        placeholders.join(",")
    );
    let rows = db.query_map(&sql, &binds, map_card_with_collection)?;
    Ok(rows.into_iter().map(|c| (c.card.product_id, c)).collect())
}

fn enrich_trade_item(
    stored: &TradeItemStored,
    lookup: &HashMap<i64, CardWithCollection>,
) -> TradeItemEnriched {
    let card_col = lookup.get(&stored.product_id);
    TradeItemEnriched {
        product_id: stored.product_id,
        quantity: stored.quantity,
        unit_market_usd: stored.unit_market_usd,
        unit_cost_usd: stored.unit_cost_usd,
        condition: stored.condition.clone(),
        name: card_col
            .map(|c| c.card.name.clone())
            .unwrap_or_else(|| format!("#{}", stored.product_id)),
        card_number: card_col
            .map(|c| c.card.card_number.clone())
            .unwrap_or_default(),
        edition_name: card_col
            .map(|c| c.card.edition_name.clone())
            .unwrap_or_default(),
        edition_abbr: card_col
            .map(|c| c.card.edition_abbr.clone())
            .unwrap_or_default(),
        rarity: card_col.map(|c| c.card.rarity.clone()).unwrap_or_default(),
        color: card_col.map(|c| c.card.color.clone()).unwrap_or_default(),
        card_type: card_col
            .map(|c| c.card.card_type.clone())
            .unwrap_or_default(),
        image_url: card_col
            .map(|c| c.card.image_url.clone())
            .unwrap_or_default(),
        item_category: card_col
            .map(|c| c.card.item_category.clone())
            .unwrap_or_else(|| "card".to_string()),
        current_market_usd: card_col.and_then(|c| c.card.market_price.or(c.card.foil_market_price)),
        owned_quantity: card_col.map(|c| c.total_owned).unwrap_or(0),
        is_wishlist: card_col.map(|c| c.is_wishlist).unwrap_or(false),
        wishlist_target_qty: card_col.map(|c| c.wishlist_target_qty).unwrap_or(1),
    }
}

fn build_trade_detail(
    row: StoredTradeRow,
    lookup: &HashMap<i64, CardWithCollection>,
) -> TradeDetail {
    let items_in: Vec<TradeItemEnriched> = row
        .items_in
        .iter()
        .map(|i| enrich_trade_item(i, lookup))
        .collect();
    let items_out: Vec<TradeItemEnriched> = row
        .items_out
        .iter()
        .map(|i| enrich_trade_item(i, lookup))
        .collect();

    let in_value_at_deal_usd = round2(
        items_in
            .iter()
            .map(|i| i.quantity as f64 * i.unit_market_usd)
            .sum(),
    );
    let out_value_at_deal_usd = round2(
        items_out
            .iter()
            .map(|i| i.quantity as f64 * i.unit_market_usd)
            .sum(),
    );
    let in_total_at_deal = in_value_at_deal_usd + row.cash_received_usd;
    let out_total_at_deal = out_value_at_deal_usd + row.cash_paid_usd;
    let deal_balance_usd = round2(in_total_at_deal - out_total_at_deal);
    let deal_roi_pct = compute_roi_pct(deal_balance_usd, in_total_at_deal, out_total_at_deal);
    let verdict_at_deal = classify_trade_verdict(deal_balance_usd, deal_roi_pct).to_string();

    let in_value_now_usd = round2(
        items_in
            .iter()
            .map(|i| i.quantity as f64 * i.current_market_usd.unwrap_or(i.unit_market_usd))
            .sum(),
    );
    let out_value_now_usd = round2(
        items_out
            .iter()
            .map(|i| i.quantity as f64 * i.current_market_usd.unwrap_or(i.unit_market_usd))
            .sum(),
    );
    let in_total_now = in_value_now_usd + row.cash_received_usd;
    let out_total_now = out_value_now_usd + row.cash_paid_usd;
    let current_balance_usd = round2(in_total_now - out_total_now);
    let current_roi_pct = compute_roi_pct(current_balance_usd, in_total_now, out_total_now);
    let verdict_now = classify_trade_verdict(current_balance_usd, current_roi_pct).to_string();

    let (out_cost_basis_usd, realized_profit_usd) =
        if !items_out.is_empty() && items_out.iter().all(|i| i.unit_cost_usd.is_some()) {
            let cost_basis = round2(
                items_out
                    .iter()
                    .map(|i| i.quantity as f64 * i.unit_cost_usd.unwrap_or(0.0))
                    .sum(),
            );
            let realized = round2(
                (row.cash_received_usd + in_value_at_deal_usd) - row.cash_paid_usd - cost_basis,
            );
            (Some(cost_basis), Some(realized))
        } else {
            (None, None)
        };

    TradeDetail {
        id: row.id,
        trade_type: row.trade_type,
        date: row.date,
        counterparty: row.counterparty,
        notes: row.notes,
        currency_input: row.currency_input,
        exchange_rate_used: row.exchange_rate_used,
        cash_paid_usd: row.cash_paid_usd,
        cash_received_usd: row.cash_received_usd,
        cash_paid_original: row.cash_paid_original,
        cash_received_original: row.cash_received_original,
        items_in,
        items_out,
        applied_to_collection: row.applied_to_collection,
        wishlist_fulfilled_ids: row.wishlist_fulfilled_ids,
        in_value_at_deal_usd,
        out_value_at_deal_usd,
        deal_balance_usd,
        deal_roi_pct,
        verdict_at_deal,
        in_value_now_usd,
        out_value_now_usd,
        current_balance_usd,
        current_roi_pct,
        verdict_now,
        out_cost_basis_usd,
        realized_profit_usd,
        created_at: row.created_at,
        updated_at: row.updated_at,
    }
}

fn format_trade_highlight_label(trade: &TradeDetail) -> String {
    let kind = match trade.trade_type.as_str() {
        "buy" => "Compra",
        "sell" => "Venta",
        _ => "Intercambio",
    };
    let head = trade
        .items_in
        .first()
        .or_else(|| trade.items_out.first())
        .map(|i| i.name.as_str())
        .unwrap_or("Movimiento");
    if trade.counterparty.is_empty() {
        format!("{kind}: {head}")
    } else {
        format!("{kind}: {head} ({})", trade.counterparty)
    }
}

fn compute_trade_summary(items: &[TradeDetail]) -> TradeSummary {
    let total_trades = items.len() as i64;
    let mut buy_count = 0;
    let mut sell_count = 0;
    let mut trade_count = 0;
    let mut total_cash_paid_usd = 0.0;
    let mut total_cash_received_usd = 0.0;
    let mut net_worth_at_deal_usd = 0.0;
    let mut net_worth_now_usd = 0.0;
    let mut worth_count_now = 0;
    let mut fair_count_now = 0;
    let mut not_worth_count_now = 0;
    let mut worth_count_at_deal = 0;
    let mut fair_count_at_deal = 0;
    let mut not_worth_count_at_deal = 0;
    let mut wishlist_fulfilled_total = 0;
    let mut best_trade: Option<&TradeDetail> = None;

    for t in items {
        match t.trade_type.as_str() {
            "buy" => buy_count += 1,
            "sell" => sell_count += 1,
            _ => trade_count += 1,
        }
        total_cash_paid_usd += t.cash_paid_usd;
        total_cash_received_usd += t.cash_received_usd;
        net_worth_at_deal_usd += t.deal_balance_usd;
        net_worth_now_usd += t.current_balance_usd;
        wishlist_fulfilled_total += t.wishlist_fulfilled_ids.len() as i64;

        match t.verdict_now.as_str() {
            "worth" => worth_count_now += 1,
            "not_worth" => not_worth_count_now += 1,
            _ => fair_count_now += 1,
        }
        match t.verdict_at_deal.as_str() {
            "worth" => worth_count_at_deal += 1,
            "not_worth" => not_worth_count_at_deal += 1,
            _ => fair_count_at_deal += 1,
        }

        if best_trade
            .map(|b| t.current_balance_usd > b.current_balance_usd)
            .unwrap_or(true)
        {
            best_trade = Some(t);
        }
    }

    let worth_rate_now_pct = if total_trades > 0 {
        round2((worth_count_now as f64 / total_trades as f64) * 100.0)
    } else {
        0.0
    };
    let worth_rate_at_deal_pct = if total_trades > 0 {
        round2((worth_count_at_deal as f64 / total_trades as f64) * 100.0)
    } else {
        0.0
    };

    TradeSummary {
        total_trades,
        buy_count,
        sell_count,
        trade_count,
        total_cash_paid_usd: round2(total_cash_paid_usd),
        total_cash_received_usd: round2(total_cash_received_usd),
        net_cashflow_usd: round2(total_cash_received_usd - total_cash_paid_usd),
        net_worth_at_deal_usd: round2(net_worth_at_deal_usd),
        net_worth_now_usd: round2(net_worth_now_usd),
        worth_count_now,
        fair_count_now,
        not_worth_count_now,
        worth_count_at_deal,
        fair_count_at_deal,
        not_worth_count_at_deal,
        worth_rate_now_pct,
        worth_rate_at_deal_pct,
        wishlist_fulfilled_total,
        best_trade_id: best_trade.map(|b| b.id),
        best_trade_label: best_trade.map(format_trade_highlight_label),
        best_trade_gain_usd: best_trade.map(|b| b.current_balance_usd),
    }
}

fn fetch_trade_detail_by_id(db: &Database, trade_id: i64) -> Result<Option<TradeDetail>> {
    let row = db.query_row_opt(
        "SELECT id, trade_type, trade_date, counterparty, notes, currency_input,
                exchange_rate_used, cash_paid_usd, cash_received_usd,
                cash_paid_original, cash_received_original,
                items_in_json, items_out_json, applied_to_collection,
                wishlist_fulfilled_json, created_at, updated_at
         FROM trades WHERE id = ?1",
        &[SqlValue::from(trade_id)],
        read_trade_row,
    )?;
    let Some(row) = row else {
        return Ok(None);
    };
    let mut pids = HashSet::new();
    for item in row.items_in.iter().chain(row.items_out.iter()) {
        pids.insert(item.product_id);
    }
    let lookup = load_card_lookup_map(db, &pids)?;
    Ok(Some(build_trade_detail(row, &lookup)))
}

pub fn list_trades_response(db: &Database) -> Result<TradesListResponse> {
    let rows = db.query_map(
        "SELECT id, trade_type, trade_date, counterparty, notes, currency_input,
                exchange_rate_used, cash_paid_usd, cash_received_usd,
                cash_paid_original, cash_received_original,
                items_in_json, items_out_json, applied_to_collection,
                wishlist_fulfilled_json, created_at, updated_at
         FROM trades
         ORDER BY trade_date DESC, created_at DESC, id DESC",
        &[],
        read_trade_row,
    )?;
    let mut pids = HashSet::new();
    for row in &rows {
        for item in row.items_in.iter().chain(row.items_out.iter()) {
            pids.insert(item.product_id);
        }
    }
    let lookup = load_card_lookup_map(db, &pids)?;
    let items: Vec<TradeDetail> = rows
        .into_iter()
        .map(|row| build_trade_detail(row, &lookup))
        .collect();
    let summary = compute_trade_summary(&items);
    Ok(TradesListResponse { summary, items })
}

struct PreparedTradeData {
    trade_type: String,
    date: String,
    counterparty: String,
    notes: String,
    currency_input: String,
    exchange_rate_used: f64,
    cash_paid_usd: f64,
    cash_received_usd: f64,
    cash_paid_original: f64,
    cash_received_original: f64,
    items_in: Vec<TradeItemStored>,
    items_out: Vec<TradeItemStored>,
    apply_to_collection: bool,
}

fn prepare_trade_request(db: &Database, body: &SaveTradeRequest) -> std::result::Result<PreparedTradeData, ApiError> {
    let trade_type = body.trade_type.trim().to_lowercase();
    if !matches!(trade_type.as_str(), "buy" | "sell" | "trade") {
        return Err(ApiError::bad_request("Tipo de operación inválido (usa buy, sell o trade)"));
    }

    let now = Utc::now().to_rfc3339();
    let default_date: String = now.chars().take(10).collect();
    let date_raw = body.date.as_deref().unwrap_or("").trim();
    let date: String = if date_raw.is_empty() {
        default_date
    } else {
        date_raw.chars().take(32).collect()
    };

    let counterparty: String = body
        .counterparty
        .as_deref()
        .unwrap_or("")
        .trim()
        .chars()
        .take(120)
        .collect();
    let notes: String = body
        .notes
        .as_deref()
        .unwrap_or("")
        .trim()
        .chars()
        .take(1000)
        .collect();
    let currency_input = match body.currency_input.as_deref().unwrap_or("USD").trim() {
        "CLP" => "CLP".to_string(),
        _ => "USD".to_string(),
    };
    let default_rate = read_exchange_rate_config(db)
        .map(|r| r.rate_clp_per_usd)
        .unwrap_or(1000.0);
    let exchange_rate_used = body
        .exchange_rate_used
        .filter(|v| v.is_finite() && *v > 0.0)
        .unwrap_or(default_rate)
        .clamp(1.0, 1_000_000.0);

    let cash_paid_usd = clamp_usd(body.cash_paid_usd.unwrap_or(0.0));
    let cash_received_usd = clamp_usd(body.cash_received_usd.unwrap_or(0.0));
    let cash_paid_original = clamp_original_cash(body.cash_paid_original.unwrap_or(cash_paid_usd));
    let cash_received_original =
        clamp_original_cash(body.cash_received_original.unwrap_or(cash_received_usd));

    let items_in = normalize_trade_items(db, body.items_in.as_deref())?;
    let items_out = normalize_trade_items(db, body.items_out.as_deref())?;

    if trade_type == "buy" && items_in.is_empty() {
        return Err(ApiError::bad_request("Agrega al menos 1 carta recibida en la compra"));
    }
    if trade_type == "sell" && items_out.is_empty() {
        return Err(ApiError::bad_request("Agrega al menos 1 carta entregada en la venta"));
    }
    if items_in.is_empty() && items_out.is_empty() {
        return Err(ApiError::bad_request("El movimiento debe incluir al menos 1 carta"));
    }

    Ok(PreparedTradeData {
        trade_type,
        date,
        counterparty,
        notes,
        currency_input,
        exchange_rate_used,
        cash_paid_usd,
        cash_received_usd,
        cash_paid_original,
        cash_received_original,
        items_in,
        items_out,
        apply_to_collection: body.apply_to_collection.unwrap_or(true),
    })
}

pub fn create_trade_record(
    db: &Database,
    body: &SaveTradeRequest,
) -> std::result::Result<SaveTradeResponse, ApiError> {
    let mut prepared = prepare_trade_request(db, body)?;
    let wishlist_fulfilled_ids = if prepared.apply_to_collection {
        apply_trade_to_collection(
            db,
            &prepared.trade_type,
            prepared.cash_paid_usd,
            &mut prepared.items_in,
            &mut prepared.items_out,
        )?
    } else {
        Vec::new()
    };

    let now = Utc::now().to_rfc3339();
    let items_in_json = serde_json::to_string(&prepared.items_in).unwrap_or_else(|_| "[]".into());
    let items_out_json = serde_json::to_string(&prepared.items_out).unwrap_or_else(|_| "[]".into());
    let wishlist_json =
        serde_json::to_string(&wishlist_fulfilled_ids).unwrap_or_else(|_| "[]".into());

    let trade_id = db.with_transaction(|tx| {
        tx.execute(
            "INSERT INTO trades (
                trade_type, trade_date, counterparty, notes, currency_input,
                exchange_rate_used, cash_paid_usd, cash_received_usd,
                cash_paid_original, cash_received_original,
                items_in_json, items_out_json, applied_to_collection,
                wishlist_fulfilled_json, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
            &[
                SqlValue::from(prepared.trade_type.as_str()),
                SqlValue::from(prepared.date.as_str()),
                SqlValue::from(prepared.counterparty.as_str()),
                SqlValue::from(prepared.notes.as_str()),
                SqlValue::from(prepared.currency_input.as_str()),
                SqlValue::from(prepared.exchange_rate_used),
                SqlValue::from(prepared.cash_paid_usd),
                SqlValue::from(prepared.cash_received_usd),
                SqlValue::from(prepared.cash_paid_original),
                SqlValue::from(prepared.cash_received_original),
                SqlValue::from(items_in_json.as_str()),
                SqlValue::from(items_out_json.as_str()),
                SqlValue::from(prepared.apply_to_collection),
                SqlValue::from(wishlist_json.as_str()),
                SqlValue::from(now.as_str()),
                SqlValue::from(now.as_str()),
            ],
        )?;
        Ok(tx.last_insert_rowid())
    })?;

    let detail = fetch_trade_detail_by_id(db, trade_id)?
        .ok_or_else(|| ApiError::not_found("Created trade not found"))?;
    Ok(SaveTradeResponse {
        wishlist_fulfilled_count: wishlist_fulfilled_ids.len(),
        trade: detail,
    })
}

pub fn update_trade_record(
    db: &Database,
    trade_id: i64,
    body: &SaveTradeRequest,
) -> std::result::Result<SaveTradeResponse, ApiError> {
    let existing = db
        .query_row_opt(
            "SELECT id, trade_type, trade_date, counterparty, notes, currency_input,
                    exchange_rate_used, cash_paid_usd, cash_received_usd,
                    cash_paid_original, cash_received_original,
                    items_in_json, items_out_json, applied_to_collection,
                    wishlist_fulfilled_json, created_at, updated_at
             FROM trades WHERE id = ?1",
            &[SqlValue::from(trade_id)],
            read_trade_row,
        )?
        .ok_or_else(|| ApiError::not_found(format!("Trade {trade_id} not found")))?;

    let mut prepared = prepare_trade_request(db, body)?;
    if existing.applied_to_collection {
        revert_trade_from_collection(
            db,
            true,
            &existing.items_in,
            &existing.items_out,
            &existing.wishlist_fulfilled_ids,
        )?;
    }

    let wishlist_fulfilled_ids = if prepared.apply_to_collection {
        apply_trade_to_collection(
            db,
            &prepared.trade_type,
            prepared.cash_paid_usd,
            &mut prepared.items_in,
            &mut prepared.items_out,
        )?
    } else {
        Vec::new()
    };

    let now = Utc::now().to_rfc3339();
    let items_in_json = serde_json::to_string(&prepared.items_in).unwrap_or_else(|_| "[]".into());
    let items_out_json = serde_json::to_string(&prepared.items_out).unwrap_or_else(|_| "[]".into());
    let wishlist_json =
        serde_json::to_string(&wishlist_fulfilled_ids).unwrap_or_else(|_| "[]".into());

    db.execute(
        "UPDATE trades SET
            trade_type = ?1, trade_date = ?2, counterparty = ?3, notes = ?4,
            currency_input = ?5, exchange_rate_used = ?6,
            cash_paid_usd = ?7, cash_received_usd = ?8,
            cash_paid_original = ?9, cash_received_original = ?10,
            items_in_json = ?11, items_out_json = ?12,
            applied_to_collection = ?13, wishlist_fulfilled_json = ?14,
            updated_at = ?15
         WHERE id = ?16",
        &[
            SqlValue::from(prepared.trade_type.as_str()),
            SqlValue::from(prepared.date.as_str()),
            SqlValue::from(prepared.counterparty.as_str()),
            SqlValue::from(prepared.notes.as_str()),
            SqlValue::from(prepared.currency_input.as_str()),
            SqlValue::from(prepared.exchange_rate_used),
            SqlValue::from(prepared.cash_paid_usd),
            SqlValue::from(prepared.cash_received_usd),
            SqlValue::from(prepared.cash_paid_original),
            SqlValue::from(prepared.cash_received_original),
            SqlValue::from(items_in_json.as_str()),
            SqlValue::from(items_out_json.as_str()),
            SqlValue::from(prepared.apply_to_collection),
            SqlValue::from(wishlist_json.as_str()),
            SqlValue::from(now.as_str()),
            SqlValue::from(trade_id),
        ],
    )?;

    let detail = fetch_trade_detail_by_id(db, trade_id)?
        .ok_or_else(|| ApiError::not_found("Updated trade not found"))?;
    Ok(SaveTradeResponse {
        wishlist_fulfilled_count: wishlist_fulfilled_ids.len(),
        trade: detail,
    })
}

pub fn delete_trade_record(
    db: &Database,
    trade_id: i64,
    revert: bool,
) -> std::result::Result<bool, ApiError> {
    let existing = db
        .query_row_opt(
            "SELECT id, trade_type, trade_date, counterparty, notes, currency_input,
                    exchange_rate_used, cash_paid_usd, cash_received_usd,
                    cash_paid_original, cash_received_original,
                    items_in_json, items_out_json, applied_to_collection,
                    wishlist_fulfilled_json, created_at, updated_at
             FROM trades WHERE id = ?1",
            &[SqlValue::from(trade_id)],
            read_trade_row,
        )?
        .ok_or_else(|| ApiError::not_found(format!("Trade {trade_id} not found")))?;

    let reverted = if revert && existing.applied_to_collection {
        revert_trade_from_collection(
            db,
            true,
            &existing.items_in,
            &existing.items_out,
            &existing.wishlist_fulfilled_ids,
        )?
    } else {
        false
    };

    db.execute("DELETE FROM trades WHERE id = ?1", &[SqlValue::from(trade_id)])?;
    Ok(reverted)
}

async fn list_trades(State(state): State<AppState>) -> Result<Json<TradesListResponse>, ApiError> {
    let res = list_trades_response(&state.db)?;
    Ok(Json(res))
}

async fn create_trade(
    State(state): State<AppState>,
    Json(body): Json<SaveTradeRequest>,
) -> Result<(StatusCode, Json<SaveTradeResponse>), ApiError> {
    let created = create_trade_record(&state.db, &body)?;
    Ok((StatusCode::CREATED, Json(created)))
}

async fn update_trade(
    State(state): State<AppState>,
    Path(trade_id): Path<i64>,
    Json(body): Json<SaveTradeRequest>,
) -> Result<Json<SaveTradeResponse>, ApiError> {
    let updated = update_trade_record(&state.db, trade_id, &body)?;
    Ok(Json(updated))
}

async fn delete_trade(
    State(state): State<AppState>,
    Path(trade_id): Path<i64>,
    Query(q): Query<DeleteTradeQuery>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let reverted = delete_trade_record(&state.db, trade_id, q.revert.unwrap_or(true))?;
    Ok(Json(serde_json::json!({ "deleted": true, "reverted": reverted })))
}
