// The test database is disposable and never the seeded demo database.
process.env.DATABASE_URL = "file:../db/test.db";
Object.assign(process.env, { NODE_ENV: "test" });
