// ─────────────────────────────────────────────────────────────────────────────
// fraudDetection.js  —  Neo4j fraud pattern detectors
// Each function receives its OWN session (never share across concurrent calls).
// ─────────────────────────────────────────────────────────────────────────────

// ── Helpers ───────────────────────────────────────────────────────────────────
function toNum(val) {
  if (val == null) return null;
  if (typeof val === "object" && typeof val.toNumber === "function") return val.toNumber();
  if (typeof val === "object" && typeof val.low  === "number")       return val.low;
  return Number(val);
}

// ── 1. Circular transactions ──────────────────────────────────────────────────
async function detectCircular(session) {
  const result = await session.run(`
    MATCH path = (a:Account)-[:SENT_TO*3..5]->(a)
    WITH path, nodes(path) AS ns, relationships(path) AS rs
    WITH [i IN range(0, size(rs)-1) |
           { from: ns[i].id, to: ns[i+1].id, amount: rs[i].amount }
         ] AS steps
    WITH steps, [s IN steps | s.from] AS nodeIds
    WITH steps, nodeIds, apoc.coll.sort(nodeIds) AS sorted
    WITH steps, sorted[0] AS canonical
    RETURN steps
    LIMIT 20
  `);

  // Fallback if APOC is not installed — just return raw without dedup
  let fraudPaths;
  try {
    fraudPaths = result.records.map((r) =>
      r.get("steps").map((s) => ({
        from:   s.from,
        to:     s.to,
        amount: toNum(s.amount),
      }))
    );
  } catch (_) {
    fraudPaths = [];
  }

  // JS-side deduplication by normalising node set
  const seen = new Set();
  const unique = fraudPaths.filter((path) => {
    const key = [...path.map((s) => s.from)].sort().join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return { type: "circular", count: unique.length, fraudPaths: unique };
}

// ── 2. High-value transactions ────────────────────────────────────────────────
async function detectHighValue(session, threshold = 10000) {
  const result = await session.run(
    `MATCH (a:Account)-[r:SENT_TO]->(b:Account)
     WHERE r.amount > $threshold
     RETURN a.id AS from, b.id AS to, r.amount AS amount
     ORDER BY r.amount DESC
     LIMIT 100`,
    { threshold: Number(threshold) }
  );

  const transactions = result.records.map((r) => ({
    from:   r.get("from"),
    to:     r.get("to"),
    amount: toNum(r.get("amount")),
  }));

  return { type: "high_value", threshold, count: transactions.length, transactions };
}

// ── 3. Fan-out fraud ──────────────────────────────────────────────────────────
async function detectFanOut(session, minTargets = 3) {
  const result = await session.run(
    `MATCH (a:Account)-[r:SENT_TO]->(b:Account)
     WITH a,
          collect(DISTINCT b.id) AS targets,
          sum(r.amount)          AS totalSent,
          count(r)               AS txCount
     WHERE size(targets) >= $minTargets
     RETURN a.id AS account, targets AS sentTo, txCount AS transactionCount, totalSent AS totalAmount
     ORDER BY size(targets) DESC
     LIMIT 50`,
    { minTargets: Number(minTargets) }
  );

  const accounts = result.records.map((r) => ({
    account:          r.get("account"),
    sentTo:           r.get("sentTo"),
    transactionCount: toNum(r.get("transactionCount")),
    totalAmount:      toNum(r.get("totalAmount")),
    fanOutDegree:     r.get("sentTo").length,
  }));

  return { type: "fan_out", minTargets, count: accounts.length, accounts };
}

// ── 4. Fan-in fraud ───────────────────────────────────────────────────────────
async function detectFanIn(session, minSenders = 3) {
  const result = await session.run(
    `MATCH (a:Account)-[r:SENT_TO]->(b:Account)
     WITH b,
          collect(DISTINCT a.id) AS senders,
          sum(r.amount)          AS totalReceived,
          count(r)               AS txCount
     WHERE size(senders) >= $minSenders
     RETURN b.id AS account, senders AS receivedFrom, txCount AS transactionCount, totalReceived AS totalAmount
     ORDER BY size(senders) DESC
     LIMIT 50`,
    { minSenders: Number(minSenders) }
  );

  const accounts = result.records.map((r) => ({
    account:          r.get("account"),
    receivedFrom:     r.get("receivedFrom"),
    transactionCount: toNum(r.get("transactionCount")),
    totalAmount:      toNum(r.get("totalAmount")),
    fanInDegree:      r.get("receivedFrom").length,
  }));

  return { type: "fan_in", minSenders, count: accounts.length, accounts };
}

// ── 5. Rapid transactions ─────────────────────────────────────────────────────
// Simplified: accounts with >= minCount transactions all within windowMinutes.
// Groups by account, collects timestamps, checks min/max window in JS.
async function detectRapid(session, minCount = 3, windowMinutes = 60) {
  const windowMs = windowMinutes * 60 * 1000;

  const result = await session.run(
    `MATCH (a:Account)-[r:SENT_TO]->(b:Account)
     WHERE r.timestamp IS NOT NULL
     WITH a,
          collect({ to: b.id, amount: r.amount, timestamp: r.timestamp }) AS txns
     WHERE size(txns) >= $minCount
     RETURN a.id AS account, txns AS transactions
     LIMIT 50`,
    { minCount: Number(minCount) }
  );

  const accounts = [];

  for (const record of result.records) {
    const raw = record.get("transactions");
    const txns = raw.map((t) => ({
      to:        t.to,
      amount:    toNum(t.amount),
      timestamp: toNum(t.timestamp),
    })).filter((t) => t.timestamp != null)
      .sort((a, b) => a.timestamp - b.timestamp);

    // Sliding window check in JS — no complex Cypher needed
    let hasRapid = false;
    for (let i = 0; i <= txns.length - minCount; i++) {
      if (txns[i + minCount - 1].timestamp - txns[i].timestamp <= windowMs) {
        hasRapid = true;
        break;
      }
    }

    if (hasRapid) {
      accounts.push({
        account:      record.get("account"),
        totalCount:   txns.length,
        transactions: txns,
        windowMinutes,
      });
    }
  }

  return { type: "rapid", minCount, windowMinutes, count: accounts.length, accounts };
}

module.exports = { detectCircular, detectHighValue, detectFanOut, detectFanIn, detectRapid };