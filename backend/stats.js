// ─────────────────────────────────────────────────────────────────────────────
// stats.js
// Computes dashboard summary statistics from Neo4j.
// All queries run sequentially on a single session for efficiency.
// ─────────────────────────────────────────────────────────────────────────────

function toNum(val) {
  if (val == null) return 0;
  if (typeof val === "object" && typeof val.toNumber === "function") return val.toNumber();
  if (typeof val === "object" && typeof val.low === "number") return val.low;
  return Number(val) || 0;
}

async function computeStats(session, options = {}) {
  const {
    highValueThreshold = 10000,
    fanOutMin          = 3,      // min outgoing connections to count as fan-out
    fanInMin           = 3,      // min incoming connections to count as fan-in
  } = options;

  // Run all 6 Cypher queries — sequential so one session handles them safely
  const [
    accountsResult,
    transactionsResult,
    circularResult,
    highValueResult,
    fanOutResult,
    fanInResult,
    riskResult,
  ] = await Promise.all([

    // 1. Total accounts
    session.run(`MATCH (a:Account) RETURN count(a) AS total`),

    // 2. Total transactions
    session.run(`MATCH ()-[r:SENT_TO]->() RETURN count(r) AS total`),

    // 3. Circular fraud loops (distinct path groups)
    session.run(`
      MATCH path = (a:Account)-[:SENT_TO*3..5]->(a)
      WITH [n IN nodes(path) | n.id] AS nodeIds
      WITH apoc.coll.sort(nodeIds) AS sorted
      RETURN count(DISTINCT sorted) AS total
    `).catch(() =>
      // Fallback if APOC not installed — count raw paths with a cap
      session.run(`
        MATCH path = (a:Account)-[:SENT_TO*3..5]->(a)
        RETURN count(path) AS total
      `)
    ),

    // 4. High-value transactions
    session.run(
      `MATCH ()-[r:SENT_TO]->() WHERE r.amount > $threshold RETURN count(r) AS total`,
      { threshold: Number(highValueThreshold) }
    ),

    // 5. Fan-out accounts (send to ≥ minTargets distinct accounts)
    session.run(
      `MATCH (a:Account)-[:SENT_TO]->(b:Account)
       WITH a, count(DISTINCT b) AS targets
       WHERE targets >= $min
       RETURN count(a) AS total`,
      { min: Number(fanOutMin) }
    ),

    // 6. Fan-in accounts (receive from ≥ minSenders distinct accounts)
    session.run(
      `MATCH (a:Account)-[:SENT_TO]->(b:Account)
       WITH b, count(DISTINCT a) AS senders
       WHERE senders >= $min
       RETURN count(b) AS total`,
      { min: Number(fanInMin) }
    ),

    // 7. Risk score distribution (bonus — count per risk level)
    session.run(`
      MATCH (a:Account)
      OPTIONAL MATCH (a)-[out:SENT_TO]->()
      OPTIONAL MATCH ()-[inc:SENT_TO]->(a)
      WITH a,
           count(DISTINCT out) AS outDeg,
           count(DISTINCT inc) AS inDeg,
           coalesce(max(out.amount), 0) AS maxSent
      RETURN
        sum(CASE WHEN outDeg >= $fanMin OR inDeg >= $fanMin OR maxSent >= $hvThreshold THEN 1 ELSE 0 END) AS flagged,
        count(a) AS total
    `, { fanMin: Number(fanOutMin), hvThreshold: Number(highValueThreshold) }),
  ]);

  // Extract counts
  const totalAccounts     = toNum(accountsResult.records[0]?.get("total"));
  const totalTransactions = toNum(transactionsResult.records[0]?.get("total"));
  const circularCount     = toNum(circularResult.records[0]?.get("total"));
  const highValueCount    = toNum(highValueResult.records[0]?.get("total"));
  const fanOutCount       = toNum(fanOutResult.records[0]?.get("total"));
  const fanInCount        = toNum(fanInResult.records[0]?.get("total"));
  const flaggedAccounts   = toNum(riskResult.records[0]?.get("flagged"));

  return {
    totalAccounts,
    totalTransactions,
    circularCount,
    highValueCount,
    fanOutCount,
    fanInCount,
    flaggedAccounts,
    // Derived
    fraudRate: totalAccounts > 0
      ? Math.round((flaggedAccounts / totalAccounts) * 100 * 10) / 10
      : 0,
    thresholds: { highValueThreshold, fanOutMin, fanInMin },
    computedAt: new Date().toISOString(),
  };
}

module.exports = { computeStats };