// A lease holder built on the production arbiter (src/desktop/arbiter.ts), not on the fixture.
// The test needs a holder it can kill: only a separate process can lose its socket while still holding the machine
// lease, which is exactly the "holder disappeared" case the broker has to keep closed.
import { createInterface } from 'node:readline';

const pipe = process.argv[2];
if (!pipe) {
  process.stderr.write('usage: holder.mjs <pipe>\n');
  process.exit(2);
}

process.env.EVOLUTION_CU_BROKER_PIPE = pipe;
delete process.env.EVOLUTION_CU_ARBITER;

const { createArbiter } = await import(new URL('../../src/desktop/arbiter.ts', import.meta.url).href);
const say = message => process.stdout.write(JSON.stringify(message) + '\n');
const arbiter = createArbiter({});
let finish = () => {};

arbiter.withGlobalLease(async () => {
  say({ event: 'held' });
  await new Promise(resolve => { finish = resolve; });
  say({ event: 'released' });
}).then(() => {
  setTimeout(() => process.exit(0), 50);
}, error => {
  say({ event: 'failed', reason: error instanceof Error ? error.message : String(error) });
  setTimeout(() => process.exit(1), 50);
});

createInterface({ input: process.stdin }).on('line', line => {
  const command = line.trim();
  if (command === 'release' || command === 'quit') finish();
});
