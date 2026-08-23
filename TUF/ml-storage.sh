# ML / DL storage layout                              (updated 2026-08-22)
#
# THIS FILE IS VERSION-CONTROLLED IN THE REPO. ~/.config/ml-storage.sh is a
# symlink to it, and ~/.bashrc sources that path. To restore on a fresh box:
#
#     ln -s "$HOME/projects/ULTRON/TUF/ml-storage.sh" ~/.config/ml-storage.sh
#     echo '[ -f "$HOME/.config/ml-storage.sh" ] && . "$HOME/.config/ml-storage.sh"' >> ~/.bashrc
#
# The .bashrc guard is `[ -f ... ]`, which follows the symlink -- so if the repo
# is ever moved or deleted the file simply stops being sourced. Note what that
# costs: HF_HOME goes unset and huggingface_hub silently falls back to
# ~/.cache/huggingface on the OS drive. Re-link before the next download.
#
# Policy — the split is by ACCESS PATTERN, not by size alone.
#
#   OS drive (nvme1n1p2, ext4, /)   476 GB
#       Python interpreters, venvs, uv/pip caches, IDEs, source repos.
#       Millions of small files, OS/arch-specific, needs real POSIX semantics
#       and fast small-file I/O. None of it is worth backing up — it is all
#       reconstructible from requirements/ and git.
#
#   Data SSD (nvme0n1p1, ext4, /data)   916 GB
#       Model weights, datasets, checkpoints, run outputs, GGUF exports.
#       Few files, enormous, expensive to re-download, and the only thing here
#       that would ever fill a disk.
#
# WHY THE uv/pip CACHES STAY ON THE OS DRIVE (do not "optimise" this):
#   uv hardlinks packages out of its cache into each venv, and hardlinks cannot
#   cross filesystems. Move ~/.cache/uv to /data and every install silently
#   degrades from a hardlink into a full copy — slower, and it duplicates every
#   package per venv. The cache belongs on the same filesystem as the venvs.
#
# WHY /data IS MOUNTED OUTSIDE $HOME:
#   GNOME tracker3 indexes $HOME recursively. A 900 GB drive mounted inside
#   home makes the file indexer crawl all of it, forever.
#
# HISTORY:
#   This drive was NTFS at /run/media/killerx8143/Storage until 2026-08-22.
#   NTFS dropped it on every reboot via the dirty bit, and huggingface_hub
#   cannot symlink on NTFS so it copies instead — doubling disk use per model.
#   Reformatted to ext4, now mounted by UUID from /etc/fstab with `nofail`.
#
# THE GUARD IS DELIBERATE:
#   If /data is not mounted, the paths below resolve to a bare root-owned
#   directory on the OS drive. Writes then fail LOUDLY with EACCES instead of
#   silently filling / with 20 GB of weights. That is the intended failure
#   mode. Verify with `findmnt /data` before starting a long run.

export ML_STORAGE=/data

export HF_HOME="$ML_STORAGE/hf"                   # hub cache: model weights
export HF_DATASETS_CACHE="$HF_HOME/datasets"
export TORCH_HOME="$ML_STORAGE/torch"             # torch.hub artefacts
export OLLAMA_MODELS="$ML_STORAGE/ollama"         # GGUF blobs + manifests

export ML_DATASETS="$ML_STORAGE/datasets"         # curated JSONL; rsync target from the Mac
export ML_RUNS="$ML_STORAGE/runs"                 # training outputs: adapters, logs, ckpts
export ML_CHECKPOINTS="$ML_RUNS"                  # back-compat alias
export ML_MODELS="$ML_STORAGE/models"             # merged / GGUF exports
export ML_PROJECTS="$ML_STORAGE/projects"

# Explicit, even though these are the defaults — the point is that they are
# on the OS drive ON PURPOSE. See the hardlink note above.
export UV_CACHE_DIR="$HOME/.cache/uv"
export PIP_CACHE_DIR="$HOME/.cache/pip"

# Non-negotiable on this box (CLAUDE.md §3): the 4 GB card fragments badly
# without it, and a fragmented allocator OOMs well short of the 4 GB budget.
export PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True

if ! mountpoint -q "$ML_STORAGE" 2>/dev/null && [ -n "${PS1-}" ]; then
    printf 'warning: %s is NOT mounted (expected nvme0n1p1, ext4, via fstab UUID).\n' "$ML_STORAGE" >&2
    printf '         HF_HOME etc still point there, so writes fail loudly rather\n' >&2
    printf '         than filling the OS drive. Fix with: sudo mount /data\n' >&2
fi

# Environments (all on the OS drive, per the policy above).
alias dlenv='source $HOME/.venvs/dl/bin/activate'
alias ultron='cd $HOME/projects/ULTRON && source .venv/bin/activate'
