// Upstream builds its DashScope ASR vocabulary from the member glossary and refuses
// terms a compiled list cannot hold (src/pocket48_summarizer/vocabulary.py,
// _valid_hotword and _build_vocabulary). The local app sends the same glossary as a
// single initial prompt, so the same admission rules keep a typo-shaped row from
// poisoning it. Pure functions only: no network, no config, no I/O.
const MAX_CJK = 15;          // non-ASCII terms are capped by character count
const MAX_FRAGMENTS = 7;     // ASCII terms are capped by whitespace fragments
const MAX_TEXT = 40;         // the local glossary stores at most 40 characters

// NFKC folds full-width Latin and CJK compatibility ideographs so the same word
// entered two ways counts once; control characters are stripped, never escaped.
function normalize(value) {
  return String(value ?? "").normalize("NFKC").replace(/[\u0000-\u001f\u007f]/g, "").trim();
}

function validHotword(value) {
  const text = normalize(value);
  if (!text) return null;
  if ([...text].some((ch) => ch.codePointAt(0) > 127)) return [...text].length <= MAX_CJK ? text : null;
  const fragments = text.split(/\s+/).filter(Boolean);
  if (!fragments.length || fragments.length > MAX_FRAGMENTS) return null;
  return text;
}

function dedupeKey(value) {
  return normalize(value).replace(/\s+/g, "").toLocaleLowerCase("zh-CN");
}

// Returns the terms that survive admission, in glossary order, plus the reasons the
// dropped rows were rejected so the settings page can explain itself.
function admit(rows) {
  const accepted = [];
  const rejected = [];
  const seen = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || (row.enabled !== undefined && row.enabled !== true && row.enabled !== "true" && row.enabled !== null)) continue;
    const term = validHotword(row.term);
    const raw = String(row.term ?? "").slice(0, MAX_TEXT);
    if (!term) { rejected.push({ term: raw, reason: "shape" }); continue; }
    const key = dedupeKey(term);
    if (seen.has(key)) { rejected.push({ term, reason: "duplicate" }); continue; }
    seen.add(key);
    accepted.push(term);
  }
  return { accepted, rejected };
}

// The prompt budget is in UTF-16 code units today; count characters so a term made of
// surrogate pairs is never split in half by the cut.
function fit(terms, budget) {
  const parts = [];
  let used = 0;
  for (const term of terms) {
    const next = used + [...term].length + (parts.length ? 1 : 0);
    if (next > budget) break;
    parts.push(term);
    used = next;
  }
  return parts;
}

module.exports = { MAX_CJK, MAX_FRAGMENTS, normalize, validHotword, dedupeKey, admit, fit };
