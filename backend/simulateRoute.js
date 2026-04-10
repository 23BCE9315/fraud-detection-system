// ─────────────────────────────────────────────────────────────────────────────
// simulateRoute.js  —  POST /api/simulate
// Creates random realistic transactions between existing Account nodes.
// Occasionally plants fraud patterns so the graph stays interesting.
//
// Mount in server.js:
//   const simulateRoute = require('./simulateRoute');
//   app.use('/api', simulateRoute(driver));
// ─────────────────────────────────────────────────────────────────────────────

const express = require("express");

module.exports = function simulateRoute(driver) {
  const router = express.Router();

  // POST /api/simulate
  // Body (all optional): { count: 8, includeFraud: true }
  router.post("/simulate", async (req, res) => {
    const count       = Math.min(parseInt(req.body?.count) || 8, 30);
    const includeFraud = req.body?.includeFraud !== false; // default true

    const session = driver.session();
    try {
      // ── 1. Fetch all existing account IDs ──────────────────────────────────
      const accResult = await session.run(
        "MATCH (a:Account) RETURN a.id AS id ORDER BY rand() LIMIT 40"
      );
      const ids = accResult.records.map((r) => r.get("id"));

      if (ids.length < 2) {
        return res.status(400).json({
          success: false,
          error: "Need at least 2 Account nodes. Run the seed script first.",
        });
      }

      const now = Date.now();
      let created = 0;

      // ── 2. Normal random transactions ──────────────────────────────────────
      const normalCount = includeFraud ? Math.max(count - 3, Math.floor(count * 0.6)) : count;

      for (let i = 0; i < normalCount; i++) {
        const src = pick(ids);
        const tgt = pick(ids.filter((x) => x !== src));
        const amount    = randInt(100, 8000);
        const timestamp = now - randInt(0, 30 * 60 * 1000); // within last 30 min

        await session.run(
          `MATCH (a:Account {id:$src}),(b:Account {id:$tgt})
           CREATE (a)-[:SENT_TO {amount:$amount, timestamp:$timestamp, type:"simulated"}]->(b)`,
          { src, tgt, amount, timestamp }
        );
        created++;
      }

      // ── 3. Occasional fraud injection ─────────────────────────────────────
      if (includeFraud && ids.length >= 3) {

        // 40% chance: add a rapid burst (3 quick txns from same account)
        if (Math.random() < 0.4) {
          const src     = pick(ids);
          const targets = shuffle(ids.filter((x) => x !== src)).slice(0, 3);
          for (const tgt of targets) {
            const amount    = randInt(500, 5000);
            const timestamp = now - randInt(0, 5 * 60 * 1000); // within 5 min
            await session.run(
              `MATCH (a:Account {id:$src}),(b:Account {id:$tgt})
               CREATE (a)-[:SENT_TO {amount:$amount, timestamp:$timestamp, type:"simulated_rapid"}]->(b)`,
              { src, tgt, amount, timestamp }
            );
            created++;
          }
        }

        // 25% chance: add a high-value transaction
        if (Math.random() < 0.25) {
          const src    = pick(ids);
          const tgt    = pick(ids.filter((x) => x !== src));
          const amount = randInt(15000, 80000);
          await session.run(
            `MATCH (a:Account {id:$src}),(b:Account {id:$tgt})
             CREATE (a)-[:SENT_TO {amount:$amount, timestamp:$ts, type:"simulated_hv"}]->(b)`,
            { src, tgt, amount, ts: now - randInt(0, 60000) }
          );
          created++;
        }
      }

      res.json({
        success:     true,
        created,
        message:     `Simulated ${created} transaction${created !== 1 ? "s" : ""} between existing accounts.`,
        timestamp:   new Date().toISOString(),
      });

    } catch (err) {
      console.error("[/api/simulate]", err.message);
      res.status(500).json({ success: false, error: err.message });
    } finally {
      await session.close();
    }
  });

  return router;
};

// ── Helpers ───────────────────────────────────────────────────────────────────
const pick    = (arr) => arr[Math.floor(Math.random() * arr.length)];
const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const shuffle = (arr) => [...arr].sort(() => Math.random() - 0.5);