import { execSync } from 'node:child_process';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const args = new Set(process.argv.slice(2));
const watch = args.has('--watch');
const fake = args.has('--fake') || process.env.FAKE_PROVIDER === '1';
const outDir = process.env.OUT_DIR ?? (fake ? 'dist-test' : 'dist');

const env = {
  ...process.env,
  OUT_DIR: outDir,
  FAKE_PROVIDER: fake ? '1' : '0',
};

const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const vite = path.join(root, 'node_modules', '.bin', 'vite');

async function copyManifest() {
  const manifestPath = path.join(root, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.version = pkg.version;
  manifest.description =
    '划选网页文字，立即在附近显示简体中文译文。支持本地 Chrome 内置翻译与腾讯云 TokenHub。';
  // Test builds pre-grant site access so automated runs need no native prompt.
  if (fake) {
    manifest.host_permissions = ['http://*/*', 'https://*/*'];
  }
  await mkdir(path.join(root, outDir), { recursive: true });
  await writeFile(
    path.join(root, outDir, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  const icons = path.join(root, 'public', 'icons');
  if (existsSync(icons)) {
    await cp(icons, path.join(root, outDir, 'icons'), { recursive: true });
  }
}

function build(configFile, extraArgs = []) {
  const args = ['build', '--config', configFile, ...extraArgs];
  execSync(`"${vite}" ${args.join(' ')}`, { cwd: root, env, stdio: 'inherit' });
}

if (!watch) {
  build('vite.config.ts');
  build('vite.content.config.ts');
  build('vite.background.config.ts');
  await copyManifest();
  console.log(
    `\nBuilt ${outDir}/ (${fake ? 'test build with fake provider' : 'production build'})`,
  );
} else {
  console.log('Watch mode: rebuilding on changes. Reload the extension in chrome://extensions.');
  // The pages build owns emptyOutDir; run it once before starting watchers.
  build('vite.config.ts');
  await copyManifest();
  const { spawn } = await import('node:child_process');
  const watchEnv = { ...env, WATCH: '1' };
  build('vite.content.config.ts');
  build('vite.background.config.ts');
  const children = [
    spawn(vite, ['build', '--config', 'vite.config.ts', '--watch'], {
      cwd: root,
      env: watchEnv,
      stdio: 'inherit',
    }),
    spawn(vite, ['build', '--config', 'vite.content.config.ts', '--watch'], {
      cwd: root,
      env: watchEnv,
      stdio: 'inherit',
    }),
    spawn(vite, ['build', '--config', 'vite.background.config.ts', '--watch'], {
      cwd: root,
      env: watchEnv,
      stdio: 'inherit',
    }),
  ];
  const stop = () => {
    for (const child of children) child.kill('SIGTERM');
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
