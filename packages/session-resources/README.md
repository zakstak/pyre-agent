# session-resources

Passive CPU, memory, and GPU memory accounting for T3 Code agent sessions on
Linux. A sampler reads cgroup v2 accounting files for each agent scope and
writes them to SQLite. Reports attribute the cost to a thread, the threads it
delegated to, and its native subagents, with the machine baseline and the
sampler's own overhead. Agents use it through the
[session-resources skill](../../skills/session-resources/SKILL.md).

## Requirements

- Linux with cgroup v2 and a systemd user manager.
- T3 Code built with agent scopes: agent processes in
  `app-t3code.slice/.../t3code-<provider>-<id>.scope` with `T3CODE_THREAD_ID` in
  their environment.
- Rust 1.89 or newer to build.
- For GPU memory, an NVIDIA driver with `libnvidia-ml.so.1`. Without it the
  sampler records CPU and memory only.

## Data sources

| What                     | Source                                                                   | Exact or sampled                                                |
| ------------------------ | ------------------------------------------------------------------------ | --------------------------------------------------------------- |
| Agent CPU time           | `cpu.stat` `usage_usec`                                                  | Exact: cumulative counter                                       |
| Agent memory peak        | `memory.peak`                                                            | Exact over the scope's life                                     |
| Agent memory             | `memory.current` minus page cache (`memory.stat` `file - shmem`)         | Sampled                                                         |
| Agent processes          | `pids.current`                                                           | Sampled                                                         |
| GPU memory per scope     | NVML compute and graphics process lists, matched by `/proc/<pid>/cgroup` | Sampled                                                         |
| Machine CPU              | `/proc/stat` busy ticks                                                  | Exact: cumulative counter                                       |
| Machine memory           | `/proc/meminfo` `MemTotal - MemAvailable`                                | Sampled                                                         |
| Machine GPU              | NVML memory, utilization, and power                                      | Sampled                                                         |
| Thread of a scope        | `T3CODE_THREAD_ID`, `T3CODE_HOME` in the scope leader's `environ`        | Read until settled; shared scopes every 30 s                    |
| Child threads, subagents | T3 `statev2.sqlite`, opened read-only at report time                     | `app_owned` children measured; `provider_native` ones estimated |
| Sampler overhead         | its service cgroup, `getrusage`, `/proc/self/{statm,io}`, tick timing    | Every tick                                                      |

A scope's final interval, up to one tick, is lost when systemd removes the scope
before the sampler reads it after its last process exits. Its CPU total is then
a lower bound by that much.

Not recorded: per-scope disk IO, because T3's slices do not enable the io
controller. CPU energy is not recorded either, because RAPL counters are
root-only. Docker containers run under dockerd's cgroup, not the agent's scope.

## Commands

```text
session-resources run [--interval-ms 2000] [--no-gpu]      # 250 to 10000 ms
session-resources report [THREAD] [--json] [--html PATH] [--t3-home DIR]
session-resources threads [--limit 20] [--json]
session-resources status [--minutes 5] [--json]
session-resources install [--interval-ms 2000]
session-resources uninstall [--purge]
```

`status` exits 0 when healthy, 1 over a limit, and 2 when the sampler is not
running or has no database. The sampler records its process id and start time,
so `status` reports a stopped sampler at once. It also notes when the installed
binary is not the build running `status`, which is the case after a plugin
update until `install` runs again.

`install` records the database path, and `uninstall --purge` deletes that
database unless `--db` names another.

`report --html` writes one self-contained page that needs no network. An
[askama](https://docs.rs/askama) template (`templates/report.html`) renders it
from a view model in `src/page.rs`. The charts are drawn by
[uPlot](https://github.com/leeoniya/uPlot) 1.6.32, vendored in `vendor/uplot/`,
with `assets/report.js` and `assets/gap.js` from per-sample data that
`src/timeline.rs` embeds as JSON. All charts share one time axis that cuts each
idle stretch between scopes to a fixed width, with all cuts together at most
half the plot. The cursor is synced across charts, dragging zooms in, and a
button overlays the whole machine. The page compiles in the
[internal visual style](../../skills/internal-visual-style/SKILL.md) tokens,
components, and Atkinson Hyperlegible fonts, and follows the system's light or
dark mode.

Every command takes `--db PATH`. The default is
`$XDG_STATE_HOME/session-resources/samples.sqlite`. `install` writes the
resolved path into the unit, so the service and later reports use the same file.

## Attribution

- **Thread:** every scope whose leader, the process T3 started, names the thread
  in its environment. The first leader seen is pinned by process id and start
  time, and the pin is stored, so a command left behind after its parent exits
  never takes over the scope, even across sampler restarts. A thread that
  restarted its provider has several scopes, and their costs add.
- **Shared scope:** a scope whose leader names no thread. Codex runs one
  app-server for every Codex thread on an instance, and only the commands it
  starts carry a thread id. The sampler records which threads it saw in such a
  scope. A report shows the scope's cost while the thread used it, but leaves it
  out of every total, because it cannot be split per thread.
- **Delegated thread:** a T3 subagent row with `origin = app_owned` and a child
  thread id. The child is a thread with its own scopes, so the report recurses
  into it.
- **Native subagent:** a T3 subagent row with `origin = provider_native`. It
  shares its parent's process, so the CPU between each pair of parent samples is
  split evenly among the parent and the native subagents running at the
  interval's midpoint. Intervals longer than 2.5 ticks are sampler downtime and
  stay with the parent. Rolled-up minutes hide shorter gaps inside them. A
  native subagent started by another one is shown below it. Memory is not split.
- **Turn:** the thread's own scopes from the user's request to the turn's
  completion. The CPU counter is interpolated between the readings either side
  of each boundary, so a turn shorter than a tick still gets its share. A
  boundary inside sampler downtime moves to the nearest reading in the turn, and
  the CPU shows as a lower bound (`≥`). A turn entirely inside downtime is not
  listed. Memory shows `—` when no sample falls in the window.
- **Task total:** CPU and memory-hours summed across the tree. Peak resident
  memory is the highest sum, across scopes, of each scope's mean within one time
  bucket. Peak cores spread each interval's CPU over the buckets it covers.
- **Machine baseline:** machine counters over the span the task was sampled,
  split into this task, all agent scopes, the T3 app cgroup, and the rest.

## Storage

One SQLite file in WAL mode, written only by the sampler:

- `units`: one row per cgroup, keyed by boot id and the cgroup directory's
  inode. Each row holds the kind (`machine`, `agent`, `app`, `sampler`), path,
  provider, owning thread or the shared flag, pinned leader, and its creation,
  first-seen, last-seen, and gone times.
- `unit_threads`: threads seen in each scope's processes, with first and last
  seen times.
- `samples`: raw readings at the tick interval. Counters are cumulative.
- `samples_1m`: one-minute rollups of samples older than seven days, kept. Each
  keeps its first and last sample's time and CPU counter, so counters stay at
  their real times.
- `ticks`: one row per tick with its interval, lateness, duration, and the
  sampler's CPU, RSS, bytes written, and database size. Kept for seven days.

## Overhead

Measured on a 16-core workstation with an NVIDIA GPU and seven tracked cgroups:

- A median tick takes 1.2 ms, and the p99 is 9 ms.
- CPU use is about 0.07% of one core.
- Memory is 31 MiB RSS, mostly the NVML library. `--no-gpu` skips loading it.
- The database grows by about 25 MB a day at full resolution. Rollups older than
  seven days take about 0.15 MB per cgroup-day.
- The sampler writes about 80 MB a day to disk.

Writes collect in one open transaction that commits every 30 seconds, on
`SIGTERM`, and before rollups. Committing every tick wrote about 11 times as
much, because each commit rewrites whole 4 KiB pages. Reports and `status` see
data up to 30 seconds old, and a crash loses at most that much.

The systemd unit is the hard limit: idle CPU weight, `Nice=19`, a 10% CPU quota,
idle IO, `MemoryMax=128M` (file cache counts against it), and a 30-second
watchdog. `status` flags the sampler well before those limits. The thresholds
are constants in `src/report.rs`. The sampler also doubles its interval when
ticks take over a quarter of it, up to 10 seconds, a third of the watchdog
timeout. A tick's recorded duration includes commits, event samples, watch
refreshes, and rollups since the previous tick. A tick that cannot write sends
no watchdog ping, and three in a row end the process so systemd restarts it.

## Check

```sh
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
```

The tests build a fake cgroup tree, procfs, and T3 database in a temporary
folder and run the sampler and reports against them.
