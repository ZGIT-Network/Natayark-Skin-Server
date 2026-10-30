import fs from 'node:fs';
import { PNG } from 'pngjs';
const file = '.test-artifacts/review-skin.png';
const png = PNG.sync.read(fs.readFileSync(file));
png.data[0] = (png.data[0] + 1) % 256;
fs.writeFileSync(file, PNG.sync.write(png));
