// ─────────────────────────────────────────────────────────────────────────────
// seed.js  —  Generate realistic fake transaction data for Neo4j
// Fraud Detection System — seed script
//
// Creates:
//   • 80 Account nodes with realistic names
//   • ~200 normal transactions
//   • 3 circular fraud loops  (3-hop, 4-hop, 5-hop)
//   • 2 fan-out accounts      (1 → many)
//   • 2 fan-in  accounts      (many → 1)
//   • 15 high-value transactions (amount > 10000)
//
// Run:  node seed.js
// ─────────────────────────────────────────────────────────────────────────────

require("dotenv").config();
const neo4j = require("neo4j-driver");

// ── Connection (reads from .env) ──────────────────────────────────────────────
const URI  = process.env.NEO4J_URI  || "neo4j://127.0.0.1:7687";
const USER = process.env.NEO4J_USER || "neo4j";
const PASS = process.env.NEO4J_PASS || "password";

const driver  = neo4j.driver(URI, neo4j.auth.basic(USER, PASS), { disableLosslessIntegers: true });

// ── Helpers ───────────────────────────────────────────────────────────────────
const rand    = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const pick    = (arr)      => arr[Math.floor(Math.random() * arr.length)];
const shuffle = (arr)      => [...arr].sort(() => Math.random() - 0.5);
const now     = Date.now();
const minutesAgo = (m)     => now - m * 60 * 1000;

// ── Realistic account names ───────────────────────────────────────────────────
const FIRST = ["Alice","Bob","Charlie","Diana","Eve","Frank","Grace","Hank","Iris","Jack",
               "Karen","Leo","Maya","Nate","Olivia","Paul","Quinn","Rita","Sam","Tina",
               "Uma","Victor","Wendy","Xander","Yara","Zoe","Aaron","Beth","Carl","Dana",
               "Eli","Fiona","George","Holly","Ivan","Julia","Kevin","Laura","Mike","Nina",
               "Oscar","Petra","Randy","Sarah","Tom","Ursula","Vince","Wanda","Xavier","Yvonne"];

const LAST  = ["Smith","Jones","Brown","Wilson","Taylor","Davies","Evans","Thomas","Roberts",
               "Johnson","White","Harris","Martin","Clark","Lewis","Walker","Hall","Allen",
               "Young","King","Wright","Scott","Green","Baker","Adams","Nelson","Hill","Moore",
               "Turner","Parker","Edwards","Collins","Stewart","Morris","Rogers","Cook","Morgan",
               "Bell","Murphy","Bailey","Cooper","Richardson","Cox","Howard","Ward","Brooks","Gray"];

// Generate 80 unique account IDs + names
function generateAccounts(n = 80) {
  const accounts = [];
  const used = new Set();
  let i = 0;
  while (accounts.length < n) {
    const first = FIRST[i % FIRST.length];
    const last  = LAST[Math.floor(i / FIRST.length) % LAST.length];
    const id    = `ACC${String(i + 1).padStart(3, "0")}`;
    if (!used.has(id)) {
      used.add(id);
      accounts.push({ id, name: `${first} ${last}` });
    }
    i++;
  }
  return accounts;
}

// ── Cypher runner ─────────────────────────────────────────────────────────────
async function run(session, query, params = {}) {
  return session.run(query, params);
}

// ── MAIN SEED FUNCTION ────────────────────────────────────────────────────────
async function seed() {
  const session = driver.session();

  try {
    console.log("\n🌱  Starting Neo4j seed...\n");

    // ── Step 1: Clear existing data ──────────────────────────────────────────
    console.log("  🗑   Clearing existing data...");
    await run(session, "MATCH (n) DETACH DELETE n");
    console.log("  ✓   Cleared.\n");

    // ── Step 2: Create accounts ──────────────────────────────────────────────
    const accounts = generateAccounts(80);
    console.log(`  👤  Creating ${accounts.length} accounts...`);

    for (const acc of accounts) {
      await run(session,
        "CREATE (:Account { id: $id, name: $name, createdAt: $ts })",
        { id: acc.id, name: acc.name, ts: now }
      );
    }
    console.log("  ✓   Accounts created.\n");

    const ids = accounts.map((a) => a.id);

    // ── Step 3: Normal transactions ──────────────────────────────────────────
    console.log("  💸  Creating ~200 normal transactions...");
    const normalEdges = new Set();
    let normalCount   = 0;

    while (normalCount < 200) {
      const src = pick(ids);
      const tgt = pick(ids.filter((x) => x !== src));
      const key = `${src}->${tgt}`;
      if (normalEdges.has(key)) continue;
      normalEdges.add(key);

      const amount    = rand(50, 4999);
      const timestamp = minutesAgo(rand(1, 10000));

      await run(session, `
        MATCH (a:Account {id: $src}), (b:Account {id: $tgt})
        CREATE (a)-[:SENT_TO { amount: $amount, timestamp: $timestamp, type: "normal" }]->(b)
      `, { src, tgt, amount, timestamp });
      normalCount++;
    }
    console.log(`  ✓   ${normalCount} normal transactions created.\n`);

    // ── Step 4: HIGH-VALUE transactions (amount > 10000) ─────────────────────
    console.log("  💰  Creating 15 high-value transactions (> $10,000)...");
    const hvEdges = new Set();
    let hvCount   = 0;

    while (hvCount < 15) {
      const src = pick(ids);
      const tgt = pick(ids.filter((x) => x !== src));
      const key = `hv:${src}->${tgt}`;
      if (hvEdges.has(key)) continue;
      hvEdges.add(key);

      const amount    = rand(10001, 95000);
      const timestamp = minutesAgo(rand(1, 500));

      await run(session, `
        MATCH (a:Account {id: $src}), (b:Account {id: $tgt})
        CREATE (a)-[:SENT_TO { amount: $amount, timestamp: $timestamp, type: "high_value" }]->(b)
      `, { src, tgt, amount, timestamp });
      hvCount++;
    }
    console.log(`  ✓   ${hvCount} high-value transactions created.\n`);

    // ── Step 5: CIRCULAR fraud loops ─────────────────────────────────────────
    console.log("  ↺   Creating circular fraud loops...");

    // Loop 1 — 3-hop: A→B→C→A
    const loop3 = shuffle(ids).slice(0, 3);
    console.log(`       Loop 1 (3-hop): ${loop3.join(" → ")} → ${loop3[0]}`);
    for (let i = 0; i < loop3.length; i++) {
      const src = loop3[i];
      const tgt = loop3[(i + 1) % loop3.length];
      await run(session, `
        MATCH (a:Account {id: $src}), (b:Account {id: $tgt})
        MERGE (a)-[:SENT_TO { amount: $amount, timestamp: $timestamp, type: "circular" }]->(b)
      `, { src, tgt, amount: rand(5000, 30000), timestamp: minutesAgo(rand(1, 60)) });
    }

    // Loop 2 — 4-hop: A→B→C→D→A
    const loop4 = shuffle(ids.filter((x) => !loop3.includes(x))).slice(0, 4);
    console.log(`       Loop 2 (4-hop): ${loop4.join(" → ")} → ${loop4[0]}`);
    for (let i = 0; i < loop4.length; i++) {
      const src = loop4[i];
      const tgt = loop4[(i + 1) % loop4.length];
      await run(session, `
        MATCH (a:Account {id: $src}), (b:Account {id: $tgt})
        MERGE (a)-[:SENT_TO { amount: $amount, timestamp: $timestamp, type: "circular" }]->(b)
      `, { src, tgt, amount: rand(8000, 50000), timestamp: minutesAgo(rand(1, 45)) });
    }

    // Loop 3 — 5-hop: A→B→C→D→E→A
    const loop5 = shuffle(ids.filter((x) => !loop3.includes(x) && !loop4.includes(x))).slice(0, 5);
    console.log(`       Loop 3 (5-hop): ${loop5.join(" → ")} → ${loop5[0]}`);
    for (let i = 0; i < loop5.length; i++) {
      const src = loop5[i];
      const tgt = loop5[(i + 1) % loop5.length];
      await run(session, `
        MATCH (a:Account {id: $src}), (b:Account {id: $tgt})
        MERGE (a)-[:SENT_TO { amount: $amount, timestamp: $timestamp, type: "circular" }]->(b)
      `, { src, tgt, amount: rand(3000, 20000), timestamp: minutesAgo(rand(1, 30)) });
    }
    console.log("  ✓   Circular loops created.\n");

    // ── Step 6: FAN-OUT fraud (1 account → many) ─────────────────────────────
    console.log("  ↗   Creating fan-out fraud accounts...");

    const usedInLoops = new Set([...loop3, ...loop4, ...loop5]);
    const cleanIds    = ids.filter((x) => !usedInLoops.has(x));

    // Fan-out 1: sends to 8 accounts rapidly
    const fo1src     = pick(cleanIds);
    const fo1targets = shuffle(cleanIds.filter((x) => x !== fo1src)).slice(0, 8);
    console.log(`       Fan-out 1: ${fo1src} → [${fo1targets.join(", ")}]`);
    for (const tgt of fo1targets) {
      await run(session, `
        MATCH (a:Account {id: $src}), (b:Account {id: $tgt})
        MERGE (a)-[:SENT_TO { amount: $amount, timestamp: $timestamp, type: "fan_out" }]->(b)
      `, { src: fo1src, tgt, amount: rand(500, 3000), timestamp: minutesAgo(rand(1, 20)) });
    }

    // Fan-out 2: sends to 6 accounts
    const fo2src     = pick(cleanIds.filter((x) => x !== fo1src));
    const fo2targets = shuffle(cleanIds.filter((x) => x !== fo2src && x !== fo1src && !fo1targets.includes(x))).slice(0, 6);
    console.log(`       Fan-out 2: ${fo2src} → [${fo2targets.join(", ")}]`);
    for (const tgt of fo2targets) {
      await run(session, `
        MATCH (a:Account {id: $src}), (b:Account {id: $tgt})
        MERGE (a)-[:SENT_TO { amount: $amount, timestamp: $timestamp, type: "fan_out" }]->(b)
      `, { src: fo2src, tgt, amount: rand(200, 1500), timestamp: minutesAgo(rand(1, 30)) });
    }
    console.log("  ✓   Fan-out accounts created.\n");

    // ── Step 7: FAN-IN fraud (many accounts → 1) ──────────────────────────────
    console.log("  ↙   Creating fan-in fraud accounts...");

    const foUsed = new Set([fo1src, fo2src, ...fo1targets, ...fo2targets]);
    const fiPool = cleanIds.filter((x) => !foUsed.has(x));

    // Fan-in 1: 7 accounts all send to same target
    const fi1tgt     = pick(fiPool);
    const fi1sources = shuffle(fiPool.filter((x) => x !== fi1tgt)).slice(0, 7);
    console.log(`       Fan-in 1: [${fi1sources.join(", ")}] → ${fi1tgt}`);
    for (const src of fi1sources) {
      await run(session, `
        MATCH (a:Account {id: $src}), (b:Account {id: $tgt})
        MERGE (a)-[:SENT_TO { amount: $amount, timestamp: $timestamp, type: "fan_in" }]->(b)
      `, { src, tgt: fi1tgt, amount: rand(1000, 8000), timestamp: minutesAgo(rand(1, 40)) });
    }

    // Fan-in 2: 5 accounts all send to same target
    const fi2pool    = fiPool.filter((x) => x !== fi1tgt && !fi1sources.includes(x));
    const fi2tgt     = pick(fi2pool);
    const fi2sources = shuffle(fi2pool.filter((x) => x !== fi2tgt)).slice(0, 5);
    console.log(`       Fan-in 2: [${fi2sources.join(", ")}] → ${fi2tgt}`);
    for (const src of fi2sources) {
      await run(session, `
        MATCH (a:Account {id: $src}), (b:Account {id: $tgt})
        MERGE (a)-[:SENT_TO { amount: $amount, timestamp: $timestamp, type: "fan_in" }]->(b)
      `, { src, tgt: fi2tgt, amount: rand(500, 4000), timestamp: minutesAgo(rand(1, 25)) });
    }
    console.log("  ✓   Fan-in accounts created.\n");

    // ── Step 8: Summary ──────────────────────────────────────────────────────
    const countResult = await run(session, `
      MATCH (n:Account) WITH count(n) AS nodes
      MATCH ()-[r:SENT_TO]->() WITH nodes, count(r) AS edges
      RETURN nodes, edges
    `);
    const row = countResult.records[0];

    console.log("  ═══════════════════════════════════════");
    console.log("  ✅  Seed complete!");
    console.log(`      Accounts   : ${row.get("nodes")}`);
    console.log(`      Transactions: ${row.get("edges")}`);
    console.log("  ═══════════════════════════════════════");
    console.log("\n  Fraud patterns embedded:");
    console.log(`    ↺  Circular loops  : 3  (3-hop, 4-hop, 5-hop)`);
    console.log(`    ↗  Fan-out accounts: 2  (${fo1src} → 8, ${fo2src} → 6)`);
    console.log(`    ↙  Fan-in accounts : 2  (7 → ${fi1tgt}, 5 → ${fi2tgt})`);
    console.log(`    💰 High-value txns : 15 (> $10,000)`);
    console.log("\n  Now start your backend: node server.js\n");

  } catch (err) {
    console.error("\n  ❌  Seed failed:", err.message);
    if (err.message.includes("authentication")) {
      console.error("      → Wrong password. Check NEO4J_PASS in your .env file.\n");
    }
    process.exit(1);
  } finally {
    await session.close();
    await driver.close();
  }
}

seed();