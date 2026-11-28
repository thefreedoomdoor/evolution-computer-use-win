// The broker under test has to be the one the runtime ships. This fixture does not describe the broker: it reads the
// BROKER_SOURCE literal out of src/desktop/arbiter.ts, evaluates that literal, and runs it. grant/finish/drop/handle
// therefore stay production code — the fixture only tees the bytes of every socket so the test can see which protocol
// lines the broker exchanged, and reports the sha1 of the source it actually ran so the test can prove there is no copy.
//
// usage: node arbiter-broker-server.mjs <unique-pipe-name> [--legacy-lost]
//
// --legacy-lost models an older broker that sends {"op":"lost"} with no reason, so the client's "reason=unknown" path is
// exercised against the real wire. In that mode this tee removes only that one field from each outgoing 'lost' line and
// reports {downgraded:true}; grant/finish/drop/handle are still the production source and the sha1 it prints is unchanged.
// Without the flag every byte is passed through untouched.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const pipe = process.argv[2];
if (!pipe) {
  process.stderr.write('usage: arbiter-broker-server.mjs <pipe>\n');
  process.exit(2);
}

const require = createRequire(import.meta.url);
const say = message => process.stdout.write(JSON.stringify(message) + '\n');

/** Only the shape of an outgoing 'lost' is modelled away here; the broker's decisions stay production code. */
const LEGACY_LOST = process.argv[3] === '--legacy-lost';

const OPENING = 'const BROKER_SOURCE = [';
// Spelled out, not built from a template: this is the closing of the literal in arbiter.ts, backslash-n included.
const CLOSING = "].join('\\n');";

/** The literal the runtime would spawn, read as text and evaluated as a literal so a reformat cannot fork the broker. */
function productionSource() {
  const text = readFileSync(new URL('../../src/desktop/arbiter.ts', import.meta.url), 'utf8');
  const start = text.indexOf(OPENING);
  if (start < 0) throw new Error('BROKER_SOURCE is not where this fixture looks for it');
  let end = text.indexOf(CLOSING, start);
  if (end < 0) {
    // Tolerance for a reformat of the join() call only: the literal still ends at the first ']' that starts a line.
    const close = /\n\]/.exec(text.slice(start));
    if (!close) throw new Error('BROKER_SOURCE has no closing bracket this fixture can find');
    end = start + close.index + 1;
  }
  if (end <= start) throw new Error('BROKER_SOURCE is not where this fixture looks for it');
  const parts = new Function('return ' + text.slice(start + OPENING.length - 1, end + 1))();
  if (!Array.isArray(parts) || parts.some(one => typeof one !== 'string')) throw new Error('BROKER_SOURCE is not a string array');
  return parts.join('\n');
}

const net = require('node:net');

let made = null;
let sockets = 0;

/** Read-only tee: it never answers, drops, or reorders anything — the broker itself still does all of that. */
function observe(sock, sequence) {
  const seen = { inbound: '', outbound: '' };
  sock.setEncoding('utf8');
  sock.on('data', chunk => {
    seen.inbound += chunk;
    for (let at = seen.inbound.indexOf('\n'); at >= 0; at = seen.inbound.indexOf('\n')) {
      const line = seen.inbound.slice(0, at);
      seen.inbound = seen.inbound.slice(at + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch (error) { continue; }
      say({ event: 'in', op: message.op, id: message.id, sock: sequence });
    }
  });
  const write = sock.write.bind(sock);
  sock.write = (chunk, ...rest) => {
    // In legacy mode the bytes are rebuilt line by line so the stripped field never reaches the client; the broker writes
    // whole lines, so every complete line is forwarded here and only an unterminated tail waits for the next write.
    let forwarded = '';
    try {
      seen.outbound += String(chunk);
      for (let at = seen.outbound.indexOf('\n'); at >= 0; at = seen.outbound.indexOf('\n')) {
        const line = seen.outbound.slice(0, at);
        seen.outbound = seen.outbound.slice(at + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch (error) { continue; }
        const reason = typeof message.reason === 'string' ? message.reason : undefined;
        if (LEGACY_LOST && message.op === 'lost' && reason !== undefined) {
          delete message.reason;
          forwarded += JSON.stringify(message) + '\n';
          say({ event: 'out', op: message.op, id: message.id, sock: sequence, downgraded: true });
        } else {
          say({ event: 'out', op: message.op, id: message.id, sock: sequence, ...(reason !== undefined ? { reason } : {}) });
          if (LEGACY_LOST) forwarded += line + '\n';
        }
      }
    } catch (error) { /* watching must never change what the broker does */ }
    if (!LEGACY_LOST) return write(chunk, ...rest);
    return forwarded ? write(forwarded) : true;
  };
  sock.on('close', () => say({ event: 'gone', sock: sequence }));
}

// node:net is handed to the production source through this wrapper; everything else goes to the real module.
const handed = Object.create(null);
for (const key of Object.keys(net)) handed[key] = net[key];
handed.createServer = function createServer(handler) {
  const server = net.createServer(function (sock) {
    sockets += 1;
    const sequence = sockets;
    say({ event: 'socket', sock: sequence });
    observe(sock, sequence);
    handler(sock);
  });
  made = server;
  // Attached before the source attaches its own handler, so a failed listen is reported instead of vanishing.
  server.on('error', error => say({ event: 'failed', reason: String(error && error.message ? error.message : error) }));
  server.once('listening', () => say({ event: 'listening', pipe, lines: SOURCE.split('\n').length, sha1: digest }));
  return server;
};

process.env.EVOLUTION_CU_BROKER_PIPE = pipe;
const SOURCE = productionSource();
const digest = createHash('sha1').update(SOURCE).digest('hex');

new Function('require', SOURCE)(name => (name === 'node:net' ? handed : require(name)));

if (!made) {
  say({ event: 'failed', reason: 'the broker source never created its server' });
  process.exit(3);
}
