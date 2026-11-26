use crate::models::{AuditExample, AuditReport, CardRecord, Edition};
use anyhow::{Context, Result};
use regex::Regex;
use serde::Deserialize;
use std::collections::{BTreeSet, HashMap, HashSet};
use std::fs;
use std::path::Path;
use std::sync::OnceLock;

#[derive(Debug, Clone, Copy, Default)]
pub struct SanitizeFlags {
    pub had_comma: bool,
    pub had_html: bool,
    pub had_crlf: bool,
    pub had_quotes: bool,
    pub had_spacing_fix: bool,
    pub had_typo_fix: bool,
}

/// Parse an RFC-4180 CSV document into header + rows of field maps.
/// Properly preserves commas, quotes (`""`), and newlines inside quoted cells.
pub fn parse_rfc4180_csv(input: &str) -> Vec<HashMap<String, String>> {
    let mut records: Vec<Vec<String>> = Vec::new();
    let mut current_row: Vec<String> = Vec::new();
    let mut current_field = String::new();
    let mut in_quotes = false;
    let mut chars = input.chars().peekable();

    while let Some(ch) = chars.next() {
        if in_quotes {
            if ch == '"' {
                if matches!(chars.peek(), Some('"')) {
                    chars.next();
                    current_field.push('"');
                } else {
                    in_quotes = false;
                }
            } else {
                current_field.push(ch);
            }
        } else {
            match ch {
                '"' if current_field.is_empty() => {
                    in_quotes = true;
                }
                ',' => {
                    current_row.push(std::mem::take(&mut current_field));
                }
                '\r' => {
                    if matches!(chars.peek(), Some('\n')) {
                        chars.next();
                    }
                    current_row.push(std::mem::take(&mut current_field));
                    if !(current_row.len() == 1 && current_row[0].is_empty()) {
                        records.push(std::mem::take(&mut current_row));
                    } else {
                        current_row.clear();
                    }
                }
                '\n' => {
                    current_row.push(std::mem::take(&mut current_field));
                    if !(current_row.len() == 1 && current_row[0].is_empty()) {
                        records.push(std::mem::take(&mut current_row));
                    } else {
                        current_row.clear();
                    }
                }
                other => current_field.push(other),
            }
        }
    }

    if !current_field.is_empty() || !current_row.is_empty() {
        current_row.push(current_field);
        if !(current_row.len() == 1 && current_row[0].is_empty()) {
            records.push(current_row);
        }
    }

    if records.is_empty() {
        return Vec::new();
    }

    let headers = records[0].clone();
    let mut out = Vec::with_capacity(records.len().saturating_sub(1));
    for row in records.into_iter().skip(1) {
        let mut map = HashMap::with_capacity(headers.len());
        for (idx, h) in headers.iter().enumerate() {
            let val = row.get(idx).cloned().unwrap_or_default();
            map.insert(h.clone(), val);
        }
        out.push(map);
    }
    out
}

/// Sanitize card effect / rule text: clean HTML `<br>` tags, entities, CRLF,
/// bracket/quote typos, and missing spaces after labels like `LIMITEDUsable`.
pub fn sanitize_effect_text(raw: &str) -> (String, SanitizeFlags) {
    static RE_BR: OnceLock<Regex> = OnceLock::new();
    static RE_P_CLOSE: OnceLock<Regex> = OnceLock::new();
    static RE_P_OPEN: OnceLock<Regex> = OnceLock::new();
    static RE_TAGS: OnceLock<Regex> = OnceLock::new();
    static RE_TYPO_QUOTE_GT: OnceLock<Regex> = OnceLock::new();
    static RE_TYPO_BRACKET_OPEN: OnceLock<Regex> = OnceLock::new();
    static RE_TYPO_TRAIL_GT: OnceLock<Regex> = OnceLock::new();
    static RE_LIMITED: OnceLock<Regex> = OnceLock::new();
    static RE_GIFT_SPACE: OnceLock<Regex> = OnceLock::new();
    static RE_COLON_SPACE: OnceLock<Regex> = OnceLock::new();
    static RE_BRACKET_SPACE: OnceLock<Regex> = OnceLock::new();
    static RE_WS: OnceLock<Regex> = OnceLock::new();

    if raw.is_empty() {
        return (String::new(), SanitizeFlags::default());
    }

    let re_br = RE_BR.get_or_init(|| Regex::new(r"(?i)<br\s*/?>").expect("valid regex"));
    let re_p_close = RE_P_CLOSE.get_or_init(|| Regex::new(r"(?i)</p\s*>").expect("valid regex"));
    let re_p_open = RE_P_OPEN.get_or_init(|| Regex::new(r"(?i)<p[^>]*>").expect("valid regex"));
    let re_tags = RE_TAGS.get_or_init(|| Regex::new(r"<[^>]+>").expect("valid regex"));
    let re_typo_quote_gt =
        RE_TYPO_QUOTE_GT.get_or_init(|| Regex::new(r#""([A-Za-z0-9][A-Za-z0-9 '\-\.!~&]+)>"#).expect("valid regex"));
    let re_typo_bracket_open =
        RE_TYPO_BRACKET_OPEN.get_or_init(|| Regex::new(r"(^|\s)\]([A-Za-z0-9][^\[\]]*\])").expect("valid regex"));
    let re_typo_trail_gt = RE_TYPO_TRAIL_GT.get_or_init(|| Regex::new(r"([A-Za-z0-9])>").expect("valid regex"));
    let re_limited =
        RE_LIMITED.get_or_init(|| Regex::new(r"\bLIMITED(Usable|You|This|Only|1)").expect("valid regex"));
    let re_gift_space = RE_GIFT_SPACE
        .get_or_init(|| Regex::new(r#"("(?:Gift|Bloom Effect|Collab Effect)")([A-Za-z])"#).expect("valid regex"));
    let re_colon_space =
        RE_COLON_SPACE.get_or_init(|| Regex::new(r"([a-z0-9]):([A-Z])").expect("valid regex"));
    let re_bracket_space =
        RE_BRACKET_SPACE.get_or_init(|| Regex::new(r"\]([A-Z])").expect("valid regex"));
    let re_ws = RE_WS.get_or_init(|| Regex::new(r"[ \t]+").expect("valid regex"));

    let mut flags = SanitizeFlags {
        had_comma: raw.contains(','),
        had_quotes: raw.contains('"'),
        had_crlf: raw.contains('\r'),
        had_html: re_tags.is_match(raw)
            || raw.contains("&amp;")
            || raw.contains("&quot;")
            || raw.contains("&#"),
        ..Default::default()
    };

    let normalized_nl = raw.replace("\r\n", "\n").replace('\r', "\n");
    let step1 = re_br.replace_all(&normalized_nl, "\n");
    let step2 = re_p_close.replace_all(&step1, "\n");
    let step3 = re_p_open.replace_all(&step2, "");
    let step4 = re_tags.replace_all(&step3, "");
    let unescaped = decode_html_entities(&step4);

    let typo1 = re_typo_quote_gt.replace_all(&unescaped, r#""$1""#);
    let typo2 = re_typo_bracket_open.replace_all(&typo1, "$1[$2");
    let typo3 = re_typo_trail_gt.replace_all(&typo2, "$1");
    if typo3.as_ref() != unescaped {
        flags.had_typo_fix = true;
    }

    let sp1 = re_limited.replace_all(&typo3, "LIMITED: $1");
    let sp2 = re_gift_space.replace_all(&sp1, "$1 $2");
    let sp3 = re_colon_space.replace_all(&sp2, "$1: $2");
    let sp4 = re_bracket_space.replace_all(&sp3, "] $1");
    if sp4.as_ref() != typo3.as_ref() {
        flags.had_spacing_fix = true;
    }

    let cleaned = sp4
        .split('\n')
        .map(|line| re_ws.replace_all(line, " ").trim().to_string())
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n");

    (cleaned, flags)
}

fn decode_html_entities(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&#x27;", "'")
        .replace("&apos;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&nbsp;", " ")
}

fn rarity_to_code(raw: &str, name: &str) -> (String, String) {
    let trimmed = raw.trim();
    if !trimmed.is_empty() {
        let code = match trimmed.to_lowercase().as_str() {
            "common" => "C",
            "uncommon" => "U",
            "rare" => "R",
            "double rare" => "RR",
            "super rare" => "SR",
            "ultra rare" => "UR",
            "secret rare" => "SEC",
            "holomem rare" => "HR",
            "oshi common" => "OC",
            "oshi super rare" => "OSR",
            "oshi ultra rare" => "OUR",
            "special" => "S",
            "special yell" => "SY",
            "promo" => "P",
            _ => trimmed,
        };
        return (code.to_string(), trimmed.to_string());
    }
    static RE_PARENS: OnceLock<Regex> = OnceLock::new();
    let re = RE_PARENS.get_or_init(|| {
        Regex::new(r"\((OUR|OSR|SEC|SSR|UR|SR|RR|OC|SY|HR|R|U|C|S|P)\)").expect("valid regex")
    });
    if let Some(cap) = re.captures(name) {
        let code = cap[1].to_string();
        return (code.clone(), code);
    }
    (String::new(), String::new())
}

const COLOR_ORDER: [&str; 6] = ["White", "Green", "Red", "Blue", "Purple", "Yellow"];

const CARD_NUMBER_COLOR_RANGES: [(&str, u32, u32, &str); 18] = [
    ("hBP06-", 1, 2, "White"),
    ("hBP06-", 3, 3, "Green"),
    ("hBP06-", 4, 5, "Red"),
    ("hBP06-", 6, 6, "Blue"),
    ("hBP06-", 7, 7, "Purple"),
    ("hBP06-", 8, 8, "Yellow"),
    ("hBP06-", 9, 21, "White"),
    ("hBP06-", 22, 33, "Green"),
    ("hBP06-", 34, 47, "Red"),
    ("hBP06-", 48, 60, "Blue"),
    ("hBP06-", 61, 71, "Purple"),
    ("hBP06-", 72, 83, "Yellow"),
    ("hBP06-", 84, 84, "Colorless"),
    ("hSD10-", 1, 6, "Green"),
    ("hSD10-", 7, 9, "Purple"),
    ("hSD10-", 10, 10, "Colorless"),
    ("hSD11-", 1, 6, "Yellow"),
    ("hSD11-", 7, 9, "Blue"),
];

fn color_order_index(color: &str) -> usize {
    COLOR_ORDER
        .iter()
        .position(|&c| c == color)
        .unwrap_or(99)
}

fn is_hbp06_buzz_card_number(card_number: &str) -> bool {
    matches!(
        card_number.trim(),
        "hBP06-013" | "hBP06-026" | "hBP06-052" | "hBP06-065" | "hBP06-076"
    )
}

pub fn lookup_card_number_color_override(card_number: &str) -> Option<&'static str> {
    let trimmed = card_number.trim();
    for (prefix, lo, hi, color) in CARD_NUMBER_COLOR_RANGES {
        if let Some(rest) = trimmed.strip_prefix(prefix) {
            if !rest.is_empty() && rest.bytes().all(|b| b.is_ascii_digit()) {
                if let Ok(num) = rest.parse::<u32>() {
                    if (lo..=hi).contains(&num) {
                        return Some(color);
                    }
                }
            }
        }
    }
    None
}

pub fn canonicalize_color_value(raw: &str) -> String {
    let mut tokens: Vec<String> = Vec::new();
    for part in raw.split([';', '/']) {
        let trimmed = part.trim();
        if trimmed.is_empty() {
            continue;
        }
        let norm = if trimmed.eq_ignore_ascii_case("neutral")
            || trimmed.eq_ignore_ascii_case("colorless")
        {
            "Colorless".to_string()
        } else {
            capitalize_first(trimmed)
        };
        if !tokens.contains(&norm) {
            tokens.push(norm);
        }
    }
    if tokens.is_empty() {
        return String::new();
    }
    if tokens.len() > 1 {
        tokens.retain(|t| t != "Colorless");
    }
    tokens.sort_by_key(|t| color_order_index(t));
    tokens.join(" / ")
}

fn extract_arts_colors(arts1: &str, arts2: &str) -> Vec<&'static str> {
    static RE_ARTS_BRACKET: OnceLock<Regex> = OnceLock::new();
    let re = RE_ARTS_BRACKET.get_or_init(|| Regex::new(r"\[([WGRBPYN]+)\]").expect("valid regex"));
    let combined = format!("{arts1} {arts2}");
    let mut found: Vec<&'static str> = Vec::new();
    for cap in re.captures_iter(&combined) {
        for ch in cap[1].chars() {
            let c = match ch {
                'W' => Some("White"),
                'G' => Some("Green"),
                'R' => Some("Red"),
                'B' => Some("Blue"),
                'P' => Some("Purple"),
                'Y' => Some("Yellow"),
                _ => None,
            };
            if let Some(color_name) = c {
                if !found.contains(&color_name) {
                    found.push(color_name);
                }
            }
        }
    }
    found.sort_by_key(|&c| color_order_index(c));
    found
}

fn contains_word_ascii_ci(haystack: &str, word_lower: &str) -> bool {
    let lower = haystack.to_lowercase();
    for (idx, _) in lower.match_indices(word_lower) {
        let before_ok = idx == 0
            || !lower[..idx]
                .chars()
                .next_back()
                .is_some_and(|c| c.is_ascii_alphanumeric());
        let after_idx = idx + word_lower.len();
        let after_ok = after_idx >= lower.len()
            || !lower[after_idx..]
                .chars()
                .next()
                .is_some_and(|c| c.is_ascii_alphanumeric());
        if before_ok && after_ok {
            return true;
        }
    }
    false
}

fn normalize_card_type(
    raw: Option<&str>,
    rarity_name: &str,
    card_number: &str,
    ext_map: &HashMap<String, String>,
    name: &str,
    item_category: &str,
) -> (String, bool) {
    if item_category == "sealed" {
        return ("Sealed".to_string(), false);
    }
    let val = raw.map(str::trim).unwrap_or("");
    if is_hbp06_buzz_card_number(card_number) {
        return ("Buzz Holomem".to_string(), val.is_empty());
    }
    if !val.is_empty() {
        let normalized = match val.to_lowercase().as_str() {
            "oshi holomem" => "Oshi Holomem",
            "buzz holomem" => "Buzz Holomem",
            "holomem" => "Holomem",
            "support" => "Support",
            "cheer" => "Cheer",
            _ => val,
        };
        return (normalized.to_string(), false);
    }

    let r_low = rarity_name.to_lowercase();
    if r_low.contains("oshi")
        || ext_map.contains_key("Life")
        || ext_map.contains_key("Oshi Skill")
        || card_number.starts_with("hYS")
    {
        return ("Oshi Holomem".to_string(), true);
    }
    if card_number.starts_with("hY") || name.to_lowercase().contains("cheer") {
        return ("Cheer".to_string(), true);
    }
    if ext_map
        .get("Special Rules")
        .map(|s| s.to_lowercase().contains("you get life-2"))
        .unwrap_or(false)
    {
        return ("Buzz Holomem".to_string(), true);
    }
    if ext_map.contains_key("HP")
        || ext_map.contains_key("Arts 1")
        || ext_map.contains_key("BloomLevel")
    {
        return ("Holomem".to_string(), true);
    }
    ("Support".to_string(), true)
}

fn normalize_color(
    raw: Option<&str>,
    card_type: &str,
    arts1: &str,
    arts2: &str,
    name: &str,
    item_category: &str,
    card_number: &str,
) -> (String, bool) {
    if item_category == "sealed" {
        return (String::new(), false);
    }
    let val = raw.map(str::trim).unwrap_or("");
    if card_type != "Support" {
        if let Some(override_color) = lookup_card_number_color_override(card_number) {
            if val.is_empty() {
                return (override_color.to_string(), true);
            }
        }
    }
    if !val.is_empty() {
        return (canonicalize_color_value(val), false);
    }

    if card_type == "Support" {
        return ("Colorless".to_string(), true);
    }

    let found = extract_arts_colors(arts1, arts2);
    if !found.is_empty() {
        return (found.join(" / "), true);
    }

    if card_type == "Cheer" {
        for color_name in COLOR_ORDER {
            if contains_word_ascii_ci(name, &color_name.to_lowercase()) {
                return (color_name.to_string(), true);
            }
        }
    }

    ("Colorless".to_string(), true)
}

/// Second-pass reconciliation across sibling printings sharing `card_number`
/// (fixes HBP06/hSD10/hSD11 overrides, Buzz reprints, and UR Color typos).
pub fn reconcile_cards_by_number(cards: &mut [CardRecord]) {
    let mut groups: HashMap<String, Vec<usize>> = HashMap::new();
    for (idx, c) in cards.iter().enumerate() {
        if c.item_category != "card" || c.card_type == "Support" {
            continue;
        }
        let cn = c.card_number.trim();
        if !cn.is_empty() {
            groups.entry(cn.to_string()).or_default().push(idx);
        }
    }

    for (cn, idxs) in groups {
        let is_buzz = is_hbp06_buzz_card_number(&cn)
            || idxs.iter().any(|&i| cards[i].card_type == "Buzz Holomem");
        if is_buzz {
            for &i in &idxs {
                if cards[i].card_type != "Oshi Holomem" && cards[i].card_type != "Buzz Holomem" {
                    cards[i].card_type = "Buzz Holomem".to_string();
                    cards[i].sanitized_flag = true;
                }
            }
        }

        let known_bloom = if is_hbp06_buzz_card_number(&cn) {
            Some("1st".to_string())
        } else {
            idxs.iter()
                .map(|&i| cards[i].bloom_level.trim())
                .find(|s| !s.is_empty())
                .map(|s| s.to_string())
        };
        if let Some(bloom) = known_bloom {
            for &i in &idxs {
                if (cards[i].card_type == "Holomem" || cards[i].card_type == "Buzz Holomem")
                    && cards[i].bloom_level.trim().is_empty()
                {
                    cards[i].bloom_level = bloom.clone();
                    cards[i].sanitized_flag = true;
                }
            }
        }

        if let Some(override_color) = lookup_card_number_color_override(&cn) {
            for &i in &idxs {
                if cards[i].color != override_color {
                    cards[i].color = override_color.to_string();
                    cards[i].sanitized_flag = true;
                }
            }
            continue;
        }

        let mut counts: HashMap<String, usize> = HashMap::new();
        let mut arts_cols: Vec<&'static str> = Vec::new();
        for &i in &idxs {
            let col = cards[i].color.trim();
            if !col.is_empty() && col != "Colorless" {
                *counts.entry(col.to_string()).or_insert(0) += 1;
            }
            if arts_cols.is_empty() {
                arts_cols = extract_arts_colors(&cards[i].arts1, &cards[i].arts2);
            }
        }

        if let Some((winning_color, _)) = counts.into_iter().max_by_key(|(col, count)| {
            let is_multi = usize::from(col.contains(" / "));
            let arts_match = usize::from(arts_cols.iter().any(|ac| col.contains(ac)));
            (*count, is_multi, arts_match)
        }) {
            for &i in &idxs {
                if cards[i].color != winning_color {
                    cards[i].color = winning_color.clone();
                    cards[i].sanitized_flag = true;
                }
            }
        }
    }
}

fn capitalize_first(s: &str) -> String {
    let mut chars = s.chars();
    match chars.next() {
        None => String::new(),
        Some(first) => first.to_uppercase().collect::<String>() + &chars.as_str().to_lowercase(),
    }
}

fn normalize_bloom_level(raw: Option<&str>) -> String {
    let val = raw.unwrap_or("").trim();
    match val.to_lowercase().as_str() {
        "" => String::new(),
        "spot" => "Spot".to_string(),
        "debut" => "Debut".to_string(),
        "1st" => "1st".to_string(),
        "2nd" => "2nd".to_string(),
        _ => val.to_string(),
    }
}

fn parse_first_int(raw: Option<&str>) -> Option<i64> {
    static RE_INT: OnceLock<Regex> = OnceLock::new();
    let val = raw?.trim();
    if val.is_empty() {
        return None;
    }
    let re = RE_INT.get_or_init(|| Regex::new(r"\d+").expect("valid regex"));
    re.find(val).and_then(|m| m.as_str().parse::<i64>().ok())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawGroupsEnvelope {
    #[serde(default)]
    results: Vec<RawGroup>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawGroup {
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawProductsEnvelope {
    #[serde(default)]
    results: Vec<RawProduct>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawProduct {
    product_id: i64,
    #[serde(default)]
    group_id: i64,
    #[serde(default)]
    name: String,
    #[serde(default)]
    clean_name: Option<String>,
    #[serde(default)]
    image_url: Option<String>,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    modified_on: Option<String>,
    #[serde(default)]
    extended_data: Option<Vec<RawExtendedField>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawExtendedField {
    #[serde(default)]
    name: String,
    #[serde(default)]
    value: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawPricesEnvelope {
    #[serde(default)]
    results: Vec<RawPrice>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawPrice {
    product_id: i64,
    #[serde(default)]
    low_price: Option<f64>,
    #[serde(default)]
    mid_price: Option<f64>,
    #[serde(default)]
    high_price: Option<f64>,
    #[serde(default)]
    market_price: Option<f64>,
    #[serde(default)]
    direct_low_price: Option<f64>,
    #[serde(default)]
    sub_type_name: Option<String>,
}

/// Directly scan `resources/groups.json` and `resources/editions/*/products.json`,
/// `prices.json`, `ProductsAndPrices.csv`, apply Rust RFC-4180 CSV + HTML sanitization,
/// and return normalized editions, cards, and an audit report.
pub fn build_catalog_from_raw_resources(
    resources_dir: &Path,
) -> Result<(Vec<Edition>, Vec<CardRecord>, AuditReport)> {
    let groups_path = resources_dir.join("groups.json");
    let groups_raw = fs::read_to_string(&groups_path)
        .with_context(|| format!("Reading {}", groups_path.display()))?;
    let groups_env: RawGroupsEnvelope =
        serde_json::from_str(&groups_raw).context("Parsing groups.json")?;

    let mut folder_by_group: HashMap<i64, String> = HashMap::new();
    let editions_dir = resources_dir.join("editions");
    let mut edition_dirs = Vec::new();
    if editions_dir.is_dir() {
        for entry in fs::read_dir(&editions_dir)? {
            let entry = entry?;
            let path = entry.path();
            if path.is_dir() {
                if let Some(dir_name) = path.file_name().and_then(|s| s.to_str()) {
                    if let Some(prefix) = dir_name.split('_').next() {
                        if let Ok(gid) = prefix.parse::<i64>() {
                            folder_by_group.insert(gid, dir_name.to_string());
                        }
                    }
                }
                edition_dirs.push(path);
            }
        }
    }
    edition_dirs.sort();

    let mut group_map: HashMap<i64, Edition> = HashMap::new();
    let mut editions: Vec<Edition> = Vec::with_capacity(groups_env.results.len());
    for g in groups_env.results {
        let ed = Edition {
            group_id: g.group_id,
            name: g.name,
            abbreviation: g.abbreviation.unwrap_or_default(),
            is_supplemental: g.is_supplemental,
            published_on: g.published_on.unwrap_or_default(),
            modified_on: g.modified_on.unwrap_or_default(),
            folder_name: folder_by_group.get(&g.group_id).cloned().unwrap_or_default(),
        };
        group_map.insert(ed.group_id, ed.clone());
        editions.push(ed);
    }

    let mut cards = Vec::new();
    let mut seen_pids: HashSet<i64> = HashSet::new();
    let mut discovered_keys: BTreeSet<String> = BTreeSet::new();
    let mut report = AuditReport::default();

    for ed_dir in edition_dirs {
        let products_file = ed_dir.join("products.json");
        if !products_file.exists() {
            continue;
        }
        report.editions_processed += 1;

        let prod_text = fs::read_to_string(&products_file)?;
        let prod_env: RawProductsEnvelope = serde_json::from_str(&prod_text)
            .with_context(|| format!("Parsing {}", products_file.display()))?;

        let mut prices_by_pid: HashMap<i64, Vec<RawPrice>> = HashMap::new();
        let prices_file = ed_dir.join("prices.json");
        if prices_file.exists() {
            let price_text = fs::read_to_string(&prices_file)?;
            let price_env: RawPricesEnvelope = serde_json::from_str(&price_text)
                .with_context(|| format!("Parsing {}", prices_file.display()))?;
            for pr in price_env.results {
                prices_by_pid.entry(pr.product_id).or_default().push(pr);
            }
        }

        let mut csv_by_pid: HashMap<i64, HashMap<String, String>> = HashMap::new();
        let csv_file = ed_dir.join("ProductsAndPrices.csv");
        if csv_file.exists() {
            let raw_csv = fs::read_to_string(&csv_file)?;
            let mut raw_lines = raw_csv.lines();
            if let Some(header_line) = raw_lines.next() {
                let expected_cols = header_line.split(',').count();
                for line in raw_lines {
                    if line.split(',').count() != expected_cols {
                        report.naive_csv_broken_rows += 1;
                    }
                }
            }
            for row in parse_rfc4180_csv(&raw_csv) {
                report.csv_rows_parsed += 1;
                if let Some(pid) = row.get("productId").and_then(|s| s.trim().parse::<i64>().ok()) {
                    let joined: String = row
                        .iter()
                        .filter(|(k, v)| !v.is_empty() && (k.starts_with("ext") || *k == "name" || *k == "cleanName"))
                        .map(|(_, v)| v.as_str())
                        .collect::<Vec<_>>()
                        .join(" ");
                    if joined.contains(',') {
                        report.csv_rows_with_commas_in_text += 1;
                    }
                    if joined.contains('\n') || joined.contains('\r') {
                        report.csv_rows_with_newlines_in_text += 1;
                    }
                    if joined.contains('"') {
                        report.csv_rows_with_quotes_in_text += 1;
                    }
                    csv_by_pid.entry(pid).or_insert(row);
                }
            }
        }

        for prod in prod_env.results {
            if !seen_pids.insert(prod.product_id) {
                report.duplicate_products_skipped += 1;
                continue;
            }
            report.total_products += 1;

            let mut ext_map: HashMap<String, String> = HashMap::new();
            for item in prod.extended_data.unwrap_or_default() {
                let k = item.name.trim().to_string();
                let v = item.value.trim().to_string();
                if !k.is_empty() {
                    discovered_keys.insert(k.clone());
                    ext_map.insert(k, v);
                }
            }

            let csv_row = csv_by_pid.get(&prod.product_id);
            let get_field = |ext_key: &str, csv_key: &str| -> String {
                ext_map
                    .get(ext_key)
                    .cloned()
                    .filter(|s| !s.is_empty())
                    .or_else(|| csv_row.and_then(|r| r.get(csv_key)).cloned())
                    .unwrap_or_default()
            };

            let raw_rarity = get_field("Rarity", "extRarity");
            let raw_number = get_field("Number", "extNumber");
            let item_category = if !raw_rarity.is_empty() || !raw_number.is_empty() || !ext_map.is_empty() {
                report.total_cards += 1;
                "card".to_string()
            } else {
                report.total_sealed += 1;
                "sealed".to_string()
            };

            let (rarity_code, rarity_name) = rarity_to_code(&raw_rarity, &prod.name);
            let card_number = raw_number.trim().to_string();
            let (card_type, type_inferred) = normalize_card_type(
                ext_map
                    .get("CardType")
                    .map(String::as_str)
                    .or_else(|| csv_row.and_then(|r| r.get("extCardType")).map(String::as_str)),
                &rarity_name,
                &card_number,
                &ext_map,
                &prod.name,
                &item_category,
            );
            if type_inferred {
                report.missing_card_type_inferred += 1;
            }

            let raw_oshi = get_field("Oshi Skill", "extOshiSkill");
            let raw_sp_oshi = get_field("SP Oshi Skill", "extSPOshiSkill");
            let raw_keyword = get_field("Keyword", "extKeyword");
            let raw_arts1 = get_field("Arts 1", "extArts1");
            let raw_arts2 = get_field("Arts 2", "extArts2");
            let raw_special = get_field("Special Rules", "extSpecialRules");
            let raw_desc = get_field("Description", "extDescription");

            let (oshi_skill, f1) = sanitize_effect_text(&raw_oshi);
            let (sp_oshi_skill, f2) = sanitize_effect_text(&raw_sp_oshi);
            let (keyword_text, f3) = sanitize_effect_text(&raw_keyword);
            let (arts1, f4) = sanitize_effect_text(&raw_arts1);
            let (arts2, f5) = sanitize_effect_text(&raw_arts2);
            let (special_rules, f6) = sanitize_effect_text(&raw_special);
            let (description_text, f7) = sanitize_effect_text(&raw_desc);

            let flags = [f1, f2, f3, f4, f5, f6, f7];
            let had_html = flags.iter().any(|f| f.had_html);
            let had_spacing = flags.iter().any(|f| f.had_spacing_fix);
            let had_typo = flags.iter().any(|f| f.had_typo_fix);
            let had_comma = flags.iter().any(|f| f.had_comma);
            let had_crlf = flags.iter().any(|f| f.had_crlf);
            let had_quotes = flags.iter().any(|f| f.had_quotes);

            if had_html {
                report.descriptions_html_cleaned += 1;
            }
            if had_spacing {
                report.spacing_bugs_fixed += 1;
            }
            if had_typo {
                report.typos_fixed += 1;
            }

            let mut sections = Vec::new();
            if !oshi_skill.is_empty() {
                sections.push(format!("Oshi Skill: {oshi_skill}"));
            }
            if !sp_oshi_skill.is_empty() {
                sections.push(format!("SP Oshi Skill: {sp_oshi_skill}"));
            }
            if !keyword_text.is_empty() {
                sections.push(format!("Keyword: {keyword_text}"));
            }
            if !arts1.is_empty() {
                sections.push(format!("Arts 1: {arts1}"));
            }
            if !arts2.is_empty() {
                sections.push(format!("Arts 2: {arts2}"));
            }
            if !special_rules.is_empty() {
                sections.push(format!("Special Rules: {special_rules}"));
            }
            if !description_text.is_empty() {
                sections.push(description_text.clone());
            }
            let effect_text = sections.join("\n\n");
            let raw_description = [
                &raw_oshi,
                &raw_sp_oshi,
                &raw_keyword,
                &raw_arts1,
                &raw_arts2,
                &raw_special,
                &raw_desc,
            ]
            .into_iter()
            .filter(|s| !s.is_empty())
            .cloned()
            .collect::<Vec<_>>()
            .join(" | ");

            let (color, color_inferred) = normalize_color(
                ext_map
                    .get("Color")
                    .map(String::as_str)
                    .or_else(|| csv_row.and_then(|r| r.get("extColor")).map(String::as_str)),
                &card_type,
                &arts1,
                &arts2,
                &prod.name,
                &item_category,
                &card_number,
            );
            if color_inferred {
                report.missing_color_inferred += 1;
            }

            let bloom_level = normalize_bloom_level(
                ext_map
                    .get("BloomLevel")
                    .map(String::as_str)
                    .or_else(|| csv_row.and_then(|r| r.get("extBloomLevel")).map(String::as_str)),
            );
            let subtype = get_field("Subtype", "extSubtype");
            let hp = parse_first_int(Some(&get_field("HP", "extHP")));
            let life = parse_first_int(Some(&get_field("Life", "extLife")));
            let baton_pass = get_field("Baton Pass", "extBatonPass");
            let tags = get_field("Tags", "extTags");

            let price_list = prices_by_pid.get(&prod.product_id);
            let normal_p = price_list.and_then(|list| {
                list.iter()
                    .find(|p| p.sub_type_name.as_deref().unwrap_or("").eq_ignore_ascii_case("normal"))
                    .or_else(|| {
                        list.iter().find(|p| {
                            !p.sub_type_name
                                .as_deref()
                                .unwrap_or("")
                                .eq_ignore_ascii_case("foil")
                        })
                    })
            });
            let foil_p = price_list.and_then(|list| {
                list.iter()
                    .find(|p| p.sub_type_name.as_deref().unwrap_or("").eq_ignore_ascii_case("foil"))
            });
            let primary_p = normal_p.or(foil_p);

            let foil_market_price = foil_p.and_then(|p| p.market_price);
            let foil_low_price = foil_p.and_then(|p| p.low_price);
            let market_price = primary_p
                .and_then(|p| p.market_price)
                .or(foil_market_price)
                .or_else(|| csv_row.and_then(|r| r.get("marketPrice")).and_then(|s| s.parse::<f64>().ok()));
            let low_price = primary_p
                .and_then(|p| p.low_price)
                .or(foil_low_price)
                .or_else(|| csv_row.and_then(|r| r.get("lowPrice")).and_then(|s| s.parse::<f64>().ok()));
            let mid_price = primary_p.and_then(|p| p.mid_price);
            let high_price = primary_p.and_then(|p| p.high_price);
            let direct_low_price = primary_p.and_then(|p| p.direct_low_price);
            let price_subtype = primary_p
                .and_then(|p| p.sub_type_name.clone())
                .unwrap_or_else(|| "Normal".to_string());

            let ed_meta = group_map.get(&prod.group_id);
            let edition_name = ed_meta
                .map(|e| e.name.clone())
                .unwrap_or_else(|| ed_dir.file_name().unwrap_or_default().to_string_lossy().into_owned());
            let edition_abbr = ed_meta.map(|e| e.abbreviation.clone()).unwrap_or_default();

            let sanitized_flag = had_comma
                || had_html
                || had_crlf
                || had_quotes
                || had_spacing
                || had_typo
                || type_inferred
                || color_inferred;

            if (had_comma || had_html || had_spacing || had_typo || type_inferred)
                && report.examples.len() < 15
            {
                let mut issues = Vec::new();
                if had_comma {
                    issues.push("comma_in_effect_text".to_string());
                }
                if had_html {
                    issues.push("html_tags_stripped".to_string());
                }
                if had_crlf {
                    issues.push("multiline_crlf_normalized".to_string());
                }
                if had_quotes {
                    issues.push("embedded_quotes_escaped".to_string());
                }
                if had_spacing {
                    issues.push("missing_space_after_label".to_string());
                }
                if had_typo {
                    issues.push("bracket_quote_typo_repaired".to_string());
                }
                if type_inferred {
                    issues.push("missing_card_type_inferred".to_string());
                }
                if color_inferred {
                    issues.push("missing_color_inferred".to_string());
                }
                report.examples.push(AuditExample {
                    product_id: prod.product_id,
                    name: prod.name.clone(),
                    card_number: card_number.clone(),
                    issues_fixed: issues,
                    raw_snippet: raw_description.chars().take(260).collect(),
                    cleaned_snippet: effect_text.chars().take(260).collect(),
                });
            }

            cards.push(CardRecord {
                product_id: prod.product_id,
                group_id: prod.group_id,
                edition_name,
                edition_abbr,
                clean_name: prod.clean_name.unwrap_or_else(|| prod.name.clone()),
                name: prod.name,
                image_url: prod.image_url.unwrap_or_default(),
                url: prod.url.unwrap_or_default(),
                item_category,
                card_number,
                rarity: rarity_code,
                rarity_name,
                card_type,
                subtype,
                color,
                bloom_level,
                hp,
                life,
                baton_pass,
                tags,
                oshi_skill,
                sp_oshi_skill,
                keyword_text,
                arts1,
                arts2,
                special_rules,
                description_text,
                effect_text,
                raw_description,
                market_price,
                low_price,
                mid_price,
                high_price,
                direct_low_price,
                foil_market_price,
                foil_low_price,
                price_subtype,
                sanitized_flag,
                had_comma_or_html: had_comma || had_html,
                modified_on: prod.modified_on.unwrap_or_default(),
            });
        }
    }

    reconcile_cards_by_number(&mut cards);
    report.discovered_extended_keys = discovered_keys.into_iter().collect();
    Ok((editions, cards, report))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rfc4180_csv_preserves_embedded_commas_newlines_and_quotes() {
        let csv_sample = concat!(
            "productId,name,extDescription,marketPrice\n",
            "645575,\"Amane Kanata (OSR)\",\"[holo Power: -2] During this turn, 1 of your holomem gets Arts+50, and draws 1 card.<br>\"\"Squish\"\" effect.\",12.50\n",
            "645771,\"Idol Microphone (U)\",\"LIMITEDUsable only 1 per turn.\nLook at top 4, reveal any number.\",0.25\n"
        );
        let rows = parse_rfc4180_csv(csv_sample);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].get("productId").map(String::as_str), Some("645575"));
        assert_eq!(rows[0].get("marketPrice").map(String::as_str), Some("12.50"));
        assert!(rows[0]
            .get("extDescription")
            .unwrap()
            .contains("\"Squish\" effect."));
        assert_eq!(rows[1].get("marketPrice").map(String::as_str), Some("0.25"));
        assert!(rows[1]
            .get("extDescription")
            .unwrap()
            .contains('\n'));
    }

    #[test]
    fn sanitize_effect_text_cleans_html_typos_and_spacing() {
        let raw = r#"LIMITEDUsable only 1 per turn.<br>Reveal 1 "Stone Axe> from your deck, and attach it to ]green cheers]."#;
        let (clean, flags) = sanitize_effect_text(raw);
        assert!(flags.had_html);
        assert!(flags.had_comma);
        assert!(flags.had_spacing_fix);
        assert!(flags.had_typo_fix);
        assert!(clean.contains("LIMITED: Usable only 1 per turn."));
        assert!(clean.contains("\"Stone Axe\""));
        assert!(clean.contains("[green cheers]"));
        assert!(!clean.contains("<br>"));
    }

    #[test]
    fn infers_missing_card_type_and_color_accurately() {
        let mut ext = HashMap::new();
        ext.insert("Rarity".to_string(), "Promo".to_string());
        ext.insert("Number".to_string(), "hBP06-060".to_string());
        ext.insert("HP".to_string(), "210".to_string());
        let (ct, ct_inf) = normalize_card_type(None, "Promo", "hBP06-060", &ext, "Mori Calliope (P)", "card");
        assert_eq!(ct, "Holomem");
        assert!(ct_inf);

        // HBP06-060 is verified Blue despite [N] Arts costs
        let (color, color_inf) = normalize_color(None, &ct, "[N] Bull's-Eye!!!! (60)", "", "Mori Calliope (P)", "card", "hBP06-060");
        assert_eq!(color, "Blue");
        assert!(color_inf);

        // Mixed [BN] / [PN] Arts brackets infer base colors when no cardNumber override applies
        let (color_bn, _) = normalize_color(None, "Holomem", "[BN] Sweet Obsession (100)", "", "Mizumiya Su (RR)", "card", "hSD11-009");
        assert_eq!(color_bn, "Blue");
        let (color_pn, _) = normalize_color(None, "Holomem", "[PN] Vigilance Venus (80+)", "", "Kikirara Vivi (RR)", "card", "hBP99-001");
        assert_eq!(color_pn, "Purple");

        // hBP06-013 is classified as Buzz Holomem and White
        let (buzz_ct, _) = normalize_card_type(None, "Rare", "hBP06-013", &ext, "Raora Panthera (R)", "card");
        assert_eq!(buzz_ct, "Buzz Holomem");
        assert_eq!(lookup_card_number_color_override("hBP06-055"), Some("Blue"));
    }

    #[test]
    fn reconciles_sibling_colors_and_buzz_reprints_by_card_number() {
        let make_card = |pid: i64, cn: &str, ct: &str, col: &str, bl: &str| CardRecord {
            product_id: pid,
            group_id: 1,
            edition_name: "Test".into(),
            edition_abbr: "TST".into(),
            name: format!("Card {cn}"),
            clean_name: format!("Card {cn}"),
            image_url: String::new(),
            url: String::new(),
            item_category: "card".into(),
            card_number: cn.into(),
            rarity: "UR".into(),
            rarity_name: "Ultra Rare".into(),
            card_type: ct.into(),
            subtype: String::new(),
            color: col.into(),
            bloom_level: bl.into(),
            hp: Some(150),
            life: None,
            baton_pass: "1".into(),
            tags: String::new(),
            oshi_skill: String::new(),
            sp_oshi_skill: String::new(),
            keyword_text: String::new(),
            arts1: "[WWN] Test (100)".into(),
            arts2: String::new(),
            special_rules: String::new(),
            description_text: String::new(),
            effect_text: String::new(),
            raw_description: String::new(),
            market_price: None,
            low_price: None,
            mid_price: None,
            high_price: None,
            direct_low_price: None,
            foil_market_price: None,
            foil_low_price: None,
            price_subtype: "Normal".into(),
            sanitized_flag: false,
            had_comma_or_html: false,
            modified_on: String::new(),
        };

        let mut list = vec![
            make_card(1, "hBP03-014", "Holomem", "White", "2nd"),
            make_card(2, "hBP03-014", "Holomem", "White", "2nd"),
            make_card(3, "hBP03-014", "Holomem", "Yellow", "2nd"),
            make_card(4, "hBP01-071", "Buzz Holomem", "Red", "1st"),
            make_card(5, "hBP01-071", "Holomem", "Colorless", "1st"),
        ];
        reconcile_cards_by_number(&mut list);
        assert_eq!(list[2].color, "White");
        assert_eq!(list[4].card_type, "Buzz Holomem");
        assert_eq!(list[4].color, "Red");
    }
}
