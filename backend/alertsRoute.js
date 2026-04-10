// ─────────────────────────────────────────────────────────────────────────────
// alertsRoute.js  —  GET /api/alerts
// Returns accounts whose computed risk score exceeds a threshold (default 60).
// Mounted in server.js as: app.use('/api', alertsRoute(driver))
// ─────────────────────────────────────────────────────────────────────────────

const express = require("express");
const { computeRiskScores } = require("./riskScores");

module.exports = function alertsRoute(driver) {
  const router = express.Router();

  // GET /api/alerts?minScore=60&limit=50
  router.get("/alerts", async (req, res) => {
    const minScore = parseFloat(req.query.minScore) || 60;
    const limit    = Math.min(parseInt(req.query.limit) || 50, 200);

    const session = driver.session();
    try {
      const allScores = await computeRiskScores(session, {
        highValueThreshold: 10000,
        criticalThreshold:  50000,
        fanDegreeMax:       10,
      });

      const alerts = allScores
        .filter((s) => s.riskScore >= minScore)
        .slice(0, limit)
        .map((s) => ({
          accountId:  s.accountId,
          name:       s.name,
          riskScore:  s.riskScore,
          riskLevel:  s.riskLevel,
          signals:    s.signals,
          // top reason — the signal that contributed the most points
          topReason:  topReason(s.signals),
        }));

      res.json({
        success:   true,
        count:     alerts.length,
        minScore,
        alerts,
        computedAt: new Date().toISOString(),
      });
    } catch (err) {
      console.error("[/api/alerts]", err.message);
      res.status(500).json({ success: false, error: err.message });
    } finally {
      await session.close();
    }
  });

  return router;
};

// ── helpers ───────────────────────────────────────────────────────────────────
function topReason(signals) {
  const labels = {
    circular:          "Circular loop",
    fanOut:            "Fan-out",
    fanIn:             "Fan-in",
    highValueSent:     "High-value sent",
    highValueReceived: "High-value received",
  };
  const top = Object.entries(signals).sort((a, b) => b[1] - a[1])[0];
  return top ? `${labels[top[0]] ?? top[0]} (+${top[1]})` : "Unknown";
}