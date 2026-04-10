// ─────────────────────────────────────────────────────────────────────────────
// app.js  —  SentinelPay / FraudScope Backend
// ─────────────────────────────────────────────────────────────────────────────

require("dotenv").config();
const express = require("express");
const cors    = require("cors");
const neo4j   = require("neo4j-driver");

const fraudRoutes   = require("./fraudRoutes");
const alertsRoute   = require("./alertsRoute");
const simulateRoute = require("./simulateRoute");
const explainRoute  = require("./explainRoute");

const { computeRiskScores } = require("./riskScores");
const { computeStats }      = require("./stats");

const app  = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

// ── Neo4j driver ──────────────────────────────────────────────────────────────
const driver = neo4j.driver(
  process.env.NEO4J_URI  || "neo4j://127.0.0.1:7687",
  neo4j.auth.basic(
    process.env.NEO4J_USER || "neo4j",
    process.env.NEO4J_PASS || "password"
  ),
  { disableLosslessIntegers: true }
);

async function withSession(fn) {
  const session = driver.session();
  try   { return await fn(session); }
  finally { await session.close(); }
}

function toSafeNum(val) {
  if (val == null) return null;
  if (typeof val === "object" && typeof val.toNumber === "function") return val.toNumber();
  return Number(val);
}

// ─────────────────────────────────────────────────────────────────────────────
//  GET /api/health
// ─────────────────────────────────────────────────────────────────────────────
app.get("/api/health", async (req, res) => {
  try {
    await withSession((s) => s.run("RETURN 1"));
    res.json({ status: "ok", neo4j: "connected", timestamp: Date.now() });
  } catch (err) {
    res.status(503).json({ status: "error", neo4j: "disconnected", error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  GET /api/graph
// ─────────────────────────────────────────────────────────────────────────────
app.get("/api/graph", async (req, res) => {
  try {
    const data = await withSession(async (session) => {
      const result = await session.run(`
        MATCH (a:Account)-[r:SENT_TO]->(b:Account)
        RETURN
          a.id AS fromId, a.name AS fromName,
          b.id AS toId,   b.name AS toName,
          r.amount AS amount
      `);
      const nodeMap = new Map();
      const linkMap = new Map();
      for (const rec of result.records) {
        const fromId   = rec.get("fromId");
        const toId     = rec.get("toId");
        const fromName = rec.get("fromName") ?? fromId;
        const toName   = rec.get("toName")   ?? toId;
        const amount   = toSafeNum(rec.get("amount"));
        if (!nodeMap.has(fromId)) nodeMap.set(fromId, { id: fromId, name: fromName });
        if (!nodeMap.has(toId))   nodeMap.set(toId,   { id: toId,   name: toName   });
        const k = `${fromId}->${toId}`;
        if (!linkMap.has(k)) linkMap.set(k, { source: fromId, target: toId, amount });
      }
      return { nodes: [...nodeMap.values()], links: [...linkMap.values()] };
    });
    res.json(data);
  } catch (err) {
    console.error("[/api/graph]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  GET /api/stats
// ─────────────────────────────────────────────────────────────────────────────
app.get("/api/stats", async (req, res) => {
  try {
    const options = {
      highValueThreshold: parseFloat(req.query.threshold) || 10000,
      fanOutMin:          parseInt(req.query.fanOutMin)   || 3,
      fanInMin:           parseInt(req.query.fanInMin)    || 3,
    };
    const stats = await withSession((s) => computeStats(s, options));
    res.json({ success: true, ...stats });
  } catch (err) {
    console.error("[/api/stats]", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  GET /api/risk-scores  +  GET /api/risk-scores/:accountId
// ─────────────────────────────────────────────────────────────────────────────
app.get("/api/risk-scores", async (req, res) => {
  try {
    const options = {
      highValueThreshold: parseFloat(req.query.threshold) || 10000,
      criticalThreshold:  parseFloat(req.query.critical)  || 50000,
      fanDegreeMax:       parseInt(req.query.fanMax)       || 10,
    };
    const minScore = parseFloat(req.query.minScore) || 0;
    const limit    = Math.min(parseInt(req.query.limit) || 100, 500);
    let scores = await withSession((s) => computeRiskScores(s, options));
    if (minScore > 0) scores = scores.filter((s) => s.riskScore >= minScore);
    if (scores.length > limit) scores = scores.slice(0, limit);
    const dist = {
      CRITICAL: scores.filter((s) => s.riskLevel === "CRITICAL").length,
      HIGH:     scores.filter((s) => s.riskLevel === "HIGH").length,
      MEDIUM:   scores.filter((s) => s.riskLevel === "MEDIUM").length,
      LOW:      scores.filter((s) => s.riskLevel === "LOW").length,
      CLEAN:    scores.filter((s) => s.riskLevel === "CLEAN").length,
    };
    res.json({ success: true, total: scores.length, distribution: dist, scores, options, computedAt: new Date().toISOString() });
  } catch (err) {
    console.error("[/api/risk-scores]", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/api/risk-scores/:accountId", async (req, res) => {
  const { accountId } = req.params;
  try {
    const options = {
      highValueThreshold: parseFloat(req.query.threshold) || 10000,
      criticalThreshold:  parseFloat(req.query.critical)  || 50000,
      fanDegreeMax:       parseInt(req.query.fanMax)       || 10,
    };
    const all    = await withSession((s) => computeRiskScores(s, options));
    const record = all.find((s) => s.accountId === accountId);
    if (!record) return res.status(404).json({ success: false, error: `Account "${accountId}" not found` });
    res.json({ success: true, ...record });
  } catch (err) {
    console.error("[/api/risk-scores/:id]", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  Route mounts
// ─────────────────────────────────────────────────────────────────────────────
app.use("/api/fraud",   fraudRoutes(driver));
app.use("/api",         alertsRoute(driver));
app.use("/api",         simulateRoute(driver));
app.use("/api/explain", explainRoute(driver));

// ─────────────────────────────────────────────────────────────────────────────
//  POST /api/detect
//
//  Runs all 5 fraud patterns from fraudDetection.js against the live Neo4j
//  graph for the given from/to accounts:
//
//  Pattern 1 — Self Transfer      : from === to
//  Pattern 2 — High Value         : amount > 10000
//  Pattern 3 — Circular Loop      : from-account is already in a cycle in graph
//  Pattern 4 — Fan-Out            : from-account already sends to 3+ accounts
//  Pattern 5 — Fan-In             : to-account already receives from 3+ accounts
//
//  Each pattern adds a reason entry.
//  isFraud = true only if at least one pattern matches.
//  Safe transactions (amount <= 10000, no graph flags) return isFraud: false.
// ─────────────────────────────────────────────────────────────────────────────
app.post("/api/detect", async (req, res) => {
  const { from, to, amount } = req.body;

  // ── Input validation ───────────────────────────────────────────────────────
  if (!from || !to || amount == null) {
    return res.status(400).json({
      success: false,
      isFraud: null,
      reasons: ["Missing required fields: from, to, amount"],
    });
  }

  const amt = parseFloat(amount);
  if (isNaN(amt) || amt < 0) {
    return res.status(400).json({
      success: false,
      isFraud: null,
      reasons: ["amount must be a non-negative number"],
    });
  }

  const fromId = String(from).trim();
  const toId   = String(to).trim();
  const reasons = [];

  // ── Pattern 1: Self-transfer ───────────────────────────────────────────────
  // No Neo4j query needed — pure logic
  if (fromId === toId) {
    reasons.push({
      pattern:  "self_transfer",
      severity: "high",
      message:  "Self-transfer detected: sender and receiver are the same account",
    });
  }

  // ── Pattern 2: High-value transaction ─────────────────────────────────────
  // Only flag if amount > 10000. $75 = safe, $75000 = flagged.
  if (amt > 10000) {
    reasons.push({
      pattern:  "high_value",
      severity: amt > 50000 ? "critical" : "high",
      message:  `High-value transaction: $${amt.toLocaleString()} exceeds $10,000 threshold`,
    });
  }

  // ── Patterns 3, 4, 5: Graph-based checks (Neo4j queries) ──────────────────
  // Run all three in parallel — each gets its own session
  try {
    const [circularResult, fanOutResult, fanInResult] = await Promise.all([

      // Pattern 3 — Circular loop
      // Check if the "from" account is already part of a circular chain.
      // If it is, this new transaction likely extends or continues the loop.
      (async () => {
        const session = driver.session();
        try {
          const r = await session.run(
            `MATCH (a:Account { id: $fromId })
             OPTIONAL MATCH path = (a)-[:SENT_TO*2..6]->(a)
             RETURN path IS NOT NULL AS inLoop,
                    CASE WHEN path IS NOT NULL THEN length(path) ELSE null END AS loopLen
             LIMIT 1`,
            { fromId }
          );
          const inLoop  = r.records[0]?.get("inLoop")  ?? false;
          const loopLen = toSafeNum(r.records[0]?.get("loopLen"));
          return { inLoop, loopLen };
        } finally {
          await session.close();
        }
      })(),

      // Pattern 4 — Fan-out
      // Count how many DISTINCT accounts "from" already sends to.
      // If >= 3, it is a fan-out node — this new transaction makes it worse.
      (async () => {
        const session = driver.session();
        try {
          const r = await session.run(
            `MATCH (a:Account { id: $fromId })-[:SENT_TO]->(b:Account)
             RETURN count(DISTINCT b) AS outDeg`,
            { fromId }
          );
          const outDeg = toSafeNum(r.records[0]?.get("outDeg")) ?? 0;
          return { outDeg };
        } finally {
          await session.close();
        }
      })(),

      // Pattern 5 — Fan-in
      // Count how many DISTINCT accounts already send TO "to".
      // If >= 3, it is a fan-in node — receiving even more is suspicious.
      (async () => {
        const session = driver.session();
        try {
          const r = await session.run(
            `MATCH (src:Account)-[:SENT_TO]->(b:Account { id: $toId })
             RETURN count(DISTINCT src) AS inDeg`,
            { toId }
          );
          const inDeg = toSafeNum(r.records[0]?.get("inDeg")) ?? 0;
          return { inDeg };
        } finally {
          await session.close();
        }
      })(),
    ]);

    // Pattern 3 result
    if (circularResult.inLoop) {
      reasons.push({
        pattern:  "circular",
        severity: "critical",
        message:  `Circular loop risk: sender (${fromId}) is already part of a ${circularResult.loopLen}-hop transaction cycle`,
      });
    }

    // Pattern 4 result
    if (fanOutResult.outDeg >= 3) {
      reasons.push({
        pattern:  "fan_out",
        severity: fanOutResult.outDeg >= 6 ? "critical" : "high",
        message:  `Fan-out risk: sender (${fromId}) already distributes to ${fanOutResult.outDeg} accounts — structuring pattern detected`,
      });
    }

    // Pattern 5 result
    if (fanInResult.inDeg >= 3) {
      reasons.push({
        pattern:  "fan_in",
        severity: fanInResult.inDeg >= 6 ? "critical" : "high",
        message:  `Fan-in risk: receiver (${toId}) already collects from ${fanInResult.inDeg} accounts — aggregation pattern detected`,
      });
    }

  } catch (err) {
    // Graph checks failed (e.g. account doesn't exist yet) — don't block the response
    // Still return results from patterns 1 & 2 that were already checked
    console.warn("[/api/detect] Neo4j graph check failed:", err.message);
    reasons.push({
      pattern:  "graph_check_failed",
      severity: "low",
      message:  `Graph analysis unavailable: ${err.message}`,
    });
  }

  // ── Final response ─────────────────────────────────────────────────────────
  const isFraud = reasons.length > 0;

  // Derive overall severity from the worst reason
  const SEV_RANK = { critical: 4, high: 3, medium: 2, low: 1 };
  const topSeverity = reasons.reduce(
    (best, r) => (SEV_RANK[r.severity] ?? 0) > (SEV_RANK[best] ?? 0) ? r.severity : best,
    "low"
  );

  return res.json({
    success:     true,
    isFraud,
    severity:    isFraud ? topSeverity : "clean",
    // reasons as plain strings for the frontend list
    reasons:     reasons.map((r) => r.message),
    // full detail for any future use
    patterns:    reasons,
    details:     { from: fromId, to: toId, amount: amt },
  });
});


app.get("/", (req, res) => {
  res.send("Fraud Detection API is running 🚀");
});
// ── 404 fallback ──────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` });
});



// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════════════════════════╗
  ║   SentinelPay  —  http://localhost:${PORT}             ║
  ╚══════════════════════════════════════════════════════╝

  Detect patterns:
    1. Self-transfer      (no Neo4j needed)
    2. High-value > $10k  (no Neo4j needed)
    3. Circular loop      (Neo4j: sender in cycle?)
    4. Fan-out            (Neo4j: sender → 3+ accounts?)
    5. Fan-in             (Neo4j: receiver ← 3+ accounts?)
  `);
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────
process.on("SIGINT",  () => driver.close().then(() => process.exit(0)));
process.on("SIGTERM", () => driver.close().then(() => process.exit(0)));