# The plugin sandbox: what madarch needs from a machine (2026-11-09)

Status: operations text of decision 0035, item 9. By default the plugin host
runs no plugin unconfined, in any stage and whatever the plugin's origin;
where a machine lacks what the sandbox needs, the host refuses with an
operations problem that names the missing piece and points here.

## Linux

Every plugin runs under **bubblewrap**, in a sandbox that

- unshares every namespace (`--unshare-all`): its own network (no address
  reaches it), its own pid namespace, its own cgroup view, its own ipc and uts;
- clears the environment, gives no home folder and no credentials;
- binds the repository snapshot read-only at `/repo` and the plugin's closure
  read-only at `/plugin`;
- gives one private writable `tmpfs` at `/tmp` and makes the rest of the
  filesystem read-only (`--remount-ro /`);
- dies with its parent (`--die-with-parent`);
- applies a **seccomp filter** (numbers from the kernel's own
  `asm-generic/unistd.h` and `syscall_64.tbl` at v6.8) that
  - refuses `socket` and `connect` (the network profile *none*), and on x86_64
    every x32 call (`nr >= 0x40000000`, answered `ENOSYS`) — an x32 call carries
    the same `AUDIT_ARCH_X86_64` and would otherwise slip past a table of one
    ABI's numbers;
  - refuses `io_uring_setup`/`enter`/`register`, `ptrace`,
    `process_vm_readv`/`writev`, `unshare`, `setns`, `mount`, `umount2`,
    `pivot_root`, `bpf`, `perf_event_open`, `userfaultfd`, `keyctl`, `add_key`,
    `request_key` and `open_by_handle_at` with `EPERM`;
  - answers `clone3` with `ENOSYS`, so libc and Bun fall back to `clone`, and
    refuses a `clone` whose flags carry a namespace bit (`CLONE_NEWUSER`,
    `NEWNS`, `NEWNET`, `NEWPID`, `NEWIPC`, `NEWUTS`, `NEWCGROUP`, `NEWTIME`) —
    a fork is Bun's own spawning, a namespace is an escape;
  - **allows `socketpair`**: Bun hands a child its standard input and output
    through an `AF_UNIX` socket pair, which reaches no address; an address is
    reachable only through `socket` and `connect`, and both are refused;
  - every other call is allowed, and the kernel's namespaces do the rest;
- runs the plugin as `nobody` when madarch itself runs as root.

The supervisor itself is a pinned, statically linked bubblewrap
(0.11.2, `VHSgunzo/bubblewrap-static`, pinned per platform by sha256 in
`src/plugin/bwrap-builds.ts`). It is downloaded once into
`<madarch home>/tools/bubblewrap/0.11.2/` — the folder PostgreSQL's install
shares — and its sha256 is checked before every use. `MADARCH_TOOLS` moves
that cache.

### The cgroup delegation

The plugin's **whole process tree** runs in a cgroup of its own, under one
delegated to madarch, with the `memory`, `cpu` and `pids` controllers enabled.
The host writes `memory.max`, `memory.swap.max=0`, `cpu.max` and `pids.max`
**before the plugin's first instruction**, freezes the tree for a pause by
writing `cgroup.freeze`, and kills it whole with `cgroup.kill`.

madarch needs a cgroup folder that offers and hands on those three
controllers. With systemd, one slice is enough:

```sh
sudo systemctl start madarch.slice          # or a unit with Delegate=yes
echo '+memory +pids +cpu' | sudo tee /sys/fs/cgroup/madarch.slice/cgroup.subtree_control
export MADARCH_PLUGIN_CGROUP=/sys/fs/cgroup/madarch.slice
```

The controller names must stand in that folder's `cgroup.controllers`, and the
folder must hand them to its children (`cgroup.subtree_control`). A folder
that holds processes itself cannot hand controllers on — the kernel answers
"device or resource busy" — so give madarch a cgroup of its own rather than the
one its shell runs in. The host checks the delegation before every run and
refuses with the missing controllers, the folder and this page named.

### User namespaces

bubblewrap opens the plugin's namespaces as the account madarch runs as, so
unprivileged user namespaces must be available:

- `kernel.unprivileged_userns_clone` must not be `0` (Debian's switch);
- `user.max_user_namespaces` must not be `0`;
- on Ubuntu 23.10 and later, `kernel.apparmor_restrict_unprivileged_userns`
  must be `0`, or an AppArmor profile must grant the account the namespace.
  Root opens namespaces whatever these say, so the check is skipped there.

## macOS

macOS has no cgroups. The plugin runs under `/usr/bin/sandbox-exec` with a
deny-by-default profile (read: the closure, the repository, and the system's own
libraries; write: the run's temporary folder), and its memory, cpu time and
process count are bounded by **rlimits** the wrapper sets before the plugin
starts. The host tracks the tree by its **process group** and kills it by
group.

**The limit this leaves:** a descendant that calls `setsid()` leaves that
process group, and the profile does not reliably prevent it. Such a descendant
is bounded by neither the kill nor the rlimits. On Linux the same escape is
covered by the cgroup, which every descendant stays in whatever it does to its
session or group.

## The run's record

Every iteration and every host decision leaves a span and a log line under the
run's scratch folder (`<work>/traces/`), and the plugin's standard error is
kept there as a bounded log (its tail, the last 64 KiB, with the total byte
count). `madarch plugin check` and `madarch plugin run` print that folder
first.

## What the host does not run

By default, missing delegation or user namespaces refuse the run, naming the
missing controllers or setting, the folder and this page. To deliberately run
without confinement, set `MADARCH_PLUGIN_SANDBOX=off`: no bubblewrap, cgroup,
seccomp or macOS sandbox is used, and the plugin runs with the host account's
filesystem and network access. A warning is emitted once per process. Closure
approval and protocol checks still apply. Leave the variable unset for the
normal sandbox; every other value, including an empty string, is refused.
