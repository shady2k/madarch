import { describe, expect, test } from 'bun:test';
import { refusedCallNames, seccompFilter } from '../src/plugin/seccomp.js';

/** Execute the small filter against a synthetic seccomp_data; no agent or kernel setup needed. */
function verdict(filter: Buffer, syscall: number, arch: number, flags = 0): number {
  const data = Buffer.alloc(24);
  data.writeUInt32LE(syscall, 0);
  data.writeUInt32LE(arch, 4);
  data.writeUInt32LE(flags, 16);
  let accumulator = 0;
  for (let at = 0; at < filter.length; at += 8) {
    const code = filter.readUInt16LE(at);
    const yes = filter.readUInt8(at + 2);
    const no = filter.readUInt8(at + 3);
    const value = filter.readUInt32LE(at + 4);
    if (code === 0x20) accumulator = data.readUInt32LE(value);
    else if (code === 0x06) return value;
    else if (code === 0x15) at += (accumulator === value ? yes : no) * 8;
    else if (code === 0x35) at += (accumulator >= value ? yes : no) * 8;
    else if (code === 0x45) at += ((accumulator & value) !== 0 ? yes : no) * 8;
    else throw new Error(`unknown BPF opcode ${code}`);
  }
  throw new Error('filter has no verdict');
}

describe('agent network opt-in preserves the rest of confinement', () => {
  for (const abi of [
    { platform: 'linux-x64', arch: 0xc000003e, socket: 41, connect: 42, ptrace: 101, clone: 56, clone3: 435, mount: 165 },
    { platform: 'linux-arm64', arch: 0xc00000b7, socket: 198, connect: 203, ptrace: 117, clone: 220, clone3: 435, mount: 40 },
  ]) test(abi.platform, () => {
    const ordinary = seccompFilter(abi.platform);
    const agent = seccompFilter(abi.platform, { network: true });
    const allow = 0x7fff0000;
    const denied = 0x00050001;
    const absent = 0x00050026;
    expect(refusedCallNames(abi.platform)).toContain('socket');
    expect(refusedCallNames(abi.platform, { network: true })).not.toContain('socket');
    expect(refusedCallNames(abi.platform, { network: true })).not.toContain('connect');
    for (const syscall of [abi.socket, abi.connect]) {
      expect(verdict(ordinary, syscall, abi.arch)).toBe(denied);
      expect(verdict(agent, syscall, abi.arch)).toBe(allow);
    }
    for (const syscall of [abi.ptrace, abi.mount]) expect(verdict(agent, syscall, abi.arch)).toBe(denied);
    expect(verdict(agent, abi.clone, abi.arch, 0x10000000)).toBe(denied);
    expect(verdict(agent, abi.clone, abi.arch)).toBe(allow);
    expect(verdict(agent, abi.clone3, abi.arch)).toBe(absent);
    expect(verdict(agent, abi.socket, 0)).toBe(absent);
    if (abi.platform === 'linux-x64') expect(verdict(agent, 0x40000000 + abi.socket, abi.arch)).toBe(absent);
  });
});
