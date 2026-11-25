// Stand-in for the Claude Code CLI in tests. Reads the prompt from stdin and
// follows directives on their own lines, then prints a result object shaped
// like `claude -p --output-format json`:
//
//   @write <file>=<content>   create a file in the working directory (and its parent directories)
//   @say <text>               add a line to the final answer
//   @sleep <ms>               wait before answering
//   @exit <code>              exit with this code after printing
//   @error                    report is_error: true / subtype error_during_execution
//   @garbage                  print non-JSON output
//   @dump <file>              write {argv, envKeys} to <file> in the working directory
//   @ignore-term              ignore SIGTERM (must be SIGKILLed)
//   @grandchild <file>        spawn a long-lived child and write its pid to <file>
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) input += chunk;

const directives = input.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('@'));
let exitCode = 0;
let isError = false;
let garbage = false;
const said = [];

for (const line of directives) {
  const [name, ...rest] = line.split(' ');
  const arg = rest.join(' ');
  switch (name) {
    case '@write': {
      const eq = arg.indexOf('=');
      mkdirSync(dirname(join(process.cwd(), arg.slice(0, eq))), { recursive: true });
      writeFileSync(join(process.cwd(), arg.slice(0, eq)), arg.slice(eq + 1));
      break;
    }
    case '@say':
      said.push(arg);
      break;
    case '@sleep':
      await new Promise((r) => setTimeout(r, Number(arg)));
      break;
    case '@exit':
      exitCode = Number(arg);
      break;
    case '@error':
      isError = true;
      break;
    case '@garbage':
      garbage = true;
      break;
    case '@dump':
      writeFileSync(join(process.cwd(), arg), JSON.stringify({ argv: process.argv.slice(2), envKeys: Object.keys(process.env) }));
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

if (garbage) {
  process.stdout.write('this is not json\n');
} else {
  process.stdout.write(
    JSON.stringify({
      type: 'result',
      subtype: isError ? 'error_during_execution' : 'success',
      is_error: isError,
      result: isError ? 'Something went wrong' : [`Done: ${directives.length} directive(s)`, ...said].join('\n'),
      num_turns: 1,
      duration_ms: 5,
      session_id: process.argv[process.argv.indexOf('--session-id') + 1] ?? null,
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
      permission_denials: [],
    }) + '\n',
  );
}
process.stderr.write('fake-claude stderr line\n');
process.exitCode = exitCode;
