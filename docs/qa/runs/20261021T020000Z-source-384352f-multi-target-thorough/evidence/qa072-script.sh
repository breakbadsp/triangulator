#!/usr/bin/env bash
export TRIANGULATOR_HOME=/tmp/tri-qa/home
LOG=/tmp/tri-qa/logs/qa072.log
SP=$(cat /tmp/tri-qa/home/run/sampler.pid)
snap(){ echo "$(date +%H:%M:%S) $1 $(curl -s -m 5 http://127.0.0.1:19401/api/targets | python3 -c 'import json,sys; d=json.load(sys.stdin); print(" ".join(t["key"].split("/")[1]+":"+t["status"]+":"+str(t["pid"]) for t in d["targets"]))')"; }
mark(){ echo "$(date +%H:%M:%S) == $1" >> $LOG; }
sed -i 's/^id = "b"$/id = "c"/' /tmp/tri-qa/home/config/sampler.toml
kill -HUP $SP; mark "step1: renamed b to c, SIGHUP" 
for i in $(seq 1 30); do snap s1 >> $LOG; sleep 5; done
mark "step2: SIGSTOP 30s"; kill -STOP $SP
for i in $(seq 1 6); do snap s2-paused >> $LOG; sleep 5; done
kill -CONT $SP; mark "step2: SIGCONT"
for i in $(seq 1 12); do snap s2-resumed >> $LOG; sleep 5; done
mark "step3: SIGSTOP 90s"; kill -STOP $SP
for i in $(seq 1 18); do snap s3-paused >> $LOG; sleep 5; done
kill -CONT $SP; mark "step3: SIGCONT"
for i in $(seq 1 24); do snap s3-resumed >> $LOG; sleep 5; done
mark "DONE"
