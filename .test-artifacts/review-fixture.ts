import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { PNG } from 'pngjs';
import { config } from '../src/config.js';
import { registerUser } from '../src/services/user.js';
import { deleteTexture, texturePath } from '../src/services/texture.js';
import { exec, query, pool } from '../src/db.js';

assert.ok(config.db.tablePrefix.startsWith('dev_'), 'Review requires a dev_ namespace');
const file = new URL('./review-fixture.json', import.meta.url);
try {
  if (process.argv[2] === 'clear-textures') {
    const fixture = JSON.parse(await fs.readFile(file, 'utf8'));
    const textures = await query<any>('SELECT * FROM textures WHERE uploader=?', [fixture.uid]);
    for (const texture of textures) await deleteTexture(texture);
    console.log('Review upload records removed');
  } else if (process.argv[2] === 'privacy') {
    const fixture = JSON.parse(await fs.readFile(file, 'utf8'));
    await exec('INSERT INTO mojang_verifications (user_id,uuid,verified) VALUES (?,?,1)',[fixture.uid,crypto.randomBytes(16).toString('hex')]);
    console.log('Temporary verification fixture added for the review account');
  } else if (process.argv[2] === 'admin') {
    const fixture = JSON.parse(await fs.readFile(file, 'utf8'));
    await exec('UPDATE users SET permission=2 WHERE uid=?', [fixture.uid]);
    console.log('Review fixture promoted within dev_ namespace');
  } else if (process.argv[2] === 'cleanup') {
    const fixture = JSON.parse(await fs.readFile(file, 'utf8'));
    const textures = await query<any>('SELECT * FROM textures WHERE uploader=?', [fixture.uid]);
    for (const texture of textures) await deleteTexture(texture);
    await exec('DELETE FROM user_closet WHERE user_uid=?', [fixture.uid]);
    await exec('DELETE FROM `uuid` WHERE name=?', [fixture.playerName]);
    await exec('DELETE FROM players WHERE uid=?', [fixture.uid]);
    await exec('DELETE FROM mcn_web_sessions WHERE user_id=?', [fixture.uid]);
    await exec('DELETE FROM mojang_verifications WHERE user_id=?', [fixture.uid]);
    await exec('DELETE FROM users WHERE uid=?', [fixture.uid]);
    for (const filename of ['review-skin.png','review-cape.png']) {
      const data=await fs.readFile(new URL(filename,import.meta.url));
      const hash=crypto.createHash('sha256').update(data).digest('hex');
      if(!(await query<any>('SELECT tid FROM textures WHERE hash=?',[hash])).length) {
        try {await fs.unlink(texturePath(hash));} catch(error:any) {if(error.code!=='ENOENT')throw error;}
      }
    }
    console.log('Review fixtures removed');
  } else {
    const id = crypto.randomBytes(4).toString('hex');
    const email = `review-${id}@example.test`, password = 'review-local-password', playerName = `Review${id}`;
    const result = await registerUser({ email, password, player_name: playerName, verified: true, ip: '192.0.2.200' });
    assert.ok(result.ok, JSON.stringify(result));
    await exec('UPDATE users SET score=10000 WHERE uid=?', [result.user.uid]);
    const png = new PNG({ width: 64, height: 64 });
    for (let i = 0; i < png.data.length; i += 4) {
      png.data[i] = (i / 4) % 64 * 4;
      png.data[i + 1] = crypto.randomBytes(1)[0];
      png.data[i + 2] = 120;
      png.data[i + 3] = 255;
    }
    const image = new URL('./review-skin.png', import.meta.url);
    await fs.writeFile(image, PNG.sync.write(png));
    const fixture = { uid: result.user.uid, email, password, playerName, image: image.pathname };
    await fs.writeFile(file, JSON.stringify(fixture, null, 2));
    console.log(JSON.stringify(fixture));
  }
} finally { await pool.end(); }
