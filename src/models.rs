use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Edition {
    pub group_id: i64,
    pub name: String,
    pub abbreviation: String,
    pub is_supplemental: bool,
    pub published_on: String,
    pub modified_on: String,
    pub folder_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditionStats {
    pub group_id: i64,
    pub name: String,
    pub abbreviation: String,
    pub is_supplemental: bool,
    pub published_on: String,
    pub total_cards: i64,
    pub total_sealed: i64,
    pub owned_unique_cards: i64,
    pub owned_total_copies: i64,
    pub completion_pct: f64,
    pub collection_value_usd: f64,
    pub set_total_value_usd: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CardRecord {
    pub product_id: i64,
    pub group_id: i64,
    pub edition_name: String,
    pub edition_abbr: String,
    pub name: String,
    pub clean_name: String,
    pub image_url: String,
    pub url: String,
    pub item_category: String,
    pub card_number: String,
    pub rarity: String,
    pub rarity_name: String,
    pub card_type: String,
    pub subtype: String,
    pub color: String,
    pub bloom_level: String,
    pub hp: Option<i64>,
    pub life: Option<i64>,
    pub baton_pass: String,
    pub tags: String,
    pub oshi_skill: String,
    pub sp_oshi_skill: String,
    pub keyword_text: String,
    pub arts1: String,
    pub arts2: String,
    pub special_rules: String,
    pub description_text: String,
    pub effect_text: String,
    pub raw_description: String,
    pub market_price: Option<f64>,
    pub low_price: Option<f64>,
    pub mid_price: Option<f64>,
    pub high_price: Option<f64>,
    pub direct_low_price: Option<f64>,
    pub foil_market_price: Option<f64>,
    pub foil_low_price: Option<f64>,
    pub price_subtype: String,
    pub sanitized_flag: bool,
    pub had_comma_or_html: bool,
    pub modified_on: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionEntry {
    pub product_id: i64,
    pub quantity_normal: i64,
    pub quantity_foil: i64,
    pub condition: String,
    pub language: String,
    pub purchase_price: Option<f64>,
    pub is_favorite: bool,
    pub is_wishlist: bool,
    pub wishlist_target_qty: i64,
    pub notes: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CardWithCollection {
    #[serde(flatten)]
    pub card: CardRecord,
    pub quantity_normal: i64,
    pub quantity_foil: i64,
    pub total_owned: i64,
    pub condition: String,
    pub language: String,
    pub purchase_price: Option<f64>,
    pub is_favorite: bool,
    pub is_wishlist: bool,
    pub wishlist_target_qty: i64,
    pub notes: String,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CardsPageResponse {
    pub items: Vec<CardWithCollection>,
    pub total: i64,
    pub page: i64,
    pub per_page: i64,
    pub total_pages: i64,
    pub facets: FilterFacets,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilterFacets {
    pub colors: Vec<FacetCount>,
    pub rarities: Vec<FacetCount>,
    pub card_types: Vec<FacetCount>,
    pub bloom_levels: Vec<FacetCount>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FacetCount {
    pub value: String,
    pub count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExchangeRateConfig {
    pub rate_clp_per_usd: f64,
    pub source: String,
    pub observed_date: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateExchangeRateRequest {
    pub rate_clp_per_usd: f64,
    pub source: Option<String>,
    pub observed_date: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KpiSummary {
    pub total_editions: i64,
    pub catalog_total_cards: i64,
    pub catalog_total_sealed: i64,
    pub owned_unique_cards: i64,
    pub completion_pct: f64,
    pub owned_total_copies: i64,
    pub owned_normal_copies: i64,
    pub owned_foil_copies: i64,
    pub collection_market_value_usd: f64,
    pub collection_cost_basis_usd: f64,
    pub net_gain_usd: f64,
    pub favorites_count: i64,
    pub wishlist_count: i64,
    pub high_rarity_owned_copies: i64,
    pub top_owned_card: Option<TopCardHighlight>,
    pub color_breakdown: Vec<ColorBreakdown>,
    pub rarity_breakdown: Vec<RarityBreakdown>,
    pub exchange_rate: ExchangeRateConfig,
    pub last_synced_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TopCardHighlight {
    pub product_id: i64,
    pub name: String,
    pub card_number: String,
    pub rarity: String,
    pub market_price: f64,
    pub image_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColorBreakdown {
    pub color: String,
    pub catalog_count: i64,
    pub owned_unique: i64,
    pub owned_copies: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RarityBreakdown {
    pub rarity: String,
    pub rarity_name: String,
    pub catalog_count: i64,
    pub owned_unique: i64,
    pub owned_copies: i64,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default)]
pub struct CardFilterParams {
    pub q: Option<String>,
    pub group_id: Option<i64>,
    pub color: Option<String>,
    pub rarity: Option<String>,
    pub card_type: Option<String>,
    pub bloom_level: Option<String>,
    pub item_category: Option<String>,
    pub ownership: Option<String>,
    pub deck_zone: Option<String>,
    pub parallel: Option<String>,
    pub limited_only: Option<bool>,
    pub min_price: Option<f64>,
    pub max_price: Option<f64>,
    pub sort: Option<String>,
    pub page: Option<i64>,
    pub per_page: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertCollectionRequest {
    pub quantity: Option<i64>,
    pub quantity_normal: Option<i64>,
    pub quantity_foil: Option<i64>,
    pub condition: Option<String>,
    pub language: Option<String>,
    pub purchase_price: Option<f64>,
    pub is_favorite: Option<bool>,
    pub is_wishlist: Option<bool>,
    pub wishlist_target_qty: Option<i64>,
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdjustCollectionRequest {
    pub delta: Option<i64>,
    pub delta_normal: Option<i64>,
    pub delta_foil: Option<i64>,
    pub toggle_favorite: Option<bool>,
    pub toggle_wishlist: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionExportPayload {
    pub exported_at: String,
    pub version: String,
    pub entries: Vec<CollectionEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditExample {
    #[serde(alias = "product_id")]
    pub product_id: i64,
    pub name: String,
    #[serde(alias = "card_number")]
    pub card_number: String,
    #[serde(alias = "issues_fixed")]
    pub issues_fixed: Vec<String>,
    #[serde(alias = "raw_snippet")]
    pub raw_snippet: String,
    #[serde(alias = "cleaned_snippet")]
    pub cleaned_snippet: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AuditReport {
    #[serde(alias = "editions_processed")]
    pub editions_processed: i64,
    #[serde(alias = "total_products")]
    pub total_products: i64,
    #[serde(alias = "total_cards")]
    pub total_cards: i64,
    #[serde(alias = "total_sealed")]
    pub total_sealed: i64,
    #[serde(alias = "csv_rows_parsed")]
    pub csv_rows_parsed: i64,
    #[serde(alias = "naive_csv_broken_rows")]
    pub naive_csv_broken_rows: i64,
    #[serde(alias = "csv_rows_with_commas_in_text")]
    pub csv_rows_with_commas_in_text: i64,
    #[serde(alias = "csv_rows_with_newlines_in_text")]
    pub csv_rows_with_newlines_in_text: i64,
    #[serde(alias = "csv_rows_with_quotes_in_text")]
    pub csv_rows_with_quotes_in_text: i64,
    #[serde(alias = "descriptions_html_cleaned")]
    pub descriptions_html_cleaned: i64,
    #[serde(alias = "spacing_bugs_fixed")]
    pub spacing_bugs_fixed: i64,
    #[serde(alias = "typos_fixed")]
    pub typos_fixed: i64,
    #[serde(alias = "missing_card_type_inferred")]
    pub missing_card_type_inferred: i64,
    #[serde(alias = "missing_color_inferred")]
    pub missing_color_inferred: i64,
    #[serde(alias = "csv_vs_json_mismatches_resolved")]
    pub csv_vs_json_mismatches_resolved: i64,
    #[serde(alias = "duplicate_products_skipped")]
    pub duplicate_products_skipped: i64,
    #[serde(alias = "discovered_extended_keys")]
    pub discovered_extended_keys: Vec<String>,
    pub examples: Vec<AuditExample>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeckSummary {
    pub id: i64,
    pub name: String,
    pub oshi_product_id: Option<i64>,
    pub oshi_name: Option<String>,
    pub oshi_card_number: Option<String>,
    pub oshi_color: Option<String>,
    pub oshi_image_url: Option<String>,
    pub description: String,
    pub main_count: i64,
    pub cheer_count: i64,
    pub owned_coverage_pct: f64,
    pub estimated_cost_usd: f64,
    pub missing_cost_usd: f64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeckCardItem {
    pub product_id: i64,
    pub zone: String,
    pub quantity: i64,
    pub owned_quantity: i64,
    pub name: String,
    pub card_number: String,
    pub card_type: String,
    pub bloom_level: String,
    pub color: String,
    pub rarity: String,
    pub effect_text: String,
    pub image_url: String,
    pub market_price: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeckDetail {
    pub id: i64,
    pub name: String,
    pub oshi_product_id: Option<i64>,
    pub oshi_card: Option<DeckCardItem>,
    pub description: String,
    pub cards: Vec<DeckCardItem>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveDeckRequest {
    pub name: String,
    pub oshi_product_id: Option<i64>,
    pub description: Option<String>,
    pub cards: Option<Vec<DeckCardInput>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeckCardInput {
    pub product_id: i64,
    pub zone: String,
    pub quantity: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TradeItemStored {
    pub product_id: i64,
    pub quantity: i64,
    pub unit_market_usd: f64,
    pub unit_cost_usd: Option<f64>,
    pub condition: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TradeItemEnriched {
    pub product_id: i64,
    pub quantity: i64,
    pub unit_market_usd: f64,
    pub unit_cost_usd: Option<f64>,
    pub condition: String,
    pub name: String,
    pub card_number: String,
    pub edition_name: String,
    pub edition_abbr: String,
    pub rarity: String,
    pub color: String,
    pub card_type: String,
    pub image_url: String,
    pub item_category: String,
    pub current_market_usd: Option<f64>,
    pub owned_quantity: i64,
    pub is_wishlist: bool,
    pub wishlist_target_qty: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TradeDetail {
    pub id: i64,
    #[serde(rename = "type")]
    pub trade_type: String,
    pub date: String,
    pub counterparty: String,
    pub notes: String,
    pub currency_input: String,
    pub exchange_rate_used: f64,
    pub cash_paid_usd: f64,
    pub cash_received_usd: f64,
    pub cash_paid_original: f64,
    pub cash_received_original: f64,
    pub items_in: Vec<TradeItemEnriched>,
    pub items_out: Vec<TradeItemEnriched>,
    pub applied_to_collection: bool,
    pub wishlist_fulfilled_ids: Vec<i64>,
    pub in_value_at_deal_usd: f64,
    pub out_value_at_deal_usd: f64,
    pub deal_balance_usd: f64,
    pub deal_roi_pct: f64,
    pub verdict_at_deal: String,
    pub in_value_now_usd: f64,
    pub out_value_now_usd: f64,
    pub current_balance_usd: f64,
    pub current_roi_pct: f64,
    pub verdict_now: String,
    pub out_cost_basis_usd: Option<f64>,
    pub realized_profit_usd: Option<f64>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TradeSummary {
    pub total_trades: i64,
    pub buy_count: i64,
    pub sell_count: i64,
    pub trade_count: i64,
    pub total_cash_paid_usd: f64,
    pub total_cash_received_usd: f64,
    pub net_cashflow_usd: f64,
    pub net_worth_at_deal_usd: f64,
    pub net_worth_now_usd: f64,
    pub worth_count_now: i64,
    pub fair_count_now: i64,
    pub not_worth_count_now: i64,
    pub worth_count_at_deal: i64,
    pub fair_count_at_deal: i64,
    pub not_worth_count_at_deal: i64,
    pub worth_rate_now_pct: f64,
    pub worth_rate_at_deal_pct: f64,
    pub wishlist_fulfilled_total: i64,
    pub best_trade_id: Option<i64>,
    pub best_trade_label: Option<String>,
    pub best_trade_gain_usd: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TradesListResponse {
    pub summary: TradeSummary,
    pub items: Vec<TradeDetail>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveTradeItemInput {
    pub product_id: i64,
    pub quantity: i64,
    pub unit_market_usd: Option<f64>,
    pub unit_cost_usd: Option<f64>,
    pub condition: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveTradeRequest {
    #[serde(rename = "type")]
    pub trade_type: String,
    pub date: Option<String>,
    pub counterparty: Option<String>,
    pub notes: Option<String>,
    pub currency_input: Option<String>,
    pub exchange_rate_used: Option<f64>,
    pub cash_paid_usd: Option<f64>,
    pub cash_received_usd: Option<f64>,
    pub cash_paid_original: Option<f64>,
    pub cash_received_original: Option<f64>,
    pub items_in: Option<Vec<SaveTradeItemInput>>,
    pub items_out: Option<Vec<SaveTradeItemInput>>,
    pub apply_to_collection: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveTradeResponse {
    pub trade: TradeDetail,
    pub wishlist_fulfilled_count: usize,
}
