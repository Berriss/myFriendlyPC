use crate::db::sqlite::{Database, SqlValue};
use crate::models::{AuditReport, CardRecord, Edition, ExchangeRateConfig};
use crate::sanitizer;
use anyhow::{anyhow, Context, Result};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncSummary {
    pub editions_synced: usize,
    pub cards_synced: usize,
    pub skipped_already_populated: bool,
    pub synced_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GroupsFileEnvelope {
    results: Vec<GroupJsonEntry>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GroupJsonEntry {
    group_id: i64,
    name: String,
    #[serde(default)]
    abbreviation: Option<String>,
    #[serde(default)]
    is_supplemental: bool,
    #[serde(default)]
    published_on: Option<String>,
    #[serde(default)]
    modified_on: Option<String>,
}

pub fn seed_exchange_rate_if_empty(db: &Database, resources_dir: &Path) -> Result<()> {
    let existing: i64 = db
        .query_row_opt("SELECT COUNT(*) FROM exchange_rate_config", &[], |r| Ok(r.get_i64(0)))?
        .unwrap_or(0);
    if existing > 0 {
        return Ok(());
    }

    let rate_path = resources_dir.join("exchange_rate.json");
    let config = if rate_path.is_file() {
        let raw = fs::read_to_string(&rate_path)?;
        serde_json::from_str::<ExchangeRateConfig>(&raw).unwrap_or_else(|_| default_exchange_rate())
    } else {
        default_exchange_rate()
    };

    db.execute(
        "INSERT INTO exchange_rate_config (id, rate_clp_per_usd, source, observed_date, updated_at)
         VALUES (1, ?1, ?2, ?3, ?4)
         ON CONFLICT(id) DO NOTHING",
        &[
            SqlValue::from(config.rate_clp_per_usd),
            SqlValue::from(config.source.as_str()),
            SqlValue::from(config.observed_date.as_str()),
            SqlValue::from(config.updated_at.as_str()),
        ],
    )?;
    Ok(())
}

fn default_exchange_rate() -> ExchangeRateConfig {
    let now = Utc::now().to_rfc3339();
    ExchangeRateConfig {
        rate_clp_per_usd: 1007.79,
        source: "Referencia local".to_string(),
        observed_date: now.chars().take(10).collect(),
        updated_at: now,
    }
}

pub fn sync_resources_to_db(
    db: &Database,
    resources_dir: &Path,
    force: bool,
) -> Result<SyncSummary> {
    seed_exchange_rate_if_empty(db, resources_dir)?;

    let existing_count: i64 = db
        .query_row_opt("SELECT COUNT(*) FROM cards", &[], |row| Ok(row.get_i64(0)))?
        .unwrap_or(0);

    if !force && existing_count > 0 {
        let ed_count: i64 = db
            .query_row_opt("SELECT COUNT(*) FROM editions", &[], |row| Ok(row.get_i64(0)))?
            .unwrap_or(0);
        let synced_at = db
            .query_row_opt(
                "SELECT synced_at FROM audit_summary WHERE id = 1",
                &[],
                |row| Ok(row.get_string(0)),
            )?
            .unwrap_or_else(|| Utc::now().to_rfc3339());
        return Ok(SyncSummary {
            editions_synced: ed_count as usize,
            cards_synced: existing_count as usize,
            skipped_already_populated: true,
            synced_at,
        });
    }

    let editions_dir = resources_dir.join("editions");
    let (editions, cards, report): (Vec<Edition>, Vec<CardRecord>, AuditReport) =
        if editions_dir.is_dir() && has_subdirectories(&editions_dir)? {
            sanitizer::build_catalog_from_raw_resources(resources_dir)?
        } else {
            load_from_cleaned_json(resources_dir)?
        };

    let synced_at = Utc::now().to_rfc3339();
    let report_json = serde_json::to_string_pretty(&report)?;

    db.with_transaction(|tx| {
        for ed in &editions {
            tx.execute(
                "INSERT INTO editions (group_id, name, abbreviation, is_supplemental, published_on, modified_on, folder_name)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT(group_id) DO UPDATE SET
                   name = excluded.name,
                   abbreviation = excluded.abbreviation,
                   is_supplemental = excluded.is_supplemental,
                   published_on = excluded.published_on,
                   modified_on = excluded.modified_on,
                   folder_name = excluded.folder_name",
                &[
                    SqlValue::from(ed.group_id),
                    SqlValue::from(ed.name.as_str()),
                    SqlValue::from(ed.abbreviation.as_str()),
                    SqlValue::from(ed.is_supplemental),
                    SqlValue::from(ed.published_on.as_str()),
                    SqlValue::from(ed.modified_on.as_str()),
                    SqlValue::from(ed.folder_name.as_str()),
                ],
            )?;
        }

        for card in &cards {
            tx.execute(
                "INSERT INTO cards (
                    product_id, group_id, edition_name, edition_abbr, name, clean_name,
                    image_url, url, item_category, card_number, rarity, rarity_name,
                    card_type, subtype, color, bloom_level, hp, life, baton_pass, tags,
                    oshi_skill, sp_oshi_skill, keyword_text, arts1, arts2, special_rules,
                    description_text, effect_text, raw_description,
                    market_price, low_price, mid_price, high_price, direct_low_price,
                    foil_market_price, foil_low_price, price_subtype,
                    sanitized_flag, had_comma_or_html, modified_on
                 ) VALUES (
                    ?1, ?2, ?3, ?4, ?5, ?6,
                    ?7, ?8, ?9, ?10, ?11, ?12,
                    ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20,
                    ?21, ?22, ?23, ?24, ?25, ?26,
                    ?27, ?28, ?29,
                    ?30, ?31, ?32, ?33, ?34,
                    ?35, ?36, ?37,
                    ?38, ?39, ?40
                 )
                 ON CONFLICT(product_id) DO UPDATE SET
                    group_id = excluded.group_id,
                    edition_name = excluded.edition_name,
                    edition_abbr = excluded.edition_abbr,
                    name = excluded.name,
                    clean_name = excluded.clean_name,
                    image_url = excluded.image_url,
                    url = excluded.url,
                    item_category = excluded.item_category,
                    card_number = excluded.card_number,
                    rarity = excluded.rarity,
                    rarity_name = excluded.rarity_name,
                    card_type = excluded.card_type,
                    subtype = excluded.subtype,
                    color = excluded.color,
                    bloom_level = excluded.bloom_level,
                    hp = excluded.hp,
                    life = excluded.life,
                    baton_pass = excluded.baton_pass,
                    tags = excluded.tags,
                    oshi_skill = excluded.oshi_skill,
                    sp_oshi_skill = excluded.sp_oshi_skill,
                    keyword_text = excluded.keyword_text,
                    arts1 = excluded.arts1,
                    arts2 = excluded.arts2,
                    special_rules = excluded.special_rules,
                    description_text = excluded.description_text,
                    effect_text = excluded.effect_text,
                    raw_description = excluded.raw_description,
                    market_price = excluded.market_price,
                    low_price = excluded.low_price,
                    mid_price = excluded.mid_price,
                    high_price = excluded.high_price,
                    direct_low_price = excluded.direct_low_price,
                    foil_market_price = excluded.foil_market_price,
                    foil_low_price = excluded.foil_low_price,
                    price_subtype = excluded.price_subtype,
                    sanitized_flag = excluded.sanitized_flag,
                    had_comma_or_html = excluded.had_comma_or_html,
                    modified_on = excluded.modified_on",
                &[
                    SqlValue::from(card.product_id),
                    SqlValue::from(card.group_id),
                    SqlValue::from(card.edition_name.as_str()),
                    SqlValue::from(card.edition_abbr.as_str()),
                    SqlValue::from(card.name.as_str()),
                    SqlValue::from(card.clean_name.as_str()),
                    SqlValue::from(card.image_url.as_str()),
                    SqlValue::from(card.url.as_str()),
                    SqlValue::from(card.item_category.as_str()),
                    SqlValue::from(card.card_number.as_str()),
                    SqlValue::from(card.rarity.as_str()),
                    SqlValue::from(card.rarity_name.as_str()),
                    SqlValue::from(card.card_type.as_str()),
                    SqlValue::from(card.subtype.as_str()),
                    SqlValue::from(card.color.as_str()),
                    SqlValue::from(card.bloom_level.as_str()),
                    SqlValue::from(card.hp),
                    SqlValue::from(card.life),
                    SqlValue::from(card.baton_pass.as_str()),
                    SqlValue::from(card.tags.as_str()),
                    SqlValue::from(card.oshi_skill.as_str()),
                    SqlValue::from(card.sp_oshi_skill.as_str()),
                    SqlValue::from(card.keyword_text.as_str()),
                    SqlValue::from(card.arts1.as_str()),
                    SqlValue::from(card.arts2.as_str()),
                    SqlValue::from(card.special_rules.as_str()),
                    SqlValue::from(card.description_text.as_str()),
                    SqlValue::from(card.effect_text.as_str()),
                    SqlValue::from(card.raw_description.as_str()),
                    SqlValue::from(card.market_price),
                    SqlValue::from(card.low_price),
                    SqlValue::from(card.mid_price),
                    SqlValue::from(card.high_price),
                    SqlValue::from(card.direct_low_price),
                    SqlValue::from(card.foil_market_price),
                    SqlValue::from(card.foil_low_price),
                    SqlValue::from(card.price_subtype.as_str()),
                    SqlValue::from(card.sanitized_flag),
                    SqlValue::from(card.had_comma_or_html),
                    SqlValue::from(card.modified_on.as_str()),
                ],
            )?;
        }

        tx.execute(
            "INSERT INTO audit_summary (id, report_json, synced_at)
             VALUES (1, ?1, ?2)
             ON CONFLICT(id) DO UPDATE SET
               report_json = excluded.report_json,
               synced_at = excluded.synced_at",
            &[
                SqlValue::from(report_json.as_str()),
                SqlValue::from(synced_at.as_str()),
            ],
        )?;

        Ok(())
    })?;

    Ok(SyncSummary {
        editions_synced: editions.len(),
        cards_synced: cards.len(),
        skipped_already_populated: false,
        synced_at,
    })
}

fn has_subdirectories(dir: &Path) -> Result<bool> {
    for entry in fs::read_dir(dir)? {
        if entry?.path().is_dir() {
            return Ok(true);
        }
    }
    Ok(false)
}

fn load_from_cleaned_json(
    resources_dir: &Path,
) -> Result<(Vec<Edition>, Vec<CardRecord>, AuditReport)> {
    let groups_path = resources_dir.join("groups.json");
    let cards_path = resources_dir.join("cards_cleaned.json");
    if !groups_path.exists() || !cards_path.exists() {
        return Err(anyhow!(
            "Neither raw editions nor cards_cleaned.json found in {}",
            resources_dir.display()
        ));
    }

    let groups_env: GroupsFileEnvelope =
        serde_json::from_str(&fs::read_to_string(&groups_path)?)
            .context("Parsing groups.json")?;
    let editions = groups_env
        .results
        .into_iter()
        .map(|g| Edition {
            group_id: g.group_id,
            name: g.name,
            abbreviation: g.abbreviation.unwrap_or_default(),
            is_supplemental: g.is_supplemental,
            published_on: g.published_on.unwrap_or_default(),
            modified_on: g.modified_on.unwrap_or_default(),
            folder_name: String::new(),
        })
        .collect();

    let cards: Vec<CardRecord> =
        serde_json::from_str(&fs::read_to_string(&cards_path)?)
            .context("Parsing cards_cleaned.json")?;

    let audit_path = resources_dir.join("audit_report.json");
    let report: AuditReport = if audit_path.exists() {
        serde_json::from_str(&fs::read_to_string(&audit_path)?).unwrap_or_default()
    } else {
        AuditReport::default()
    };

    Ok((editions, cards, report))
}
