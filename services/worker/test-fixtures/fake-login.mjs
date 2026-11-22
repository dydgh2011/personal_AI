#!/usr/bin/env node
// Fake agent CLI for auth tests. State lives in $HOME/.fake-login (a file: "in" or "out"); HOME is one of
// the few variables the worker passes to agent processes.
//   fake-login.mjs auth status            -> {"loggedIn": true|false}
//   fake-login.mjs auth login --claudeai  -> prints URL + "Paste code here", accepts "good-code-123" on stdin
//   fake-login.mjs login status           -> exit 0 "Logged in using ChatGPT" | exit 1 "Not logged in"
//   fake-login.mjs login --device-auth    -> prints device URL + code, logs in after $FAKE_DEVICE_MS
//                                            (state "timeout": exits 1 with the CLI's timeout message)
import { readFileSync, writeFileSync } from 'node:fs';

const stateFile = `${process.env.HOME}/.fake-login`;
const get = () => {
  try {
    return readFileSync(stateFile, 'utf8').trim();
  } catch {
    return 'out';
  }
};
const set = (v) => writeFileSync(stateFile, v);
const args = process.argv.slice(2).join(' ');

if (args === 'auth status') {
  console.log(JSON.stringify({ loggedIn: get() === 'in', authMethod: get() === 'in' ? 'claude.ai' : 'none' }));
} else if (args.startsWith('auth login')) {
  set('out');
  process.stdout.write('Opening browser to sign in…\nIf the browser didn\'t open, visit: https://claude.com/cai/oauth/authorize?code=true&state=s1\nPaste code here if prompted > ');
  process.stdin.setEncoding('utf8');
  process.stdin.once('data', (d) => {
    if (d.trim() === 'good-code-123') {
      set('in');
      console.log('Login successful.');
      process.exit(0);
    }
    console.log('Login failed: Request failed with status code 400');
    process.exit(1);
  });
} else if (args === 'login status') {
  if (get() === 'in') console.log('Logged in using ChatGPT');
  else console.log('Not logged in');
  process.exit(get() === 'in' ? 0 : 1);
} else if (args === 'login --device-auth') {
  // State "timeout": nobody enters the code and the CLI gives up, like the real one after 15 minutes.
  const timeout = get() === 'timeout';
  set('out');
  console.log('\n1. Open this link in your browser and sign in to your account\n   \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m\n\n2. Enter this one-time code \x1b[90m(expires in 15 minutes)\x1b[0m\n   \x1b[94mABCD-EFGHI\x1b[0m\n');
  setTimeout(() => {
    if (timeout) {
      console.log('Error logging in with device code: device auth timed out after 15 minutes');
      process.exit(1);
    }
    set('in');
    console.log('Successfully logged in');
    process.exit(0);
  }, Number(process.env.FAKE_DEVICE_MS ?? 200));
} else {
  console.error(`unknown: ${args}`);
  process.exit(2);
}
