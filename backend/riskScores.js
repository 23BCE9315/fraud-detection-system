// ─────────────────────────────────────────────────────────────────────────────
// riskScores.js
// Risk score engine for fraud detection.
//
// Each account gets a score 0–100 built from 5 weighted signals:
//
//  Signal                 Max pts  Logic
//  ─────────────────────────────────────────────────────────────────
//  Circular involvement    35      in any loop → 35 pts
//  Fan-out degree          20      >10 targets → 20, scales linearly
//  Fan-in degree           20      >10 senders → 20, scales linearly
//  High-value sent         15      any txn >$50k → 15, >$10k → 8
//  High-value received     10      any txn >$50k → 10, >$10k → 5
//  ─────────────────────────────────────────────────────────────────
//  Total                   100
// ─────────────────────────────────────────────────────────────────────────────

// ── Risk level thresholds ─────────────────────────────────────────────────────
function riskLevel(score) {
  if (score >= 75) return "CRITICAL";
  if (score >= 50) return "HIGH";
  if (score >= 25) return "MEDIUM";
  if (score >= 10) return "LOW";
  return "CLEAN";
}

// ── Safe Neo4j integer → JS number ───────────────────────────────────────────
function toNum(val) {
  if (val == null) return 0;
  if (typeof val === "object" && typeof val.toNumber === "function") return val.toNumber();
  if (typeof val === "object" && typeof val.low === "number") return val.low;
  return Number(val) || 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main export: computeRiskScores(session, options)
// Returns array of { accountId, name, riskScore, riskLevel, signals }
// ─────────────────────────────────────────────────────────────────────────────
async function computeRiskScores(session, options = {}) {
  const {
    highValueThreshold = 10000,   // "high" transaction
    criticalThreshold  = 50000,   // "critical" transaction
    fanDegreeMax       = 10,      // degree above which full fan points awarded
  } = options;

  // ── Query 1: per-account transaction metrics ──────────────────────────────
  // Collects outgoing/incoming degree, max sent/received amounts in one pass.
  const txMetrics = await session.run(`
    MATCH (a:Account)
    OPTIONAL MATCH (a)-[out:SENT_TO]->()
    OPTIONAL MATCH ()-[inc:SENT_TO]->(a)
    WITH a,
         count(DISTINCT out)          AS outDegree,
         count(DISTINCT inc)          AS inDegree,
         coalesce(max(out.amount), 0) AS maxSent,
         coalesce(max(inc.amount), 0) AS maxReceived
    RETURN
      a.id   AS id,
      a.name AS name,
      outDegree  AS outDegree,
      inDegree   AS inDegree,
      maxSent    AS maxSent,
      maxReceived AS maxReceived
    ORDER BY a.id
  `);

  // ── Query 2: which accounts are in circular loops ─────────────────────────
  const circularResult = await session.run(`
    MATCH path = (a:Account)-[:SENT_TO*3..5]->(a)
    WITH nodes(path) AS ns
    UNWIND ns AS n
    RETURN DISTINCT n.id AS id
  `);

  const circularIds = new Set(
    circularResult.records.map((r) => r.get("id"))
  );

  // ── Build score for every account ────────────────────────────────────────
  const scores = txMetrics.records.map((r) => {
    const id          = r.get("id");
    const name        = r.get("name") ?? id;
    const outDegree   = toNum(r.get("outDegree"));
    const inDegree    = toNum(r.get("inDegree"));
    const maxSent     = toNum(r.get("maxSent"));
    const maxReceived = toNum(r.get("maxReceived"));

    const signals = {};

    // Signal 1 — Circular involvement (35 pts)
    signals.circular = circularIds.has(id) ? 35 : 0;

    // Signal 2 — Fan-out (20 pts, linear up to fanDegreeMax targets)
    signals.fanOut = outDegree > 0
      ? Math.min(20, Math.round((outDegree / fanDegreeMax) * 20))
      : 0;

    // Signal 3 — Fan-in (20 pts, linear up to fanDegreeMax senders)
    signals.fanIn = inDegree > 0
      ? Math.min(20, Math.round((inDegree / fanDegreeMax) * 20))
      : 0;

    // Signal 4 — High-value sent (15 pts)
    signals.highValueSent =
      maxSent >= criticalThreshold  ? 15 :
      maxSent >= highValueThreshold  ? 8  : 0;

    // Signal 5 — High-value received (10 pts)
    signals.highValueReceived =
      maxReceived >= criticalThreshold ? 10 :
      maxReceived >= highValueThreshold ? 5 : 0;

    const riskScore = Math.min(
      100,
      signals.circular +
      signals.fanOut   +
      signals.fanIn    +
      signals.highValueSent +
      signals.highValueReceived
    );

    return {
      accountId:  id,
      name,
      riskScore,
      riskLevel:  riskLevel(riskScore),
      signals,    // individual contributions for transparency
      metrics: { outDegree, inDegree, maxSent, maxReceived },
    };
  });

  // Sort: highest risk first
  scores.sort((a, b) => b.riskScore - a.riskScore);

  return scores;
}

module.exports = { computeRiskScores };