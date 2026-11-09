/**
 * The seccomp filter the sandbox hands bubblewrap (decision 0035, item 9):
 * classic BPF over `seccomp_data` that refuses every way out of the sandbox's
 * rules that a kernel call would open — creating a socket (the network
 * profile "none"), io_uring's submission path, ptrace with its cross-process
 * memory readers, every namespace a plugin never needs, the kernel surfaces a
 * plugin never needs (bpf, perf events, userfaultfd, the keyring, a file opened
 * by handle), and a fork that would leave with a namespace of its own.
 *
 * `socketpair` is allowed and `socket` is not: Bun's own spawning hands a child
 * its standard input and output through an `AF_UNIX` socket pair, which reaches
 * no address, while an address is reachable only through `socket` and
 * `connect`, and both are refused.
 *
 * The filter is built here rather than vendored: bubblewrap's own
 * `--seccomp FD` applies a program madarch composes, so the sandbox carries no
 * third-party applier whose hash and licence a person would have to trust for
 * something this small. A syscall the table does not name is allowed; the
 * kernel's own namespaces do the rest.
 *
 * The numbers are the kernel's own, read from two tables and named in
 * `REFUSED_CALLS` below: the generic ABI's `include/uapi/asm-generic/unistd.h`
 * (what arm64 uses) and x86_64's `arch/x86/entry/syscalls/syscall_64.tbl`, both
 * at v6.8.
 *
 * Two refusals are not a number's: `clone3` answers ENOSYS so libc and Bun fall
 * back to `clone`, and `clone` is allowed only when its flags carry no
 * namespace bit — a fork is Bun's own spawning, a namespace is an escape.
 * On x86_64 the x32 ABI is refused whole: its calls carry the same
 * `AUDIT_ARCH_X86_64` and differ only by `__X32_SYSCALL_BIT` in `nr`
 * (`arch/x86/include/uapi/asm/unistd.h`), so every x32 number would slip past a
 * table of one ABI's numbers.
 */

/** The classic BPF opcodes this filter uses, as the kernel's `linux/filter.h` spells them. */
const BPF_LD_W_ABS = 0x20;
const BPF_JEQ_K = 0x15;
const BPF_JGE_K = 0x35;
const BPF_JSET_K = 0x45;
const BPF_RET_K = 0x06;

/** The returns the kernel reads off the filter's accumulator. */
const SECCOMP_RET_ALLOW = 0x7fff0000;
const SECCOMP_RET_ERRNO = 0x00050000;

/** The errno a refused call answers with, and the one a foreign ABI or an x32 call gets. */
const EPERM = 1;
const ENOSYS = 38;

/** `seccomp_data` offsets: `nr`, `arch`, `instruction_pointer`, then `args[6]`. */
const OFFSET_NR = 0;
const OFFSET_ARCH = 4;
const OFFSET_ARG0_LOW = 16;

/** The architecture values `seccomp_data.arch` holds for the machine madarch runs on (`linux/audit.h`). */
const AUDIT_ARCH: Readonly<Record<string, number>> = {
  'linux-arm64': 0xc00000b7,
  'linux-x64': 0xc000003e,
};

/** x86_64's x32 ABI marks its calls with this bit in `nr`; nothing sane reaches for x32 here. */
const X32_SYSCALL_BIT = 0x40000000;

/** The namespace a fork may not carry: mount, cgroup, uts, ipc, user, pid, net and time (`linux/sched.h`). */
const CLONE_NAMESPACE_FLAGS = 0x7e02_0080;

/**
 * The calls the filter refuses, by the platform key, with the kernel's numbers
 * for that platform's ABI:
 *
 * - arm64: `include/uapi/asm-generic/unistd.h`, v6.8 (`__NR_*` there);
 * - x86_64: `arch/x86/entry/syscalls/syscall_64.tbl`, v6.8.
 *
 * `clone` and `clone3` are absent from this table on purpose: they are refused
 * below, one by argument and one by disposition.
 */
const REFUSED_CALLS: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  'linux-arm64': {
    socket: 198,
    connect: 203,
    io_uring_setup: 425,
    io_uring_enter: 426,
    io_uring_register: 427,
    ptrace: 117,
    process_vm_readv: 270,
    process_vm_writev: 271,
    unshare: 97,
    setns: 268,
    mount: 40,
    umount2: 39,
    pivot_root: 41,
    bpf: 280,
    perf_event_open: 241,
    userfaultfd: 282,
    keyctl: 219,
    add_key: 217,
    request_key: 218,
    open_by_handle_at: 265,
  },
  'linux-x64': {
    socket: 41,
    connect: 42,
    io_uring_setup: 425,
    io_uring_enter: 426,
    io_uring_register: 427,
    ptrace: 101,
    process_vm_readv: 310,
    process_vm_writev: 311,
    unshare: 272,
    setns: 308,
    mount: 165,
    umount2: 166,
    pivot_root: 155,
    bpf: 321,
    perf_event_open: 298,
    userfaultfd: 323,
    keyctl: 250,
    add_key: 248,
    request_key: 249,
    open_by_handle_at: 304,
  },
};

/** `clone` and `clone3`'s numbers, by platform, and the flags a clone may not carry. */
const FORK_CALLS: Readonly<Record<string, { readonly clone: number; readonly clone3: number }>> = {
  'linux-arm64': { clone: 220, clone3: 435 },
  'linux-x64': { clone: 56, clone3: 435 },
};

/** One BPF instruction, in the kernel's `struct sock_filter` layout. */
function instruction(code: number, jumpTrue: number, jumpFalse: number, k: number): Buffer {
  const bytes = Buffer.alloc(8);
  bytes.writeUInt16LE(code, 0);
  bytes.writeUInt8(jumpTrue, 2);
  bytes.writeUInt8(jumpFalse, 3);
  bytes.writeUInt32LE(k >>> 0, 4);
  return bytes;
}

/** The names the filter refuses, in code point order: what the operations text and a record state. */
export function refusedCallNames(platform: string = `${process.platform}-${process.arch}`): string[] {
  const table = REFUSED_CALLS[platform];
  const forks = FORK_CALLS[platform];
  if (table === undefined || forks === undefined) return [];
  return [...Object.keys(table), 'clone', 'clone3'].sort();
}

/**
 * The filter for one platform, in this order: the ABI is checked first (a call
 * from another ABI answers ENOSYS rather than slipping past a table of one
 * ABI's numbers); on x86_64 every x32 call answers ENOSYS by its bit; then each
 * refused call answers EPERM, `clone3` answers ENOSYS so the clone fallback
 * runs, a `clone` that carries a namespace flag answers EPERM, and everything
 * else is allowed.
 */
export function seccompFilter(platform: string = `${process.platform}-${process.arch}`): Buffer {
  const arch = AUDIT_ARCH[platform];
  const table = REFUSED_CALLS[platform];
  const forks = FORK_CALLS[platform];
  if (arch === undefined || table === undefined || forks === undefined) {
    throw new Error(`src/plugin/seccomp.ts:1: no seccomp filter is built for ${platform}: the sandbox's filter names ${Object.keys(AUDIT_ARCH).join(' and ')}, and a platform without one cannot run a plugin with sockets refused`);
  }
  const parts: Buffer[] = [];
  parts.push(instruction(BPF_LD_W_ABS, 0, 0, OFFSET_ARCH));
  parts.push(instruction(BPF_JEQ_K, 1, 0, arch));
  parts.push(instruction(BPF_RET_K, 0, 0, SECCOMP_RET_ERRNO | ENOSYS));
  parts.push(instruction(BPF_LD_W_ABS, 0, 0, OFFSET_NR));
  if (platform === 'linux-x64') {
    // Every x32 call carries this bit: 0x40000000 and up is no syscall this sandbox has a number for.
    parts.push(instruction(BPF_JGE_K, 0, 1, X32_SYSCALL_BIT));
    parts.push(instruction(BPF_RET_K, 0, 0, SECCOMP_RET_ERRNO | ENOSYS));
  }
  for (const name of Object.keys(table).sort()) {
    parts.push(instruction(BPF_JEQ_K, 0, 1, table[name]!));
    parts.push(instruction(BPF_RET_K, 0, 0, SECCOMP_RET_ERRNO | EPERM));
  }
  // clone3: ENOSYS, so libc and Bun fall back to clone, whose flags are checked next.
  parts.push(instruction(BPF_JEQ_K, 0, 1, forks.clone3));
  parts.push(instruction(BPF_RET_K, 0, 0, SECCOMP_RET_ERRNO | ENOSYS));
  // clone: allowed unless its flags carry a namespace; the three instructions after the compare are skipped when it is
  // another call, and the mask's false branch skips the refusal.
  parts.push(instruction(BPF_JEQ_K, 0, 3, forks.clone));
  parts.push(instruction(BPF_LD_W_ABS, 0, 0, OFFSET_ARG0_LOW));
  parts.push(instruction(BPF_JSET_K, 0, 1, CLONE_NAMESPACE_FLAGS));
  parts.push(instruction(BPF_RET_K, 0, 0, SECCOMP_RET_ERRNO | EPERM));
  parts.push(instruction(BPF_RET_K, 0, 0, SECCOMP_RET_ALLOW));
  return Buffer.concat(parts);
}
