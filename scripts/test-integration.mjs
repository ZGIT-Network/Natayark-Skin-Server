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
]) {
  console.log('\nRunning ' + file);
  const result = spawnSync(process.execPath, ['--import', 'tsx', ...(file.endsWith('.test.ts') ? ['--test'] : []), file], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
