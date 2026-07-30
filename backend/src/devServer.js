/** Local-only entry point with a safe default for the co-located Python service. */

if (!String(process.env.RETRIEVAL_SERVICE_URL || "").trim()) {
  process.env.RETRIEVAL_SERVICE_URL = "http://127.0.0.1:8000";
}

const { startServer } = require("./server");

startServer().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
