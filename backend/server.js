// ─────────────────────────────────────────────────────────────────────────────
// server.js  —  FraudScope Backend
// Neo4j + Express + fraud detection + risk scoring + stats
// ─────────────────────────────────────────────────────────────────────────────

require("dotenv").config();
const express     = require("express");
const cors        = require("cors");
const neo4j       = require("neo4j-driver");
const fraudRoutes  = require("./fraudRoutes");
const alertsRoute  = require("./alertsRoute");
const simulateRoute = require("./simulateRoute");
const explainRoute  = require("./explainRoute");
const { computeRiskScores } = require("./riskScores");
const { computeStats }      = require("./stats");

// ── App setup ─────────────────────────────────────────────────────────────────
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

// ── Session helper ────────────────────────────────────────────────────────────
async function withSession(fn) {
  const session = driver.session();
  try {
    return await fn(session);
  } finally {
    await session.close();
  }
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
        if (!nodeMap.has(toId))   nodeMap.set(toId,   { id: toId,   name: toName });

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
//  Dashboard summary stats.
//
//  Query params (all optional):
//    threshold=10000   high-value amount threshold
//    fanOutMin=3       min out-degree to classify as fan-out
//    fanInMin=3        min in-degree  to classify as fan-in
//
//  Response:
//  {
//    totalAccounts, totalTransactions,
//    circularCount, highValueCount, fanOutCount, fanInCount,
//    flaggedAccounts, fraudRate, thresholds, computedAt
//  }
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
//  GET /api/risk-scores
//  Risk score 0–100 for every account, sorted highest → lowest.
//
//  Query params (all optional):
//    threshold=10000   high-value amount threshold
//    critical=50000    critical-value threshold (max signal points)
//    fanMax=10         degree ceiling for fan-in/fan-out scoring
//    minScore=0        exclude accounts below this score
//    limit=100         max results (capped at 500)
//
//  Response:
//  {
//    total, distribution: { CRITICAL, HIGH, MEDIUM, LOW, CLEAN },
//    scores: [{ accountId, name, riskScore, riskLevel, signals, metrics }]
//  }
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

    const distribution = {
      CRITICAL: scores.filter((s) => s.riskLevel === "CRITICAL").length,
      HIGH:     scores.filter((s) => s.riskLevel === "HIGH").length,
      MEDIUM:   scores.filter((s) => s.riskLevel === "MEDIUM").length,
      LOW:      scores.filter((s) => s.riskLevel === "LOW").length,
      CLEAN:    scores.filter((s) => s.riskLevel === "CLEAN").length,
    };

    res.json({
      success: true,
      total: scores.length,
      distribution,
      scores,
      options,
      computedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[/api/risk-scores]", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  GET /api/risk-scores/:accountId
//  Risk score for one specific account.
// ─────────────────────────────────────────────────────────────────────────────
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

    if (!record) {
      return res.status(404).json({ success: false, error: `Account "${accountId}" not found` });
    }

    res.json({ success: true, ...record });
  } catch (err) {
    console.error("[/api/risk-scores/:id]", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Fraud routes: /api/fraud/* ────────────────────────────────────────────────
app.use("/api/fraud", fraudRoutes(driver));

// ── Alerts route: /api/alerts ─────────────────────────────────────────────────
app.use("/api", alertsRoute(driver));

// ── Simulate route: POST /api/simulate ───────────────────────────────────────
app.use("/api", simulateRoute(driver));

// ── Explain route: GET /api/explain/:id ──────────────────────────────────────
app.use("/api", explainRoute(driver));

// ── 404 fallback ──────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
  ╔═══════════════════════════════════════════════════════╗
  ║   FraudScope  —  http://localhost:${PORT}               ║
  ╚═══════════════════════════════════════════════════════╝

  Neo4j  :  ${process.env.NEO4J_URI || "neo4j://127.0.0.1:7687"}

  Endpoints:
    GET  /api/health
    GET  /api/graph
    GET  /api/stats
    GET  /api/risk-scores
    GET  /api/risk-scores/:accountId
    GET  /api/alerts               ?minScore=60
    POST /api/simulate             { count, includeFraud }

    GET  /api/fraud/circular
    GET  /api/fraud/high-value
    GET  /api/fraud/fan-out
    GET  /api/fraud/fan-in
    GET  /api/fraud/rapid
    GET  /api/fraud/all
  `);
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────
process.on("SIGINT",  () => driver.close().then(() => process.exit(0)));
process.on("SIGTERM", () => driver.close().then(() => process.exit(0)));

// ── Util ──────────────────────────────────────────────────────────────────────
function toSafeNum(val) {
  if (val == null) return null;
  if (typeof val === "object" && typeof val.toNumber === "function") return val.toNumber();
  return Number(val);
}