const express = require("express");
const router = express.Router();

const { getSession } = require("../config/db");


// ✅ GET full graph
router.get("/graph", async (req, res) => {
  const session = getSession();

  try {
    const result = await session.run(`
      MATCH (a:Account)-[r:SENT_TO]->(b:Account)
      RETURN a, r, b
    `);

    const nodesMap = new Map();
    const links = [];

    result.records.forEach((record) => {
      const a = record.get("a").properties;
      const b = record.get("b").properties;
      const r = record.get("r").properties;

      nodesMap.set(a.id, a);
      nodesMap.set(b.id, b);

      links.push({
        source: a.id,
        target: b.id,
        amount: Number(r.amount), // safer conversion
      });
    });

    const nodes = Array.from(nodesMap.values());

    res.json({ nodes, links });

  } catch (error) {
    console.error("Graph Fetch Error:", error);
    res.status(500).json({ error: error.message });
  } finally {
    await session.close();
  }
});


// 🔥 Fraud Detection: Circular Transactions (FINAL FIX)
router.get("/fraud/circular", async (req, res) => {
  const session = getSession();

  try {
    const result = await session.run(`
      MATCH path = (a:Account)-[:SENT_TO*3..5]->(a)
      RETURN path
    `);

    const uniqueLoops = new Set();

const fraudPaths = result.records
  .map((record) => {
    const path = record.get("path");

    // Extract nodes
    let nodes = path.segments.map((seg) => seg.start.properties.id);
    nodes.push(path.end.properties.id);

    // Remove last duplicate node for cycle
    nodes = nodes.slice(0, -1);

    // Generate all rotations
    const rotations = nodes.map((_, i) =>
      [...nodes.slice(i), ...nodes.slice(0, i)].join("-")
    );

    // Pick smallest rotation as canonical key
    const key = rotations.sort()[0];

    if (uniqueLoops.has(key)) return null;
    uniqueLoops.add(key);

    return path.segments.map((seg) => ({
      from: seg.start.properties.id,
      to: seg.end.properties.id,
    }));
  })
  .filter(Boolean);
    res.json({ fraudPaths });

  } catch (error) {
    console.error("Fraud Detection Error:", error);
    res.status(500).json({ error: error.message });
  } finally {
    await session.close();
  }
});

module.exports = router;