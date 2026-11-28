// A protocol-only broker client: it speaks the named-pipe protocol and nothing else — no arbiter, no helper, no mouse.
// The test drives it with stdin commands and reads one JSON line per protocol event, so a lease hand-off can be watched
// from the outside of both processes.
import { connect } from 'node:net';
import { createInterface } from 'node:readline';

const [pipe, id] = process.argv.slice(2);
if (!pipe || !id) {
  process.stderr.write('usage: client.mjs <pipe> <id>\n');
  process.exit(2);
}

const say = message => process.stdout.write(JSON.stringify({ id, ...message }) + '\n');
const socket = connect(pipe);
let buffer = '';

socket.setEncoding('utf8');
socket.on('connect', () => say({ event: 'connected' }));
socket.on('data', chunk => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    // 'granted' and 'lost' both carry no body worth keeping beyond the lease id.
    say({ event: message.op, ...(message.id === undefined ? {} : { lease: message.id }) });
  }
});
socket.on('error', () => { /* the test decides what a dead socket means */ });
socket.on('close', () => { say({ event: 'closed' }); process.exit(0); });

createInterface({ input: process.stdin }).on('line', line => {
  const command = line.trim();
  if (!command) return;
  if (command === 'quit') { socket.end(); return; }
  socket.write(JSON.stringify({ op: command, id }) + '\n');
});
