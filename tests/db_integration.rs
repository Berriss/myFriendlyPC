use hololive_ocg_tracker::api::{
    classify_trade_verdict, compute_kpis, create_trade_record, delete_trade_record,
    list_trades_response, query_cards, read_exchange_rate_config, save_exchange_rate_config,
};
use hololive_ocg_tracker::db;
use hololive_ocg_tracker::db::sqlite::{Database, SqlValue};
use hololive_ocg_tracker::importer;
use hololive_ocg_tracker::models::{CardFilterParams, SaveTradeItemInput, SaveTradeRequest};
use std::path::Path;
use tempfile::tempdir;

#[test]
fn real_resources_sync_and_collection_kpis_work() {
    let resources_dir = Path::new("resources");
    assert!(
        resources_dir.join("groups.json").exists(),
        "resources/groups.json must exist"
    );

    let tmp = tempdir().expect("create tempdir");
    let db_path = tmp.path().join("test_hololive.db");
    let database = Database::open(&db_path).expect("open sqlite db");
    db::init_schema(&database).expect("init schema");

    let sync = importer::sync_resources_to_db(&database, resources_dir, true)
        .expect("sync real resources to sqlite");
    assert_eq!(sync.editions_synced, 26);
    assert_eq!(sync.cards_synced, 2367);
    assert!(!sync.skipped_already_populated);

    let initial_kpis = compute_kpis(&database).expect("compute initial kpis");
    assert_eq!(initial_kpis.total_editions, 26);
    assert_eq!(initial_kpis.catalog_total_cards, 2304);
    assert_eq!(initial_kpis.catalog_total_sealed, 63);
    assert_eq!(initial_kpis.owned_unique_cards, 0);
    assert_eq!(initial_kpis.owned_total_copies, 0);

    // Pick a high-rarity Foil card (e.g. SEC/OUR/OSR) and a base Non-Foil Common card
    let foil_pid: i64 = database
        .query_row_opt(
            "SELECT product_id FROM cards WHERE item_category = 'card' AND rarity IN ('SEC','OUR','OSR','UR','SR','RR','R','S','SY','HR') AND market_price IS NOT NULL ORDER BY market_price DESC LIMIT 1",
            &[],
            |r| Ok(r.get_i64(0)),
        )
        .expect("query top foil card")
        .expect("at least one priced foil-tier card");

    let common_pid: i64 = database
        .query_row_opt(
            "SELECT product_id FROM cards WHERE item_category = 'card' AND rarity = 'C' LIMIT 1",
            &[],
            |r| Ok(r.get_i64(0)),
        )
        .expect("query common card")
        .expect("at least one common card");

    database
        .execute(
            "INSERT INTO collection (product_id, quantity_normal, quantity_foil, condition, language, purchase_price, is_favorite, is_wishlist, wishlist_target_qty, notes, updated_at)
             VALUES (?1, 3, 0, 'NM', 'EN', 10.0, 1, 0, 1, 'Pull de sobre', '2026-11-20T00:00:00Z')",
            &[SqlValue::from(foil_pid)],
        )
        .expect("insert foil-rarity collection item");

    database
        .execute(
            "INSERT INTO collection (product_id, quantity_normal, quantity_foil, condition, language, purchase_price, is_favorite, is_wishlist, wishlist_target_qty, notes, updated_at)
             VALUES (?1, 2, 0, 'NM', 'EN', 0.25, 0, 0, 1, 'Base C', '2026-11-20T00:00:00Z')",
            &[SqlValue::from(common_pid)],
        )
        .expect("insert common collection item");

    let updated_kpis = compute_kpis(&database).expect("compute updated kpis");
    assert_eq!(updated_kpis.owned_unique_cards, 2);
    assert_eq!(updated_kpis.owned_foil_copies, 3);
    assert_eq!(updated_kpis.owned_normal_copies, 2);
    assert_eq!(updated_kpis.owned_total_copies, 5);
    assert_eq!(updated_kpis.favorites_count, 1);
    assert!(updated_kpis.collection_market_value_usd > 0.0);
    assert!((updated_kpis.collection_cost_basis_usd - 30.5).abs() < 0.001);
    assert!(updated_kpis.top_owned_card.is_some());

    // Re-sync must preserve existing collection!
    let resync = importer::sync_resources_to_db(&database, resources_dir, true)
        .expect("resync preserves collection");
    assert_eq!(resync.cards_synced, 2367);
    let after_resync = compute_kpis(&database).expect("kpis after resync");
    assert_eq!(after_resync.owned_unique_cards, 2);
    assert_eq!(after_resync.owned_total_copies, 5);
    assert!(after_resync.exchange_rate.rate_clp_per_usd > 0.0);

    // Updating exchange rate persists in SQLite without touching resources_dir
    let rate_tmp = tempdir().expect("create rate tempdir");
    let updated_rate = save_exchange_rate_config(
        &database,
        rate_tmp.path(),
        985.5,
        "Test Manual".to_string(),
        "2026-11-20".to_string(),
    )
    .expect("save exchange rate");
    assert!((updated_rate.rate_clp_per_usd - 985.5).abs() < 0.001);
    let read_back = read_exchange_rate_config(&database).expect("read exchange rate");
    assert!((read_back.rate_clp_per_usd - 985.5).abs() < 0.001);
    assert_eq!(read_back.source, "Test Manual");
}

#[test]
fn trades_sync_collection_wishlist_and_revert_work() {
    let resources_dir = Path::new("resources");
    let tmp = tempdir().expect("create tempdir");
    let db_path = tmp.path().join("test_trades.db");
    let database = Database::open(&db_path).expect("open sqlite db");
    db::init_schema(&database).expect("init schema");
    importer::sync_resources_to_db(&database, resources_dir, true).expect("sync resources");

    assert_eq!(classify_trade_verdict(10.0, 25.0), "worth");
    assert_eq!(classify_trade_verdict(0.2, 2.0), "fair");
    assert_eq!(classify_trade_verdict(-10.0, -25.0), "not_worth");

    // Pick 3 real priced cards
    let pids: Vec<i64> = database
        .query_map(
            "SELECT product_id FROM cards WHERE item_category = 'card' AND COALESCE(market_price, foil_market_price, 0.0) >= 5.0 ORDER BY market_price DESC LIMIT 3",
            &[],
            |r| Ok(r.get_i64(0)),
        )
        .expect("query priced cards");
    assert_eq!(pids.len(), 3);
    let card_wish = pids[0];
    let card_out = pids[1];
    let card_in = pids[2];

    // Put card_wish on wishlist with target qty 1
    database
        .execute(
            "INSERT INTO collection (product_id, quantity_normal, quantity_foil, condition, language, purchase_price, is_favorite, is_wishlist, wishlist_target_qty, notes, updated_at)
             VALUES (?1, 0, 0, 'NM', 'EN', NULL, 0, 1, 1, 'Buscando', '2026-11-22T00:00:00Z')",
            &[SqlValue::from(card_wish)],
        )
        .expect("insert wishlist card");

    // Seed card_out in collection with qty 2 and purchase price $10.00
    database
        .execute(
            "INSERT INTO collection (product_id, quantity_normal, quantity_foil, condition, language, purchase_price, is_favorite, is_wishlist, wishlist_target_qty, notes, updated_at)
             VALUES (?1, 2, 0, 'NM', 'EN', 10.0, 0, 0, 1, '', '2026-11-22T00:00:00Z')",
            &[SqlValue::from(card_out)],
        )
        .expect("insert owned card_out");

    // 1) BUY card_wish below market ($15 paid for $30 market -> WORTH)
    let buy_res = create_trade_record(
        &database,
        &SaveTradeRequest {
            trade_type: "buy".to_string(),
            date: Some("2026-11-22".to_string()),
            counterparty: Some("Tienda OCG".to_string()),
            notes: Some("Gangazo".to_string()),
            currency_input: Some("USD".to_string()),
            exchange_rate_used: Some(1000.0),
            cash_paid_usd: Some(15.0),
            cash_received_usd: Some(0.0),
            cash_paid_original: Some(15.0),
            cash_received_original: Some(0.0),
            items_in: Some(vec![SaveTradeItemInput {
                product_id: card_wish,
                quantity: 1,
                unit_market_usd: Some(30.0),
                unit_cost_usd: None,
                condition: Some("NM".to_string()),
            }]),
            items_out: Some(vec![]),
            apply_to_collection: Some(true),
        },
    )
    .expect("create buy trade");
    assert_eq!(buy_res.wishlist_fulfilled_count, 1);
    assert_eq!(buy_res.trade.verdict_at_deal, "worth");
    assert_eq!(buy_res.trade.deal_balance_usd, 15.0);

    // Verify card_wish now has qty 1, purchase_price 15.0, is_wishlist = false
    let (wish_qty, wish_price, wish_flag) = database
        .query_row_opt(
            "SELECT quantity_normal, purchase_price, is_wishlist FROM collection WHERE product_id = ?1",
            &[SqlValue::from(card_wish)],
            |r| Ok((r.get_i64(0), r.get_opt_f64(1), r.get_bool(2))),
        )
        .expect("query bought card")
        .expect("bought row present");
    assert_eq!(wish_qty, 1);
    assert!((wish_price.unwrap() - 15.0).abs() < 0.01);
    assert!(!wish_flag);

    // 2) SELL 1x card_out ($20 received for $25 market -> negative market balance, positive realized profit +$10 vs $10 cost basis)
    let sell_res = create_trade_record(
        &database,
        &SaveTradeRequest {
            trade_type: "sell".to_string(),
            date: Some("2026-11-22".to_string()),
            counterparty: Some("Jugador A".to_string()),
            notes: None,
            currency_input: Some("USD".to_string()),
            exchange_rate_used: Some(1000.0),
            cash_paid_usd: Some(0.0),
            cash_received_usd: Some(20.0),
            cash_paid_original: Some(0.0),
            cash_received_original: Some(20.0),
            items_in: Some(vec![]),
            items_out: Some(vec![SaveTradeItemInput {
                product_id: card_out,
                quantity: 1,
                unit_market_usd: Some(25.0),
                unit_cost_usd: None,
                condition: Some("NM".to_string()),
            }]),
            apply_to_collection: Some(true),
        },
    )
    .expect("create sell trade");
    assert_eq!(sell_res.trade.verdict_at_deal, "not_worth");
    assert_eq!(sell_res.trade.out_cost_basis_usd, Some(10.0));
    assert_eq!(sell_res.trade.realized_profit_usd, Some(10.0));

    let out_qty_after_sell = database
        .query_row_opt(
            "SELECT quantity_normal FROM collection WHERE product_id = ?1",
            &[SqlValue::from(card_out)],
            |r| Ok(r.get_i64(0)),
        )
        .expect("query sold card")
        .expect("row exists");
    assert_eq!(out_qty_after_sell, 1);

    // 3) TRADE remaining 1x card_out ($20) + $5 cash vs 1x card_in ($25) -> fair
    let swap_res = create_trade_record(
        &database,
        &SaveTradeRequest {
            trade_type: "trade".to_string(),
            date: Some("2026-11-22".to_string()),
            counterparty: Some("Jugador B".to_string()),
            notes: Some("Swap directo".to_string()),
            currency_input: Some("USD".to_string()),
            exchange_rate_used: Some(1000.0),
            cash_paid_usd: Some(5.0),
            cash_received_usd: Some(0.0),
            cash_paid_original: Some(5.0),
            cash_received_original: Some(0.0),
            items_in: Some(vec![SaveTradeItemInput {
                product_id: card_in,
                quantity: 1,
                unit_market_usd: Some(25.0),
                unit_cost_usd: None,
                condition: Some("NM".to_string()),
            }]),
            items_out: Some(vec![SaveTradeItemInput {
                product_id: card_out,
                quantity: 1,
                unit_market_usd: Some(20.0),
                unit_cost_usd: None,
                condition: Some("NM".to_string()),
            }]),
            apply_to_collection: Some(true),
        },
    )
    .expect("create swap trade");
    assert_eq!(swap_res.trade.verdict_at_deal, "fair");

    let list_res = list_trades_response(&database).expect("list trades");
    assert_eq!(list_res.summary.total_trades, 3);
    assert_eq!(list_res.summary.buy_count, 1);
    assert_eq!(list_res.summary.sell_count, 1);
    assert_eq!(list_res.summary.trade_count, 1);
    assert_eq!(list_res.summary.wishlist_fulfilled_total, 1);

    // 4) DELETE buy_res with revert = true -> restores card_wish qty=0 and is_wishlist=true
    let reverted = delete_trade_record(&database, buy_res.trade.id, true).expect("delete & revert buy");
    assert!(reverted);
    let (restored_qty, restored_wish) = database
        .query_row_opt(
            "SELECT quantity_normal, is_wishlist FROM collection WHERE product_id = ?1",
            &[SqlValue::from(card_wish)],
            |r| Ok((r.get_i64(0), r.get_bool(1))),
        )
        .expect("query reverted wishlist card")
        .expect("wishlist row restored");
    assert_eq!(restored_qty, 0);
    assert!(restored_wish);
}

#[test]
fn catalog_colors_buzz_classifications_and_grouped_holomem_filter_work() {
    let resources_dir = Path::new("resources");
    let tmp = tempdir().expect("create tempdir");
    let db_path = tmp.path().join("test_catalog_filters.db");
    let database = Database::open(&db_path).expect("open sqlite db");
    db::init_schema(&database).expect("init schema");
    importer::sync_resources_to_db(&database, resources_dir, true).expect("sync resources");

    // 1. All 6 Mizumiya Su cards must be Blue
    let su_colors: Vec<String> = database
        .query_map(
            "SELECT color FROM cards WHERE name LIKE '%Mizumiya Su%'",
            &[],
            |r| Ok(r.get_string(0)),
        )
        .expect("query Mizumiya Su");
    assert_eq!(su_colors.len(), 6);
    assert!(su_colors.iter().all(|c| c == "Blue"));

    // 2. Mori Calliope hBP06-057..060 -> Blue, hBP02-054 -> Purple, hBP01-100 Spot -> Colorless
    let calli_blue: Vec<String> = database
        .query_map(
            "SELECT color FROM cards WHERE card_number IN ('hBP06-057','hBP06-058','hBP06-059','hBP06-060')",
            &[],
            |r| Ok(r.get_string(0)),
        )
        .expect("query Calliope Blue");
    assert_eq!(calli_blue.len(), 11);
    assert!(calli_blue.iter().all(|c| c == "Blue"));

    let calli_purple: Vec<String> = database
        .query_map(
            "SELECT color FROM cards WHERE card_number = 'hBP02-054'",
            &[],
            |r| Ok(r.get_string(0)),
        )
        .expect("query Calliope Purple");
    assert!(!calli_purple.is_empty());
    assert!(calli_purple.iter().all(|c| c == "Purple"));

    let calli_spot: Vec<String> = database
        .query_map(
            "SELECT color FROM cards WHERE card_number = 'hBP01-100'",
            &[],
            |r| Ok(r.get_string(0)),
        )
        .expect("query Calliope Spot");
    assert_eq!(calli_spot.len(), 2);
    assert!(calli_spot.iter().all(|c| c == "Colorless"));

    // 3. Sakamata Chloe hBP06-055 -> Blue; Spot cards hBP06-084 & hSD10-010 -> Colorless
    let chloe_colors: Vec<String> = database
        .query_map(
            "SELECT color FROM cards WHERE card_number = 'hBP06-055'",
            &[],
            |r| Ok(r.get_string(0)),
        )
        .expect("query Chloe");
    assert!(!chloe_colors.is_empty());
    assert!(chloe_colors.iter().all(|c| c == "Blue"));

    for spot_cn in ["hBP06-084", "hSD10-010"] {
        let cols: Vec<String> = database
            .query_map(
                "SELECT color FROM cards WHERE card_number = ?1",
                &[SqlValue::from(spot_cn)],
                |r| Ok(r.get_string(0)),
            )
            .expect("query Spot card");
        assert!(!cols.is_empty());
        assert!(cols.iter().all(|c| c == "Colorless"));
    }

    // 4. All 6 HBP03E UR cards with TCGCSV Yellow typos must reconcile to true colors
    for (pid, expected_color) in [
        (669035_i64, "White"),
        (669038, "White"),
        (669050, "Green"),
        (669057, "Green"),
        (669069, "Red"),
        (669077, "Red"),
    ] {
        let actual = database
            .query_row_opt(
                "SELECT color FROM cards WHERE product_id = ?1",
                &[SqlValue::from(pid)],
                |r| Ok(r.get_string(0)),
            )
            .expect("query HBP03E UR")
            .expect("UR card exists");
        assert_eq!(actual, expected_color, "product_id {pid}");
    }

    // 5. All 5 HBP06 Buzz Holomems and Omaru Polka SR reprint 645712 must be Buzz Holomem
    for cn in [
        "hBP06-013",
        "hBP06-026",
        "hBP06-052",
        "hBP06-065",
        "hBP06-076",
        "hBP01-071",
    ] {
        let types: Vec<String> = database
            .query_map(
                "SELECT card_type FROM cards WHERE card_number = ?1",
                &[SqlValue::from(cn)],
                |r| Ok(r.get_string(0)),
            )
            .expect("query Buzz cardType");
        assert!(!types.is_empty());
        assert!(types.iter().all(|t| t == "Buzz Holomem"), "card_number {cn}");
    }

    // 6. Filtering by card_type = "Holomem" returns BOTH Holomem and Buzz Holomem
    let grouped = query_cards(
        &database,
        &CardFilterParams {
            q: Some("Kazama Iroha".to_string()),
            card_type: Some("Holomem".to_string()),
            per_page: Some(250),
            ..Default::default()
        },
    )
    .expect("query grouped Holomem filter");
    assert!(grouped.items.iter().any(|c| c.card.card_type == "Holomem"));
    assert!(grouped
        .items
        .iter()
        .any(|c| c.card.card_type == "Buzz Holomem"));
    assert!(grouped
        .items
        .iter()
        .all(|c| c.card.card_type == "Holomem" || c.card.card_type == "Buzz Holomem"));

    // 7. Missing hBP06/hSD10/hSD11 Bloom Levels (including hBP06-027 Kazama Iroha 2nd) must be repaired
    let iroha_2nd = query_cards(
        &database,
        &CardFilterParams {
            q: Some("hBP06-027".to_string()),
            bloom_level: Some("2nd".to_string()),
            per_page: Some(20),
            ..Default::default()
        },
    )
    .expect("query hBP06-027 under 2nd filter");
    assert_eq!(iroha_2nd.items.len(), 3);
    assert!(iroha_2nd
        .items
        .iter()
        .all(|c| c.card.bloom_level == "2nd" && c.card.card_number == "hBP06-027"));

    for cn_2nd in [
        "hBP06-014", "hBP06-020", "hBP06-021", "hBP06-027", "hBP06-031", "hBP06-039",
        "hBP06-045", "hBP06-046", "hBP06-047", "hBP06-053", "hBP06-054", "hBP06-055",
        "hBP06-056", "hBP06-060", "hBP06-066", "hBP06-070", "hBP06-071", "hBP06-077",
        "hBP06-081", "hBP06-082", "hSD10-006", "hSD10-009", "hSD11-006", "hSD11-009",
    ] {
        let levels: Vec<String> = database
            .query_map(
                "SELECT bloom_level FROM cards WHERE card_number = ?1",
                &[SqlValue::from(cn_2nd)],
                |r| Ok(r.get_string(0)),
            )
            .expect("query 2nd bloom level");
        assert!(!levels.is_empty(), "{cn_2nd} missing");
        assert!(levels.iter().all(|b| b == "2nd"), "{cn_2nd}: {levels:?}");
    }

    for cn_spot in ["hBP06-084", "hSD10-010"] {
        let levels: Vec<String> = database
            .query_map(
                "SELECT bloom_level FROM cards WHERE card_number = ?1",
                &[SqlValue::from(cn_spot)],
                |r| Ok(r.get_string(0)),
            )
            .expect("query Spot bloom level");
        assert!(!levels.is_empty());
        assert!(levels.iter().all(|b| b == "Spot"), "{cn_spot}: {levels:?}");
    }

    let second_count: i64 = database
        .query_row_opt(
            "SELECT COUNT(*) FROM cards WHERE item_category = 'card' AND bloom_level = '2nd'",
            &[],
            |r| Ok(r.get_i64(0)),
        )
        .expect("count 2nd cards")
        .unwrap_or(0);
    assert_eq!(second_count, 396);

    let missing_bloom_count: i64 = database
        .query_row_opt(
            "SELECT COUNT(*) FROM cards WHERE item_category = 'card' AND card_type IN ('Holomem', 'Buzz Holomem') AND TRIM(bloom_level) = ''",
            &[],
            |r| Ok(r.get_i64(0)),
        )
        .expect("count empty bloom_level")
        .unwrap_or(-1);
    assert_eq!(missing_bloom_count, 0);

    // 8. LIMITED Support filter matches true LIMITED cards (158) without false positives like Sub PC
    let limited_supports = query_cards(
        &database,
        &CardFilterParams {
            deck_zone: Some("main".to_string()),
            limited_only: Some(true),
            per_page: Some(250),
            ..Default::default()
        },
    )
    .expect("query LIMITED support cards");
    assert_eq!(limited_supports.total, 158);
    assert_eq!(limited_supports.items.len(), 158);
    assert!(limited_supports
        .items
        .iter()
        .all(|c| c.card.card_type == "Support"));
    for cn_limited in ["hBP01-102", "hBP01-108", "hBP06-085"] {
        assert!(
            limited_supports
                .items
                .iter()
                .any(|c| c.card.card_number == cn_limited),
            "expected LIMITED card {cn_limited}"
        );
    }
    assert!(
        !limited_supports
            .items
            .iter()
            .any(|c| c.card.card_number == "hSD01-018"),
        "Sub PC (hSD01-018) must not be classified as LIMITED"
    );
}
