#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const usage = 'Usage: node scripts/import-textures.mjs <uploader UID> <directory> [--cape] [--gbk] [--apply|--dry-run]\n\nDefault: dry run. --apply imports public texture records without changing scores or closets.\nRun npm run build before importing.';
if (!args.length || args.includes('--help') || args.includes('-h')) {
  console.log(usage);
} else {
  const flags = args.filter((arg) => arg.startsWith('--'));
  const positional = args.filter((arg) => !arg.startsWith('--'));
  if (positional.length !== 2 || flags.some((arg) => !['--cape', '--gbk', '--apply', '--dry-run'].includes(arg)) || (flags.includes('--apply') && flags.includes('--dry-run'))) {
    console.error(usage); process.exitCode = 1;
  } else {
    let pool;
    try {
      const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
      process.chdir(root);
      const service = await import('../dist/services/batch-import.js');
      ({ pool } = await import('../dist/db.js'));
      const dryRun = !flags.includes('--apply');
      const results = await service.batchImportTextures({ uploader: Number(positional[0]), directory: positional[1], cape: flags.includes('--cape'), gbk: flags.includes('--gbk'), dryRun });
      for (const result of results) console.log(`${result.status}\t${result.file}${result.tid ? `\t#${result.tid}` : ''}${result.reason ? `\t${result.reason}` : ''}`);
      console.log(`${dryRun ? 'Dry run' : 'Import'}: ${results.length} PNG files, ${results.filter((r) => r.status === 'imported' || r.status === 'would-import').length} ${dryRun ? 'planned' : 'imported'}, ${results.filter((r) => r.status === 'duplicate').length} duplicates, ${results.filter((r) => r.status === 'invalid').length} invalid.`);
      if (results.some((r) => r.status === 'invalid')) process.exitCode = 1;
    } catch (error) { console.error(error.message); process.exitCode = 1; }
    finally { await pool?.end(); }
  }
}
