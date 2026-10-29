import { build } from 'esbuild';
import { access, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export async function buildApiObservation({ root = process.cwd(), outfile } = {}) {
  const projectRoot = path.resolve(root);
  const target = path.resolve(projectRoot, outfile ?? '.next/standalone/api-observation-preload.cjs');
  const relative = path.relative(projectRoot, target);
  if (!relative || relative.startsWith('..' + path.sep) || path.isAbsolute(relative) || path.extname(target) !== '.cjs') {
    throw new Error('Preload output must be a .cjs file inside the project root');
  }
  await access(path.join(projectRoot, 'package.json'));
  await access(path.join(projectRoot, 'src/lib/api-observation.node.ts'));
  await mkdir(path.dirname(target), { recursive: true });
  await build({
    absWorkingDir: projectRoot,
    entryPoints: ['scripts/api-observation-preload.ts'],
    outfile: target,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    packages: 'external',
    tsconfig: path.join(projectRoot, 'tsconfig.json'),
    sourcemap: false,
    logLevel: 'silent',
  });
  return target;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = {};
    const args = process.argv.slice(2);
    for (let i = 0; i < args.length; i += 2) {
      if (!['--root', '--outfile'].includes(args[i]) || !args[i + 1]) throw new Error('Invalid preload build arguments');
      options[args[i].slice(2)] = args[i + 1];
    }
    await buildApiObservation(options);
  } catch {
    // Build paths/errors can contain local values; use a fixed diagnostic only.
    process.stderr.write('API observation preload build failed.\n');
    process.exitCode = 1;
  }
}
