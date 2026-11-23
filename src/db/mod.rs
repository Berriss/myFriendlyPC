pub mod sqlite;

use anyhow::Result;
use sqlite::Database;

/// Initialize all SQLite tables and indexes for the Hololive OCG tracker.
pub fn init_schema(db: &Database) -> Result<()> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS editions (
            group_id INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            abbreviation TEXT NOT NULL DEFAULT '',
            is_supplemental INTEGER NOT NULL DEFAULT 0,
            published_on TEXT NOT NULL DEFAULT '',
            modified_on TEXT NOT NULL DEFAULT '',
            folder_name TEXT NOT NULL DEFAULT ''
        );

        CREATE TABLE IF NOT EXISTS cards (
            product_id INTEGER PRIMARY KEY,
            group_id INTEGER NOT NULL REFERENCES editions(group_id) ON DELETE CASCADE,
            edition_name TEXT NOT NULL,
            edition_abbr TEXT NOT NULL DEFAULT '',
            name TEXT NOT NULL,
            clean_name TEXT NOT NULL,
            image_url TEXT NOT NULL DEFAULT '',
            url TEXT NOT NULL DEFAULT '',
            item_category TEXT NOT NULL DEFAULT 'card',
            card_number TEXT NOT NULL DEFAULT '',
            rarity TEXT NOT NULL DEFAULT '',
            rarity_name TEXT NOT NULL DEFAULT '',
            card_type TEXT NOT NULL DEFAULT '',
            subtype TEXT NOT NULL DEFAULT '',
            color TEXT NOT NULL DEFAULT '',
            bloom_level TEXT NOT NULL DEFAULT '',
            hp INTEGER,
            life INTEGER,
            baton_pass TEXT NOT NULL DEFAULT '',
            tags TEXT NOT NULL DEFAULT '',
            oshi_skill TEXT NOT NULL DEFAULT '',
            sp_oshi_skill TEXT NOT NULL DEFAULT '',
            keyword_text TEXT NOT NULL DEFAULT '',
            arts1 TEXT NOT NULL DEFAULT '',
            arts2 TEXT NOT NULL DEFAULT '',
            special_rules TEXT NOT NULL DEFAULT '',
            description_text TEXT NOT NULL DEFAULT '',
            effect_text TEXT NOT NULL DEFAULT '',
            raw_description TEXT NOT NULL DEFAULT '',
            market_price REAL,
            low_price REAL,
            mid_price REAL,
            high_price REAL,
            direct_low_price REAL,
            foil_market_price REAL,
            foil_low_price REAL,
            price_subtype TEXT NOT NULL DEFAULT 'Normal',
            sanitized_flag INTEGER NOT NULL DEFAULT 0,
            had_comma_or_html INTEGER NOT NULL DEFAULT 0,
            modified_on TEXT NOT NULL DEFAULT ''
        );

        CREATE INDEX IF NOT EXISTS idx_cards_group_id ON cards(group_id);
        CREATE INDEX IF NOT EXISTS idx_cards_item_category ON cards(item_category);
        CREATE INDEX IF NOT EXISTS idx_cards_rarity ON cards(rarity);
        CREATE INDEX IF NOT EXISTS idx_cards_color ON cards(color);
        CREATE INDEX IF NOT EXISTS idx_cards_card_type ON cards(card_type);
        CREATE INDEX IF NOT EXISTS idx_cards_bloom_level ON cards(bloom_level);
        CREATE INDEX IF NOT EXISTS idx_cards_card_number ON cards(card_number);
        CREATE INDEX IF NOT EXISTS idx_cards_market_price ON cards(market_price);

        CREATE TABLE IF NOT EXISTS collection (
            product_id INTEGER PRIMARY KEY REFERENCES cards(product_id) ON DELETE CASCADE,
            quantity_normal INTEGER NOT NULL DEFAULT 0,
            quantity_foil INTEGER NOT NULL DEFAULT 0,
            condition TEXT NOT NULL DEFAULT 'NM',
            language TEXT NOT NULL DEFAULT 'EN',
            purchase_price REAL,
            is_favorite INTEGER NOT NULL DEFAULT 0,
            is_wishlist INTEGER NOT NULL DEFAULT 0,
            wishlist_target_qty INTEGER NOT NULL DEFAULT 1,
            notes TEXT NOT NULL DEFAULT '',
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS decks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            oshi_product_id INTEGER,
            description TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS deck_cards (
            deck_id INTEGER NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
            product_id INTEGER NOT NULL REFERENCES cards(product_id) ON DELETE CASCADE,
            zone TEXT NOT NULL DEFAULT 'main',
            quantity INTEGER NOT NULL DEFAULT 1,
            PRIMARY KEY (deck_id, product_id, zone)
        );

        CREATE TABLE IF NOT EXISTS audit_summary (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            report_json TEXT NOT NULL,
            synced_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS exchange_rate_config (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            rate_clp_per_usd REAL NOT NULL,
            source TEXT NOT NULL,
            observed_date TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS trades (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            trade_type TEXT NOT NULL,
            trade_date TEXT NOT NULL,
            counterparty TEXT NOT NULL DEFAULT '',
            notes TEXT NOT NULL DEFAULT '',
            currency_input TEXT NOT NULL DEFAULT 'USD',
            exchange_rate_used REAL NOT NULL DEFAULT 1000.0,
            cash_paid_usd REAL NOT NULL DEFAULT 0.0,
            cash_received_usd REAL NOT NULL DEFAULT 0.0,
            cash_paid_original REAL NOT NULL DEFAULT 0.0,
            cash_received_original REAL NOT NULL DEFAULT 0.0,
            items_in_json TEXT NOT NULL DEFAULT '[]',
            items_out_json TEXT NOT NULL DEFAULT '[]',
            applied_to_collection INTEGER NOT NULL DEFAULT 1,
            wishlist_fulfilled_json TEXT NOT NULL DEFAULT '[]',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_trades_date ON trades(trade_date DESC, id DESC);",
    )
}
