/**
 * The cgroup v2 a plugin's whole process tree runs in (decision 0035, item
 * 9): a child of one delegated to madarch, with `memory`, `cpu` and `pids`
 * bounded before the plugin's first instruction runs, frozen by the cgroup's
 * freezer, and killed by `cgroup.kill` — so no descendant escapes by changing
 * its session or process group.
 *
 * The host checks the delegation before a run and runs nothing where it is
 * missing: an unconfined plugin is not a slower plugin, it is another program
 * on the machine (docs/system/plugin-sandbox.md says what to enable).
 */
import { existsSync, mkdirSync, readFileSync, rmdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { log } from '../obs/log.js';

/** The cgroup filesystem madarch reads and writes. */
const CGROUP_ROOT = '/sys/fs/cgroup';

/** Where a refusal stands. */
const WHERE = 'src/plugin/cgroup.ts';

/** The controllers a plugin's cgroup needs: memory bounds it, cpu shares it, pids bounds its forks. */
export const REQUIRED_CONTROLLERS = ['cpu', 'memory', 'pids'] as const;

/** What the host bounds a plugin's whole tree by. */
export interface CgroupLimits {
  /** The most resident memory the tree may hold, in bytes. */
  readonly memoryBytes: number;
  /** The quota of one cpu period the tree may use, in microseconds, beside the period itself. */
  readonly cpuQuotaMicros: number;
  readonly cpuPeriodMicros: number;
  /** The most processes and threads the tree may hold. */
  readonly pids: number;
}

/** What a cgroup counted while a unit ran: the numbers a record keeps, never the plugin's own claims. */
export interface CgroupCounters {
  /** The highest resident memory the tree reached, in bytes. */
  readonly memoryPeakBytes: number;
  /** How many times the kernel killed a process of the tree for memory. */
  readonly oomKills: number;
  /** How many times a fork in the tree met the pids bound. */
  readonly pidsMaxHits: number;
  /** The cpu time the tree used, in microseconds. */
  readonly cpuMicros: number;
  /** How many processes and threads stand in the tree now. */
  readonly pidsCurrent: number;
}

/** One refusal of the machine's setup: what is missing and what to enable. */
export interface SetupProblem {
  readonly code: 'cgroup-delegation' | 'user-namespaces' | 'sandbox-platform';
  readonly message: string;
}

/** The cgroup folder this process runs in, as `/proc/self/cgroup` names it. */
export function ownCgroupFolder(): string {
  const line = readFileSync('/proc/self/cgroup', 'utf8').split('\n').find((entry) => entry.startsWith('0::'));
  const path = line === undefined ? '/' : line.slice('0::'.length);
  return join(CGROUP_ROOT, path);
}

/** The folder madarch creates plugin cgroups under: `MADARCH_PLUGIN_CGROUP`, else the process's own cgroup. */
export function cgroupParent(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const named = env['MADARCH_PLUGIN_CGROUP']?.trim();
  if (named !== undefined && named !== '') return named;
  try {
    return ownCgroupFolder();
  } catch {
    return CGROUP_ROOT;
  }
}

/** The controllers a cgroup offers its children, as `cgroup.controllers` lists them. */
export function availableControllers(parent: string): string[] {
  try {
    return readFileSync(join(parent, 'cgroup.controllers'), 'utf8').trim().split(/\s+/u).filter((name) => name !== '').sort();
  } catch {
    return [];
  }
}

/** The controllers a cgroup hands its children, as `cgroup.subtree_control` lists them. */
function delegatedControllers(parent: string): string[] {
  try {
    return readFileSync(join(parent, 'cgroup.subtree_control'), 'utf8').trim().split(/\s+/u).filter((name) => name !== '');
  } catch {
    return [];
  }
}

/**
 * Whether the cgroup at `parent` is delegated to madarch: it offers the three
 * controllers and hands them to its children. A cgroup that offers them but
 * holds processes cannot hand them on — the kernel refuses, and the reason
 * names that as what to change.
 */
export function checkCgroupDelegation(parent: string): SetupProblem | undefined {
  if (!existsSync(join(parent, 'cgroup.controllers'))) {
    return {
      code: 'cgroup-delegation',
      message: `${WHERE}:1: ${parent} is not a cgroup v2 folder: the sandbox puts every plugin in a cgroup of its own for its memory, cpu and pids bounds. Mount cgroup v2 at ${CGROUP_ROOT} and delegate a folder to madarch (docs/system/plugin-sandbox.md), then name it in MADARCH_PLUGIN_CGROUP`,
    };
  }
  const offered = availableControllers(parent);
  const missing = REQUIRED_CONTROLLERS.filter((controller) => !offered.includes(controller));
  if (missing.length > 0) {
    return {
      code: 'cgroup-delegation',
      message: `${WHERE}:1: ${parent} does not offer the ${missing.join(', ')} controller${missing.length === 1 ? '' : 's'}: the sandbox bounds a plugin's memory, cpu and processes. Enable ${missing.join(', ')} on the cgroup that holds madarch (systemd: start its unit with Delegate=yes and list the controllers in its unit file; docs/system/plugin-sandbox.md), then run again`,
    };
  }
  const handed = delegatedControllers(parent);
  const unhanded = REQUIRED_CONTROLLERS.filter((controller) => !handed.includes(controller));
  if (unhanded.length > 0) {
    // The folder may hold this process and its shells: the kernel then refuses to hand controllers to children,
    // which is the case the operations page names as the one to fix with a slice of its own.
    return {
      code: 'cgroup-delegation',
      message: `${WHERE}:1: ${parent} does not hand the ${unhanded.join(', ')} controller${unhanded.length === 1 ? '' : 's'} to its children (cgroup.subtree_control holds ${handed.length === 0 ? 'nothing' : handed.join(' ')}): madarch is not delegated a cgroup it may bound plugins in. Give madarch a cgroup of its own with the controllers enabled — systemd: a slice with Delegate=yes, for example systemd-run --slice=madarch.slice --scope true and MADARCH_PLUGIN_CGROUP=/sys/fs/cgroup/madarch.slice — and run again; docs/system/plugin-sandbox.md holds the whole setup`,
    };
  }
  return undefined;
}

/**
 * Whether unprivileged user namespaces are available: bubblewrap unshares the
 * plugin's namespaces as the user running madarch, and a kernel (or an
 * AppArmor profile) that refuses them runs no confined plugin at all.
 */
export function checkUserNamespaces(files: { read?: (path: string) => string; uid?: number | undefined } = {}): SetupProblem | undefined {
  const read = files.read ?? ((path: string) => readFileSync(path, 'utf8'));
  const uid = files.uid ?? (typeof process.getuid === 'function' ? process.getuid() : undefined);
  const readNumber = (path: string): number | undefined => {
    try {
      const value = Number(read(path).trim());
      return Number.isFinite(value) ? value : undefined;
    } catch {
      return undefined;
    }
  };
  const max = readNumber('/proc/sys/user/max_user_namespaces');
  if (max !== undefined && max <= 0) {
    return {
      code: 'user-namespaces',
      message: `${WHERE}:1: /proc/sys/user/max_user_namespaces is ${String(max)}: unprivileged user namespaces are switched off, and bubblewrap unshares the plugin's namespaces as this user. Enable them (sysctl user.max_user_namespaces=15000; docs/system/plugin-sandbox.md), then run again`,
    };
  }
  // Root opens a namespace whatever a policy for unprivileged users says; the sysctls below are read for the
  // account madarch runs as.
  if (uid === 0) return undefined;
  const clone = readNumber('/proc/sys/kernel/unprivileged_userns_clone');
  if (clone !== undefined && clone === 0) {
    return {
      code: 'user-namespaces',
      message: `${WHERE}:1: /proc/sys/kernel/unprivileged_userns_clone is 0: this kernel refuses unprivileged user namespaces, and the sandbox opens one for every plugin. Set kernel.unprivileged_userns_clone=1 (docs/system/plugin-sandbox.md), then run again`,
    };
  }
  const apparmor = readNumber('/proc/sys/kernel/apparmor_restrict_unprivileged_userns');
  if (apparmor !== undefined && apparmor === 1) {
    return {
      code: 'user-namespaces',
      message: `${WHERE}:1: /proc/sys/kernel/apparmor_restrict_unprivileged_userns is 1: an AppArmor policy restricts unprivileged user namespaces to confined programs, and bubblewrap cannot open the plugin's namespaces as an ordinary user here. Allow the account madarch runs as (an AppArmor profile granting userns), or set kernel.apparmor_restrict_unprivileged_userns=0; docs/system/plugin-sandbox.md holds both, then run again`,
    };
  }
  return undefined;
}

/** The cgroup one plugin's whole tree runs in, from the moment before its first instruction. */
export class PluginCgroup {
  readonly folder: string;
  private readonly limits: CgroupLimits;

  private constructor(folder: string, limits: CgroupLimits) {
    this.folder = folder;
    this.limits = limits;
  }

  /**
   * Makes the cgroup and writes its bounds before anything runs in it:
   * memory (with swap off, so the bound is the tree's memory), one cpu
   * period's quota, and the process count.
   */
  static create(parent: string, name: string, limits: CgroupLimits): PluginCgroup {
    const folder = join(parent, name);
    mkdirSync(folder);
    const cgroup = new PluginCgroup(folder, limits);
    cgroup.write('memory.max', String(limits.memoryBytes));
    cgroup.write('memory.swap.max', '0');
    cgroup.write('cpu.max', `${String(limits.cpuQuotaMicros)} ${String(limits.cpuPeriodMicros)}`);
    cgroup.write('pids.max', String(limits.pids));
    return cgroup;
  }

  private write(file: string, value: string): void {
    writeFileSync(join(this.folder, file), value);
  }

  private read(file: string): string {
    return readFileSync(join(this.folder, file), 'utf8');
  }

  /** Puts one process — and everything it forks after — into the cgroup. */
  add(pid: number): void {
    this.write('cgroup.procs', String(pid));
  }

  /** Waits until the process stands in the cgroup, and refuses when it never does. */
  contains(pid: number, timeoutMs = 500): void {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      try {
        const held = this.read('cgroup.procs').split('\n').map((line) => line.trim());
        if (held.includes(String(pid))) return;
      } catch {
        break;
      }
      Bun.sleepSync(2);
    }
    throw new Error(`the sandbox's supervisor ${String(pid)} did not stand in ${this.folder} (cgroup.procs holds ${(() => { try { return this.read('cgroup.procs').trim().replace(/\s+/gu, ' '); } catch { return 'nothing' } })()})`);
  }

  /** Whether the kernel still holds the folder: an emptied cgroup's folder is removed by its owner. */
  exists(): boolean {
    return existsSync(this.folder);
  }

  /** How many processes and threads stand in the tree now. */
  pidsCurrent(): number {
    try {
      return Number(this.read('pids.current').trim());
    } catch {
      return 0;
    }
  }

  /** Freezes the whole tree at once, and answers once the cgroup reports it frozen. */
  freeze(): void {
    try {
      this.write('cgroup.freeze', '1');
      this.waitFor('1');
    } catch {
      // The cgroup's last process left and the kernel removed the folder: there is no tree left to freeze.
    }
  }

  /** Thaws the whole tree. */
  thaw(): void {
    try {
      this.write('cgroup.freeze', '0');
      this.waitFor('0');
    } catch {
      // Nothing left to thaw, as above.
    }
  }

  /** Waits until `cgroup.events` states the frozen flag, or a second has passed. */
  private waitFor(flag: string): void {
    const until = Date.now() + 1_000;
    while (Date.now() < until) {
      const events = this.read('cgroup.events');
      const match = events.split('\n').find((line) => line.startsWith('frozen '));
      if (match !== undefined && match.slice('frozen '.length).trim() === flag) return;
      Bun.sleepSync(1);
    }
  }

  /** Kills every process of the tree at once, however it detached itself below the cgroup. */
  kill(): void {
    try {
      this.write('cgroup.kill', '1');
    } catch {
      // The kernel answers EBUSY for a cgroup already empty of processes; a kill of nothing is nothing to do.
    }
  }

  /** What the cgroup counted: read after a unit, and again at the end of the run. */
  counters(): CgroupCounters {
    const events = (file: string): Readonly<Record<string, number>> => {
      const held: Record<string, number> = {};
      try {
        for (const line of this.read(file).split('\n')) {
          const [name, value] = line.trim().split(/\s+/u);
          if (name !== undefined && value !== undefined) held[name] = Number(value);
        }
      } catch {
        // A cgroup the kernel removed with its last process counts nothing.
      }
      return held;
    };
    let peak = 0;
    try {
      peak = Number(this.read('memory.peak').trim());
    } catch {
      peak = 0;
    }
    const memory = events('memory.events');
    const pids = events('pids.events');
    let cpuMicros = 0;
    try {
      const stat = this.read('cpu.stat');
      const usage = stat.split('\n').find((line) => line.startsWith('usage_usec '));
      cpuMicros = usage === undefined ? 0 : Number(usage.slice('usage_usec '.length).trim());
    } catch {
      cpuMicros = 0;
    }
    return {
      memoryPeakBytes: Number.isFinite(peak) ? peak : 0,
      oomKills: memory['oom_kill'] ?? 0,
      pidsMaxHits: pids['max'] ?? 0,
      cpuMicros,
      pidsCurrent: this.pidsCurrent(),
    };
  }

  /**
   * Removes the cgroup once its processes are gone. The kernel refuses while a process still stands in the tree, and a
   * killed tree takes a moment to be reaped, so the removal waits a short while; a folder that outlives the wait is
   * named in the log rather than left to fill the delegation silently.
   */
  async remove(): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        rmdirSync(this.folder);
        return;
      } catch {
        if (!this.exists()) return;
        await Bun.sleep(20);
      }
    }
    log.warn('a plugin cgroup outlived its tree', { folder: this.folder, pids: this.pidsCurrent() });
  }
}
