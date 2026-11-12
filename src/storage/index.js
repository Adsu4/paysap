const { DATA_DIR, isPostgresEnabled } = require('../config/env');
const { JsonStore } = require('./jsonStore');
const { PostgresStore } = require('./postgresStore');

function createStore() {
  if (isPostgresEnabled()) {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL must be configured when STORAGE_DRIVER=postgres.');
    }
    return new PostgresStore(process.env.DATABASE_URL);
  }
  return new JsonStore(DATA_DIR);
}

module.exports = { createStore, JsonStore, PostgresStore };

