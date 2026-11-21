use hololive_ocg_tracker::api::{compute_kpis, read_exchange_rate_config, save_exchange_rate_config};
use hololive_ocg_tracker::db;
use hololive_ocg_tracker::db::sqlite::{Database, SqlValue};
use hololive_ocg_tracker::importer;
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
