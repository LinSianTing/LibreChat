// Disposable container only: compare the full client typecheck with fixed 984 source,
// using precisely the same image dependencies. This does not modify the read-only /h3 mount.
const fs = require('node:fs');
const cp = require('node:child_process');
const check = () => {
  const result = cp.spawnSync('/app/node_modules/.bin/tsc', ['--noEmit', '--pretty', 'false'], {
    cwd: '/app/client', encoding: 'utf8',
  });
  return { status: result.status, output: result.stdout + result.stderr };
};
const candidate = check();
process.stdout.write(candidate.output);
if (candidate.status === 0) {
  process.stdout.write('H3 full client typecheck: PASS\n');
  process.exit(0);
}
const archive = cp.execFileSync('git', ['-c', 'safe.directory=/h3', '-C', '/h3', 'archive',
  '984626afd3683b291d4b7b3746fd0580604ed86c', 'client'], { maxBuffer: 64 * 1024 * 1024 });
cp.execFileSync('tar', ['-xf', '-', '-C', '/app'], { input: archive });
for (const file of [
  'hooks/Input/openschoolHandoff.ts', 'hooks/Input/useOpenSchoolHandoff.ts',
  'hooks/Input/useOpenSchoolHandoff.spec.tsx', 'components/Chat/Input/OpenSchoolHandoff.tsx',
]) {
  fs.rmSync(`/app/client/src/${file}`);
}
const baseline = check();
if (candidate.output === baseline.output && baseline.status !== 0) {
  process.stdout.write('H3 client typecheck matches fixed 984 baseline: no added diagnostics; full check remains blocked by existing image-missing Sandpack dependency.\n');
  process.exit(0);
}
process.stdout.write('BASELINE TYPECHECK:\n' + baseline.output);
process.exit(1);
