/**
 * The seccomp filter the sandbox hands bubblewrap (decision 0035, item 9):
 * classic BPF over `seccomp_data` that refuses every way out of the sandbox's
 * rules that a kernel call would open — creating a socket (the network
 * profile "none"), io_uring's submission path, and ptrace with its
 * cross-process memory readers.
 *
 * The filter is built here rather than vendored: bubblewrap's own
 * `--seccomp FD` applies a program madarch composes, so the sandbox carries no
 * third-party applier whose hash and licence a person would have to trust for
 * something this small. A syscall the table does not name is allowed; the
 * kernel's own namespaces do the rest.
 */

/** The classic BPF opcodes this filter uses, as the kernel's `linux/filter.h` spells them. */
const BPF_LD_W_ABS = 0x20;
const BPF_JEQ_K = 0x15;
const BPF_RET_K = 0x06;

/** The returns the kernel reads off the filter's accumulator. */
const SECCOMP_RET_ALLOW = 0x7fff0000;
const SECCOMP_RET_ERRNO = 0x00050000;

/** The errno a refused call answers with, and the one a foreign ABI gets. */
const EPERM = 1;
const ENOSYS = 38;

/** The architecture values `seccomp_data.arch` holds for the machine madarch runs on. */
const AUDIT_ARCH: Readonly<Record<string, number>> = {
  'linux-arm64': 0xc00000b7,
  'linux-x64': 0xc000003e,
};

/** The calls the filter refuses, by the platform key, with the kernel's numbers. */
const REFUSED_CALLS: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  'linux-arm64': {
    socket: 198,
    socketpair: 199,
    connect: 203,
    io_uring_setup: 425,
    io_uring_enter: 426,
    io_uring_register: 427,
    ptrace: 117,
    process_vm_readv: 270,
    process_vm_writev: 271,
  },
  'linux-x64': {
    socket: 41,
    socketpair: 53,
    connect: 42,
    io_uring_setup: 425,
    io_uring_enter: 426,
    io_uring_register: 427,
    ptrace: 101,
    process_vm_readv: 310,
    process_vm_writev: 311,
  },
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
  return table === undefined ? [] : Object.keys(table).sort();
}

/**
 * The filter for one platform: the ABI is checked first (a call from another
 * ABI answers ENOSYS rather than slipping past a table of one ABI's numbers),
 * then each refused call answers EPERM, and everything else is allowed.
 */
export function seccompFilter(platform: string = `${process.platform}-${process.arch}`): Buffer {
  const arch = AUDIT_ARCH[platform];
  const table = REFUSED_CALLS[platform];
  if (arch === undefined || table === undefined) {
    throw new Error(`src/plugin/seccomp.ts:1: no seccomp filter is built for ${platform}: the sandbox's filter names ${Object.keys(AUDIT_ARCH).join(' and ')}, and a platform without one cannot run a plugin with sockets refused`);
  }
  const parts: Buffer[] = [];
  // seccomp_data.arch stands at offset 4; a foreign ABI's call is not one this table numbers.
  parts.push(instruction(BPF_LD_W_ABS, 0, 0, 4));
  parts.push(instruction(BPF_JEQ_K, 1, 0, arch));
  parts.push(instruction(BPF_RET_K, 0, 0, SECCOMP_RET_ERRNO | ENOSYS));
  // seccomp_data.nr stands at offset 0.
  parts.push(instruction(BPF_LD_W_ABS, 0, 0, 0));
  for (const name of Object.keys(table).sort()) {
    parts.push(instruction(BPF_JEQ_K, 0, 1, table[name]!));
    parts.push(instruction(BPF_RET_K, 0, 0, SECCOMP_RET_ERRNO | EPERM));
  }
  parts.push(instruction(BPF_RET_K, 0, 0, SECCOMP_RET_ALLOW));
  return Buffer.concat(parts);
}
