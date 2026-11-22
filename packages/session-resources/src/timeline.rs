//! Chart data for the report page: every sample of the task's scopes on one time axis, the spans in which a scope was
//! alive, the stretches a scope was alive but not sampled, and the marks the samples cannot show. The page script only
//! stacks and formats what this emits.

use crate::host::UnitKind;
use crate::report::{Continuity, GIB, Node, NodeKind, Report, Window, collect_units};
use crate::store::{Point, Store, Unit};
use serde::Serialize;
use std::collections::HashMap;

/// The most rows a chart carries. Longer runs are bucketed so the page stays small.
const MAX_ROWS: usize = 2400;
/// Scopes closer together than this share one span, and the time between them is drawn to scale.
const MERGE_MS: i64 = 60_000;
/// Delegated threads beyond this many fold into one "Other delegated" series.
const MAX_DELEGATED: usize = 5;
const MIB: f64 = 1024.0 * 1024.0;

#[derive(Debug, Clone, Copy, Serialize)]
pub struct Span {
    pub f: i64,
    pub t: i64,
}

#[derive(Debug, Serialize)]
pub struct Series {
    pub label: String,
    /// A `--sr-*` colour token. Context series have none and draw grey.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<&'static str>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub soft: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub dash: bool,
    pub data: Vec<Option<f64>>,
}

/// A value the samples do not show: CPU used before the first sample, or a kernel peak between samples.
#[derive(Debug, Serialize)]
pub struct Mark {
    pub f: i64,
    pub t: i64,
    pub v: f64,
    pub label: String,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub dash: bool,
}

#[derive(Debug, Serialize)]
pub struct Chart {
    pub id: &'static str,
    pub title: &'static str,
    pub sub: &'static str,
    pub unit: &'static str,
    pub peak: bool,
    pub series: Vec<Series>,
    pub context: Vec<Series>,
    pub marks: Vec<Mark>,
}

/// One bar in a lane above the charts.
#[derive(Debug, Clone, Serialize)]
pub struct LaneSpan {
    pub f: i64,
    pub t: i64,
    #[serde(skip)]
    pub label: String,
    pub tip: String,
    #[serde(skip)]
    pub color: &'static str,
    #[serde(skip)]
    pub native: bool,
}

#[derive(Debug, Serialize)]
pub struct Lane {
    #[serde(skip)]
    pub name: &'static str,
    pub spans: Vec<LaneSpan>,
}

#[derive(Debug, Serialize)]
pub struct Timeline {
    pub t: Vec<i64>,
    pub spans: Vec<[i64; 2]>,
    pub range: String,
    pub bands: Vec<Span>,
    pub unsampled: Vec<Span>,
    pub lanes: Vec<Lane>,
    pub charts: Vec<Chart>,
    /// Highest total CPU in any row, so the headline matches the chart.
    #[serde(skip)]
    pub peak_cores: f64,
}

/// Row timestamps shared by every series. Unbucketed rows are the sample times themselves; bucketed rows start each
/// bucket.
struct Grid {
    t: Vec<i64>,
    bucket: Option<i64>,
}

impl Grid {
    fn row(&self, ts: i64) -> Option<usize> {
        let key = self.bucket.map_or(ts, |b| ts.div_euclid(b) * b);
        self.t.binary_search(&key).ok()
    }
}

/// Per-row sums over a set of units.
struct Values {
    cpu: Vec<Option<f64>>,
    resident: Vec<Option<f64>>,
    cache: Vec<Option<f64>>,
    vram: Vec<Option<f64>>,
}

fn add(slot: &mut Option<f64>, value: f64) {
    *slot = Some(slot.unwrap_or(0.0) + value);
}

fn round(value: f64, places: i32) -> f64 {
    let scale = 10f64.powi(places);
    (value * scale).round() / scale
}

fn values(store: &Store, units: &[Unit], window: Window, grid: &Grid, cont: &Continuity) -> rusqlite::Result<Values> {
    let n = grid.t.len();
    let mut out = Values {
        cpu: vec![None; n],
        resident: vec![None; n],
        cache: vec![None; n],
        vram: vec![None; n],
    };
    let mut usec: HashMap<usize, f64> = HashMap::new();
    for unit in units {
        // Per unit and row, the highest reading, so a bucket shows the peak rather than a mean.
        let mut resident: HashMap<usize, f64> = HashMap::new();
        let mut cache: HashMap<usize, f64> = HashMap::new();
        let mut vram: HashMap<usize, f64> = HashMap::new();
        // A cgroup's counter is zero when it is created, so its first reading is a rate from creation when that was
        // recent enough to count as one interval.
        let mut previous = (unit.kind != UnitKind::Machine && unit.created_ms.is_some()).then(|| (unit.start_ms(), 0));
        for point in store.points(unit.unit_id, window.from_ms, window.to_ms)? {
            let row = grid.row(point.ts_ms);
            if let Some(row) = row {
                let keep = |map: &mut HashMap<usize, f64>, v: f64| {
                    let slot = map.entry(row).or_insert(v);
                    *slot = slot.max(v);
                };
                keep(&mut resident, point.resident_max as f64);
                keep(
                    &mut cache,
                    point.mem_current_max.saturating_sub(point.resident_max) as f64,
                );
                if let Some(v) = point.vram_max {
                    keep(&mut vram, v as f64);
                }
            }
            let Some(cpu) = point.cpu_usec else { continue };
            if let Some((t0, c0)) = previous.filter(|(t0, _)| *t0 < point.ts_ms && cont.continuous(*t0, point.ts_ms)) {
                let delta = cpu.saturating_sub(c0) as f64;
                match grid.bucket {
                    None => {
                        if let Some(row) = row {
                            add(&mut out.cpu[row], delta / 1000.0 / (point.ts_ms - t0) as f64);
                        }
                    }
                    Some(b) => {
                        let span = (point.ts_ms - t0) as f64;
                        for key in t0.div_euclid(b)..=point.ts_ms.div_euclid(b) {
                            let overlap = (point.ts_ms.min((key + 1) * b) - t0.max(key * b)).max(0);
                            if let (true, Some(row)) = (overlap > 0, grid.row(key * b)) {
                                *usec.entry(row).or_default() += delta * overlap as f64 / span;
                            }
                        }
                    }
                }
            }
            previous = Some((point.ts_ms, cpu));
        }
        for (map, into) in [
            (resident, &mut out.resident),
            (cache, &mut out.cache),
            (vram, &mut out.vram),
        ] {
            for (row, v) in map {
                add(&mut into[row], v);
            }
        }
    }
    if let Some(b) = grid.bucket {
        for (row, u) in usec {
            add(&mut out.cpu[row], u / 1000.0 / b as f64);
        }
    }
    Ok(out)
}

/// When a unit was alive in the window, as `[start, end]`.
fn life(unit: &Unit, window: Window) -> Option<Span> {
    let f = unit.start_ms().max(window.from_ms);
    let t = unit.gone_ms.unwrap_or(unit.last_seen_ms).min(window.to_ms);
    (t > f).then_some(Span { f, t })
}

/// Stretches a unit was alive without readings: before its first sample and across sampler downtime.
fn gaps(points: &[Point], alive: Span, cont: &Continuity) -> Vec<Span> {
    let Some(first) = points.first() else {
        return vec![alive];
    };
    let mut out = Vec::new();
    if first.ts_ms > alive.f && !cont.continuous(alive.f, first.ts_ms) {
        out.push(Span {
            f: alive.f,
            t: first.ts_ms,
        });
    }
    for pair in points.windows(2) {
        if !cont.continuous(pair[0].ts_ms, pair[1].ts_ms) {
            out.push(Span {
                f: pair[0].ts_ms,
                t: pair[1].ts_ms,
            });
        }
    }
    out
}

/// Merge overlapping or nearly touching spans.
fn merge(mut spans: Vec<Span>, slack: i64) -> Vec<Span> {
    spans.sort_by_key(|s| s.f);
    let mut out: Vec<Span> = Vec::new();
    for s in spans {
        match out.last_mut() {
            Some(last) if s.f <= last.t + slack => last.t = last.t.max(s.t),
            _ => out.push(s),
        }
    }
    out
}

pub fn clock(ms: i64, seconds: bool) -> String {
    let s = ms.div_euclid(1000).rem_euclid(86_400);
    if seconds {
        format!("{:02}:{:02}:{:02}", s / 3600, s % 3600 / 60, s % 60)
    } else {
        format!("{:02}:{:02}", s / 3600, s % 3600 / 60)
    }
}

/// A duration as the page writes it: "4.2 s", "3m 24s", "2h 03m".
pub fn duration(ms: i64) -> String {
    let s = ms.max(0) as f64 / 1000.0;
    if s < 10.0 {
        format!("{s:.1} s")
    } else if s < 60.0 {
        format!("{s:.0} s")
    } else {
        let m = (s / 60.0) as i64;
        if m < 60 {
            format!("{m}m {:02}s", s as i64 % 60)
        } else {
            format!("{}h {:02}m", m / 60, m % 60)
        }
    }
}

pub fn size(bytes: f64) -> String {
    if bytes >= GIB {
        format!("{:.2} GiB", bytes / GIB)
    } else {
        format!("{:.0} MiB", bytes / MIB)
    }
}

/// A thread whose subtree is charted as one series.
struct Group<'a> {
    label: String,
    color: &'static str,
    units: Vec<Unit>,
    nodes: Vec<&'a Node>,
}

const SLOTS: [&str; 6] = ["sr-s1", "sr-s2", "sr-s3", "sr-s4", "sr-s5", "sr-s6"];

fn groups(root: &Node) -> Vec<Group<'_>> {
    let mut out = vec![Group {
        label: "This thread".to_owned(),
        color: SLOTS[0],
        units: root.units.clone(),
        nodes: vec![root],
    }];
    // A delegated thread that ran only in a shared scope has no measurement of its own, but its descendants may.
    let mut delegated: Vec<(&Node, Vec<Unit>, u64)> = root
        .children
        .iter()
        .filter(|c| c.kind == NodeKind::Delegated)
        .filter_map(|c| {
            let cpu = subtree_cpu(c)?;
            let mut units = Vec::new();
            collect_units(c, &mut units);
            Some((c, units, cpu))
        })
        .collect();
    delegated.sort_by_key(|(_, _, cpu)| std::cmp::Reverse(*cpu));
    let fold = delegated.len() > MAX_DELEGATED;
    for (index, (child, units, _)) in delegated.into_iter().enumerate() {
        if fold && index + 1 >= MAX_DELEGATED {
            if let Some(other) = out.get_mut(MAX_DELEGATED) {
                other.units.extend(units);
                other.nodes.push(child);
                continue;
            }
            out.push(Group {
                label: "Other delegated".to_owned(),
                color: SLOTS[MAX_DELEGATED],
                units,
                nodes: vec![child],
            });
        } else {
            out.push(Group {
                label: crate::page::node_name(child),
                color: SLOTS[index + 1],
                units,
                nodes: vec![child],
            });
        }
    }
    out
}

/// CPU measured anywhere in a node's subtree, or `None` when no node in it has a measured scope.
fn subtree_cpu(node: &Node) -> Option<u64> {
    let own = node.measured.as_ref().map(|m| m.cpu_usec);
    node.children
        .iter()
        .filter_map(subtree_cpu)
        .chain(own)
        .reduce(|a, b| a + b)
}

fn natives(node: &Node, end: i64, into: &mut Vec<LaneSpan>) {
    for child in &node.children {
        if child.kind == NodeKind::Native
            && let Some(f) = child.started_ms
        {
            let name = crate::page::node_name(child);
            let estimate = child
                .estimated_cpu_usec
                .map(|u| format!(" · ~{} CPU", duration(u as i64 / 1000)))
                .unwrap_or_default();
            into.push(LaneSpan {
                f,
                t: child.completed_ms.unwrap_or(end),
                tip: format!("subagent {name}{estimate}"),
                label: name,
                color: SLOTS[0],
                native: true,
            });
        }
        natives(child, end, into);
    }
}

impl Timeline {
    /// The task's charts, or `None` when none of its own scopes has a sample.
    pub fn build(store: &Store, report: &Report) -> rusqlite::Result<Option<Timeline>> {
        let Some(window) = report.window else {
            return Ok(None);
        };
        if report.total.scopes == 0 {
            return Ok(None);
        }
        let window = Window {
            from_ms: report.total.first_ms.min(window.from_ms),
            to_ms: window.to_ms,
        };
        let cont = Continuity::load(store, window)?;
        let groups = groups(&report.root);
        let task: Vec<&Unit> = groups.iter().flat_map(|g| &g.units).collect();

        // Spans, unsampled stretches, and every sample time.
        let mut alive = Vec::new();
        let mut unsampled = Vec::new();
        let mut times = Vec::new();
        let mut kernel = Vec::new();
        let mut early = Vec::new();
        for unit in &task {
            let Some(life) = life(unit, window) else { continue };
            let points = store.points(unit.unit_id, window.from_ms, window.to_ms)?;
            alive.push(life);
            let missing = gaps(&points, life, &cont);
            // CPU the counter holds at the first sample but that no rate can place in time.
            if let (Some(first), Some(lead)) = (points.first(), missing.first().filter(|g| g.f == life.f))
                && let Some(cpu) = first.cpu_usec.filter(|c| *c > 0)
                && unit.created_ms.is_some()
            {
                early.push(Mark {
                    f: lead.f,
                    t: lead.t,
                    v: round(cpu as f64 / 1000.0 / (lead.t - lead.f).max(1) as f64, 3),
                    label: format!("{} CPU before the first sample", duration(cpu as i64 / 1000)),
                    dash: true,
                });
            }
            // The kernel's peak, when it is well above every sample and the unit's whole life is in the window.
            let sampled = points.iter().map(|p| p.mem_current_max).max().unwrap_or(0) as f64;
            let peak = points.iter().filter_map(|p| p.mem_peak).max().unwrap_or(0) as f64;
            if life.f == unit.start_ms() && peak > sampled * 1.1 {
                let rose = points.windows(2).rposition(|p| p[1].mem_peak > p[0].mem_peak);
                let (f, t) = match rose {
                    Some(i) => (points[i].ts_ms, points[i + 1].ts_ms),
                    None => (life.f, points.first().map_or(life.t, |p| p.ts_ms)),
                };
                kernel.push((f, t, peak));
            }
            unsampled.extend(missing);
            times.extend(points.iter().map(|p| p.ts_ms));
        }
        let spans = merge(alive, MERGE_MS);
        let unsampled = merge(unsampled, 0);
        times.sort_unstable();
        times.dedup();
        if times.is_empty() {
            return Ok(None);
        }
        let live_ms: i64 = spans.iter().map(|s| s.t - s.f).sum();
        let interval = store.interval_at(window.to_ms)?.unwrap_or(2_000).max(1);
        let bucket = (times.len() > MAX_ROWS).then(|| {
            let per_row = (live_ms as f64 / MAX_ROWS as f64 / interval as f64).ceil() as i64;
            per_row.max(2) * interval
        });
        let mut t: Vec<i64> = match bucket {
            Some(b) => times.iter().map(|ts| ts.div_euclid(b) * b).collect(),
            None => times,
        };
        // A row with no values where each span and each unsampled stretch starts, so lines break there. A bucketed
        // span starts in the bucket before its first row of values.
        t.extend(spans.iter().map(|s| bucket.map_or(s.f, |b| s.f.div_euclid(b) * b - 1)));
        t.extend(unsampled.iter().map(|s| s.f + 1));
        t.sort_unstable();
        t.dedup();
        let grid = Grid { t, bucket };

        let task_values: Vec<Values> = groups
            .iter()
            .map(|g| values(store, &g.units, window, &grid, &cont))
            .collect::<rusqlite::Result<_>>()?;
        let machine = store.units_overlapping(UnitKind::Machine, window.from_ms, window.to_ms)?;
        let machine = values(store, &machine, window, &grid, &cont)?;
        let agents = store.units_overlapping(UnitKind::Agent, window.from_ms, window.to_ms)?;
        let agents = values(store, &agents, window, &grid, &cont)?;
        let n = grid.t.len();
        // Context readings exist only where the task was alive.
        let in_span = |i: usize| spans.iter().any(|s| s.f < grid.t[i] && grid.t[i] <= s.t);
        let context = |data: &[Option<f64>], scale: f64, places: i32| -> Vec<Option<f64>> {
            (0..n)
                .map(|i| data[i].filter(|_| in_span(i)).map(|v| round(v / scale, places)))
                .collect()
        };
        let single = groups.len() == 1;
        let peak_cores = (0..n)
            .map(|i| task_values.iter().filter_map(|v| v.cpu[i]).sum::<f64>())
            .fold(0.0, f64::max);

        let cpu = Chart {
            id: "cpu",
            title: "CPU",
            sub: "cores",
            unit: "cores",
            peak: true,
            series: groups
                .iter()
                .zip(&task_values)
                .map(|(g, v)| Series {
                    label: g.label.clone(),
                    color: Some(g.color),
                    soft: false,
                    dash: false,
                    data: v.cpu.iter().map(|c| c.map(|c| round(c, 3))).collect(),
                })
                .collect(),
            context: vec![
                Series {
                    label: "Whole machine".to_owned(),
                    color: None,
                    soft: false,
                    dash: false,
                    data: context(&machine.cpu, 1.0, 3),
                },
                Series {
                    label: "All T3 agents".to_owned(),
                    color: None,
                    soft: false,
                    dash: true,
                    data: context(&agents.cpu, 1.0, 3),
                },
            ],
            marks: early,
        };

        let memory_top = (0..n)
            .map(|i| {
                task_values
                    .iter()
                    .map(|v| v.resident[i].unwrap_or(0.0) + v.cache[i].unwrap_or(0.0))
                    .sum::<f64>()
            })
            .fold(0.0, f64::max);
        let (unit, scale, places) = if memory_top >= GIB {
            ("GiB", GIB, 3)
        } else {
            ("MiB", MIB, 0)
        };
        let scaled = |data: &[Option<f64>]| -> Vec<Option<f64>> {
            data.iter().map(|v| v.map(|v| round(v / scale, places))).collect()
        };
        let mut memory_series: Vec<Series> = groups
            .iter()
            .zip(&task_values)
            .map(|(g, v)| Series {
                label: if single { "Resident".to_owned() } else { g.label.clone() },
                color: Some(g.color),
                soft: false,
                dash: false,
                data: scaled(&v.resident),
            })
            .collect();
        let cache: Vec<Option<f64>> = (0..n)
            .map(|i| task_values.iter().filter_map(|v| v.cache[i]).reduce(|a, b| a + b))
            .collect();
        memory_series.push(Series {
            label: "Page cache".to_owned(),
            color: Some("sr-ctx"),
            soft: true,
            dash: false,
            data: scaled(&cache),
        });
        let memory = Chart {
            id: "mem",
            title: "Memory",
            sub: unit,
            unit,
            peak: true,
            series: memory_series,
            context: vec![Series {
                label: "Machine used".to_owned(),
                color: None,
                soft: false,
                dash: false,
                data: context(&machine.resident, scale, places),
            }],
            marks: kernel
                .into_iter()
                .map(|(f, t, peak)| Mark {
                    f,
                    t,
                    v: round(peak / scale, places),
                    label: format!("kernel peak {}", size(peak)),
                    dash: false,
                })
                .collect(),
        };
        let mut charts = vec![cpu, memory];

        let with_vram: Vec<(&Group, &Values)> = groups
            .iter()
            .zip(&task_values)
            .filter(|(_, v)| v.vram.iter().any(|x| x.is_some_and(|x| x > 0.0)))
            .collect();
        if !with_vram.is_empty() {
            let top = (0..n)
                .map(|i| with_vram.iter().filter_map(|(_, v)| v.vram[i]).sum::<f64>())
                .fold(0.0, f64::max);
            let (unit, scale, places) = if top >= GIB { ("GiB", GIB, 3) } else { ("MiB", MIB, 0) };
            charts.push(Chart {
                id: "gpu",
                title: "GPU memory",
                sub: unit,
                unit,
                peak: true,
                series: with_vram
                    .iter()
                    .map(|(g, v)| Series {
                        label: if single {
                            "GPU memory".to_owned()
                        } else {
                            g.label.clone()
                        },
                        color: Some(g.color),
                        soft: false,
                        dash: false,
                        data: v.vram.iter().map(|x| x.map(|x| round(x / scale, places))).collect(),
                    })
                    .collect(),
                context: vec![Series {
                    label: "Machine used".to_owned(),
                    color: None,
                    soft: false,
                    dash: false,
                    data: context(&machine.vram, scale, places),
                }],
                marks: Vec::new(),
            });
        }

        // Turns, delegated threads, and native subagents, clipped to the window.
        let end = window.to_ms;
        let clip = |s: LaneSpan| -> Option<LaneSpan> {
            let f = s.f.max(grid.t[0]);
            let t = s.t.min(end);
            (t >= f).then_some(LaneSpan { f, t, ..s })
        };
        let turns: Vec<LaneSpan> = report
            .root
            .turns
            .iter()
            .filter(|turn| turn.usage.is_some())
            .filter_map(|turn| {
                clip(LaneSpan {
                    f: turn.started_ms,
                    t: turn.completed_ms.unwrap_or(end),
                    label: turn.ordinal.to_string(),
                    tip: format!("turn {}", turn.ordinal),
                    color: SLOTS[0],
                    native: false,
                })
            })
            .collect();
        let bands = turns.iter().map(|s| Span { f: s.f, t: s.t }).collect();
        let delegated: Vec<LaneSpan> = groups
            .iter()
            .skip(1)
            .flat_map(|g| g.nodes.iter().map(move |node| (g, node)))
            .filter_map(|(g, node)| {
                let name = crate::page::node_name(node);
                clip(LaneSpan {
                    f: node.started_ms?,
                    t: node.completed_ms.unwrap_or(end),
                    tip: name.clone(),
                    label: name,
                    color: g.color,
                    native: false,
                })
            })
            .collect();
        let mut subagents = Vec::new();
        natives(&report.root, end, &mut subagents);
        let subagents: Vec<LaneSpan> = subagents.into_iter().filter_map(clip).collect();
        let lanes = [("Turns", turns), ("Delegated", delegated), ("Subagents", subagents)]
            .into_iter()
            .filter(|(_, spans)| !spans.is_empty())
            .map(|(name, spans)| Lane { name, spans })
            .collect();

        Ok(Some(Timeline {
            range: format!("{} → {} UTC", clock(grid.t[0], false), clock(end, false)),
            t: grid.t,
            spans: spans.iter().map(|s| [s.f, s.t]).collect(),
            bands,
            unsampled,
            lanes,
            charts,
            peak_cores,
        }))
    }

    /// Idle stretches between spans, for the lane labels.
    pub fn idle(&self) -> Vec<Span> {
        self.spans.windows(2).map(|p| Span { f: p[0][1], t: p[1][0] }).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merges_spans_that_nearly_touch() {
        let spans = vec![Span { f: 0, t: 10 }, Span { f: 50, t: 60 }, Span { f: 5, t: 20 }];
        let merged = merge(spans, 30);
        assert_eq!(merged.iter().map(|s| (s.f, s.t)).collect::<Vec<_>>(), vec![(0, 60)]);
        let merged = merge(vec![Span { f: 0, t: 10 }, Span { f: 50, t: 60 }], 30);
        assert_eq!(merged.len(), 2);
    }

    #[test]
    fn writes_durations_and_sizes_for_the_page() {
        assert_eq!(duration(4_240), "4.2 s");
        assert_eq!(duration(204_000), "3m 24s");
        assert_eq!(duration(7_380_000), "2h 03m");
        assert_eq!(size(1.64 * GIB), "1.64 GiB");
        assert_eq!(size(209.0 * MIB), "209 MiB");
        assert_eq!(clock(1_795_281_709_753, true), "17:21:49");
    }
}
