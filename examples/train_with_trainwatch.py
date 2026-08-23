"""A real PyTorch training loop with trainwatch wired in.

Runs on CPU with no dataset — the point is the instrumentation, not the model.

    python examples/train_with_trainwatch.py

What to copy into your own loop is marked with ``# ── trainwatch ──``. It is
four lines: construct it, log each step, and let the context manager handle
the ending.
"""

from __future__ import annotations

import torch
import torch.nn as nn
import torch.nn.functional as F

from trainwatch import TrainMonitor

VOCAB, DIM, LAYERS, HEADS, SEQ, BATCH = 512, 128, 6, 4, 64, 16
STEPS = 600


class Block(nn.Module):
    def __init__(self, dim: int, heads: int) -> None:
        super().__init__()
        self.n1 = nn.LayerNorm(dim)
        self.attn = nn.MultiheadAttention(dim, heads, batch_first=True)
        self.n2 = nn.LayerNorm(dim)
        self.mlp = nn.Sequential(nn.Linear(dim, 4 * dim), nn.GELU(), nn.Linear(4 * dim, dim))

    def forward(self, x: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
        h = self.n1(x)
        a, weights = self.attn(h, h, h, need_weights=True, average_attn_weights=True)
        x = x + a
        x = x + self.mlp(self.n2(x))
        return x, weights


class Tiny(nn.Module):
    def __init__(self) -> None:
        super().__init__()
        self.emb = nn.Embedding(VOCAB, DIM)
        self.blocks = nn.ModuleList([Block(DIM, HEADS) for _ in range(LAYERS)])
        self.head = nn.Linear(DIM, VOCAB)

    def forward(self, idx: torch.Tensor) -> tuple[torch.Tensor, list[float], list[float]]:
        x = self.emb(idx)
        resid_rms: list[float] = []
        logit_max: list[float] = []
        for block in self.blocks:
            x, weights = block(x)
            # ── trainwatch ──────────────────────────────────────────────
            # The two per-layer probes the guide names. Cheap, detached, and
            # the reason you get warned *before* the loss blows up rather
            # than after. Gate behind `if step % k == 0` if k is tight.
            resid_rms.append(x.detach().pow(2).mean().sqrt().item())
            logit_max.append(weights.detach().max().item())
        return self.head(x), resid_rms, logit_max


def main() -> None:
    torch.manual_seed(0)
    model = Tiny()
    opt = torch.optim.AdamW(model.parameters(), lr=3e-4)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=STEPS)

    # ── trainwatch ──────────────────────────────────────────────────────
    # The `with` block is what catches CUDA OOM, dataloader crashes and NCCL
    # timeouts and pages you, instead of leaving a dead tmux pane and silence.
    with TrainMonitor(
        "example_tiny_lm",
        meta={"model": "tiny-lm", "layers": LAYERS, "dim": DIM, "batch": BATCH},
    ) as tw:
        for step in range(STEPS):
            idx = torch.randint(0, VOCAB, (BATCH, SEQ))
            target = torch.randint(0, VOCAB, (BATCH, SEQ))

            logits, resid_rms, logit_max = model(idx)
            loss = F.cross_entropy(logits.reshape(-1, VOCAB), target.reshape(-1))

            opt.zero_grad(set_to_none=True)
            loss.backward()
            grad_norm = nn.utils.clip_grad_norm_(model.parameters(), max_norm=1.0)
            opt.step()
            sched.step()

            # Entropy of the predictive distribution — collapse detection.
            with torch.no_grad():
                probs = logits.softmax(-1)
                entropy = -(probs * probs.clamp_min(1e-9).log()).sum(-1).mean()

            # ── trainwatch ──────────────────────────────────────────────
            # One call: every sink, every watchdog rule, the heartbeat, and
            # any alert. Slash-prefixed keys group themselves in the
            # dashboard, TensorBoard and W&B alike. step_time is measured
            # for you unless you pass your own.
            tw.log(
                {
                    "loss": loss,
                    "grad_norm": grad_norm,
                    "lr": sched.get_last_lr()[0],
                    "entropy": entropy,
                    **{f"resid_rms/layer_{i}": v for i, v in enumerate(resid_rms)},
                    **{f"attn_logit_max/layer_{i}": v for i, v in enumerate(logit_max)},
                },
                step=step,
            )

            if step % 50 == 0:
                print(f"  step {step:>4}  loss {loss.item():.4f}  |g| {grad_norm:.2f}")

        # Optional: an ad-hoc push when something you care about happens.
        tw.alert(f"final loss {loss.item():.4f}", priority="low")

    print("\ndone — open the dashboard:  trainwatch serve")


if __name__ == "__main__":
    main()
