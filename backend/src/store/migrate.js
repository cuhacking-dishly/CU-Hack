require("dotenv").config();

const { closeStore, getStoreMode, initializeStore } = require("./index");

async function migrate() {
  if (getStoreMode() !== "postgres") {
    throw new Error("DATABASE_URL is required to run database migrations");
  }

  try {
    await initializeStore();
    console.log("Dishly database migration completed.");
  } finally {
    await closeStore();
  }
}

if (require.main === module) {
  migrate().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { migrate };
