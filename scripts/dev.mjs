// Runs the API server and the Vite dev server together (works on Windows, macOS and Linux).
import { spawn } from 'node:child_process';

const run = (name, args) => {
  const child = spawn('npm', args, { stdio: 'inherit', shell: true });
  child.on('exit', (code) => {
    console.log(`[${name}] exited with ${code}`);
    process.exit(code ?? 0);
  });
  return child;
};

const children = [
  run('server', ['run', 'dev', '--workspace', 'server']),
  run('web', ['run', 'dev', '--workspace', 'web']),
];
const stop = () => { for (const c of children) c.kill(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
console.log('\nKannaku AI dev: open http://localhost:5173 (API on http://127.0.0.1:4000)\n');
