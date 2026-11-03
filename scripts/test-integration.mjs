import 'dotenv/config';
import { spawnSync } from 'node:child_process';

if (!/^dev_[A-Za-z0-9_]+$/.test(process.env.DB_TABLE_PREFIX || '')) {
  throw new Error('Integration tests require an isolated dev_ DB_TABLE_PREFIX.');
}

// Suites change site options, so run them sequentially in separate processes.
for (const file of [
  'tests/auth.integration.test.ts', 'tests/economy.integration.ts',
  'tests/addons.integration.ts', 'tests/protocol.integration.ts',
  'tests/mojang.integration.ts', 'tests/web.integration.test.ts',
  'tests/appearance.integration.test.ts',
  'tests/connect-http.integration.test.ts',
  'tests/management.integration.test.ts',
  'tests/native-plugins.integration.test.ts',
  'tests/search.integration.test.ts',
  'tests/join-cluster.integration.test.ts',
  'tests/friends.integration.test.ts',
  'tests/first-start.integration.test.ts',
  'tests/migration.integration.test.ts',
  'tests/resource-controls.integration.test.ts',
]) {
  console.log('\nRunning ' + file);
  const result = spawnSync(process.execPath, ['--import', 'tsx', ...(file.endsWith('.test.ts') ? ['--test'] : []), file], { stdio: 'inherit', env:{...process.env,MAIL_HOST:'',MAIL_FROM_ADDRESS:''} });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
