# Ubuntu 26.04 Post-Install Runbook — Asus TUF A17

Everything from here to a working ULTRON training box. The pre-install phases (inventory,
backup, ISO, BIOS, live-boot test) are done and have been removed — this document is only
what is left.

---

## This machine

| | |
|---|---|
| Laptop | Asus TUF A17 · Ryzen 7 4800H (8c/16t, x86-64) · 16 GB RAM · RTX 3050 4 GB (Ampere, `sm_86`) |
| OS SSD | 512 GB — Ubuntu 26.04 LTS, ext4, **no encryption** |
| Data SSD | 1 TB — **currently detached**, reattached in Step 6 as `/data` |
| Network | Realtek RTL8111/8168 Ethernet (works natively, `r8169`) · **Wi-Fi does not enumerate — see Step 3** |
| Install choices | Interactive · Default/minimal selection · third-party drivers **enabled** · no encryption |

Because you took the **minimal** selection, expect a lean system: Firefox, Files, Settings,
terminal, and not much else. Everything you need gets installed deliberately below.

Because you enabled **third-party drivers**, the NVIDIA driver is already on disk — but it
will not load until you complete Step 1.

---

## Order of operations

```
1. MOK enrollment        → first reboot, blocks everything else
2. GPU + hybrid check    → confirms the reason you switched
3. Wi-Fi triage          → the one open hardware question
4. System baseline       → apt, tools, swap
5. Remote access         → do this early; everything after is easier from the Mac
6. Reattach the 1 TB     → /data
7. Keys + git identity
8. Caches + env vars     → BEFORE any model download
9. Conda + ML stack
10. Smoke tests          → all must pass
11. Docker               → sandbox Level 2
12. Record the baseline  → reconcile against the field guide
```

Do not reorder 8 before 6, or 9 before 8. Those two are the expensive mistakes.

Step 5 is deliberately early. Once SSH works you can drive the rest from the Mac — paste
commands instead of retyping them, and keep one keyboard.

---

## Step 1 — MOK enrollment ⚠️ the first trap

On the first reboot you get a **blue MOK Manager screen**. This is Secure Boot asking you to
trust the key that signs the NVIDIA kernel module.

1. Choose **Enroll MOK**
2. **Continue**
3. **Yes**
4. Enter the password you set during install
5. Reboot

**Do not pick "Reboot" at the top of that menu.** It is the reflexive choice and it skips
enrollment. The system boots fine, looks normal, and then:

```bash
nvidia-smi
```

fails with *"NVIDIA-SMI has failed because it couldn't communicate with the NVIDIA driver."*
No CUDA, no training, and nothing in the UI explains why.

**If you missed the screen or forgot the password:**

```bash
sudo mokutil --import /var/lib/shim-signed/mok/MOK.der
```

Set a new password, reboot, and take the blue screen seriously this time.

**Verify enrollment succeeded:**

```bash
mokutil --list-enrolled | grep -i -A2 'Subject:'
```

---

## Step 2 — GPU and hybrid mode

```bash
nvidia-smi
```

Expect the RTX 3050 Mobile and **4096 MiB**. If it fails after MOK enrollment is confirmed:

```bash
ubuntu-drivers devices && sudo ubuntu-drivers autoinstall && sudo reboot
```

### Confirm both GPUs are present

```bash
lspci -nn | grep -iE 'vga|3d'
```

You need **two** entries — the RTX 3050 *and* an AMD Renoir integrated GPU. The Renoir is
what drives your display in hybrid mode. If it is missing, the VRAM figures below do not
apply and the whole memory budget in the field guide shifts by ~0.5 GB.

> **The installer never asks about hybrid vs dGPU mode, and that is correct.** On this
> chassis the display panel is physically wired to the Renoir iGPU — the 3050 has no path to
> the screen and can only render and hand frames back (PRIME render offload). The 2020 A17
> with a 4800H has no MUX switch, so there is nothing to configure. Hybrid is the hardware
> default, which means ~3.95 GB usable VRAM is what you get out of the box.
>
> Do **not** install `supergfxctl` to "enable" hybrid — you are already there, and its only
> effect would be to move you off it.

Confirm the desktop is actually rendering on the iGPU:

```bash
sudo apt install -y mesa-utils && glxinfo | grep -i 'OpenGL renderer'
```

This must name the **AMD Renoir**. If it names the NVIDIA card, something is offloading the
desktop to the dGPU — that is the one case worth chasing, and it costs you ~150–300 MB.

### Verify the VRAM win — the reason you switched

Query the fields explicitly, so there is no guessing about which column says what:

```bash
nvidia-smi --query-gpu=name,driver_version,memory.total,memory.used,display_active,persistence_mode --format=csv
```

You want **`display_active: Disabled`** and `memory.used` in single-digit MB.

> **`Off` in the `nvidia-smi` table is not a fault.** Two columns read `Off` in normal
> operation: **Disp.A** (Display Active) means the dGPU is not driving your screen — that is
> the hybrid-mode confirmation you want. **Persistence-M** is off by default on every
> consumer and laptop card. Neither indicates a problem.
>
> The laptop also powers the dGPU fully down when idle (RTD3), so low power draw or a
> slightly slow first `nvidia-smi` is expected — it wakes when a CUDA process starts.

| Setup | Idle VRAM | Usable |
|---|---|---|
| Windows 11 + browser (what you left) | 500–1000 MB | ~3.0–3.5 GB |
| Ubuntu, hybrid, display on iGPU | **5–20 MB** | **~3.95 GB** |

If you see hundreds of MB idle, something is driving the display off the dGPU. Stay in
**Hybrid** mode — do *not* switch to dGPU-only via `supergfxctl`. Hybrid is precisely what
keeps the 3050 free.

For the longest runs you can drop to a TTY with **Ctrl+Alt+F3**, which buys back the last
~20 MB and guarantees the desktop never touches the card mid-run.

---

## Step 3 — Wi-Fi triage

Your live-USB check returned only the Realtek Ethernet controller. That is a meaningful
signal: **a card missing from `lspci` entirely is not a driver problem.** A device with no
driver still enumerates on the PCI bus — you would see it listed with `Kernel driver in
use:` absent. Nothing at all means the PCIe device is not coming up.

Work through this in order and stop when you get an answer.

```bash
lspci -nnk | grep -iA3 'network\|wireless\|802\.11'
```

```bash
rfkill list
```

```bash
lsusb
```

```bash
sudo dmesg | grep -iE 'wlan|wifi|mt79|iwlwifi|rtw|ath1|firmware'
```

| Result | Meaning | Fix |
|---|---|---|
| `rfkill` lists a `wlan` device | Card **is** present, radio blocked | `sudo rfkill unblock all` — easiest case |
| Appears in `lspci`, no driver bound | Missing firmware | `sudo apt install linux-firmware` then reboot |
| `dmesg` shows firmware load failure | Named blob missing | install the vendor firmware package the log names |
| Appears in `lsusb` | Wi-Fi is on the USB bus | driver issue, not seating |
| **Absent everywhere** | Not enumerating — hardware or BIOS | reseat the M.2 card, check BIOS, see below |

### Findings so far — this machine is on the "absent everywhere" branch

| Check | Result |
|---|---|
| `lspci` (live USB) | Realtek RTL8168 Ethernet only — no wireless device |
| `ip link` / `nmcli device status` (installed) | `lo` + `enp2s0` only — no `wlan0` |
| `enp2s0` ↔ PCI `02:00.0` | consistent; Ethernet is healthy end to end |

**What this rules out — do not retry these:**

- `linux-firmware` / vendor firmware packages — firmware loads onto a device that exists
- `rfkill unblock` — rfkill blocks radios, it does not hide PCI devices
- driver packages, `modprobe`, DKMS — there is no device to bind a driver to

A missing *driver* still leaves an `lspci` entry with `Kernel driver in use:` blank. No entry
at all means the PCIe endpoint is not answering, which is a hardware or firmware-config
state that no `apt install` can reach.

Confirm the bus topology once, then stop looking at software:

```bash
lspci -tv
```

Look for a PCIe root port with **nothing behind it** — that is the empty M.2 slot.

```bash
ls /sys/class/rfkill/
```

An empty directory confirms the kernel knows of no radio hardware at all.

### If it is absent everywhere

**Check BIOS first — it needs no disassembly.** F2 → **Advanced → Onboard Devices
Configuration** → look for `WLAN` / `Wireless LAN` / `Wi-Fi` and set it **Enabled**. A device
disabled there is electrically off and will not enumerate, which matches these findings
exactly. This is the leading hypothesis on a machine whose BIOS was recently visited for
Secure Boot and password changes.

The M.2 Wi-Fi module on the TUF A17 sits **next to the storage M.2 slots**. You had the
chassis open to pull the 1 TB SSD, and it is easy to unseat the card or pull an antenna lead
while working in there. Since you are opening it again in Step 6 anyway:

- Reseat the Wi-Fi card firmly
- Confirm **both** antenna leads are clipped down
- While in BIOS, look for a wireless enable/disable toggle

If it is genuinely dead, the fallbacks in order of cost:

1. **USB-tether your phone** — works immediately, zero cost, fine for setup
2. **Ethernet** — what you are using now; adequate for this whole machine's job
3. **USB Wi-Fi dongle** — pick one with a chipset in mainline (`mt7921u`, `rtw88`)
4. **Replace the M.2 card** — an Intel AX210 is the common upgrade and is well supported

None of this blocks any ULTRON work. This box trains models; it does not need to be mobile.

---

## Step 4 — System baseline

```bash
sudo apt update && sudo apt full-upgrade -y && sudo reboot
```

Minimal install means you are missing the toolchain:

```bash
sudo apt install -y build-essential git curl wget htop tmux nvtop \
                    python3-pip python3-venv unzip pkg-config \
                    linux-firmware pciutils
```

`nvtop` is worth having specifically — it is `htop` for the GPU, and watching VRAM live
during a training run is how you learn where your 4 GB actually goes.

### Swap — matters on 16 GB

Your real ceiling is system RAM, not VRAM. Generous swap converts a hard OOM-kill during
dataset loading into a slowdown you can recover from:

```bash
swapon --show
```

The installer's default will be small. Enlarge it:

```bash
sudo swapoff /swap.img && sudo fallocate -l 16G /swap.img && sudo chmod 600 /swap.img && sudo mkswap /swap.img && sudo swapon /swap.img
```

```bash
free -h
```

Ubuntu's installer already put `/swap.img` in `/etc/fstab`, so this survives reboot — but
confirm the path matches what `swapon --show` reported. Older installs use `/swapfile`.

### Asus-specific (optional)

`asusctl` gives fan curves, keyboard backlight, and power profiles on TUF hardware. Follow
the current instructions at `asus-linux.org` — the repo URL changes between releases. Useful
but not required; skip it until the ML stack works.

---

## Step 5 — Remote access from the Mac

The TUF's job is to sit on the desk and train. You will sit at the Mac. Set this up now and
every step below can be pasted from the Mac instead of retyped on the laptop.

### On the TUF — SSH server and a name

Minimal install ships no SSH server:

```bash
sudo apt install -y openssh-server avahi-daemon
```

```bash
sudo hostnamectl set-hostname tuf
```

```bash
sudo systemctl enable --now ssh && systemctl status ssh --no-pager
```

`avahi-daemon` publishes `tuf.local` over mDNS, which macOS resolves natively via Bonjour —
no static IP, no router config. The TUF is on Ethernet and the Mac on Wi-Fi, but they are on
the same LAN, so this works.

**If `tuf.local` does not resolve**, get the address directly and use a DHCP reservation in
your router so it stops moving:

```bash
ip -4 addr show scope global | grep inet
```

### Stop it suspending ⚠️ the trap that kills training runs

A laptop is not a server by default. **Closing the lid suspends it** — and takes your 8-hour
GRPO run with it.

```bash
sudo sed -i 's/^#*HandleLidSwitch=.*/HandleLidSwitch=ignore/' /etc/systemd/logind.conf
```

```bash
sudo sed -i 's/^#*HandleLidSwitchExternalPower=.*/HandleLidSwitchExternalPower=ignore/' /etc/systemd/logind.conf
```

Reboot to apply — restarting `systemd-logind` can drop your GUI session.

Then in the GUI: **Settings → Power → Automatic Suspend → Off**. Screen blanking is fine and
even desirable; *suspend* is what you must disable. Verify:

```bash
systemctl status sleep.target --no-pager && gsettings get org.gnome.settings-daemon.plugins.power sleep-inactive-ac-type
```

You want `'nothing'`.

### On the Mac — key and shortcut

```bash
ssh-copy-id <user>@tuf.local
```

If you have no key yet: `ssh-keygen -t ed25519 -C "mac"` first.

Add to `~/.ssh/config` on the Mac so it becomes just `ssh tuf`:

```
Host tuf
    HostName tuf.local
    User <user>
    ServerAliveInterval 30
    ServerAliveCountMax 6
```

`ServerAliveInterval` keeps long idle sessions from being dropped by the router — worth
having when you leave a monitoring session open for hours.

### tmux — the single most important habit

If you SSH in, launch a training run, and close your Mac, the run dies with the session.
tmux is what prevents that:

```bash
ssh tuf -t 'tmux new -A -s train'
```

`new -A` means attach-if-exists, create-if-not — one command for both cases. Detach with
**Ctrl+B** then **D**. Close the Mac, walk away, reattach tomorrow with the same command and
the run is still going.

Get this wrong once on a GRPO run and you lose a night.

### Moving data

Datasets out, adapters back:

```bash
rsync -avz --partial --progress ~/ULTRON/data/processed/ tuf:/data/datasets/
```

```bash
rsync -avz --partial --progress tuf:/data/runs/ ~/ULTRON/results/runs/
```

LoRA adapters are 20–200 MB, so pulling checkpoints back is cheap and you should do it often
— the Mac is where eval and merging happen.

> **Never rsync conda environments or `.git` directories between machines.** Environments
> contain absolute paths and platform-specific binaries; recreate them from
> `requirements.txt`. For code, use git — push from the Mac, pull on the TUF — or edit
> directly on the TUF with the remote IDE below. Rsyncing code in both directions creates
> divergence you will not notice until it costs you an experiment.

### Editing code on the TUF

| Tool | Works? |
|---|---|
| **VS Code Remote-SSH** | Yes, free. Full IDE against the TUF's filesystem, integrated terminal, automatic port forwarding. The default recommendation. |
| **PyCharm Professional** | Yes — SSH interpreter or JetBrains Gateway. |
| **PyCharm Community** | **No.** Remote interpreters are a Professional-only feature. |

Given your projects live under `PycharmProjects`, that last row matters: if you are on
Community, VS Code Remote-SSH is the free path to remote development.

### Monitoring a run

**W&B is the real answer** and it is already in your stack — metrics land in the browser on
the Mac with no SSH session open at all. That is why it is in the field guide.

For everything else:

```bash
ssh tuf -t nvtop
```

```bash
ssh -L 8888:localhost:8888 tuf
```

That forward lets a Jupyter or TensorBoard instance running on the TUF open in the Mac's
browser at `localhost:8888`.

### Remote desktop — rarely needed

Ubuntu 26.04 has RDP built in: **Settings → Sharing → Remote Desktop**. Connect with
Microsoft Remote Desktop on the Mac. For a training box you will almost never want this —
SSH plus W&B covers the real work, and a remote desktop session puts load on the GPU you are
trying to keep free.

---

## Step 6 — Reattach the 1 TB as `/data`

Shut down, reinstall the 1 TB, boot.

```bash
lsblk -o NAME,SIZE,MODEL,FSTYPE,MOUNTPOINT
```

Expect `nvme0n1` ~512 G (Ubuntu) **and** `nvme1n1` ~1 T (your data, NTFS).

### Read it read-only first

```bash
sudo mkdir -p /mnt/old && sudo mount -t ntfs3 -o ro /dev/nvme1n1p1 /mnt/old && ls /mnt/old
```

> **Refuses to mount, or read-only unexpectedly?** Windows Fast Startup left the volume
> dirty. `sudo ntfsfix /dev/nvme1n1p1`, then retry.
>
> **Mounts but empty or erroring?** It may still be BitLocker-encrypted. Linux cannot read
> that without painful tooling.

### The decision: ext4 or keep NTFS

| If the 1 TB… | Do this |
|---|---|
| Stays inside the TUF permanently | **Reformat to ext4** |
| Gets swapped to the Mac sometimes | **Keep NTFS**, and point `HF_HOME` at the 512 GB instead |

**Why ext4 matters for ML work specifically:**

- The HuggingFace cache is built on **symlinks** (`blobs/` + `snapshots/`). On NTFS,
  `huggingface_hub` falls back to copying — roughly doubling disk usage per model.
- Conda's package cache uses **hardlinks** — degraded or broken on NTFS.
- Git depends on **Unix permissions** — NTFS mounts present a uniform fake mask.

Given this drive's job is `HF_HOME`, datasets, and checkpoints, ext4 is the right answer
unless you have a concrete reason to plug it into the Mac.

### Reformat to ext4

```bash
rsync -av --progress /mnt/old/ /media/$USER/backup/1tb/    # and VERIFY it
```

```bash
sudo umount /mnt/old
```

> ⚠️ The next commands erase the 1 TB. Confirm `nvme1n1` is the **1 TB**, not your new
> Ubuntu drive. Run `lsblk` again if there is any doubt at all.

```bash
sudo wipefs -a /dev/nvme1n1 && sudo parted /dev/nvme1n1 mklabel gpt && sudo parted -a opt /dev/nvme1n1 mkpart primary ext4 0% 100% && sudo mkfs.ext4 -L data /dev/nvme1n1p1
```

```bash
sudo mkdir -p /data && sudo mount /dev/nvme1n1p1 /data && sudo chown -R $USER:$USER /data
```

That `chown` is not optional — without it `/data` is root-owned and every write fails with
permission denied.

### Make it permanent

```bash
sudo blkid /dev/nvme1n1p1
```

Add **one** line to `/etc/fstab` using the UUID (never `/dev/nvme1n1p1` — device names can
reorder between boots):

```
UUID=<uuid>  /data  ext4   defaults,noatime  0  2
```

For NTFS instead:

```
UUID=<uuid>  /data  ntfs3  defaults,uid=1000,gid=1000,noatime  0  0
```

Test **before rebooting** — a bad fstab entry can block boot:

```bash
sudo umount /data && sudo mount -a && df -h /data
```

`noatime` stops the kernel writing an access timestamp on every file read, which matters
when you are streaming datasets.

### The split

| Drive | Holds | Notes |
|---|---|---|
| **512 GB** — `/` | Ubuntu, conda envs, PyTorch, repos, swap | ~60 GB used |
| **1 TB** — `/data` | `HF_HOME`, datasets, rollouts, checkpoints | this is the part that grows |

```bash
mkdir -p /data/hf /data/datasets
```

---

## Step 7 — Keys and git identity

```bash
mkdir -p ~/.ssh && cp /path/to/backup/ssh/* ~/.ssh/ && chmod 700 ~/.ssh && chmod 600 ~/.ssh/id_* && chmod 644 ~/.ssh/*.pub
```

```bash
ssh -T git@github.com
```

```bash
git config --global user.name "Your Name" && git config --global user.email "your@email"
```

**Re-clone repos rather than copying them** — you avoid stale absolute paths and CRLF line
endings. Recreate Python environments from `environment.yml` / `requirements.txt`; never
copy environment directories across operating systems.

---

## Step 8 — Caches and env vars ⚠️ before any download

This is the cheapest mistake to avoid on this machine. The OS SSD is only 512 GB and the
default HF cache lands in your home directory. A 200 GB dataset download will fill the root
partition and take the desktop down with it.

```bash
cat >> ~/.bashrc <<'EOF'
export HF_HOME=/data/hf
export HF_DATASETS_CACHE=$HF_HOME/datasets
export PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True
EOF
```

```bash
source ~/.bashrc && echo $HF_HOME
```

Do not proceed until `echo $HF_HOME` prints `/data/hf`.

---

## Step 9 — Conda and the ML stack

```bash
wget https://repo.anaconda.com/miniconda/Miniconda3-latest-Linux-x86_64.sh && bash Miniconda3-latest-Linux-x86_64.sh
```

Restart the shell, then:

```bash
conda create -n ultron python=3.11 -y && conda activate ultron
```

### Match the wheel to the driver

`nvidia-smi` on this machine reports **CUDA 13.2** — that is the *driver's* capability, not a
toolkit you installed. CUDA drivers are backward compatible, so any `cu12x` or `cu13x` wheel
will run. Take the newest build PyTorch publishes rather than an old one:

```bash
pip install torch --index-url https://download.pytorch.org/whl/cu128
```

If that index 404s, check the current options at `pytorch.org/get-started/locally/` — the
published builds move between releases.

**Verify what you actually got before installing anything else:**

```bash
python -c "import torch; print(torch.__version__, torch.version.cuda, torch.cuda.get_device_capability())"
```

Expect `(8, 6)` — Ampere `sm_86`, still fully supported in CUDA 13. That is what tells you
bf16, TF32, and Flash Attention 2 are available.

```bash
pip install transformers datasets accelerate peft trl bitsandbytes unsloth wandb
```

> ⚠️ **`bitsandbytes` and Unsloth must match torch's CUDA build.** Install torch first,
> confirm `torch.version.cuda`, then install the rest so pip resolves against it. A mismatch
> does not fail at install time — it fails at training time, hours later, which is why the
> `python -m bitsandbytes` smoke test in Step 10 is non-negotiable.

> **You do NOT need the CUDA Toolkit.** PyTorch's pip wheels bundle their own CUDA runtime;
> only the *driver* is system-wide. Most guides tell you to install the full toolkit — a
> large download you do not need unless you are compiling CUDA C yourself.

### Optional — Flash Attention 2

Ampere supports it and it saves real memory, but it compiles from source. Budget ~20 minutes
and cap the job count or it will exhaust your 16 GB:

```bash
MAX_JOBS=4 pip install flash-attn --no-build-isolation
```

---

## Step 10 — Smoke tests — all must pass

```bash
python -c "import torch; assert torch.cuda.is_available(); print(torch.cuda.get_device_name(0))"
```

```bash
python -c "import torch; print(torch.cuda.get_device_capability())"
```

Expect `(8, 6)` — Ampere `sm_86`. This is what tells you bf16, TF32, and FA2 are available.

```bash
python -m bitsandbytes
```

This is the single most common broken install. It fails silently at training time otherwise.

```bash
python -c "from unsloth import FastLanguageModel; print('unsloth ok')"
```

Then a real **10-step LoRA run** on Qwen2.5-Coder-0.5B before you trust any of it. Ten steps
proves the whole chain: data → tokenizer → model → optimizer → backward → save.

**Never `fp16` on this box.** Use `bf16=True`. fp16 NaNs on step 1 and Ampere supports bf16
natively.

---

## Step 11 — Docker for sandbox Level 2

The POSIX APIs the executor needs (`resource.setrlimit`, `os.setsid`, `os.killpg`) are now
native — nothing to do for Level 1.

```bash
sudo apt install -y docker.io && sudo usermod -aG docker $USER
```

Log out and back in, then:

```bash
docker run --rm hello-world
```

On Linux, containers run on the host kernel at roughly **50 ms** overhead — versus 1–3 s on
the Mac's VM-backed Docker. That asymmetry is why bulk and unattended execution belongs on
this machine.

---

## Step 12 — Record the baseline

Capture the real numbers so the field guide's tables can be reconciled against measured
values rather than estimates:

```bash
{ nvidia-smi --query-gpu=name,memory.total,memory.used,driver_version --format=csv; nproc; free -h; lsblk -o NAME,SIZE,FSTYPE,MOUNTPOINT; python -c "import torch;print(torch.__version__, torch.version.cuda, torch.cuda.get_device_capability())"; } 2>&1 | tee /data/baseline.txt
```

Send that output over and the memory-math and throughput tables in the deck get updated from
estimates to your actual hardware.

---

## If something goes wrong

| Symptom | Fix |
|---|---|
| `nvidia-smi`: couldn't communicate with driver | MOK not enrolled → `sudo mokutil --import /var/lib/shim-signed/mok/MOK.der`, reboot, enroll |
| Black screen after boot | At GRUB press `e`, add `nomodeset` to the linux line, `Ctrl+X`. Fix the driver, then remove it. |
| Idle VRAM still ~500 MB | Display is on the dGPU. Confirm hybrid mode; `nvidia-smi` to see what holds memory. |
| No Wi-Fi | Step 3. Short answer: USB-tether the phone or use Ethernet. |
| `/data` empty after reboot | Not in `/etc/fstab`. Add by UUID, test with `sudo mount -a` **before** rebooting. |
| Permission denied writing `/data` | `sudo chown -R $USER:$USER /data` |
| Won't boot after editing fstab | At GRUB press `e`, add `systemd.mask=data.mount`, `Ctrl+X`. Fix the entry. |
| 1 TB won't mount / read-only | Fast Startup left NTFS dirty → `sudo ntfsfix /dev/nvme1n1p1`. Or it is BitLocker-encrypted. |
| `torch.cuda.is_available()` is False | CPU-only wheel installed. Reinstall with `--index-url .../whl/cu124`. |
| `bitsandbytes: CUDA Setup failed` | Version mismatch with torch's CUDA. Run `python -m bitsandbytes` for the diagnostic. |
| Disk fills up in a week | `HF_HOME` was never set. Step 8. |
| Dataset load kills the process | 16 GB RAM, non-streaming load. Use `streaming=True`, or move the step to the Mac. |
| `flash-attn` build hangs or OOMs | `MAX_JOBS=4`, or skip it — it is optional. |
| Need Windows back | Build a Windows USB on the Mac. The OEM key is in UEFI firmware and reactivates automatically. |

---

## Time budget — remaining work only

| Step | Time |
|---|---|
| 1–2 · MOK + GPU verify | 15 min |
| 3 · Wi-Fi triage | 20 min (longer if you open the chassis) |
| 4 · System baseline + swap | 30 min |
| 5 · Remote access + tmux + no-suspend | 25 min |
| 6 · Reattach 1 TB + reformat | 1–3 h if copying data off first |
| 7–8 · Keys, git, env vars | 20 min |
| 9 · Conda + ML stack | 30 min (+20 min if building flash-attn) |
| 10 · Smoke tests + 10-step run | 30 min |
| 11–12 · Docker + baseline | 20 min |

Call it **half a day** if the 1 TB needs copying, **3–4 hours** if you reformat it outright.
