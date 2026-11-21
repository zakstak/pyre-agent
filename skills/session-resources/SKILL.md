---
name: session-resources
description:
  "Use when asked what a T3 Code session, thread, task, or subagent swarm cost
  in CPU, memory, or GPU memory, for a machine baseline, or to install, check,
  or remove the session resource sampler on Linux."
metadata:
  version: "1.0.0"
---

# Session resources

Measure the CPU, memory, and GPU memory a T3 Code task used, without model
tokens and without touching the agents. The command gives a task tree with the
machine baseline and the sampler's own overhead for the same window.

## How it measures

On Linux with systemd, T3 Code starts each agent provider process in its own
cgroup: a `t3code-<provider>-<id>.scope` below `app-t3code.slice`. The kernel
accounts every process in that scope, including tools, MCP servers, and dev
servers the agent started. A small sampler reads those accounting files every
two seconds and writes them to its own SQLite database. It reads kernel files
only. It does not signal, trace, or slow the agents.

- A scope belongs to the thread named by `T3CODE_THREAD_ID` in the environment
  of its leader, the process T3 started.
- Codex runs one app-server for every Codex thread, so its scope is shared. A
  report shows a shared scope's cost while the thread used it, marked "not in
  totals", because it cannot be split per thread.
- A report reads T3's state database read-only to find each thread's children.
  Threads started by T3 (`delegate_task`, workflows, swarms) have their own
  scopes and are measured exactly.
- Provider subagents (Claude `Agent`, Codex `spawn_agent`) run inside their
  parent's process. The parent's CPU in each sample is split evenly among the
  parent and the subagents running then. These numbers are estimates, and memory
  stays with the parent.
- CPU time and memory peaks are kernel counters, so they are exact between
  samples. Memory averages, memory-hours, and GPU memory are sampled.
- GPU memory comes from NVML, the library `nvidia-smi` uses, for NVIDIA GPUs.
  Other vendors' GPUs are not read.

The sampler is not counted in any agent. It records its own cost on every tick.

## Run the command

Run every command through the launcher in this skill's folder,
`scripts/session-resources`, by its full path:

```sh
SR=/path/to/this/skill/scripts/session-resources
"$SR" --help
```

The launcher builds
[packages/session-resources](../../packages/session-resources/README.md) with
cargo on first use and when its sources change. The first build needs network
access to fetch the locked crates. Build output goes to stderr.

## Install the sampler

Install only when the user asks for it. Installation adds a systemd user service
that keeps running after this session. Nothing is recorded before the service
starts, so earlier sessions cannot be reported.

```sh
"$SR" install
"$SR" status
```

`install` copies the binary to `$XDG_DATA_HOME/session-resources/bin/`. It
writes `$XDG_CONFIG_HOME/systemd/user/session-resources.service`, then enables
and starts it. Samples go to `$XDG_STATE_HOME/session-resources/samples.sqlite`.
The service keeps running that copy after a plugin update. When `status` notes
that the service runs a different build, run `install` again.

Do not run the sampler as root, change cgroup controllers, or edit T3's
database. A system without systemd user services or T3's agent scopes has
nothing to measure. Tell the user rather than working around it.

## Report a task

```sh
"$SR" report                       # the thread this command runs in
"$SR" report <thread-id>           # any thread
"$SR" report <thread-id> --json    # the full tree, all turns
"$SR" report <thread-id> --html /tmp/task-resources.html
"$SR" threads --limit 20           # recent threads and their totals
```

`report` defaults to `$T3CODE_THREAD_ID`, so inside T3 Code it reports the
current thread. The report shows:

- The task tree: the thread, each delegated thread nested below it, and native
  subagents marked `native` with an estimated CPU share.
- For each measured thread: wall time, CPU time and average cores, resident
  memory average and maximum, memory-hours (GiB·h), peak memory including page
  cache, GPU memory, and the largest process count.
- Turns: the thread's own cost for each user request, with CPU interpolated at
  the turn's start and end.
- Task total: CPU across the tree, the highest combined resident memory at one
  time, and memory-hours.
- Machine baseline over the sampled window: busy cores, memory and GPU memory
  used, GPU utilization and power, and how busy CPU split between this task, all
  T3 agents, the T3 app, and everything else.
- Sampler overhead over the same window.

Resident memory excludes page cache, which the kernel reclaims under pressure.
Peak memory with cache is the cgroup's `memory.peak` and is often much larger
after an agent reads many files. Lead with resident memory.

A scope created before the sampler started still reports its full CPU, because
the counter starts with the scope. Its memory averages cover only the sampled
part, which the report shows as "sampled from".

The HTML page needs no network access and follows the system's light or dark
mode. It leads with headline figures, then interactive charts of CPU, memory,
and GPU memory for the thread and each delegated child on one time axis. Idle
stretches between scopes are cut short, turns and subagents are bands, and
stretches a scope was alive but unsampled are hatched. A kernel memory peak that
no sample caught is marked. Hover reads every series, dragging zooms in, and the
Machine button overlays the whole machine. Tables list the task tree and turns,
then machine meters and a busy-CPU split. Sampler overhead and method notes sit
in closed sections at the end. Open it locally, or attach it as an artifact when
the user asks for one.

## Check the sampler

```sh
"$SR" status            # exit 0 healthy, 1 over a limit, 2 not running
"$SR" status --minutes 60 --json
```

`status` reports the last tick, live agent scopes, and the sampler's overhead.
Over the window, it flags:

- more than 1% of one core on average
- a p99 tick above 250 ms
- a tick starting over 2 s late
- resident memory above 48 MiB
- a database above 2 GiB
- an interval backed off from the configured one

The service unit sets the hard limits:

- `CPUWeight=idle` and `Nice=19`, so any real work runs first
- `CPUQuota=10%` of one CPU
- `IOSchedulingClass=idle`
- `MemoryHigh=96M` and `MemoryMax=128M`, which leave room for file cache
- a 30-second watchdog that restarts a hung sampler

If ticks take more than a quarter of the interval three times in a row, the
sampler doubles its interval, up to 10 seconds. It returns to the configured
interval once ticks are cheap again. Ticks that cannot write to the database
stop the watchdog pings, and three in a row end the process so systemd restarts
it.

Late ticks under heavy load are expected, because the sampler yields to
everything else. CPU totals stay exact, and only the time resolution drops.

## Remove the sampler

```sh
"$SR" uninstall           # keeps the samples
"$SR" uninstall --purge   # also deletes the database
```

## Retention

Samples stay at full resolution for seven days, then fold into one-minute rows
that are kept. The sampler's tick records are dropped after seven days.
