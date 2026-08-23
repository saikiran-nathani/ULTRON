#!/usr/bin/env bash
# Layer 1 · Persist — a tmux session your run outlives the SSH pipe in.
#
#   bash scripts/train-session.sh                    # just the session
#   bash scripts/train-session.sh python train.py    # session + launch
#
# Layout:
#   pane 0 (left)       training output, tee'd to logs/run_<stamp>.log
#   pane 1 (top right)  watch -n 2 nvidia-smi
#   pane 2 (bot right)  trainwatch serve  (the dashboard)
#
# Detach with Ctrl-b then d. Reattach from anywhere with:  tmux a -t train
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

SESSION="${TRAINWATCH_SESSION:-train}"
STAMP="$(date +%Y%m%d_%H%M)"
LOG="logs/run_${STAMP}.log"
PY=".venv/bin/python"
TW="scripts/trainwatch"

mkdir -p logs var

if tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "Session '$SESSION' already exists — attaching."
  echo "(kill it first with: tmux kill-session -t $SESSION)"
  exec tmux attach -t "$SESSION"
fi

# A long scrollback is comfort, not storage — the tee'd log is the real record.
tmux new-session -d -s "$SESSION" -n run
tmux set-option -t "$SESSION" history-limit 50000
tmux set-option -t "$SESSION" mouse on          # scroll/select works from Blink

# pane 1 · GPU health, on its own so it can't be lost in training output
tmux split-window -h -t "${SESSION}:run" -p 38
if command -v nvidia-smi >/dev/null 2>&1; then
  tmux send-keys -t "${SESSION}:run.1" 'watch -n 2 nvidia-smi' C-m
else
  tmux send-keys -t "${SESSION}:run.1" \
    'echo "nvidia-smi not on PATH; on WSL2: export PATH=\$PATH:/usr/lib/wsl/lib"' C-m
fi

# pane 2 · the dashboard
tmux split-window -v -t "${SESSION}:run.1"
tmux send-keys -t "${SESSION}:run.2" "$TW serve" C-m

tmux select-pane -t "${SESSION}:run.0"

if [[ $# -gt 0 ]]; then
  # 2>&1 | tee -a keeps stderr (where the traceback lives) in the log too.
  # `set -o pipefail` inside the pane so a crash isn't masked by tee's exit 0.
  tmux send-keys -t "${SESSION}:run.0" \
    "set -o pipefail; $* 2>&1 | tee -a ${LOG}" C-m
  echo "launched: $*"
  echo "logging to: ${LOG}"
else
  tmux send-keys -t "${SESSION}:run.0" \
    "echo 'Ready. Launch with:  set -o pipefail; ${PY} train.py 2>&1 | tee -a ${LOG}'" C-m
fi

cat <<EOF

  session '${SESSION}' created
    pane 0  training       pane 1  nvidia-smi       pane 2  dashboard
    detach: Ctrl-b then d      reattach: tmux a -t ${SESSION}

EOF

exec tmux attach -t "$SESSION"
