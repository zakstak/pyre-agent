//! Turns stored samples into per-task costs: a thread, the threads it delegated to, and estimates for subagents
//! that ran inside its process, with the machine baseline and the sampler's own overhead over the same window.

use crate::host::UnitKind;
use crate::store::{Point, SharedUse, Store, TickRow, Unit};
use crate::t3::{ChildOrigin, T3};
use serde::Serialize;
use std::collections::{HashMap, HashSet};

/// The longest gap between two samples that is integrated as if the later value held throughout. Longer gaps are
/// sampler downtime; capping them keeps a stopped sampler from inventing memory-hours. One minute plus margin covers
/// rolled-up rows.
const GAP_CAP_MS: i64 = 65_000;
pub(crate) const GIB: f64 = 1024.0 * 1024.0 * 1024.0;
const HOUR_MS: f64 = 3_600_000.0;

#[derive(Debug, Clone, Copy, Serialize)]
pub struct Window {
    pub from_ms: i64,
    pub to_ms: i64,
}

impl Window {
    pub const ALL: Window = Window {
        from_ms: i64::MIN / 4,
        to_ms: i64::MAX / 4,
    };

    fn covers(&self, unit: &Unit) -> bool {
        self.from_ms <= unit.start_ms() && self.to_ms >= unit.last_seen_ms
    }
}

/// Measured cost of a set of cgroups.
#[derive(Debug, Clone, Default, Serialize)]
pub struct Usage {
    pub scopes: usize,
    /// Start of the measured time: the earliest scope's creation when the window includes it, else the window's first
    /// sample.
    pub first_ms: i64,
    /// The first sample inside the window.
    pub first_sample_ms: i64,
    pub last_ms: i64,
    pub wall_ms: i64,
    /// Time covered by samples, summed per scope. Memory averages and memory-hours cover only this time.
    pub sampled_ms: i64,
    /// Samples inside the window. With none, the memory fields are unknown rather than zero.
    pub samples: usize,
    pub cpu_usec: u64,
    /// The window starts or ends in a stretch without readings, so `cpu_usec` covers only the sampled part of it.
    pub cpu_partial: bool,
    pub avg_cores: f64,
    /// Highest memory including page cache. For a whole scope lifetime this is the kernel's `memory.peak`, exact
    /// between samples; inside a narrower window it is the highest sampled value.
    pub mem_peak: u64,
    /// Memory minus page cache: what the processes and kernel hold for them.
    pub resident_avg: f64,
    pub resident_max: u64,
    pub resident_gib_hours: f64,
    /// GPU memory, `None` when no sample in the window had a GPU memory reading.
    pub vram_max: Option<u64>,
    pub vram_gib_hours: Option<f64>,
    pub pids_max: u64,
}

pub(crate) fn usage(store: &Store, units: &[Unit], window: Window) -> rusqlite::Result<Option<Usage>> {
    let mut total = Usage {
        first_ms: i64::MAX,
        first_sample_ms: i64::MAX,
        last_ms: i64::MIN,
        ..Usage::default()
    };
    let mut resident_ms = 0.0;
    for unit in units {
        let points = store.points(unit.unit_id, window.from_ms, window.to_ms)?;
        let cpu = unit_cpu(store, unit, window)?;
        // A window between two readings has no points but still used the CPU interpolated across it.
        if points.is_empty() && cpu.is_none() {
            continue;
        }
        total.scopes += 1;
        total.samples += points.len();
        let (started, ended) = if unit.kind == UnitKind::Machine {
            (
                points.first().map_or(window.from_ms, |p| p.ts_ms),
                points.last().map_or(window.to_ms, |p| p.ts_ms),
            )
        } else {
            (window.from_ms.max(unit.start_ms()), window.to_ms.min(unit.last_seen_ms))
        };
        total.first_ms = total.first_ms.min(started);
        total.last_ms = total.last_ms.max(ended);
        if let Some(first) = points.first() {
            total.first_sample_ms = total.first_sample_ms.min(first.ts_ms);
        }
        if let Some(cpu) = cpu {
            total.cpu_usec += cpu.usec;
            total.cpu_partial |= cpu.partial;
        }
        let whole_life = window.covers(unit);
        for (index, point) in points.iter().enumerate() {
            let peak = if whole_life {
                point.mem_peak.unwrap_or(point.mem_current_max)
            } else {
                point.mem_current_max
            };
            total.mem_peak = total.mem_peak.max(peak);
            total.resident_max = total.resident_max.max(point.resident_max);
            if let Some(vram) = point.vram_max {
                total.vram_max = Some(total.vram_max.unwrap_or(0).max(vram));
            }
            total.pids_max = total.pids_max.max(point.pids_max);
            if index > 0 {
                let dt = (point.ts_ms - points[index - 1].ts_ms).clamp(0, GAP_CAP_MS) as f64;
                total.resident_gib_hours += point.resident_avg * dt / GIB / HOUR_MS;
                if let Some(vram) = point.vram_avg {
                    *total.vram_gib_hours.get_or_insert(0.0) += vram * dt / GIB / HOUR_MS;
                }
                resident_ms += point.resident_avg * dt;
                total.sampled_ms += dt as i64;
            }
        }
    }
    if total.scopes == 0 {
        return Ok(None);
    }
    if total.first_sample_ms == i64::MAX {
        total.first_sample_ms = total.first_ms;
    }
    total.wall_ms = (total.last_ms - total.first_ms).max(0);
    if total.wall_ms > 0 {
        total.avg_cores = total.cpu_usec as f64 / 1000.0 / total.wall_ms as f64;
    }
    if total.sampled_ms > 0 {
        total.resident_avg = resident_ms / total.sampled_ms as f64;
    }
    Ok(Some(total))
}

/// Time buckets summed across units, for charts and for the concurrent peak of a whole task tree.
#[derive(Debug, Clone, Copy, Default, Serialize)]
pub struct Bucket {
    pub ts_ms: i64,
    pub cores: f64,
    pub resident: f64,
    /// `None` when no unit had a GPU memory reading in the bucket.
    pub vram: Option<f64>,
}

pub fn series(store: &Store, units: &[Unit], window: Window, bucket_ms: i64) -> rusqlite::Result<Vec<Bucket>> {
    let bucket_ms = bucket_ms.max(1);
    let mut cpu: HashMap<i64, f64> = HashMap::new();
    let mut resident: HashMap<i64, f64> = HashMap::new();
    let mut vram: HashMap<i64, f64> = HashMap::new();
    for unit in units {
        let points = store.points(unit.unit_id, window.from_ms, window.to_ms)?;
        // Per unit and bucket: the sum and count of readings, so each unit contributes its mean for the bucket.
        let mut unit_resident: HashMap<i64, (f64, u32)> = HashMap::new();
        let mut unit_vram: HashMap<i64, (f64, u32)> = HashMap::new();
        let mut previous: Option<&Point> = None;
        for point in &points {
            // A rate needs two readings. The first reading's counter may hold hours from before the sampler saw the
            // scope, so it marks the start rather than counting as usage. Across sampler downtime the time of use is
            // unknown, so it is left out of the rate. Otherwise the delta spreads evenly over the buckets the
            // interval covers.
            if let Some(before) = previous.filter(|p| point.ts_ms - p.ts_ms <= GAP_CAP_MS) {
                let delta = point.cpu_usec.unwrap_or(0).saturating_sub(before.cpu_usec.unwrap_or(0)) as f64;
                spread(&mut cpu, before.ts_ms, point.ts_ms, bucket_ms, delta);
            }
            let bucket = point.ts_ms.div_euclid(bucket_ms);
            let r = unit_resident.entry(bucket).or_default();
            *r = (r.0 + point.resident_avg, r.1 + 1);
            if let Some(value) = point.vram_avg {
                let v = unit_vram.entry(bucket).or_default();
                *v = (v.0 + value, v.1 + 1);
            }
            previous = Some(point);
        }
        for (bucket, (sum, n)) in unit_resident {
            *resident.entry(bucket).or_default() += sum / f64::from(n);
        }
        for (bucket, (sum, n)) in unit_vram {
            *vram.entry(bucket).or_default() += sum / f64::from(n);
        }
    }
    let mut keys: Vec<i64> = cpu
        .keys()
        .chain(resident.keys())
        .copied()
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    keys.sort_unstable();
    Ok(keys
        .into_iter()
        .map(|bucket| Bucket {
            ts_ms: bucket * bucket_ms,
            cores: cpu.get(&bucket).copied().unwrap_or(0.0) / 1000.0 / bucket_ms as f64,
            resident: resident.get(&bucket).copied().unwrap_or(0.0),
            vram: vram.get(&bucket).copied(),
        })
        .collect())
}

/// Add `amount`, used evenly over `[from, to]`, to the buckets that interval overlaps.
fn spread(into: &mut HashMap<i64, f64>, from: i64, to: i64, bucket_ms: i64, amount: f64) {
    if to <= from {
        *into.entry(to.div_euclid(bucket_ms)).or_default() += amount;
        return;
    }
    let span = (to - from) as f64;
    for bucket in from.div_euclid(bucket_ms)..=to.div_euclid(bucket_ms) {
        let overlap = (to.min((bucket + 1) * bucket_ms) - from.max(bucket * bucket_ms)).max(0);
        if overlap > 0 {
            *into.entry(bucket).or_default() += amount * overlap as f64 / span;
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NodeKind {
    Thread,
    /// A T3-started child thread with its own scope, measured exactly.
    Delegated,
    /// A provider subagent inside its parent's process; only an estimate is possible.
    Native,
}

#[derive(Debug, Clone, Serialize)]
pub struct Node {
    pub kind: NodeKind,
    pub thread_id: Option<String>,
    pub title: Option<String>,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub status: Option<String>,
    pub started_ms: Option<i64>,
    pub completed_ms: Option<i64>,
    pub measured: Option<Usage>,
    /// For native subagents: the parent's CPU in each sample split evenly among the parent and the subagents active
    /// at that moment.
    pub estimated_cpu_usec: Option<u64>,
    /// For a thread with native subagents: its measured CPU minus their estimates.
    pub own_cpu_usec_estimate: Option<u64>,
    /// For the root thread: cost per turn (one user request and the agent's work on it).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub turns: Vec<TurnUsage>,
    /// Scopes that served this thread and others at once, such as Codex's single app-server. Their cost cannot be
    /// split per thread, so it is shown for context and left out of every total.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub shared: Vec<SharedScope>,
    #[serde(skip)]
    pub units: Vec<Unit>,
    pub children: Vec<Node>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TurnUsage {
    pub ordinal: i64,
    pub status: String,
    pub started_ms: i64,
    pub completed_ms: Option<i64>,
    /// The thread's own scopes during the turn; delegated threads are reported in their own nodes.
    pub usage: Option<Usage>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SharedScope {
    pub provider: Option<String>,
    /// Threads seen in the scope's processes over its life.
    pub threads: usize,
    /// The whole scope's cost while this thread used it.
    pub usage: Option<Usage>,
}

fn turns(store: &Store, t3: &T3, thread_id: &str, units: &[Unit]) -> rusqlite::Result<Vec<TurnUsage>> {
    let mut out = Vec::new();
    for run in t3.runs(thread_id) {
        let Some(started) = run.requested_ms else {
            continue;
        };
        let window = Window {
            from_ms: started,
            to_ms: run.completed_ms.unwrap_or(i64::MAX / 4),
        };
        out.push(TurnUsage {
            ordinal: run.ordinal,
            status: run.status,
            started_ms: started,
            completed_ms: run.completed_ms,
            usage: usage(store, units, window)?,
        });
    }
    Ok(out)
}

/// Whether two readings are consecutive samples rather than the two sides of a gap. While tick records exist (the
/// last seven days), readings are consecutive when at most 2.5 intervals apart, the interval in effect taken from the
/// tick at or before the later one. Older readings come from rollups, where gaps inside a minute are no longer visible,
/// so only `GAP_CAP_MS` applies.
pub(crate) struct Continuity(Vec<(i64, i64)>);

impl Continuity {
    pub(crate) fn load(store: &Store, window: Window) -> rusqlite::Result<Self> {
        Ok(Self(
            store
                .ticks(window.from_ms, window.to_ms)?
                .into_iter()
                .map(|t| (t.ts_ms, t.interval_ms))
                .collect(),
        ))
    }

    pub(crate) fn continuous(&self, from: i64, to: i64) -> bool {
        let index = self.0.partition_point(|(ts, _)| *ts <= to);
        consecutive(to - from, index.checked_sub(1).map(|i| self.0[i].1))
    }
}

/// Whether readings `gap_ms` apart are consecutive samples, given the sampling interval in effect, if known.
fn consecutive(gap_ms: i64, interval_ms: Option<i64>) -> bool {
    match interval_ms {
        Some(interval) => gap_ms * 2 <= interval * 5,
        None => gap_ms <= GAP_CAP_MS,
    }
}

/// Split a parent's CPU among native subagents by overlap. Returns one estimate per window, in order.
fn estimate_native(
    store: &Store,
    parent_units: &[Unit],
    windows: &[(i64, Option<i64>)],
    window: Window,
) -> rusqlite::Result<Vec<u64>> {
    let mut estimates = vec![0.0_f64; windows.len()];
    if windows.is_empty() {
        return Ok(Vec::new());
    }
    let continuity = Continuity::load(store, window)?;
    for unit in parent_units {
        let points = store.points(unit.unit_id, window.from_ms, window.to_ms)?;
        // Intervals across sampler downtime are not split: when the CPU was used inside them is unknown, so it stays
        // in the parent's estimate.
        for pair in points
            .windows(2)
            .filter(|p| continuity.continuous(p[0].ts_ms, p[1].ts_ms))
        {
            let delta = pair[1]
                .cpu_usec
                .unwrap_or(0)
                .saturating_sub(pair[0].cpu_usec.unwrap_or(0)) as f64;
            let mid = (pair[0].ts_ms + pair[1].ts_ms) / 2;
            let active: Vec<usize> = windows
                .iter()
                .enumerate()
                .filter(|(_, (start, end))| *start <= mid && mid <= end.unwrap_or(i64::MAX))
                .map(|(index, _)| index)
                .collect();
            let share = delta / (active.len() + 1) as f64;
            for index in active {
                estimates[index] += share;
            }
        }
    }
    Ok(estimates.into_iter().map(|e| e.round() as u64).collect())
}

fn build_node(
    store: &Store,
    t3: Option<&T3>,
    thread_id: &str,
    kind: NodeKind,
    window: Window,
    seen: &mut HashSet<String>,
) -> rusqlite::Result<Node> {
    seen.insert(thread_id.to_owned());
    let info = t3.and_then(|t| t.thread(thread_id));
    let units = store.units_for_thread(thread_id)?;
    let measured = usage(store, &units, window)?;
    let mut node = Node {
        kind,
        thread_id: Some(thread_id.to_owned()),
        title: info.as_ref().and_then(|i| i.title.clone()),
        provider: info
            .as_ref()
            .and_then(|i| i.provider.clone())
            .or_else(|| units.first().and_then(|u| u.provider.clone())),
        model: None,
        status: None,
        started_ms: measured.as_ref().map(|m| m.first_ms),
        completed_ms: measured.as_ref().map(|m| m.last_ms),
        measured,
        estimated_cpu_usec: None,
        own_cpu_usec_estimate: None,
        turns: Vec::new(),
        shared: Vec::new(),
        units,
        children: Vec::new(),
    };
    let runs = t3.map(|t| t.runs(thread_id)).unwrap_or_default();
    for shared in store.shared_units_for_thread(thread_id)? {
        node.shared.push(shared_scope(store, &shared, &runs, window)?);
    }
    let Some(t3) = t3 else {
        return Ok(node);
    };
    if kind == NodeKind::Thread {
        node.turns = turns(store, t3, thread_id, &node.units)?;
    }
    let children = t3.children(thread_id);
    let natives: Vec<_> = children
        .iter()
        .filter(|c| c.origin == ChildOrigin::ProviderNative && c.started_ms.is_some())
        .collect();
    let windows: Vec<(i64, Option<i64>)> = natives
        .iter()
        .map(|c| (c.started_ms.unwrap_or(0), c.completed_ms))
        .collect();
    let estimates = estimate_native(store, &node.units, &windows, window)?;
    let mut native_total = 0;
    let mut native_nodes = Vec::new();
    for child in &children {
        match child.origin {
            ChildOrigin::ProviderNative => {
                // Natives without a start time were not estimated.
                let Some(index) = natives.iter().position(|n| std::ptr::eq(*n, child)) else {
                    continue;
                };
                let native = natives[index];
                // With no scope of the parent's own, as for a thread that ran only in a shared scope, there is no
                // attributable CPU to split, so the estimate is unknown rather than zero.
                let estimate = (!node.units.is_empty()).then(|| estimates[index]);
                native_total += estimate.unwrap_or(0);
                let native_node = Node {
                    kind: NodeKind::Native,
                    thread_id: native.child_thread_id.clone(),
                    title: native.title.clone(),
                    provider: Some(native.provider.clone()),
                    model: native.model.clone(),
                    status: Some(native.status.clone()),
                    started_ms: native.started_ms,
                    completed_ms: native.completed_ms,
                    measured: None,
                    estimated_cpu_usec: estimate,
                    own_cpu_usec_estimate: None,
                    turns: Vec::new(),
                    shared: Vec::new(),
                    units: Vec::new(),
                    children: Vec::new(),
                };
                native_nodes.push((native.subagent_id.clone(), native.parent_node_id.clone(), native_node));
            }
            ChildOrigin::AppOwned => {
                let Some(child_id) = &child.child_thread_id else {
                    continue;
                };
                if seen.contains(child_id) {
                    continue;
                }
                let mut sub = build_node(store, Some(t3), child_id, NodeKind::Delegated, window, seen)?;
                sub.title = sub.title.or_else(|| child.title.clone());
                sub.model = child.model.clone();
                sub.status = Some(child.status.clone());
                sub.started_ms = child.started_ms.or(sub.started_ms);
                sub.completed_ms = child.completed_ms.or(sub.completed_ms);
                node.children.push(sub);
            }
        }
    }
    node.children.extend(nest_natives(native_nodes));
    node.children.sort_by_key(|c| c.started_ms.unwrap_or(i64::MAX));
    if !natives.is_empty()
        && let Some(measured) = &node.measured
    {
        node.own_cpu_usec_estimate = Some(measured.cpu_usec.saturating_sub(native_total));
    }
    Ok(node)
}

/// Place native subagents under the native subagent that started them. Each keeps its own estimate, made across
/// every native active in the scope. A subagent whose parent is not a native, or that sits in a cycle, is top level.
fn nest_natives(pool: Vec<(String, Option<String>, Node)>) -> Vec<Node> {
    type ByParent = HashMap<Option<String>, Vec<(String, Node)>>;
    fn attach(key: Option<String>, by_parent: &mut ByParent) -> Vec<Node> {
        let Some(list) = by_parent.remove(&key) else {
            return Vec::new();
        };
        list.into_iter()
            .map(|(id, mut node)| {
                node.children = attach(Some(id), by_parent);
                node
            })
            .collect()
    }
    let ids: HashSet<String> = pool.iter().map(|(id, ..)| id.clone()).collect();
    let mut by_parent: ByParent = HashMap::new();
    for (id, parent, node) in pool {
        let key = parent.filter(|p| ids.contains(p) && *p != id);
        by_parent.entry(key).or_default().push((id, node));
    }
    let mut top = attach(None, &mut by_parent);
    top.extend(by_parent.into_values().flatten().map(|(_, node)| node));
    top
}

/// A shared scope's cost while the thread used it: from its first turn, or when it was first seen in the scope, to its
/// last turn's end or when it was last seen.
fn shared_scope(
    store: &Store,
    shared: &SharedUse,
    runs: &[crate::t3::Run],
    window: Window,
) -> rusqlite::Result<SharedScope> {
    let from = runs
        .iter()
        .filter_map(|r| r.requested_ms)
        .chain([shared.first_seen_ms])
        .min()
        .unwrap_or(shared.first_seen_ms);
    let to = runs
        .iter()
        .map(|r| r.completed_ms.unwrap_or(shared.unit.last_seen_ms))
        .chain([shared.last_seen_ms])
        .max()
        .unwrap_or(shared.last_seen_ms);
    let used = Window {
        from_ms: from.max(window.from_ms),
        to_ms: to.min(window.to_ms),
    };
    Ok(SharedScope {
        provider: shared.unit.provider.clone(),
        threads: shared.threads,
        usage: usage(store, std::slice::from_ref(&shared.unit), used)?,
    })
}

pub(crate) fn collect_units(node: &Node, into: &mut Vec<Unit>) {
    into.extend(node.units.iter().cloned());
    for child in &node.children {
        collect_units(child, into);
    }
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct Total {
    pub scopes: usize,
    /// Some scope's CPU covers only the sampled part of the window.
    pub cpu_partial: bool,
    pub first_ms: i64,
    pub last_ms: i64,
    pub wall_ms: i64,
    pub cpu_usec: u64,
    pub avg_cores: f64,
    pub peak_cores: f64,
    /// Highest sum of resident memory across the tree's scopes at one time.
    pub concurrent_resident_peak: f64,
    pub resident_gib_hours: f64,
    pub concurrent_vram_peak: Option<f64>,
    pub vram_gib_hours: Option<f64>,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct Baseline {
    pub cpu_count: usize,
    pub mem_total: Option<u64>,
    pub vram_total: Option<u64>,
    pub busy_cores_avg: f64,
    pub busy_cores_peak: f64,
    pub mem_used_avg: f64,
    pub mem_used_max: u64,
    pub vram_used_avg: f64,
    pub vram_used_max: u64,
    pub gpu_util_avg: Option<f64>,
    pub gpu_power_w_avg: Option<f64>,
    pub machine_cpu_usec: u64,
    pub all_agents_cpu_usec: u64,
    pub t3_app_cpu_usec: u64,
    /// Machine CPU not spent in any T3 agent scope or the T3 app.
    pub other_cpu_usec: u64,
    /// This task tree's CPU as a fraction of all machine CPU in the window.
    pub task_share: Option<f64>,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct Overhead {
    /// Whether the numbers come from the sampler's own systemd cgroup; otherwise from the process's rusage.
    pub from_cgroup: bool,
    pub cpu_usec: u64,
    pub avg_cores: f64,
    /// The sampler's CPU as a fraction of all machine CPU in the window.
    pub share_of_machine: Option<f64>,
    /// Highest resident memory, without reclaimable file cache.
    pub mem_max: u64,
    pub ticks: usize,
    pub tick_p50_us: i64,
    pub tick_p99_us: i64,
    pub tick_max_us: i64,
    pub lag_max_ms: i64,
    pub interval_max_ms: i64,
    /// Ticks that came more than 2.5 intervals after the previous one: downtime or starvation.
    pub gaps: usize,
    pub db_bytes: u64,
    pub write_bytes: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Report {
    /// The span the sampler saw, which charts, the baseline, and overhead cover. `None` when nothing was sampled.
    pub window: Option<Window>,
    pub root: Node,
    pub total: Total,
    pub machine: Option<Baseline>,
    pub sampler: Option<Overhead>,
    pub notes: Vec<String>,
}

fn sum_cpu(store: &Store, units: &[Unit], window: Window) -> rusqlite::Result<u64> {
    let mut total = 0;
    for unit in units {
        total += unit_cpu(store, unit, window)?.map_or(0, |cpu| cpu.usec);
    }
    Ok(total)
}

/// CPU a unit used inside a window.
#[derive(Debug, Clone, Copy)]
struct Cpu {
    usec: u64,
    /// A boundary fell in a stretch without readings and was moved inward to the nearest reading.
    partial: bool,
}

/// CPU a unit used inside the window: its cumulative counter at the window's end minus at its start. `None` when the
/// window holds no reading and cannot be interpolated, as for a window inside sampler downtime.
fn unit_cpu(store: &Store, unit: &Unit, window: Window) -> rusqlite::Result<Option<Cpu>> {
    // A window that ends before the cgroup existed says nothing about it.
    if unit.kind != UnitKind::Machine && window.to_ms <= unit.start_ms() {
        return Ok(None);
    }
    let start = boundary(store, unit, window.from_ms, true)?;
    let end = boundary(store, unit, window.to_ms, false)?;
    Ok(match (start, end) {
        (Some((t0, c0, p0)), Some((t1, c1, p1))) if t0 <= t1 => Some(Cpu {
            usec: c1.saturating_sub(c0),
            partial: p0 || p1,
        }),
        _ => None,
    })
}

/// A unit's cumulative CPU counter at a window boundary, as `(time, value, moved)`.
///
/// A cgroup's counter is zero when it is created, so at or before creation it is zero, which counts time before the
/// sampler first saw it. Between two consecutive readings (see `consecutive`) it is interpolated. Inside a gap, when
/// the CPU was used is unknown, so the boundary moves inward to the reading on the window's side and is marked moved.
/// Past the last reading the counter holds its last value. The machine counter runs since boot, so before its first
/// reading the window starts there.
fn boundary(store: &Store, unit: &Unit, ts: i64, is_start: bool) -> rusqlite::Result<Option<(i64, u64, bool)>> {
    let created = (unit.kind != UnitKind::Machine).then(|| unit.start_ms());
    if created.is_some_and(|c| ts <= c) {
        return Ok(Some((ts, 0, false)));
    }
    let before = store
        .cpu_near(unit.unit_id, ts, false)?
        .or_else(|| created.map(|c| (c, 0)));
    let after = store.cpu_near(unit.unit_id, ts, true)?;
    Ok(match (before, after) {
        (Some((t0, c0)), Some((t1, c1))) if consecutive(t1 - t0, store.interval_at(t1)?) => {
            let fraction = if t1 > t0 {
                (ts - t0) as f64 / (t1 - t0) as f64
            } else {
                0.0
            };
            Some((ts, c0 + (c1.saturating_sub(c0) as f64 * fraction).round() as u64, false))
        }
        // An end that would move back to the creation point has no reading on its side: nothing was sampled.
        (Some((t0, _)), Some(_)) if !is_start && created == Some(t0) => None,
        (Some((t0, c0)), Some((t1, c1))) => Some(if is_start { (t1, c1, true) } else { (t0, c0, true) }),
        // Past the last reading: a window starting here holds nothing; one ending here ends at that reading.
        (Some((t0, c0)), None) => Some(if is_start { (ts, c0, false) } else { (t0, c0, false) }),
        // Before the first machine reading: a window starting here starts at it; one ending here holds nothing.
        (None, Some((t1, c1))) => Some(if is_start { (t1, c1, false) } else { (ts, c1, false) }),
        (None, None) => None,
    })
}

fn meta_number<T: std::str::FromStr>(store: &Store, key: &str) -> Option<T> {
    store.meta(key).ok().flatten().and_then(|v| v.parse().ok())
}

/// The machine over the part of `window` it was sampled in, and how that time split between `task` scopes, all T3
/// agents, the T3 app, and everything else. Every share is a difference over that same sampled span.
pub fn baseline(store: &Store, window: Window, task: &[Unit]) -> rusqlite::Result<Option<Baseline>> {
    let machines = store.units_overlapping(UnitKind::Machine, window.from_ms, window.to_ms)?;
    if machines.is_empty() {
        return Ok(None);
    }
    let mut base = Baseline {
        cpu_count: meta_number(store, "cpu_count").unwrap_or(1),
        mem_total: meta_number(store, "mem_total"),
        vram_total: meta_number(store, "vram_total"),
        ..Baseline::default()
    };
    let mut first = i64::MAX;
    let mut last = i64::MIN;
    let mut mem_ms = 0.0;
    let mut vram_ms = 0.0;
    let mut util = (0.0, 0);
    let mut power = (0.0, 0);
    for unit in &machines {
        let points = store.points(unit.unit_id, window.from_ms, window.to_ms)?;
        for (index, point) in points.iter().enumerate() {
            first = first.min(point.ts_ms);
            last = last.max(point.ts_ms);
            base.mem_used_max = base.mem_used_max.max(point.resident_max);
            base.vram_used_max = base.vram_used_max.max(point.vram_max.unwrap_or(0));
            if let Some(u) = point.gpu_util_avg {
                util = (util.0 + u, util.1 + 1);
            }
            if let Some(p) = point.gpu_power_mw_avg {
                power = (power.0 + p, power.1 + 1);
            }
            if index > 0 {
                let dt = (point.ts_ms - points[index - 1].ts_ms).clamp(0, GAP_CAP_MS) as f64;
                mem_ms += point.resident_avg * dt;
                vram_ms += point.vram_avg.unwrap_or(0.0) * dt;
            }
        }
    }
    // Nothing to compare over when the window holds fewer than two machine readings.
    if last <= first {
        return Ok(None);
    }
    let wall = (last - first) as f64;
    // Every share below is a difference over this same span.
    let span = Window {
        from_ms: first,
        to_ms: last,
    };
    base.machine_cpu_usec = sum_cpu(store, &machines, span)?;
    base.busy_cores_avg = base.machine_cpu_usec as f64 / 1000.0 / wall;
    base.mem_used_avg = mem_ms / wall;
    base.vram_used_avg = vram_ms / wall;
    let bucket = ((wall / 300.0) as i64).max(2_000);
    base.busy_cores_peak = series(store, &machines, span, bucket)?
        .iter()
        .map(|b| b.cores)
        .fold(0.0, f64::max)
        .min(base.cpu_count as f64);
    base.gpu_util_avg = (util.1 > 0).then(|| util.0 / f64::from(util.1));
    base.gpu_power_w_avg = (power.1 > 0).then(|| power.0 / f64::from(power.1) / 1000.0);
    base.all_agents_cpu_usec = sum_cpu(store, &store.units_overlapping(UnitKind::Agent, first, last)?, span)?;
    base.t3_app_cpu_usec = sum_cpu(store, &store.units_overlapping(UnitKind::App, first, last)?, span)?;
    base.other_cpu_usec = base
        .machine_cpu_usec
        .saturating_sub(base.all_agents_cpu_usec + base.t3_app_cpu_usec);
    base.task_share = (!task.is_empty() && base.machine_cpu_usec > 0)
        .then(|| sum_cpu(store, task, span))
        .transpose()?
        .map(|cpu| cpu as f64 / base.machine_cpu_usec as f64);
    Ok(Some(base))
}

fn percentile(sorted: &[i64], fraction: f64) -> i64 {
    if sorted.is_empty() {
        return 0;
    }
    let index = ((sorted.len() - 1) as f64 * fraction).round() as usize;
    sorted[index.min(sorted.len() - 1)]
}

pub fn overhead(store: &Store, window: Window, machine_cpu: Option<u64>) -> rusqlite::Result<Option<Overhead>> {
    let ticks: Vec<TickRow> = store.ticks(window.from_ms, window.to_ms)?;
    if ticks.is_empty() {
        return Ok(None);
    }
    let span = Window {
        from_ms: ticks[0].ts_ms,
        to_ms: ticks[ticks.len() - 1].ts_ms,
    };
    let wall = (span.to_ms - span.from_ms).max(1) as f64;
    let services = store.units_overlapping(UnitKind::Sampler, span.from_ms, span.to_ms)?;
    let mut over = Overhead {
        ticks: ticks.len(),
        ..Overhead::default()
    };
    if services.is_empty() {
        // A foreground run: its process counters reset when it restarts, so sum the non-negative steps.
        over.cpu_usec = ticks
            .windows(2)
            .map(|p| p[1].self_cpu_usec.saturating_sub(p[0].self_cpu_usec))
            .sum();
        over.mem_max = ticks.iter().map(|t| t.self_rss).max().unwrap_or(0);
    } else {
        over.from_cgroup = true;
        over.cpu_usec = sum_cpu(store, &services, span)?;
        if let Some(u) = usage(store, &services, span)? {
            over.mem_max = u.resident_max;
        }
    }
    over.avg_cores = over.cpu_usec as f64 / 1000.0 / wall;
    over.share_of_machine = machine_cpu.filter(|m| *m > 0).map(|m| over.cpu_usec as f64 / m as f64);
    let mut durations: Vec<i64> = ticks.iter().map(|t| t.duration_us).collect();
    durations.sort_unstable();
    over.tick_p50_us = percentile(&durations, 0.5);
    over.tick_p99_us = percentile(&durations, 0.99);
    over.tick_max_us = durations.last().copied().unwrap_or(0);
    over.lag_max_ms = ticks.iter().map(|t| t.lag_ms).max().unwrap_or(0);
    over.interval_max_ms = ticks.iter().map(|t| t.interval_ms).max().unwrap_or(0);
    over.gaps = ticks
        .windows(2)
        .filter(|p| (p[1].ts_ms - p[0].ts_ms) as f64 > p[0].interval_ms as f64 * 2.5)
        .count();
    over.db_bytes = ticks.last().map_or(0, |t| t.db_bytes);
    // Process counters restart with the process, so sum the non-negative steps.
    over.write_bytes = ticks.iter().any(|t| t.self_write_bytes.is_some()).then(|| {
        ticks
            .windows(2)
            .filter_map(|p| Some(p[1].self_write_bytes?.saturating_sub(p[0].self_write_bytes?)))
            .sum()
    });
    Ok(Some(over))
}

pub fn report(store: &Store, t3: Option<&T3>, thread_id: &str, window: Window) -> rusqlite::Result<Report> {
    let mut seen = HashSet::new();
    let root = build_node(store, t3, thread_id, NodeKind::Thread, window, &mut seen)?;
    let mut units = Vec::new();
    collect_units(&root, &mut units);
    let mut notes = Vec::new();
    if t3.is_none() {
        notes.push("T3 state database not found: child threads and subagents are not shown.".to_owned());
    }
    if has_shared(&root) {
        notes.push(
            "Some threads ran in a shared scope, such as Codex's single app-server for all Codex threads. Its cost \
             cannot be split per thread, so it is shown for context and left out of the totals."
                .to_owned(),
        );
    }
    let measured = usage(store, &units, window)?;
    // Charts, the baseline, and overhead cover the time the sampler saw; the totals cover each scope's lifetime. A
    // thread that ran only in shared scopes has no totals, but the time it used them still sets the context window.
    let span = match (&measured, shared_span(&root)) {
        (Some(m), _) => Window {
            from_ms: m.first_sample_ms,
            to_ms: m.last_ms,
        },
        (None, Some(span)) => span,
        (None, None) => {
            notes.push(format!(
                "No samples recorded for thread {thread_id} or its child threads."
            ));
            return Ok(Report {
                window: None,
                root,
                total: Total::default(),
                machine: None,
                sampler: None,
                notes,
            });
        }
    };
    let machine = baseline(store, span, &units)?;
    let sampler = overhead(store, span, machine.as_ref().map(|m| m.machine_cpu_usec))?;
    let total = match &measured {
        Some(measured) => task_total(store, &units, span, measured)?,
        None => Total::default(),
    };
    if has_native(&root) {
        notes.push(
            "Native subagents run inside their parent's process; their CPU is an estimate and their memory is the \
             parent's."
                .to_owned(),
        );
    }
    Ok(Report {
        window: Some(span),
        root,
        total,
        machine,
        sampler,
        notes,
    })
}

/// The time shared scopes were used across the tree, from their sampled usage.
fn shared_span(node: &Node) -> Option<Window> {
    let own = node.shared.iter().filter_map(|s| s.usage.as_ref()).map(|u| Window {
        from_ms: u.first_sample_ms,
        to_ms: u.last_ms,
    });
    own.chain(node.children.iter().filter_map(shared_span))
        .reduce(|a, b| Window {
            from_ms: a.from_ms.min(b.from_ms),
            to_ms: a.to_ms.max(b.to_ms),
        })
}

fn task_total(store: &Store, units: &[Unit], span: Window, measured: &Usage) -> rusqlite::Result<Total> {
    let bucket = ((span.to_ms - span.from_ms) / 300).max(2_000);
    let buckets = series(store, units, span, bucket)?;
    Ok(Total {
        scopes: measured.scopes,
        cpu_partial: measured.cpu_partial,
        first_ms: measured.first_ms,
        last_ms: measured.last_ms,
        wall_ms: measured.wall_ms,
        cpu_usec: measured.cpu_usec,
        avg_cores: measured.avg_cores,
        peak_cores: buckets.iter().map(|b| b.cores).fold(0.0, f64::max),
        // Bucket means can sit below a single sample's maximum; the peak is at least the largest one scope reached.
        concurrent_resident_peak: buckets
            .iter()
            .map(|b| b.resident)
            .fold(measured.resident_max as f64, f64::max),
        resident_gib_hours: measured.resident_gib_hours,
        concurrent_vram_peak: buckets
            .iter()
            .filter_map(|b| b.vram)
            .chain(measured.vram_max.map(|v| v as f64))
            .reduce(f64::max),
        vram_gib_hours: measured.vram_gib_hours,
    })
}

fn has_shared(node: &Node) -> bool {
    !node.shared.is_empty() || node.children.iter().any(has_shared)
}

fn has_native(node: &Node) -> bool {
    node.children
        .iter()
        .any(|c| c.kind == NodeKind::Native || has_native(c))
}

/// Recent threads and their measured totals, newest first.
#[derive(Debug, Clone, Serialize)]
pub struct ThreadSummary {
    pub thread_id: String,
    pub title: Option<String>,
    pub first_ms: i64,
    pub last_ms: i64,
    pub usage: Option<Usage>,
}

pub fn recent(store: &Store, limit: usize) -> rusqlite::Result<Vec<ThreadSummary>> {
    let mut t3_by_home: HashMap<String, Option<T3>> = HashMap::new();
    let mut out = Vec::new();
    for row in store.recent_threads(limit)? {
        let thread_id = row.thread_id;
        let home = crate::t3::resolve_home(row.t3_home.as_deref());
        let t3 = t3_by_home
            .entry(home.to_string_lossy().into_owned())
            .or_insert_with(|| T3::open(&home).ok());
        let units = store.units_for_thread(&thread_id)?;
        out.push(ThreadSummary {
            title: t3.as_ref().and_then(|t| t.thread(&thread_id)).and_then(|i| i.title),
            usage: usage(store, &units, Window::ALL)?,
            thread_id,
            first_ms: row.first_seen_ms,
            last_ms: row.last_seen_ms,
        });
    }
    Ok(out)
}

/// Sampler health over the last few minutes, with the reasons it is unhealthy.
#[derive(Debug, Clone, Serialize)]
pub struct Health {
    pub running: bool,
    pub last_tick_age_ms: Option<i64>,
    pub interval_ms: Option<i64>,
    pub configured_interval_ms: Option<i64>,
    pub live_scopes: usize,
    pub overhead: Option<Overhead>,
    pub problems: Vec<String>,
    /// Whether the service's installed binary is this command's build. None when no binary is installed.
    pub installed_current: Option<bool>,
}

/// Limits for `status`. The service's systemd limits (CPUQuota, MemoryMax) are the hard stop; these flag a sampler
/// that is costing more than it should well before it reaches them.
pub const MAX_AVG_CORES: f64 = 0.01;
pub const MAX_TICK_P99_US: i64 = 250_000;
pub const MAX_LAG_MS: i64 = 2_000;
pub const MAX_MEM_BYTES: u64 = 48 * 1024 * 1024;
pub const MAX_DB_BYTES: u64 = 2 * 1024 * 1024 * 1024;

impl Health {
    /// The result for a database that does not exist yet.
    pub fn never_ran(db: &std::path::Path) -> Self {
        Self {
            running: false,
            last_tick_age_ms: None,
            interval_ms: None,
            configured_interval_ms: None,
            live_scopes: 0,
            overhead: None,
            problems: vec![format!(
                "no database at {}; the sampler has never run with it. Install it with `session-resources install`",
                db.display()
            )],
            installed_current: None,
        }
    }
}

pub fn health(store: &Store, now_ms: i64, lookback_ms: i64) -> rusqlite::Result<Health> {
    let last = store.last_tick()?;
    let configured: Option<i64> = meta_number(store, "interval_ms");
    let age = last.map(|t| now_ms - t.ts_ms);
    // Ticks become visible when the sampler commits, so the newest can be a full flush period old.
    let stale_after = last.map_or(10_000, |t| (t.interval_ms * 3).max(10_000)) + crate::store::FLUSH_EVERY_MS;
    let fresh = age.is_some_and(|a| a <= stale_after);
    // The sampler records its pid and start time, so a stopped one is caught at once instead of after the flush delay.
    let writer: Option<u32> = meta_number(store, "writer_pid");
    let writer_start: Option<u64> = meta_number(store, "writer_start");
    let writer_alive = match (writer, writer_start) {
        (Some(pid), Some(start)) => {
            Some(crate::host::process_start(&crate::host::Roots::default(), pid) == Some(start))
        }
        _ => None,
    };
    // A tick from a previous writer does not show that the current one works.
    let writer_since: Option<i64> = meta_number(store, "writer_started_ms");
    let current = last.zip(writer_since).is_none_or(|(t, since)| t.ts_ms >= since);
    let running = fresh && current && writer_alive != Some(false);
    let window = Window {
        from_ms: now_ms - lookback_ms,
        to_ms: now_ms,
    };
    let machine_cpu = baseline(store, window, &[])?.map(|b| b.machine_cpu_usec);
    let over = overhead(store, window, machine_cpu)?;
    let live_scopes = store
        .units_overlapping(UnitKind::Agent, now_ms - stale_after, now_ms)?
        .iter()
        .filter(|u| u.gone_ms.is_none())
        .count();
    let mut problems = Vec::new();
    if !running {
        problems.push(match (age, writer_alive, writer) {
            (Some(_), Some(false), Some(pid)) => format!("the sampler (pid {pid}) has exited"),
            (Some(_), _, _) if !current => "the sampler restarted and has not recorded a tick yet".to_owned(),
            (Some(a), _, _) => format!("no tick for {}; the sampler is not running or is stalled", duration(a)),
            (None, _, _) => "no ticks recorded; the sampler has never run with this database".to_owned(),
        });
    }
    if let Some(o) = &over {
        if o.avg_cores > MAX_AVG_CORES {
            problems.push(format!(
                "using {:.2}% of a core on average (limit {:.0}%)",
                o.avg_cores * 100.0,
                MAX_AVG_CORES * 100.0
            ));
        }
        if o.tick_p99_us > MAX_TICK_P99_US {
            problems.push(format!(
                "p99 tick took {} ms (limit {} ms)",
                o.tick_p99_us / 1000,
                MAX_TICK_P99_US / 1000
            ));
        }
        if o.lag_max_ms > MAX_LAG_MS {
            problems.push(format!(
                "a tick started {} ms late; the machine was busy enough to starve it, so samples there are coarser",
                o.lag_max_ms
            ));
        }
        if o.mem_max > MAX_MEM_BYTES {
            problems.push(format!(
                "resident memory reached {} (limit {})",
                bytes(o.mem_max as f64),
                bytes(MAX_MEM_BYTES as f64)
            ));
        }
        if o.db_bytes > MAX_DB_BYTES {
            problems.push(format!("database is {}", bytes(o.db_bytes as f64)));
        }
    }
    if let (Some(t), Some(c)) = (last, configured)
        && t.interval_ms > c
    {
        problems.push(format!(
            "backed off to one tick every {} ms (configured {c} ms)",
            t.interval_ms
        ));
    }
    Ok(Health {
        running,
        last_tick_age_ms: age,
        interval_ms: last.map(|t| t.interval_ms),
        configured_interval_ms: configured,
        live_scopes,
        overhead: over,
        problems,
        installed_current: None,
    })
}

// ---- Text formatting ----

pub fn bytes(value: f64) -> String {
    const UNITS: [&str; 5] = ["B", "KiB", "MiB", "GiB", "TiB"];
    let mut value = value.max(0.0);
    let mut unit = 0;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{value:.0} B")
    } else {
        format!("{value:.1} {}", UNITS[unit])
    }
}

pub fn duration(ms: i64) -> String {
    let seconds = ms.max(0) / 1000;
    match seconds {
        s if s < 60 => format!("{s}s"),
        s if s < 3600 => format!("{}m{:02}s", s / 60, s % 60),
        s => format!("{}h{:02}m", s / 3600, s % 3600 / 60),
    }
}

pub fn cpu_seconds(usec: u64) -> String {
    let seconds = usec as f64 / 1e6;
    if seconds < 10.0 {
        format!("{seconds:.1}s")
    } else if seconds < 3600.0 {
        format!("{seconds:.0}s")
    } else {
        format!("{:.2}h", seconds / 3600.0)
    }
}

/// CPU time, marked as a lower bound when part of the window had no readings.
pub fn usage_cpu(u: &Usage) -> String {
    format!("{}{}", if u.cpu_partial { "≥" } else { "" }, cpu_seconds(u.cpu_usec))
}

/// A memory figure, or a dash when the window holds no samples to take it from.
pub fn sampled_bytes(u: &Usage, value: f64) -> String {
    if u.samples == 0 { "—".to_owned() } else { bytes(value) }
}

fn percent(fraction: f64) -> String {
    format!("{:.1}%", fraction * 100.0)
}

fn label(node: &Node) -> String {
    let title = node.title.clone().unwrap_or_else(|| {
        node.thread_id
            .as_deref()
            .map(|id| id.chars().take(36).collect())
            .unwrap_or_else(|| "(untitled)".to_owned())
    });
    let mut parts = Vec::new();
    if let Some(p) = &node.provider {
        parts.push(p.clone());
    }
    if let Some(m) = &node.model {
        parts.push(m.clone());
    }
    let kind = match node.kind {
        NodeKind::Thread => "",
        NodeKind::Delegated => "delegated ",
        NodeKind::Native => "native ",
    };
    if parts.is_empty() {
        format!("{kind}{title}")
    } else {
        format!("{kind}{title} [{}]", parts.join(", "))
    }
}

fn render_node(node: &Node, prefix: &str, last: bool, depth: usize, out: &mut String) {
    let branch = if depth == 0 {
        String::new()
    } else if last {
        format!("{prefix}└ ")
    } else {
        format!("{prefix}├ ")
    };
    out.push_str(&format!("{branch}{}\n", label(node)));
    let detail_prefix = if depth == 0 {
        "  ".to_owned()
    } else {
        format!("{prefix}{}  ", if last { " " } else { "│" })
    };
    let child_prefix = if depth == 0 {
        String::new()
    } else {
        format!("{prefix}{}", if last { "  " } else { "│ " })
    };
    match (&node.measured, node.estimated_cpu_usec) {
        (Some(m), _) => {
            out.push_str(&format!(
                "{detail_prefix}wall {}  cpu {} ({:.2} cores avg)  resident avg {} max {}  {:.3} GiB·h  peak with cache {}",
                duration(m.wall_ms),
                usage_cpu(m),
                m.avg_cores,
                if m.sampled_ms > 0 { bytes(m.resident_avg) } else { "—".to_owned() },
                sampled_bytes(m, m.resident_max as f64),
                m.resident_gib_hours,
                sampled_bytes(m, m.mem_peak as f64),
            ));
            if let (Some(peak), Some(hours)) = (m.vram_max.filter(|v| *v > 0), m.vram_gib_hours) {
                out.push_str(&format!("  vram peak {} {hours:.3} GiB·h", bytes(peak as f64)));
            }
            out.push_str(&format!("  procs≤{}  scopes {}\n", m.pids_max, m.scopes));
            if let Some(own) = node.own_cpu_usec_estimate {
                out.push_str(&format!(
                    "{detail_prefix}own cpu after native subagents ~{}\n",
                    cpu_seconds(own)
                ));
            }
        }
        (None, estimate) if node.kind == NodeKind::Native => {
            let wall = match (node.started_ms, node.completed_ms) {
                (Some(a), Some(b)) => duration(b - a),
                (Some(_), None) => "running".to_owned(),
                _ => "?".to_owned(),
            };
            let cpu = estimate.map_or_else(
                || "unknown (no measured parent scope)".to_owned(),
                |e| format!("~{} (estimated share of parent)", cpu_seconds(e)),
            );
            out.push_str(&format!(
                "{detail_prefix}wall {wall}  cpu {cpu}  memory shared with parent\n"
            ));
        }
        (None, _) if node.shared.is_empty() => out.push_str(&format!("{detail_prefix}no samples\n")),
        (None, _) => {}
    }
    for shared in &node.shared {
        let provider = shared.provider.as_deref().unwrap_or("agent");
        let serving = match shared.threads {
            1 => "1 thread".to_owned(),
            n => format!("{n} threads"),
        };
        match &shared.usage {
            Some(u) => out.push_str(&format!(
                "{detail_prefix}shared {provider} scope serving {serving}: cpu {} resident max {} while this thread used \
                 it (not in totals)\n",
                usage_cpu(u),
                sampled_bytes(u, u.resident_max as f64),
            )),
            None => out.push_str(&format!(
                "{detail_prefix}shared {provider} scope serving {serving}: no samples\n"
            )),
        }
    }
    let count = node.children.len();
    for (index, child) in node.children.iter().enumerate() {
        render_node(child, &child_prefix, index + 1 == count, depth + 1, out);
    }
}

/// Turns shown in text; JSON has all of them.
const TEXT_TURNS: usize = 15;

fn render_turns(turns: &[TurnUsage], out: &mut String) {
    let measured: Vec<&TurnUsage> = turns.iter().filter(|t| t.usage.is_some()).collect();
    if measured.is_empty() {
        return;
    }
    out.push_str("\nTurns (this thread's own scopes)\n");
    if measured.len() > TEXT_TURNS {
        out.push_str(&format!(
            "  … {} earlier turns in --json\n",
            measured.len() - TEXT_TURNS
        ));
    }
    for turn in measured.iter().skip(measured.len().saturating_sub(TEXT_TURNS)) {
        let Some(u) = &turn.usage else { continue };
        let wall = turn
            .completed_ms
            .map_or_else(|| "running".to_owned(), |end| duration(end - turn.started_ms));
        out.push_str(&format!(
            "  #{:<4} {}  wall {:>7}  cpu {:>7}  resident max {:>9}  {}\n",
            turn.ordinal,
            crate::parse::ms_to_iso_utc(turn.started_ms),
            wall,
            usage_cpu(u),
            sampled_bytes(u, u.resident_max as f64),
            turn.status,
        ));
    }
}

pub fn render_text(report: &Report) -> String {
    let mut out = String::new();
    render_node(&report.root, "", true, 0, &mut out);
    render_turns(&report.root.turns, &mut out);
    let t = &report.total;
    if t.scopes > 0 {
        out.push_str(&format!(
            "\nTask total ({} scopes, {} → {}, {}; sampled from {})\n  cpu {}{} ({:.2} cores avg, {:.2} peak)  resident peak {} (concurrent)  {:.3} GiB·h",
            t.scopes,
            crate::parse::ms_to_iso_utc(t.first_ms),
            crate::parse::ms_to_iso_utc(t.last_ms),
            duration(t.wall_ms),
            report
                .window
                .map_or_else(|| "?".to_owned(), |w| crate::parse::ms_to_iso_utc(w.from_ms)),
            if t.cpu_partial { "≥" } else { "" },
            cpu_seconds(t.cpu_usec),
            t.avg_cores,
            t.peak_cores,
            bytes(t.concurrent_resident_peak),
            t.resident_gib_hours,
        ));
        if let (Some(peak), Some(hours)) = (t.concurrent_vram_peak.filter(|v| *v > 0.0), t.vram_gib_hours) {
            out.push_str(&format!("  vram peak {} {hours:.3} GiB·h", bytes(peak)));
        }
        out.push('\n');
    }
    if let Some(m) = &report.machine {
        out.push_str(&format!(
            "\nMachine over the same window ({} CPUs{}{})\n  cpu busy {:.2} cores avg, {:.2} peak  mem used avg {} max {}",
            m.cpu_count,
            m.mem_total.map(|v| format!(", {} RAM", bytes(v as f64))).unwrap_or_default(),
            m.vram_total.map(|v| format!(", {} VRAM", bytes(v as f64))).unwrap_or_default(),
            m.busy_cores_avg,
            m.busy_cores_peak,
            bytes(m.mem_used_avg),
            bytes(m.mem_used_max as f64),
        ));
        if m.vram_total.is_some() {
            out.push_str(&format!(
                "  vram avg {} max {}",
                bytes(m.vram_used_avg),
                bytes(m.vram_used_max as f64)
            ));
        }
        if let Some(u) = m.gpu_util_avg {
            out.push_str(&format!("  gpu {u:.0}%"));
        }
        if let Some(p) = m.gpu_power_w_avg {
            out.push_str(&format!(" {p:.0} W"));
        }
        out.push_str(&format!(
            "\n  busy cpu split: all T3 agents {} (this task {})  T3 app {}  everything else {}\n",
            share(m.all_agents_cpu_usec, m.machine_cpu_usec),
            m.task_share.map(percent).unwrap_or_else(|| "?".to_owned()),
            share(m.t3_app_cpu_usec, m.machine_cpu_usec),
            share(m.other_cpu_usec, m.machine_cpu_usec),
        ));
    }
    if let Some(o) = &report.sampler {
        out.push_str(&format!("\n{}", render_overhead(o)));
    }
    for note in &report.notes {
        out.push_str(&format!("\nNote: {note}"));
    }
    if !report.notes.is_empty() {
        out.push('\n');
    }
    out
}

fn share(part: u64, whole: u64) -> String {
    if whole == 0 {
        "?".to_owned()
    } else {
        percent(part as f64 / whole as f64)
    }
}

pub fn render_overhead(o: &Overhead) -> String {
    format!(
        "Sampler overhead ({})\n  cpu {} ({:.3}% of a core{})  resident max {}  ticks {} p50 {:.1} ms p99 {:.1} ms max {:.1} ms  lag max {} ms  gaps {}  db {}{}\n",
        if o.from_cgroup {
            "its systemd cgroup"
        } else {
            "process counters"
        },
        cpu_seconds(o.cpu_usec),
        o.avg_cores * 100.0,
        o.share_of_machine
            .map(|s| format!(", {} of busy machine CPU", percent(s)))
            .unwrap_or_default(),
        bytes(o.mem_max as f64),
        o.ticks,
        o.tick_p50_us as f64 / 1000.0,
        o.tick_p99_us as f64 / 1000.0,
        o.tick_max_us as f64 / 1000.0,
        o.lag_max_ms,
        o.gaps,
        bytes(o.db_bytes as f64),
        o.write_bytes
            .map(|w| format!("  wrote {}", bytes(w as f64)))
            .unwrap_or_default(),
    )
}

pub fn render_recent(rows: &[ThreadSummary]) -> String {
    let mut out = String::new();
    for row in rows {
        let title = row.title.clone().unwrap_or_else(|| row.thread_id.clone());
        match &row.usage {
            Some(u) => out.push_str(&format!(
                "{}  {:<48}  wall {:>7}  cpu {:>7}  resident max {:>9}  {:.3} GiB·h\n  {}\n",
                crate::parse::ms_to_iso_utc(row.last_ms),
                title.chars().take(48).collect::<String>(),
                duration(u.wall_ms),
                usage_cpu(u),
                sampled_bytes(u, u.resident_max as f64),
                u.resident_gib_hours,
                row.thread_id,
            )),
            None => out.push_str(&format!(
                "{}  {title}  no samples\n",
                crate::parse::ms_to_iso_utc(row.last_ms)
            )),
        }
    }
    out
}

pub fn render_health(h: &Health) -> String {
    let mut out = format!(
        "Sampler: {}  last tick {}  interval {}  live agent scopes {}\n",
        if h.running { "running" } else { "NOT RUNNING" },
        h.last_tick_age_ms
            .map(|a| format!("{} ago", duration(a)))
            .unwrap_or_else(|| "never".to_owned()),
        h.interval_ms
            .map(|i| format!("{i} ms"))
            .unwrap_or_else(|| "?".to_owned()),
        h.live_scopes,
    );
    if let Some(o) = &h.overhead {
        out.push_str(&render_overhead(o));
    }
    if h.installed_current == Some(false) {
        out.push_str("Note: the service runs a different build than this command. Run `install` to replace it.\n");
    }
    if h.problems.is_empty() {
        out.push_str("Healthy.\n");
    } else {
        for problem in &h.problems {
            out.push_str(&format!("Problem: {problem}\n"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tells_samples_from_gaps() {
        let continuity = Continuity(vec![(0, 2_000), (10_000, 2_000)]);
        assert!(continuity.continuous(8_000, 10_000));
        assert!(!continuity.continuous(2_000, 10_000), "8 s at a 2 s interval is a gap");
        assert!(
            Continuity(Vec::new()).continuous(0, 60_000),
            "rolled-up readings use the one-minute cap"
        );
    }

    #[test]
    fn formats_values() {
        assert_eq!(bytes(1536.0), "1.5 KiB");
        assert_eq!(duration(3_723_000), "1h02m");
        assert_eq!(duration(75_000), "1m15s");
        assert_eq!(cpu_seconds(2_500_000), "2.5s");
        assert_eq!(percentile(&[1, 2, 3, 4, 100], 0.5), 3);
    }
}
