// Seed a dev-only OAuth provider option pointing at the mock provider.
import { config } from '../../src/config.js';
import mysql from 'mysql2/promise';

const provider = {
  key: 'e2etest', displayName: 'E2E Test',
  authUrl: 'http://127.0.0.1:3901/authorize',
  tokenUrl: 'http://127.0.0.1:3901/token',
  userUrl: 'http://127.0.0.1:3901/userinfo',
  clientId: 'e2e-client', clientSecret: 'e2e-secret',
  emailVerifiedField: 'email_verified',
};
const conn = await mysql.createConnection({
  host: config.db.host, port: config.db.port, user: config.db.user, password: config.db.password,
  database: config.db.database,
});
const prefix = process.env.DB_TABLE_PREFIX ?? '';
const options = `\`${prefix}options\``;
await conn.execute(
  `INSERT INTO ${options} (option_name, option_value) SELECT ?, ? FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM ${options} WHERE option_name = ?)`,
  ['oauth_providers', JSON.stringify([provider]), 'oauth_providers']
);
await conn.execute(`UPDATE ${options} SET option_value = ? WHERE option_name = ?`, [JSON.stringify([provider]), 'oauth_providers']);
console.log('oauth_providers seeded');
await conn.end();
