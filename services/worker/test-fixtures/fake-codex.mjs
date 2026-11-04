// Stand-in for `codex exec --json ... -` in tests. Like the real CLI it reads the
// prompt from stdin until EOF (it hangs if stdin is never closed), then follows
// directives on their own lines and prints JSONL events:
//
//   @write <file>=<content>   create a file in the working directory (+ file_change item)
//   @command <exit> <text>    report a command_execution item with that exit code
//   @sleep <ms>               wait before answering
//   @exit <code>              exit with this code at the end
//   @turn-failed              emit turn.failed instead of turn.completed, exit 1
//   @error-event              emit a non-fatal top-level error event (e.g. a reconnect notice)
//   @garbage                  print non-JSON lines and a non-object JSON value between events
//   @unknown                  emit unknown event and item types
//   @no-final                 complete the turn without an agent message
//   @no-turn                  stop after turn.started (no turn.completed)
//   @big <bytes>              a command_execution item with that much output (truncation tests)
//   @dump <file>              write {argv, envKeys, stdin} to <file> in the working directory
//   @ignore-term              ignore SIGTERM (must be SIGKILLed)
//   @grandchild <file>        spawn a long-lived child and write its pid to <file>
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
if (argv[0] !== 'exec' || argv.at(-1) !== '-' || !argv.includes('--json')) {
  process.stderr.write(`fake-codex: unexpected arguments: ${argv.join(' ')}\n`);
  process.exit(2);
}

process.stderr.write('Reading additional input from stdin...\n');
let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) input += chunk;

const emit = (event) => process.stdout.write(JSON.stringify(event) + '\n');
const directives = input.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('@'));
let exitCode = 0;
let turnFailed = false;
let finalMessage = true;
let completeTurn = true;
let item = 0;
const nextId = () => `item_${item++}`;

emit({ type: 'thread.started', thread_id: '0199a213-81c0-7800-8aa1-bbab2a035a53' });
emit({ type: 'turn.started' });

for (const line of directives) {
  const [name, ...rest] = line.split(' ');
  const arg = rest.join(' ');
  switch (name) {
    case '@write': {
      const eq = arg.indexOf('=');
      const file = arg.slice(0, eq);
      writeFileSync(join(process.cwd(), file), arg.slice(eq + 1));
      emit({ type: 'item.completed', item: { id: nextId(), type: 'file_change', changes: [{ path: join(process.cwd(), file), kind: 'add' }], status: 'completed' } });
      break;
    }
    case '@command': {
      const [code, ...text] = rest;
      const id = nextId();
      emit({ type: 'item.started', item: { id, type: 'command_execution', command: text.join(' '), aggregated_output: '', exit_code: null, status: 'in_progress' } });
      emit({ type: 'item.completed', item: { id, type: 'command_execution', command: text.join(' '), aggregated_output: 'output\n', exit_code: Number(code), status: Number(code) === 0 ? 'completed' : 'failed' } });
      break;
    }
    case '@sleep':
      await new Promise((r) => setTimeout(r, Number(arg)));
      break;
    case '@exit':
      exitCode = Number(arg);
      break;
    case '@turn-failed':
      turnFailed = true;
      break;
    case '@error-event':
      emit({ type: 'error', message: 'Reconnecting... 1/5' });
      break;
    case '@garbage':
      process.stdout.write('this is not json\n{"type":"item.completed","item":{"id":"broken"\n42\n');
      break;
    case '@unknown':
      emit({ type: 'thread.future_event', detail: 1 });
      emit({ type: 'item.completed', item: { id: nextId(), type: 'hologram', text: 'ignored' } });
      break;
    case '@no-final':
      finalMessage = false;
      break;
    case '@no-turn':
      completeTurn = false;
      break;
    case '@big':
      emit({ type: 'item.completed', item: { id: nextId(), type: 'command_execution', command: 'cat big', aggregated_output: 'y'.repeat(Number(arg)), exit_code: 0, status: 'completed' } });
      break;
    case '@dump':
      writeFileSync(join(process.cwd(), arg), JSON.stringify({ argv, envKeys: Object.keys(process.env), stdin: input }));
      break;
    case '@ignore-term':
      process.on('SIGTERM', () => {});
      break;
    case '@grandchild': {
      const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 600000)'], { stdio: 'ignore' });
      writeFileSync(join(process.cwd(), arg), String(child.pid));
      break;
    }
  }
}

if (turnFailed) {
  emit({ type: 'turn.failed', error: { message: 'stream disconnected before completion' } });
  exitCode = exitCode || 1;
} else if (completeTurn) {
  emit({ type: 'item.completed', item: { id: nextId(), type: 'reasoning', text: 'thinking' } });
  if (finalMessage) emit({ type: 'item.completed', item: { id: nextId(), type: 'agent_message', text: `Done: ${directives.length} directive(s)` } });
  emit({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 7, reasoning_output_tokens: 2 } });
}
process.exitCode = exitCode;
