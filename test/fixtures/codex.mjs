import { writeFileSync } from 'node:fs';

const at = process.argv.indexOf('--record');
writeFileSync(process.argv[at + 1], JSON.stringify({ args: process.argv.slice(2), localKey: process.env.MCODEX_LOCAL_KEY, codeHome: process.env.CODEX_HOME,
  bashEnv: process.env.BASH_ENV, zDotDir: process.env.ZDOTDIR }));
if (process.argv.includes('--hang')) {
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
} else process.exit(7);
