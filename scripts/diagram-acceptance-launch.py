#!/usr/bin/env python3
"""Run one task-owned pod pipeline, then fetch and remove only its exact cluster."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import time

parser = argparse.ArgumentParser()
parser.add_argument('--phase', choices=['focused', 'acceptance'], required=True)
parser.add_argument('--overall-seconds', type=int, required=True)
parser.add_argument('--evidence-seconds', type=int, required=True)
parser.add_argument('--host-out', type=Path, required=True)
args = parser.parse_args()
if not 0 < args.overall_seconds <= 5400 or not 0 < args.evidence_seconds <= 2700:
    parser.error('owner bounds: overall <=5400; evidence <=2700')
repo = Path(__file__).resolve().parents[1]
cluster = 'madarch-avx2-madarch-diagrams-0026-099ba1'
started = time.time()
deadline = started + args.overall_seconds
stamp = time.strftime('%Y%m%dT%H%M%SZ', time.gmtime(started))
remote_out = f'/tmp/m38l15-acceptance-{stamp}'
remote = (f'python3 scripts/diagram-acceptance.py --phase {args.phase} --out {remote_out} '
          f'--deadline {deadline-120} --overall-seconds {args.overall_seconds} '
          f'--evidence-seconds {args.evidence_seconds}')
args.host_out.mkdir(parents=True, exist_ok=True)
os.environ.update(MADARCH_SKY_MEMORY='8', MADARCH_SKY_CPUS='2')
state = dict(cluster=cluster, pid=os.getpid(), started=started, absoluteDeadline=deadline,
             overallBoundSeconds=args.overall_seconds, evidenceBoundSeconds=args.evidence_seconds,
             remoteCommand=remote, remoteOut=remote_out)
def save():
    p=args.host_out/'runtime.json.tmp'; p.write_text(json.dumps(state,indent=2)); p.replace(args.host_out/'runtime.json')
def command(name, argv, seconds):
    begin=time.time()
    with (args.host_out/(name+'.log')).open('wb') as log:
        try:
            result=subprocess.run(argv,stdout=log,stderr=subprocess.STDOUT,timeout=max(1,seconds))
            code=result.returncode
        except subprocess.TimeoutExpired:
            code=124
    state[name]=dict(exit=code,seconds=time.time()-begin,argv=argv);save()
    print(f'{name} ownExit={code} seconds={time.time()-begin:.3f}',flush=True)
    return code
save()
print(json.dumps(state),flush=True)
status=command('before-status',['sky-pilot','status',cluster],60)
text=(args.host_out/'before-status.log').read_text(errors='replace')
if status or any(line.startswith(cluster+' ') for line in text.splitlines()):
    raise SystemExit('exact cluster absence not proved; no launch')
code=1
try:
    code=command('pipeline',['madarch-sky-test','--avx2','--cmd',str(repo),remote],deadline-time.time()-120)
    if code==3:
        logs=Path.home()/'.cache/madarch-sky-test'/cluster
        latest=sorted(logs.glob('run-*.log.txt'),key=lambda p:p.stat().st_mtime)
        raw=latest[-1].read_text(errors='replace') if latest else ''
        if 'Failed to provision' in raw:
            wrapped='[ -f .madarch-sky-exec ] && xargs -0 -r chmod +x < .madarch-sky-exec; start=$(date +%s); ( '+remote+' ); rc=$?; echo "MADARCH_TESTS_EXIT=$rc RUN_SECONDS=$(( $(date +%s) - start ))"; exit $rc'
            code=command('queued-pipeline',['sky-pilot','launch','-y','-c',cluster,'recipes:madarch-avx2','--workdir',str(logs/'stage'),'--cpus','2','--memory','8','--retry-until-up','--env','RUN_CMD='+wrapped],deadline-time.time()-120)
finally:
    command('fetch',['madarch-sky-test','--avx2','--fetch',str(repo),remote_out,str(args.host_out/'fetched')],90)
    command('down',['sky-pilot','down','-y',cluster],90)
    command('after-status',['sky-pilot','status',cluster],60)
    state['clusterAbsent']=not any(line.startswith(cluster+' ') for line in (args.host_out/'after-status.log').read_text(errors='replace').splitlines())
    state['pipelineExit']=code;state['wallSeconds']=time.time()-started;save()
print(f'HOST_PIPELINE_EXIT={code} WALL_SECONDS={time.time()-started:.3f}',flush=True)
raise SystemExit(code)
