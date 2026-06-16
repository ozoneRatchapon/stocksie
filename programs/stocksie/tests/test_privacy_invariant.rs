//! Phase 9 — privacy-invariant test (source grep, no LiteSVM).
//!
//! Asserts the on-chain privacy boundary from `plan/03_account_model.md` §6 and
//! `plan/07_security.md` §5: **no `#[account]` or `#[event]` struct ever stores
//! a `String`, `Vec<u8>`-as-text, or any other variable-length text type**.
//! Only fixed-size, blake3-referenced data shapes are permitted on chain
//! (`Pubkey`, fixed integers, `[u8; 32]` digests, small enums, `bool`).
//!
//! This is a source-grep test, not a runtime one. It `include_str!`s every
//! file under `programs/stocksie/src/` that defines an `#[account]` or
//! `#[event]` struct, parses each struct body line-by-line, and rejects any
//! field whose type spelling contains a forbidden token. The parser is
//! intentionally `syn`-free — a structured parse of Rust source from inside a
//! test would add a heavy dev-dependency for a check this narrow, and a
//! line-based scan is sufficient because the codebase enforces a one-field-
//! per-line style via `cargo fmt` (verified by `cargo fmt --all -- --check`).
//!
//! ## Allowed on-chain types
//!
//! Per `03_account_model.md` §6 and the implementation in `state/` + `events/`:
//!   - `Pubkey`
//!   - `u8`, `u32`, `u64`
//!   - `[u8; 32]` (and any `[u8; N]` — a fixed-size blake3/byte-array digest)
//!   - `Role`, `Status` (small enums — see `types.rs`)
//!   - `bool`
//!
//! ## Why this is a test, not a clippy lint
//!
//! Anchor's `#[account]` derive would happily Borsh-serialize a `String` if we
//! added one, and the ledger would silently start carrying raw inventory data
//! the day a careless edit lands. This test is the single source of truth that
//! makes such an edit fail CI immediately, with a message pointing at the
//! offending field.

#![cfg(not(target_os = "solana"))]

use std::collections::HashSet;

// ---------------------------------------------------------------------------
// Sources scanned — every file under `programs/stocksie/src/` that may carry
// an `#[account]` or `#[event]` attribute. Paths are relative to the crate
// root so `include_str!` resolves identically from the per-target integration
// test build directory.
//
// `types.rs` is included for completeness even though it holds only the
// `Role` / `Status` enums (no struct fields) — the parser ignores enum bodies,
// and including it future-proofs the scan against a struct landing there.
// ---------------------------------------------------------------------------

const SOURCES: &[(&str, &str)] = &[
    (
        "state/household.rs",
        include_str!("../src/state/household.rs"),
    ),
    ("state/member.rs", include_str!("../src/state/member.rs")),
    (
        "state/purchase_request.rs",
        include_str!("../src/state/purchase_request.rs"),
    ),
    ("events.rs", include_str!("../src/events.rs")),
    ("types.rs", include_str!("../src/types.rs")),
];

/// Type tokens whose presence in a struct field type spelling is forbidden by
/// the on-chain privacy boundary (`03_account_model.md` §6).
///
/// Each entry is the substring matched against the *type spelling* (the slice
/// after the field name and before the trailing comma). We do not match
/// against the whole source line because field names like `name_hash`
/// legitimately contain the substring "name".
const FORBIDDEN_TYPE_TOKENS: &[&str] = &["String", "Vec<", "Box<", "&str", "Cow<", "Rc<", "Arc<"];

/// Attributes that mark a struct as on-chain-relevant for this scan. Either
/// `#[account]` (Anchor state) or `#[event]` (Anchor event). Both emit
/// Borsh serializers and therefore both can leak data to the ledger.
const ON_CHAIN_ATTRS: &[&str] = &["#[account]", "#[event]"];

// ---------------------------------------------------------------------------
// Minimal line-based parser
// ---------------------------------------------------------------------------

/// A field declared inside a scanned struct: its source location, name, and
/// the type spelling as it appears between `:` and the trailing `,`.
#[derive(Debug)]
struct Field {
    file: &'static str,
    line_no: usize,
    name: String,
    type_spelling: String,
}

/// Walk every line of every source file, track whether we are inside a struct
/// body annotated `#[account]` or `#[event]`, and collect each `pub` field's
/// type spelling.
///
/// Rules:
///   - A struct is "on-chain" if the most recent attribute line immediately
///     preceding `pub struct X` (or `pub struct X<...>`) is one of
///     [`ON_CHAIN_ATTRS`]. This is how Anchor's macros attach; we rely on the
///     one-attribute-per-line formatting enforced by `cargo fmt`.
///   - A struct body opens on the line containing `{` (Anchor's macro output
///     and our hand-written state structs both put `{` on the struct-decl
///     line) and closes at the next top-level `}`.
///   - A field line is any line inside an on-chain struct body that matches
///     `pub <name>: <type>,`. Comments and blank lines are ignored.
fn collect_on_chain_fields() -> Vec<Field> {
    let mut fields = Vec::new();
    for (file, src) in SOURCES {
        fields.extend(scan_file(file, src));
    }
    fields
}

fn scan_file(file: &'static str, src: &str) -> Vec<Field> {
    let mut out = Vec::new();

    // The most recent on-chain attribute seen on its own line. Consumed by the
    // next `pub struct` line; cleared otherwise.
    let mut pending_attr: Option<&'static str> = None;

    // Brace depth when inside an on-chain struct body. `None` means we are
    // between structs (or inside a non-annotated struct, which we ignore).
    let mut on_chain_body_depth: Option<i32> = None;

    for (idx, raw) in src.lines().enumerate() {
        let line_no = idx + 1;
        let trimmed = raw.trim();

        // --- Outside a struct body: track pending attributes --------------
        if on_chain_body_depth.is_none() {
            if let Some(attr) = ON_CHAIN_ATTRS.iter().find(|a| trimmed == **a) {
                pending_attr = Some(attr);
                continue;
            }
        }

        // --- Detect struct entry (`pub struct Name {` or `pub struct Name<...> {`) ---
        if let Some(after_struct) = strip_struct_keyword(trimmed) {
            let is_on_chain = pending_attr.is_some();
            pending_attr = None;

            if is_on_chain {
                // The opening `{` is on the same line in every Anchor-derived
                // and hand-written on-chain struct in this codebase (verified
                // by inspecting `state/*.rs` and `events.rs`). If a future
                // struct puts `{` on its own line, the brace-depth bookkeeping
                // below still advances correctly when that lone `{` is seen.
                let opens_here = after_struct.contains('{');
                on_chain_body_depth = Some(if opens_here { 1 } else { 0 });
            }
            continue;
        }

        // --- Track body open when `{` is on its own line -----------------
        if let Some(depth) = on_chain_body_depth.as_mut() {
            if *depth == 0 && trimmed == "{" {
                *depth = 1;
                continue;
            }
        }

        // --- Detect body close -------------------------------------------
        if let Some(depth) = on_chain_body_depth.as_mut() {
            if *depth >= 1 && trimmed.starts_with('}') {
                on_chain_body_depth = None;
                continue;
            }
        }

        // --- Inside a body: scan field lines -----------------------------
        if matches!(on_chain_body_depth, Some(d) if d >= 1) {
            if let Some(field) = parse_field_line(file, line_no, trimmed) {
                out.push(field);
            }
        }
    }

    out
}

/// Strip a leading `pub struct ` or `pub(crate) struct ` from a trimmed line,
/// returning the remainder (which still carries the struct name, generics,
/// and possibly the opening brace). Returns `None` for non-struct lines.
fn strip_struct_keyword(trimmed: &str) -> Option<&str> {
    trimmed
        .strip_prefix("pub struct ")
        .or_else(|| trimmed.strip_prefix("pub(crate) struct "))
}

/// Parse a single trimmed line as a `pub <name>: <type>,` field declaration.
/// Returns `None` for non-field lines (comments, blank lines, attributes,
/// braces, doc lines, etc.).
fn parse_field_line(file: &'static str, line_no: usize, trimmed: &str) -> Option<Field> {
    // Must be a `pub`-visible field declaration.
    let after_vis = trimmed
        .strip_prefix("pub ")
        .or_else(|| trimmed.strip_prefix("pub(crate) "))?;

    // Must contain `name: type`.
    let colon = after_vis.find(':')?;
    let name = after_vis[..colon].trim().to_string();

    // Reject lines that are actually doc comments (`/// ...`) or inner
    // attributes (`#[...]`) that slipped past the prefix check.
    if name.is_empty() || name.starts_with('/') || name.starts_with('#') {
        return None;
    }

    // Type spelling = everything after `:` up to the trailing `,` (if any).
    let mut type_part = after_vis[colon + 1..].trim();
    if let Some(comma) = type_part.rfind(',') {
        type_part = type_part[..comma].trim();
    }

    Some(Field {
        file,
        line_no,
        name,
        type_spelling: type_part.to_string(),
    })
}

// ---------------------------------------------------------------------------
// The tests
// ---------------------------------------------------------------------------

/// Scan every `#[account]` and `#[event]` struct in the program source and
/// assert that no field's type spelling contains a forbidden token.
///
/// On failure, the panic lists every offending field with its file:line and
/// the forbidden token matched, so the fix is obvious.
#[test]
fn no_string_fields_on_chain() {
    let fields = collect_on_chain_fields();

    // Sanity: the scanner must have found at least the three documented
    // account structs and the event set. If it found zero, the parser drifted
    // (e.g. cargo fmt changed how `#[account]` is laid out) and the test would
    // silently pass without scanning anything — surface that loudly instead.
    assert!(
        !fields.is_empty(),
        "privacy scanner found zero fields — the parser is broken, not the \
         privacy boundary. Check that SOURCES still points at the right files \
         and that `#[account]`/`#[event]` attributes are still on their own \
         line per cargo fmt."
    );

    let mut offenders: Vec<String> = Vec::new();
    for field in &fields {
        for token in FORBIDDEN_TYPE_TOKENS {
            if field.type_spelling.contains(token) {
                offenders.push(format!(
                    "  - {}:{} field `{}` has forbidden type `{}` (matched `{}`)",
                    field.file, field.line_no, field.name, field.type_spelling, token,
                ));
                break; // one violation per field is enough to report
            }
        }
    }

    if !offenders.is_empty() {
        panic!(
            "on-chain privacy boundary violated ({} offending field(s)):\n{}\n\
             Per `plan/03_account_model.md` §6 and `plan/07_security.md` §5, \
             no `#[account]` or `#[event]` struct may carry a variable-length \
             text type. Reduce the field to a `[u8; 32]` blake3 digest and \
             move the plaintext off-chain.",
            offenders.len(),
            offenders.join("\n"),
        );
    }
}

/// Guard against the scanner silently losing coverage. Forces every documented
/// on-chain source file to contribute at least one scanned field, so a future
/// refactor that splits a struct into a new file (or strips an attribute) is
/// caught here rather than weakening `no_string_fields_on_chain`.
///
/// `types.rs` is intentionally not asserted: it holds only the `Role` /
/// `Status` enums, which contribute no fields.
#[test]
fn scanner_sees_all_on_chain_structs() {
    let fields = collect_on_chain_fields();
    let mut seen_files: HashSet<&str> = HashSet::new();
    for f in &fields {
        seen_files.insert(f.file);
    }

    let expected_files = [
        "state/household.rs",
        "state/member.rs",
        "state/purchase_request.rs",
        "events.rs",
    ];
    for expected in expected_files {
        assert!(
            seen_files.contains(expected),
            "privacy scanner did not see any on-chain struct in `{expected}` — \
             either the file lost its `#[account]`/`#[event]` annotation or \
             the parser is broken. Add the file to `SOURCES` if it is new.",
        );
    }
}
