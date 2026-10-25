#!/usr/bin/env python3
"""One bounded madarch-m38l.15 acceptance pipeline. Run on the leased AVX2 pod only."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import time

parser = argparse.ArgumentParser()
parser.add_argument('--out', required=True)
parser.add_argument('--phase', choices=['focused', 'acceptance'], required=True)
parser.add_argument('--deadline', type=float, required=True, help='absolute Unix deadline chosen BEFORE host setup')
parser.add_argument('--overall-seconds', type=int, default=5400)
parser.add_argument('--evidence-seconds', type=int, default=2700)
args = parser.parse_args()
if not 0 < args.evidence_seconds <= 2700 or not 0 < args.overall_seconds <= 5400:
    parser.error('owner bounds: evidence <=2700 seconds; overall <=5400 seconds')
root = Path.cwd()
out = Path(args.out).resolve()
if out.exists():
    raise SystemExit(f'{out}: evidence folder already exists; preserve the failed attempt')
out.mkdir(parents=True)
started = time.monotonic()
rows = []
active = None

def save(status):
    temporary = out / 'pipeline.json.tmp'
    temporary.write_text(json.dumps(dict(status=status, elapsedSeconds=time.monotonic()-started, overallBoundSeconds=args.overall_seconds, absoluteDeadline=args.deadline, stages=rows), indent=2))
    temporary.replace(out / 'pipeline.json')

def interrupted(signum, frame):
    if active is not None:
        os.killpg(active.pid, signal.SIGTERM)
    save('incomplete')
    raise SystemExit(128+signum)

signal.signal(signal.SIGTERM, interrupted)
signal.signal(signal.SIGINT, interrupted)
os.environ.update(MADARCH_OWN_WIKI='off', MADARCH_SKIP_PERF='1', PUPPETEER_SKIP_DOWNLOAD='1')

def run(name, command, bound, cwd=root):
    global active
    remaining = min(args.overall_seconds - (time.monotonic()-started), args.deadline - time.time() - 45)
    if remaining <= 0:
        save('failed')
        raise SystemExit(124)
    begin = time.monotonic()
    row = dict(name=name, command=command, cwd=str(cwd), boundSeconds=min(bound, remaining), status='running')
    rows.append(row)
    save('running')
    print(f'STAGE_START {name} bound={row["boundSeconds"]}', flush=True)
    with (out / f'{name}.log').open('wb') as log:
        active = subprocess.Popen(command, cwd=cwd, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        try:
            code = active.wait(timeout=row['boundSeconds'])
        except subprocess.TimeoutExpired:
            os.killpg(active.pid, signal.SIGTERM)
            try:
                active.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(active.pid, signal.SIGKILL)
                active.wait()
            code = 124
        finally:
            active = None
    row.update({'exit':code, 'seconds':time.monotonic()-begin, 'status':'passed' if code == 0 else 'failed'})
    save('running' if code == 0 else 'failed')
    print(f'STAGE_END {name} exit={code} seconds={row["seconds"]:.3f} log={out / (name+".log")}', flush=True)
    if code:
        print((out / f'{name}.log').read_text(errors='replace'), flush=True)
        raise SystemExit(code if code > 0 else 1)

try:
    app = root / 'wiki/app'
    if args.phase == 'focused':
        run('root-types', ['bun','run','check'], 60)
        app = root / 'wiki/app'
        run('app-install', ['bun','install','--frozen-lockfile'], 120, app)
        run('app-types', ['bun','run','check'], 60, app)
        run('app-focused', ['bun','test','src/knowledge/diagrams/first-view.test.ts','src/knowledge/diagrams/diagrams.test.tsx'], 90, app)
        run('backend-focused', ['bun','test','test/diagram-acceptance-harness.test.ts','test/knowledge-state-machines.test.ts','test/knowledge-view-regressions.test.ts','test/knowledge-likec4-dsl.test.ts','test/graph-diagrams-render.test.ts','test/knowledge-archify-binary.test.ts','test/wiki-archify.test.ts'], 180)
        run('filled-diagrams-render', ['bun','test','test/knowledge-diagrams.test.ts','test/knowledge-render.test.ts'], 300)
        save('focused-complete')
        raise SystemExit(0)
    run('app-install', ['bun','install','--frozen-lockfile'], 120, app)
    run('walker-bundle', ['bun','build','scripts/diagram-shots.ts','--target=bun','--outdir',str(out / 'walker-bundle')], 60)
    run('app-build', ['bun','run','build'], 180, app)
    binary_dir = out / 'binary'
    run('fresh-binary-smoke', ['env','-u','MADARCH_OWN_WIKI','bun','scripts/build-binary.ts','--version','0.2.4','--out',str(binary_dir)], 360)
    binary = binary_dir / 'madarch-linux-x64'
    provenance = {}
    for folder in ['src', 'scripts', 'vendor', 'wiki/app/src', 'wiki/app/dist', 'examples/training-repository']:
        for path in sorted((root / folder).rglob('*')):
            if path.is_file() and 'node_modules' not in path.parts:
                provenance[str(path.relative_to(root))] = hashlib.sha256(path.read_bytes()).hexdigest()
    provenance['binary'] = hashlib.sha256(binary.read_bytes()).hexdigest()
    (out / 'provenance.json').write_text(json.dumps(provenance, indent=2))
    walk = ['bun','scripts/diagram-shots.ts','--out',str(out / 'walk'),'--work',str(out / 'prepared-work'),'--binary',str(binary),'--port','4311']
    evidence_deadline = min(args.deadline - 90, time.time() + args.evidence_seconds)
    def evidence_run(name, command):
        remaining = evidence_deadline - time.time()
        if remaining <= 0:
            save('failed-evidence-deadline')
            raise SystemExit(124)
        run(name, command, remaining)
    evidence_run('walk-prepare', walk+['--phase','prepare'])
    evidence_run('walk-json', walk+['--phase','json'])
    for lang in ['en','ru']:
        for tag in ['1150-light','1150-dark','390-light','390-dark']:
            evidence_run(f'walk-{tag}-{lang}', walk+['--phase','matrix','--matrix',f'{tag}-{lang}'])
    evidence_run('walk-aggregate', walk+['--phase','aggregate'])
    scratch = out / 'stryker-tooling'
    scratch.mkdir()
    (scratch / 'package.json').write_text('{"private":true}')
    run('stryker-install', ['bun','add','--exact','@stryker-mutator/core@9','typescript@5'], 120, scratch)
    config = out / 'stryker.config.json'
    config.write_text(json.dumps(dict(
        mutate=['wiki/app/src/knowledge/diagrams/first-view.ts:4-39'],
        files=['bunfig.toml','test/run-scratch.ts','test/deadline.ts','wiki/app/src/knowledge/diagrams/first-view.ts','wiki/app/src/knowledge/diagrams/first-view.test.ts'],
        testRunner='command', commandRunner={'command':'bun test wiki/app/src/knowledge/diagrams/first-view.test.ts'},
        coverageAnalysis='off', concurrency=2, timeoutMS=10000, timeoutFactor=1,
        reporters=['json','html','clear-text','progress'],
        jsonReporter={'fileName':str(out / 'mutation.json')},
        htmlReporter={'fileName':str(out / 'mutation.html')},
        tempDirName=str(out / 'stryker-sandbox'),
        thresholds={'high':100,'low':80,'break':80}
    ), indent=2))
    run('stryker-changed-range', ['timeout','--signal=TERM','--kill-after=10s','600s','node',str(scratch / 'node_modules/@stryker-mutator/core/bin/stryker.js'),'run',str(config)], 600, root)
    save('numeric-complete-visual-review-pending')
finally:
    # Preserve the raw daemon log and stop even when a child hit its hard bound.
    home = out / 'prepared-work/home'
    binary = out / 'binary/madarch-linux-x64'
    if binary.exists() and home.exists():
        primary = sys.exc_info()[0] is not None
        for filename in ['.madarch-daemon.json', '.madarch-daemon.log']:
            if (home / filename).exists():
                shutil.copy2(home / filename, out / ('owned'+filename))
        try:
            result = subprocess.run([str(binary),'stop','--home',str(home)], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=30)
            (out / 'finally-stop.log').write_bytes(result.stdout)
            cleanup = {'exit':result.returncode}
        except Exception as error:
            cleanup = {'exit':None, 'error':repr(error)}
        try:
            state_file = out / 'owned.madarch-daemon.json'
            if state_file.exists():
                state = json.loads(state_file.read_text())
                proc = Path('/proc') / str(state['pid'])
                if proc.exists():
                    environment = (proc / 'environ').read_bytes().split(b'\0')
                    command = (proc / 'cmdline').read_bytes()
                    if ('MADARCH_DAEMON_TOKEN='+state['token']).encode() in environment and b'daemon-serve' in command:
                        # The lifecycle command could not finish. Kill only the verified daemon's own session,
                        # which owns its fill/read children. Never signal a recycled PID or another daemon.
                        if os.getsid(state['pid']) == state['pid']:
                            os.killpg(state['pid'], signal.SIGKILL)
                            cleanup['verifiedOwnedSessionKilled'] = state['pid']
                        else:
                            cleanup['error'] = 'verified daemon is not its session leader; pod down required'
        except Exception as error:
            cleanup['ownedProcessCheckError'] = repr(error)
        (out / 'finally-stop-exit.json').write_text(json.dumps(cleanup))
        if cleanup.get('exit') != 0:
            save('failed-cleanup-primary-preserved' if primary else 'failed-cleanup')
            if not primary:
                raise SystemExit(1)
    print(f'PIPELINE_EVIDENCE={out}', flush=True)
