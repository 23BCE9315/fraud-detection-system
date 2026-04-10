// ─────────────────────────────────────────────────────────────────────────────
// explainRoute.js  —  lives at backend/explainRoute.js
//
// ✅ THE ONLY CHANGE IN THIS FILE:
//   BEFORE:  router.get("/explain/:id", ...)
//   AFTER:   router.get("/:id", ...)
//
//   Why: app.js mounts this as  app.use("/api/explain", explainRoute(driver))
//   So the prefix "/api/explain" is already applied by Express.
//   If the route also says "/explain/:id", the full path becomes:
//     /api/explain/explain/:id  ← WRONG
//   With just "/:id" it correctly becomes:
//     /api/explain/:id          ← CORRECT
// ─────────────────────────────────────────────────────────────────────────────

const express = require("express");

module.exports = function explainRoute(driver) {
  const router = express.Router();

  // ✅ FIXED: was router.get("/explain/:id", ...)
  router.get("/:id", async (req, res) => {
    const accountId = req.params.id;

    const session = driver.session();
    try {
      // ── 1. Check account exists ────────────────────────────────────────────
      const accountResult = await session.run(
        `MATCH (a:Account { id: $id })
         RETURN a.id AS id, a.name AS name`,
        { id: accountId }
      );

      if (accountResult.records.length === 0) {
        return res.status(404).json({
          success: false,
          error: `Account "${accountId}" not found`,
        });
      }

      const accountName = accountResult.records[0].get("name") ?? accountId;

      // ── 2. Circular loop check ─────────────────────────────────────────────
      const circularResult = await session.run(
        `MATCH path = (a:Account { id: $id })-[:SENT_TO*2..6]->(a)
         RETURN length(path) AS loopLen
         LIMIT 1`,
        { id: accountId }
      );
      const isCircular = circularResult.records.length > 0;
      const loopLen    = isCircular
        ? toSafeNum(circularResult.records[0].get("loopLen"))
        : null;

      // ── 3. High-value outgoing ─────────────────────────────────────────────
      const highValueResult = await session.run(
        `MATCH (a:Account { id: $id })-[r:SENT_TO]->(:Account)
         WHERE r.amount > 10000
         RETURN count(r) AS cnt, max(r.amount) AS maxAmt`,
        { id: accountId }
      );
      const hvCount  = toSafeNum(highValueResult.records[0]?.get("cnt"))    ?? 0;
      const hvMaxAmt = toSafeNum(highValueResult.records[0]?.get("maxAmt")) ?? 0;

      // ── 4. Fan-out ─────────────────────────────────────────────────────────
      const fanOutResult = await session.run(
        `MATCH (a:Account { id: $id })-[:SENT_TO]->(b:Account)
         RETURN count(DISTINCT b) AS outDeg`,
        { id: accountId }
      );
      const outDeg   = toSafeNum(fanOutResult.records[0]?.get("outDeg")) ?? 0;
      const isFanOut = outDeg >= 3;

      // ── 5. Fan-in ──────────────────────────────────────────────────────────
      const fanInResult = await session.run(
        `MATCH (src:Account)-[:SENT_TO]->(tgt:Account { id: $id })
         RETURN count(DISTINCT src) AS inDeg`,
        { id: accountId }
      );
      const inDeg   = toSafeNum(fanInResult.records[0]?.get("inDeg")) ?? 0;
      const isFanIn = inDeg >= 3;

      // ── 6. Build reasons array ─────────────────────────────────────────────
      const reasons = [];

      if (isCircular) {
        reasons.push({
          type:     "circular",
          severity: "critical",
          icon:     "↺",
          title:    "Circular Transaction Loop",
          detail:   `This account is part of a ${loopLen}-hop circular money loop — a strong indicator of layering fraud.`,
        });
      }

      if (hvCount > 0) {
        reasons.push({
          type:     "high_value",
          severity: hvMaxAmt > 50000 ? "critical" : "high",
          icon:     "$",
          title:    "High-Value Transactions",
          detail:   `${hvCount} outgoing transaction${hvCount > 1 ? "s" : ""} exceed $10,000 (max: $${hvMaxAmt.toLocaleString()}).`,
        });
      }

      if (isFanOut) {
        reasons.push({
          type:     "fan_out",
          severity: outDeg >= 6 ? "high" : "medium",
          icon:     "↗",
          title:    "Fan-Out Pattern",
          detail:   `Sends money to ${outDeg} distinct accounts — possible structuring or smurfing behaviour.`,
        });
      }

      if (isFanIn) {
        reasons.push({
          type:     "fan_in",
          severity: inDeg >= 6 ? "high" : "medium",
          icon:     "↙",
          title:    "Fan-In Pattern",
          detail:   `Receives money from ${inDeg} distinct accounts — possible aggregation point for illicit funds.`,
        });
      }

      // ── 7. Overall severity ────────────────────────────────────────────────
      const SEV_RANK = { critical: 4, high: 3, medium: 2, low: 1 };
      const topSev = reasons.reduce(
        (best, r) => (SEV_RANK[r.severity] ?? 0) > (SEV_RANK[best] ?? 0) ? r.severity : best,
        "low"
      );
      const severity = reasons.length === 0 ? "clean" : topSev;

      const summary =
        reasons.length === 0
          ? `${accountName} shows no suspicious patterns.`
          : `${accountName} has ${reasons.length} fraud indicator${reasons.length > 1 ? "s" : ""}: ${reasons.map((r) => r.title).join(", ")}.`;

      res.json({
        success:   true,
        accountId,
        name:      accountName,
        severity,
        summary,
        reasons,
        checkedAt: new Date().toISOString(),
      });
    } catch (err) {
      console.error("[/api/explain/:id]", err.message);
      res.status(500).json({ success: false, error: err.message });
    } finally {
      await session.close();
    }
  });

  return router;
};

// ── Util ──────────────────────────────────────────────────────────────────────
function toSafeNum(val) {
  if (val == null) return null;
  if (typeof val === "object" && typeof val.toNumber === "function") return val.toNumber();
  return Number(val);
}