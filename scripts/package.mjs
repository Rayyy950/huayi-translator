import { execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const dist = path.join(root, 'dist');
const release = path.join(root, 'release');

async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

if (!(await exists(path.join(dist, 'manifest.json')))) {
  console.error('dist/manifest.json is missing. Run npm run build first.');
  process.exit(1);
}
if (
  !(await exists(path.join(dist, 'background.js'))) ||
  !(await exists(path.join(dist, 'content.js')))
) {
  console.error('dist is missing background.js or content.js.');
  process.exit(1);
}
for (const forbidden of ['probe', 'tests', 'node_modules', 'src']) {
  if (await exists(path.join(dist, forbidden))) {
    console.error(`Refusing to package: dist contains ${forbidden}.`);
    process.exit(1);
  }
}

await mkdir(release, { recursive: true });
const zipPath = path.join(release, `huayi-v${pkg.version}.zip`);
execFileSync('rm', ['-f', zipPath]);
execFileSync(
  'zip',
  ['-r', '-q', zipPath, '.', '-x', '*.DS_Store', '-x', '__MACOSX/*', '-x', '*.map'],
  { cwd: dist, stdio: 'inherit' },
);

const files = await readdir(dist, { recursive: true });
const size = (await stat(zipPath)).size;
console.log(
  `Packaged ${files.length} files into ${path.relative(root, zipPath)} (${Math.round(size / 1024)} KB)`,
);
