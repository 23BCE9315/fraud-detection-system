// ─────────────────────────────────────────────────────────────────────────────
// fraudRoutes.js  —  /api/fraud/*
//
// Existing routes unchanged.
// ✅ NEW ROUTE ADDED:  POST /api/fraud/detect
// ─────────────────────────────────────────────────────────────────────────────

const express = require("express");

module.exports = function fraudRoutes(driver) {
  const router = express.Router();

  // ── Util ──────────────────────────────────────────────────────────────────
  function toSafeNum(val) {
    if (val == null) return null;
    if (typeof val === "object" && typeof val.toNumber === "function") return val.toNumber();
    return Number(val);
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  GET /api/fraud/circular
  // ─────────────────────────────────────────────────────────────────────────
  router.get("/circular", async (req, res) => {
    const session = driver.session();
    try {
      const result = await session.run(`
        MATCH path = (a:Account)-[:SENT_TO*2..6]->(a)
        WITH nodes(path) AS ns, relationships(path) AS rs
        RETURN [n IN ns | n.id]  AS cycle,
               [r IN rs | r.amount] AS amounts
        LIMIT 20
      `);

      const fraudPaths = result.records.map((rec) => {
        const cycle   = rec.get("cycle");
        const amounts = rec.get("amounts").map(toSafeNum);
        const steps   = [];
        for (let i = 0; i < cycle.length - 1; i++) {
          steps.push({ from: cycle[i], to: cycle[i + 1], amount: amounts[i] });
        }
        return steps;
      });

      res.json({ success: true, count: fraudPaths.length, fraudPaths });
    } catch (err) {
      console.error("[/api/fraud/circular]", err.message);
      res.status(500).json({ success: false, error: err.message });
    } finally {
      await session.close();
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  //  GET /api/fraud/high-value
  // ─────────────────────────────────────────────────────────────────────────
  router.get("/high-value", async (req, res) => {
    const threshold = parseFloat(req.query.threshold) || 10000;
    const session   = driver.session();
    try {
      const result = await session.run(
        `MATCH (a:Account)-[r:SENT_TO]->(b:Account)
         WHERE r.amount > $threshold
         RETURN a.id AS from, b.id AS to, r.amount AS amount
         ORDER BY r.amount DESC
         LIMIT 50`,
        { threshold }
      );

      const transactions = result.records.map((rec) => ({
        from:   rec.get("from"),
        to:     rec.get("to"),
        amount: toSafeNum(rec.get("amount")),
      }));

      res.json({ success: true, count: transactions.length, threshold, transactions });
    } catch (err) {
      console.error("[/api/fraud/high-value]", err.message);
      res.status(500).json({ success: false, error: err.message });
    } finally {
      await session.close();
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  //  GET /api/fraud/fan-out
  // ─────────────────────────────────────────────────────────────────────────
  router.get("/fan-out", async (req, res) => {
    const minDeg  = parseInt(req.query.min) || 3;
    const session = driver.session();
    try {
      const result = await session.run(
        `MATCH (a:Account)-[:SENT_TO]->(b:Account)
         WITH a, collect(DISTINCT b.id) AS targets
         WHERE size(targets) >= $minDeg
         RETURN a.id AS account, size(targets) AS degree, targets AS sentTo
         ORDER BY degree DESC
         LIMIT 30`,
        { minDeg }
      );

      const accounts = result.records.map((rec) => ({
        account: rec.get("account"),
        degree:  toSafeNum(rec.get("degree")),
        sentTo:  rec.get("sentTo"),
      }));

      res.json({ success: true, count: accounts.length, minDegree: minDeg, accounts });
    } catch (err) {
      console.error("[/api/fraud/fan-out]", err.message);
      res.status(500).json({ success: false, error: err.message });
    } finally {
      await session.close();
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  //  GET /api/fraud/fan-in
  // ─────────────────────────────────────────────────────────────────────────
  router.get("/fan-in", async (req, res) => {
    const minDeg  = parseInt(req.query.min) || 3;
    const session = driver.session();
    try {
      const result = await session.run(
        `MATCH (src:Account)-[:SENT_TO]->(tgt:Account)
         WITH tgt, collect(DISTINCT src.id) AS sources
         WHERE size(sources) >= $minDeg
         RETURN tgt.id AS account, size(sources) AS degree, sources AS receivedFrom
         ORDER BY degree DESC
         LIMIT 30`,
        { minDeg }
      );

      const accounts = result.records.map((rec) => ({
        account:      rec.get("account"),
        degree:       toSafeNum(rec.get("degree")),
        receivedFrom: rec.get("receivedFrom"),
      }));

      res.json({ success: true, count: accounts.length, minDegree: minDeg, accounts });
    } catch (err) {
      console.error("[/api/fraud/fan-in]", err.message);
      res.status(500).json({ success: false, error: err.message });
    } finally {
      await session.close();
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  //  GET /api/fraud/rapid
  // ─────────────────────────────────────────────────────────────────────────
  router.get("/rapid", async (req, res) => {
    const session = driver.session();
    try {
      const result = await session.run(`
        MATCH (a:Account)-[r:SENT_TO]->(b:Account)
        WHERE r.timestamp IS NOT NULL
        WITH a, collect({ to: b.id, ts: r.timestamp, amount: r.amount }) AS txns
        WHERE size(txns) >= 3
        RETURN a.id AS account, txns
        LIMIT 20
      `);

      const accounts = result.records.map((rec) => ({
        account: rec.get("account"),
        txns:    rec.get("txns"),
      }));

      res.json({ success: true, count: accounts.length, accounts });
    } catch (err) {
      console.error("[/api/fraud/rapid]", err.message);
      res.status(500).json({ success: false, error: err.message });
    } finally {
      await session.close();
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  //  GET /api/fraud/all
  //  Runs circular, high-value, fan-out, fan-in in parallel and merges.
  // ─────────────────────────────────────────────────────────────────────────
  router.get("/all", async (req, res) => {
    const threshold = parseFloat(req.query.threshold) || 10000;
    const fanMin    = parseInt(req.query.fanMin) || 3;

    try {
      const [circular, highValue, fanOut, fanIn] = await Promise.all([
        (async () => {
          const s = driver.session();
          try {
            const r = await s.run(`
              MATCH path = (a:Account)-[:SENT_TO*2..6]->(a)
              WITH nodes(path) AS ns, relationships(path) AS rs
              RETURN [n IN ns | n.id] AS cycle, [r IN rs | r.amount] AS amounts
              LIMIT 20
            `);
            const fraudPaths = r.records.map((rec) => {
              const cycle   = rec.get("cycle");
              const amounts = rec.get("amounts").map(toSafeNum);
              return cycle.slice(0, -1).map((id, i) => ({ from: id, to: cycle[i + 1], amount: amounts[i] }));
            });
            return { count: fraudPaths.length, fraudPaths };
          } finally { await s.close(); }
        })(),

        (async () => {
          const s = driver.session();
          try {
            const r = await s.run(
              `MATCH (a:Account)-[r:SENT_TO]->(b:Account)
               WHERE r.amount > $threshold
               RETURN a.id AS from, b.id AS to, r.amount AS amount
               ORDER BY r.amount DESC LIMIT 50`,
              { threshold }
            );
            const transactions = r.records.map((rec) => ({
              from: rec.get("from"), to: rec.get("to"), amount: toSafeNum(rec.get("amount")),
            }));
            return { count: transactions.length, threshold, transactions };
          } finally { await s.close(); }
        })(),

        (async () => {
          const s = driver.session();
          try {
            const r = await s.run(
              `MATCH (a:Account)-[:SENT_TO]->(b:Account)
               WITH a, collect(DISTINCT b.id) AS targets
               WHERE size(targets) >= $fanMin
               RETURN a.id AS account, size(targets) AS degree, targets AS sentTo
               ORDER BY degree DESC LIMIT 30`,
              { fanMin }
            );
            const accounts = r.records.map((rec) => ({
              account: rec.get("account"), degree: toSafeNum(rec.get("degree")), sentTo: rec.get("sentTo"),
            }));
            return { count: accounts.length, minDegree: fanMin, accounts };
          } finally { await s.close(); }
        })(),

        (async () => {
          const s = driver.session();
          try {
            const r = await s.run(
              `MATCH (src:Account)-[:SENT_TO]->(tgt:Account)
               WITH tgt, collect(DISTINCT src.id) AS sources
               WHERE size(sources) >= $fanMin
               RETURN tgt.id AS account, size(sources) AS degree, sources AS receivedFrom
               ORDER BY degree DESC LIMIT 30`,
              { fanMin }
            );
            const accounts = r.records.map((rec) => ({
              account: rec.get("account"), degree: toSafeNum(rec.get("degree")), receivedFrom: rec.get("receivedFrom"),
            }));
            return { count: accounts.length, minDegree: fanMin, accounts };
          } finally { await s.close(); }
        })(),
      ]);

      res.json({ success: true, circular, highValue, fanOut, fanIn, computedAt: new Date().toISOString() });
    } catch (err) {
      console.error("[/api/fraud/all]", err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  //  ✅ NEW:  POST /api/fraud/detect
  //
  //  Body:   { from: "A1", to: "A2", amount: 20000 }
  //  Output: { success: true, fraud: true|false, reasons: [] }
  //
  //  Rules (simple, as requested):
  //    1. from === to          → "Self transfer detected"
  //    2. amount > 10000       → "High value transaction"
  //    Otherwise               → not fraud
  // ─────────────────────────────────────────────────────────────────────────
  router.post("/detect", async (req, res) => {
    const { from, to, amount } = req.body;

    // ── Input validation ──────────────────────────────────────────────────
    if (!from || !to || amount == null) {
      return res.status(400).json({
        success: false,
        error:   "Missing required fields: from, to, amount",
      });
    }

    const amt = parseFloat(amount);
    if (isNaN(amt) || amt < 0) {
      return res.status(400).json({
        success: false,
        error:   "amount must be a non-negative number",
      });
    }

    // ── Fraud rules ───────────────────────────────────────────────────────
    const reasons = [];

    if (String(from).trim() === String(to).trim()) {
      reasons.push("Self transfer detected");
    }

    if (amt > 10000) {
      reasons.push("High value transaction");
    }

    const isFraud = reasons.length > 0;

    // ── Response ──────────────────────────────────────────────────────────
    return res.json({
      success: true,
      fraud:   isFraud,
      reasons,
      details: { from, to, amount: amt },
    });
  });

  return router;
};