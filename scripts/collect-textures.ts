import { collectTextureGarbage } from '../src/services/texture-files.js';
import { boundedEnv } from '../src/services/work-limit.js';
import { pool } from '../src/db.js';

try {
  const apply = process.argv.includes('--apply');
  const result = await collectTextureGarbage({ apply, retentionMs: boundedEnv('TEXTURE_GC_RETENTION_HOURS', 24, 8760) * 3600_000 });
  console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', ...result }));
} finally { await pool.end(); }
