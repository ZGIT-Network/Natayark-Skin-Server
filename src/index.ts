import { createApp } from './app.js';
import { config } from './config.js';
import { pool } from './db.js';

const app = await createApp();
try {
  await app.listen({ port: config.port, host: config.host });
  console.log('MCNSKIN listening on http://' + config.host + ':' + config.port);
} catch (error) {
  app.log.error(error);
  await pool.end();
  process.exitCode = 1;
}
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, async () => {
  await app.close();
  await pool.end();
});
