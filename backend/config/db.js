require("dotenv").config({ path: __dirname + "/../.env" }); // MUST be first

const neo4j = require("neo4j-driver");

// Debug (remove later)
console.log("NEO4J_URI:", process.env.NEO4J_URI);
console.log("NEO4J_USER:", process.env.NEO4J_USER);

const driver = neo4j.driver(
  process.env.NEO4J_URI,
  neo4j.auth.basic(
    process.env.NEO4J_USER,
    process.env.NEO4J_PASSWORD
  )
);

const getSession = () => driver.session();

module.exports = { driver, getSession };