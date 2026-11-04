// Builds codex-worker.json from Docker's default seccomp profile.
//
//   node images/coding-worker/seccomp/build-codex-profile.mjs
//
// docker-default.json is moby/profiles seccomp/default.json at commit
// 6fe7deb1b9fb7c0397a4593480d7d22b9ee8caef (sha256 6416b477...3053f6).
//
// Codex runs every model-generated command inside bubblewrap, which needs an
// unprivileged user namespace plus mount/pivot_root *inside* that namespace.
// Docker's default profile only allows those syscalls with CAP_SYS_ADMIN, so
// without this change Codex cannot sandbox anything in the container.
//
// The only difference from the default profile: clone (with namespace flags),
// unshare, mount, umount2 and pivot_root are allowed. The container still has
// no capabilities (cap_drop: ALL) and no-new-privileges, so these calls only
// take effect inside a user namespace the process created itself; they cannot
// change the container's own mounts. clone3 keeps returning ENOSYS (callers
// fall back to clone), and everything else the default profile blocks stays
// blocked (bpf, setns, keyctl, ptrace restrictions, new mount API, ...).
import { readFileSync, writeFileSync } from 'node:fs';

const NAMESPACE_SYSCALLS = ['clone', 'unshare', 'mount', 'umount2', 'pivot_root'];

const dir = new URL('.', import.meta.url);
const profile = JSON.parse(readFileSync(new URL('docker-default.json', dir), 'utf8'));

// Drop the default "clone without namespace flags" rules; the unconditional rule below replaces them.
profile.syscalls = profile.syscalls.filter((rule) => !(rule.names.length === 1 && rule.names[0] === 'clone'));
profile.syscalls.push({
  names: NAMESPACE_SYSCALLS,
  action: 'SCMP_ACT_ALLOW',
  comment: 'codex-worker: bubblewrap sandbox (unprivileged user namespaces). See build-codex-profile.mjs.',
});

writeFileSync(new URL('codex-worker.json', dir), JSON.stringify(profile, null, 2) + '\n');
console.log(`codex-worker.json written (${profile.syscalls.length} rules)`);
