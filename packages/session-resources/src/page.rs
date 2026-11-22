//! The report as a self-contained HTML page: an askama template over a view model prepared here, with the chart data
//! from `timeline` and the uPlot charts drawn by `assets/report.js`.

use crate::report::{GIB, Node, NodeKind, Report, TurnUsage, Usage};
use crate::store::Store;
use crate::timeline::{Lane, LaneSpan, Timeline, clock, duration, size};
use askama::Template;

const TOKENS_CSS: &str = include_str!("../../../skills/internal-visual-style/assets/tokens.css");
const COMPONENTS_CSS: &str = include_str!("../../../skills/internal-visual-style/assets/components.css");
const FONT_READING: &[u8] =
    include_bytes!("../../../skills/internal-visual-style/assets/fonts/atkinson-hyperlegible-next.ttf");
const FONT_TECHNICAL: &[u8] =
    include_bytes!("../../../skills/internal-visual-style/assets/fonts/atkinson-hyperlegible-mono.ttf");
const UPLOT_CSS: &str = include_str!("../vendor/uplot/uPlot.min.css");
const UPLOT_JS: &str = include_str!("../vendor/uplot/uPlot.iife.min.js");
const PAGE_CSS: &str = include_str!("../assets/report.css");
const PAGE_JS: &str = include_str!("../assets/report.js");
pub(crate) const GAP_JS: &str = include_str!("../assets/gap.js");

/// A turn under this share of the task's CPU is quiet; runs of quiet turns share one row.
const QUIET_SHARE: f64 = 0.01;
const QUIET_RUN: usize = 3;

/// A lower bound or an estimate, shown as a symbol with its reason.
#[derive(Clone, Copy)]
struct Qualifier {
    symbol: &'static str,
    reason: &'static str,
}

const PARTIAL: Qualifier = Qualifier {
    symbol: "≥",
    reason: "Lower bound: part of this time has no samples",
};
const ESTIMATE: Qualifier = Qualifier {
    symbol: "~",
    reason: "Estimate: shares the parent's process",
};

/// A number cell with an optional qualifier.
struct Value {
    qualifier: Option<Qualifier>,
    text: String,
}

impl Value {
    fn plain(text: impl Into<String>) -> Self {
        Value {
            qualifier: None,
            text: text.into(),
        }
    }

    fn dash() -> Self {
        Value::plain("—")
    }

    fn cpu(usec: u64, partial: bool) -> Self {
        Value {
            qualifier: partial.then_some(PARTIAL),
            text: duration(usec as i64 / 1000),
        }
    }
}

struct Figure {
    label: &'static str,
    value: Value,
    detail: String,
}

struct Status {
    class: &'static str,
    word: String,
}

impl Status {
    fn of(status: &str) -> Self {
        let class = match status {
            "completed" => "ok",
            "running" | "pending" | "starting" => "run",
            "cancelled" => "off",
            _ => "stop",
        };
        Status {
            class,
            word: status.to_owned(),
        }
    }
}

struct TreeRow {
    class: &'static str,
    depth: usize,
    name: String,
    sub: String,
    own: Option<String>,
    cpu: Value,
    /// Share of the task's CPU as a percentage, and whether it is an estimate.
    share: Option<(f64, bool)>,
    memory: String,
    gib_hours: String,
    vram: String,
    wall: String,
}

struct TurnRow {
    label: String,
    start: String,
    status: Option<Status>,
    note: Option<String>,
    duration: String,
    cpu: Value,
    share: Option<f64>,
    memory: String,
}

struct LaneRow {
    name: &'static str,
    spans: Vec<LaneSpan>,
    idle: Vec<(i64, i64, String)>,
}

struct ChartSlot {
    id: &'static str,
    title: &'static str,
    sub: &'static str,
    short: bool,
}

struct Charts {
    range: String,
    lanes: Vec<LaneRow>,
    charts: Vec<ChartSlot>,
    data: String,
}

struct Meter {
    label: &'static str,
    value: String,
    of: String,
    average: f64,
    peak: f64,
    detail: String,
}

struct Part {
    label: &'static str,
    percent: f64,
    text: String,
    color: &'static str,
}

impl Part {
    fn new(label: &'static str, percent: f64, color: &'static str) -> Self {
        let text = if percent < 1.0 {
            format!("{percent:.2}%")
        } else {
            format!("{percent:.1}%")
        };
        Part {
            label,
            percent: (percent * 100.0).round() / 100.0,
            text,
            color,
        }
    }
}

struct Machine {
    sub: String,
    meters: Vec<Meter>,
    parts: Vec<Part>,
}

#[derive(Template)]
#[template(path = "report.html")]
struct Page {
    title: String,
    meta: String,
    status: Option<Status>,
    figures: Vec<Figure>,
    charts: Option<Charts>,
    empty: Option<&'static str>,
    tree: Vec<TreeRow>,
    tree_vram: bool,
    turns: Vec<TurnRow>,
    machine: Option<Machine>,
    overhead_summary: String,
    overhead: Vec<(&'static str, String)>,
    method: Vec<String>,
    thread_id: String,
    style: String,
    script: String,
}

pub fn node_name(node: &Node) -> String {
    node.title.clone().unwrap_or_else(|| {
        node.thread_id
            .as_deref()
            .map(|id| id.chars().take(36).collect())
            .unwrap_or_else(|| "(untitled)".to_owned())
    })
}

fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = chunk
            .iter()
            .enumerate()
            .fold(0u32, |n, (i, b)| n | u32::from(*b) << (16 - 8 * i));
        for i in 0..4 {
            out.push(if i <= chunk.len() {
                char::from(TABLE[(n >> (18 - 6 * i) & 63) as usize])
            } else {
                '='
            });
        }
    }
    out
}

fn style() -> String {
    let face = |family: &str, font: &[u8]| {
        format!(
            "@font-face{{font-family:\"{family}\";src:url(data:font/ttf;base64,{}) format(\"truetype\");\
             font-weight:200 800;font-display:swap}}\n",
            base64(font)
        )
    };
    [
        face("Atkinson Hyperlegible Next", FONT_READING),
        face("Atkinson Hyperlegible Mono", FONT_TECHNICAL),
        TOKENS_CSS.to_owned(),
        COMPONENTS_CSS.to_owned(),
        UPLOT_CSS.to_owned(),
        PAGE_CSS.to_owned(),
    ]
    .concat()
}

/// A calendar date from Unix milliseconds, as "21 Nov 2026" (UTC).
fn date(ms: i64) -> String {
    // Howard Hinnant's days-to-civil.
    let z = ms.div_euclid(86_400_000) + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    format!("{day} {} {year}", MONTHS[(month - 1) as usize])
}

fn gib_hours(value: f64) -> String {
    format!("{value:.2}")
}

fn memory_peak(u: &Usage) -> String {
    if u.samples == 0 {
        "—".to_owned()
    } else {
        size(u.resident_max as f64)
    }
}

fn share(cpu: u64, total: u64) -> Option<f64> {
    (total > 0).then(|| (cpu as f64 / total as f64 * 100.0).min(100.0))
}

fn tree_rows(node: &Node, depth: usize, total_cpu: u64, out: &mut Vec<TreeRow>) {
    let model = node.model.as_deref().or(node.provider.as_deref()).unwrap_or("");
    let wall = match (node.started_ms, node.completed_ms) {
        (Some(a), Some(b)) => duration(b - a),
        (Some(_), None) => "running".to_owned(),
        _ => "—".to_owned(),
    };
    let row = match (node.kind, &node.measured) {
        (NodeKind::Native, _) => TreeRow {
            class: "",
            depth,
            name: node_name(node),
            sub: "subagent".to_owned(),
            own: None,
            cpu: node.estimated_cpu_usec.map_or_else(
                || Value::plain("unknown"),
                |u| Value {
                    qualifier: Some(ESTIMATE),
                    text: duration(u as i64 / 1000),
                },
            ),
            share: node
                .estimated_cpu_usec
                .and_then(|u| share(u, total_cpu))
                .map(|s| (s, true)),
            memory: "—".to_owned(),
            gib_hours: "—".to_owned(),
            vram: "—".to_owned(),
            wall,
        },
        (_, Some(m)) => TreeRow {
            class: if depth == 0 { "root" } else { "" },
            depth,
            name: node_name(node),
            sub: format!("{model} · {} scope{}", m.scopes, if m.scopes == 1 { "" } else { "s" }),
            own: node.own_cpu_usec_estimate.map(|u| duration(u as i64 / 1000)),
            cpu: Value::cpu(m.cpu_usec, m.cpu_partial),
            share: share(m.cpu_usec, total_cpu).map(|s| (s, false)),
            memory: memory_peak(m),
            gib_hours: gib_hours(m.resident_gib_hours),
            vram: m.vram_max.map_or_else(|| "—".to_owned(), |v| size(v as f64)),
            wall: duration(m.wall_ms),
        },
        (_, None) => TreeRow {
            class: if depth == 0 { "root" } else { "" },
            depth,
            name: node_name(node),
            sub: format!(
                "{model} · {}",
                if node.shared.is_empty() {
                    "not sampled"
                } else {
                    "shared scope only"
                }
            ),
            own: None,
            cpu: Value::dash(),
            share: None,
            memory: "—".to_owned(),
            gib_hours: "—".to_owned(),
            vram: "—".to_owned(),
            wall,
        },
    };
    out.push(row);
    for shared in &node.shared {
        let provider = shared.provider.as_deref().unwrap_or("agent");
        let mut chars = provider.chars();
        let provider = chars
            .next()
            .map(|c| c.to_uppercase().chain(chars).collect::<String>())
            .unwrap_or_default();
        let u = shared.usage.as_ref();
        out.push(TreeRow {
            class: "ctx",
            depth: depth + 1,
            name: format!("Shared {provider} scope"),
            sub: format!(
                "{} thread{} · not in total",
                shared.threads,
                if shared.threads == 1 { "" } else { "s" }
            ),
            own: None,
            cpu: u.map_or_else(Value::dash, |u| Value::cpu(u.cpu_usec, u.cpu_partial)),
            share: None,
            memory: u.map_or_else(|| "—".to_owned(), memory_peak),
            gib_hours: u.map_or_else(|| "—".to_owned(), |u| gib_hours(u.resident_gib_hours)),
            vram: u
                .and_then(|u| u.vram_max)
                .map_or_else(|| "—".to_owned(), |v| size(v as f64)),
            wall: u.map_or_else(|| "—".to_owned(), |u| duration(u.wall_ms)),
        });
    }
    for child in &node.children {
        tree_rows(child, depth + 1, total_cpu, out);
    }
}

fn has_vram(node: &Node) -> bool {
    node.measured.as_ref().and_then(|m| m.vram_max).is_some_and(|v| v > 0) || node.children.iter().any(has_vram)
}

fn turn_row(turn: &TurnUsage, u: &Usage, total_cpu: u64, end: i64) -> TurnRow {
    TurnRow {
        label: turn.ordinal.to_string(),
        start: clock(turn.started_ms, true),
        status: Some(Status::of(&turn.status)),
        note: None,
        duration: duration(turn.completed_ms.unwrap_or(end) - turn.started_ms),
        cpu: Value::cpu(u.cpu_usec, u.cpu_partial),
        share: share(u.cpu_usec, total_cpu),
        memory: memory_peak(u),
    }
}

/// A run of turns in one row: those before sampling started, or several quiet ones in a row.
fn range_row(run: &[&TurnUsage], note: String, total_cpu: u64, end: i64) -> TurnRow {
    let (first, last) = (run[0], run[run.len() - 1]);
    let measured: Vec<&Usage> = run.iter().filter_map(|t| t.usage.as_ref()).collect();
    let cpu: u64 = measured.iter().map(|u| u.cpu_usec).sum();
    TurnRow {
        label: if run.len() == 1 {
            first.ordinal.to_string()
        } else {
            format!("{}–{}", first.ordinal, last.ordinal)
        },
        start: format!(
            "{}–{}",
            clock(first.started_ms, false),
            clock(last.completed_ms.unwrap_or(end), false)
        ),
        status: None,
        note: Some(note),
        duration: if measured.is_empty() {
            "—".to_owned()
        } else {
            duration(last.completed_ms.unwrap_or(end) - first.started_ms)
        },
        cpu: if measured.is_empty() {
            Value::dash()
        } else {
            Value::cpu(cpu, measured.iter().any(|u| u.cpu_partial))
        },
        share: (!measured.is_empty()).then(|| share(cpu, total_cpu)).flatten(),
        memory: measured
            .iter()
            .filter(|u| u.samples > 0)
            .map(|u| u.resident_max)
            .max()
            .map_or_else(|| "—".to_owned(), |m| size(m as f64)),
    }
}

fn turn_rows(turns: &[TurnUsage], total_cpu: u64, end: i64) -> Vec<TurnRow> {
    let mut out = Vec::new();
    let unsampled = turns.iter().take_while(|t| t.usage.is_none()).count();
    if unsampled > 0 {
        let run: Vec<&TurnUsage> = turns[..unsampled].iter().collect();
        out.push(range_row(&run, "before sampling started".to_owned(), total_cpu, end));
    }
    let quiet = |t: &TurnUsage| {
        t.status != "running"
            && t.usage
                .as_ref()
                .is_some_and(|u| (u.cpu_usec as f64) < total_cpu as f64 * QUIET_SHARE)
    };
    let rest = &turns[unsampled..];
    let mut i = 0;
    while i < rest.len() {
        let run = rest[i..].iter().take_while(|t| quiet(t)).count();
        if run >= QUIET_RUN {
            let group: Vec<&TurnUsage> = rest[i..i + run].iter().collect();
            out.push(range_row(&group, format!("{run} quiet turns"), total_cpu, end));
            i += run;
            continue;
        }
        let turn = &rest[i];
        out.push(match &turn.usage {
            Some(u) => turn_row(turn, u, total_cpu, end),
            None => TurnRow {
                label: turn.ordinal.to_string(),
                start: clock(turn.started_ms, true),
                status: None,
                note: Some("not sampled".to_owned()),
                duration: duration(turn.completed_ms.unwrap_or(end) - turn.started_ms),
                cpu: Value::dash(),
                share: None,
                memory: "—".to_owned(),
            },
        });
        i += 1;
    }
    out
}

/// Spread a lane's spans over rows so none overlap.
fn pack(spans: Vec<LaneSpan>) -> Vec<Vec<LaneSpan>> {
    let mut rows: Vec<Vec<LaneSpan>> = Vec::new();
    let mut sorted = spans;
    sorted.sort_by_key(|s| s.f);
    for span in sorted {
        match rows.iter_mut().find(|r| r.last().is_some_and(|l| l.t <= span.f)) {
            Some(row) => row.push(span),
            None => rows.push(vec![span]),
        }
    }
    rows
}

fn charts(timeline: &Timeline) -> Result<Charts, String> {
    let mut lanes = Vec::new();
    let mut idle: Vec<(i64, i64, String)> = timeline
        .idle()
        .into_iter()
        .map(|s| (s.f, s.t, duration(s.t - s.f)))
        .collect();
    for Lane { name, spans } in &timeline.lanes {
        for (index, row) in pack(spans.clone()).into_iter().enumerate() {
            lanes.push(LaneRow {
                name: if index == 0 { name } else { "" },
                spans: row,
                idle: std::mem::take(&mut idle),
            });
        }
    }
    if lanes.is_empty() && !idle.is_empty() {
        lanes.push(LaneRow {
            name: "",
            spans: Vec::new(),
            idle,
        });
    }
    let data = serde_json::to_string(timeline).map_err(|e| e.to_string())?;
    Ok(Charts {
        range: timeline.range.clone(),
        lanes,
        charts: timeline
            .charts
            .iter()
            .map(|c| ChartSlot {
                id: c.id,
                title: c.title,
                sub: c.sub,
                short: c.id == "gpu",
            })
            .collect(),
        // Inside a script element, "</" could close it early.
        data: data.replace("</", "<\\/"),
    })
}

fn machine(report: &Report) -> Option<Machine> {
    let m = report.machine.as_ref()?;
    let window = report.window?;
    let pct = |part: f64, whole: f64| {
        if whole > 0.0 {
            (part / whole * 100.0).min(100.0)
        } else {
            0.0
        }
    };
    let mut meters = vec![Meter {
        label: "CPU busy",
        value: format!("{:.2}", m.busy_cores_avg),
        of: format!("of {} cores", m.cpu_count),
        average: pct(m.busy_cores_avg, m.cpu_count as f64),
        peak: pct(m.busy_cores_peak, m.cpu_count as f64),
        detail: format!("peak {:.1}", m.busy_cores_peak),
    }];
    if let Some(total) = m.mem_total {
        meters.push(Meter {
            label: "Memory used",
            value: format!("{:.1}", m.mem_used_avg / GIB),
            of: format!("of {:.1} GiB", total as f64 / GIB),
            average: pct(m.mem_used_avg, total as f64),
            peak: pct(m.mem_used_max as f64, total as f64),
            detail: format!("peak {}", size(m.mem_used_max as f64)),
        });
    }
    if let Some(total) = m.vram_total {
        let mut detail = format!("peak {}", size(m.vram_used_max as f64));
        if let Some(util) = m.gpu_util_avg {
            detail.push_str(&format!(" · {util:.1}% busy"));
        }
        if let Some(power) = m.gpu_power_w_avg {
            detail.push_str(&format!(" · {power:.0} W"));
        }
        meters.push(Meter {
            label: "GPU memory used",
            value: m
                .vram_used_avg
                .map_or_else(|| "unknown".to_owned(), |v| format!("{:.2}", v / GIB)),
            of: format!("of {:.1} GiB", total as f64 / GIB),
            average: m.vram_used_avg.map_or(0.0, |v| pct(v, total as f64)),
            peak: pct(m.vram_used_max as f64, total as f64),
            detail,
        });
    }
    let whole = m.machine_cpu_usec as f64;
    let task = m.task_share.unwrap_or(0.0) * whole;
    let parts = vec![
        Part::new("This task", pct(task, whole), "var(--sr-s1)"),
        Part::new(
            "Other T3 agents",
            pct((m.all_agents_cpu_usec as f64 - task).max(0.0), whole),
            "var(--sr-ctx)",
        ),
        Part::new(
            "T3 app",
            pct(m.t3_app_cpu_usec as f64, whole),
            "color-mix(in oklab, var(--sr-ctx) 55%, var(--bg-page))",
        ),
        Part::new(
            "Everything else",
            pct(m.other_cpu_usec as f64, whole),
            "color-mix(in oklab, var(--sr-ctx) 28%, var(--bg-page))",
        ),
    ];
    Some(Machine {
        sub: format!("{}–{} UTC", clock(window.from_ms, false), clock(window.to_ms, false)),
        meters,
        parts,
    })
}

pub fn render(store: &Store, report: &Report) -> Result<String, String> {
    let root = &report.root;
    let total = &report.total;
    let timeline = Timeline::build(store, report).map_err(|e| e.to_string())?;
    let end = report.window.map_or(root.completed_ms.unwrap_or(0), |w| w.to_ms);
    let start = root
        .measured
        .as_ref()
        .map(|m| m.first_ms)
        .or(report.window.map(|w| w.from_ms));

    let mut meta = vec![root.provider.clone().unwrap_or_else(|| "agent".to_owned())];
    if let Some(start) = start {
        meta.push(format!(
            "{}, {}–{} UTC",
            date(start),
            clock(start, false),
            clock(end, false)
        ));
    }
    let status = root.turns.last().map(|t| Status::of(&t.status));

    let mut figures = Vec::new();
    if total.scopes > 0 {
        let peak_cores = timeline.as_ref().map_or(total.peak_cores, |t| t.peak_cores);
        figures.push(Figure {
            label: "CPU time",
            value: Value::cpu(total.cpu_usec, total.cpu_partial),
            detail: format!("{peak_cores:.1} cores peak"),
        });
        figures.push(Figure {
            label: "Memory peak",
            value: Value::plain(size(total.concurrent_resident_peak)),
            detail: format!("{:.2} GiB·h", total.resident_gib_hours),
        });
        if let Some(peak) = total.concurrent_vram_peak.filter(|v| *v > 0.0) {
            figures.push(Figure {
                label: "GPU memory peak",
                value: Value::plain(size(peak)),
                detail: format!("{:.2} GiB·h", total.vram_gib_hours.unwrap_or(0.0)),
            });
        }
        let live = timeline
            .as_ref()
            .map(|t| t.spans.iter().map(|s| s[1] - s[0]).sum::<i64>())
            .unwrap_or(total.wall_ms);
        figures.push(Figure {
            label: "Live",
            value: Value::plain(duration(live)),
            detail: format!(
                "of {} · {} scope{}",
                duration(total.wall_ms),
                total.scopes,
                if total.scopes == 1 { "" } else { "s" }
            ),
        });
        if let Some(m) = &report.machine
            && let Some(task_share) = m.task_share
        {
            figures.push(Figure {
                label: "Machine share",
                value: Value::plain(format!("{:.2}%", task_share * 100.0)),
                detail: format!("of {} CPU", duration(m.machine_cpu_usec as i64 / 1000)),
            });
        }
    }

    let empty = match (&timeline, report.window, total.scopes) {
        (Some(_), ..) => None,
        (None, None, _) => Some("Nothing was sampled for this thread or the threads it delegated to."),
        (None, Some(_), 0) => Some("This thread ran only in shared scopes, so it has no samples of its own."),
        (None, Some(_), _) => Some("Too few samples to chart."),
    };

    let mut tree = Vec::new();
    tree_rows(root, 0, total.cpu_usec, &mut tree);

    let (overhead_summary, overhead) = match &report.sampler {
        Some(o) => (
            format!(
                "{}{} · {} gaps",
                o.share_of_machine
                    .map(|s| format!("{:.2}% of machine CPU · ", s * 100.0))
                    .unwrap_or_default(),
                size(o.mem_max as f64),
                o.gaps
            ),
            vec![
                (
                    "CPU",
                    format!("{} · {:.4} cores", duration(o.cpu_usec as i64 / 1000), o.avg_cores),
                ),
                ("Resident peak", size(o.mem_max as f64)),
                ("Ticks", o.ticks.to_string()),
                (
                    "Tick p50 / p99 / max",
                    format!(
                        "{:.1} / {:.1} / {:.0} ms",
                        o.tick_p50_us as f64 / 1000.0,
                        o.tick_p99_us as f64 / 1000.0,
                        o.tick_max_us as f64 / 1000.0
                    ),
                ),
                ("Worst lag", format!("{} ms", o.lag_max_ms)),
                ("Longest interval", duration(o.interval_max_ms)),
                ("Database", size(o.db_bytes as f64)),
                (
                    "Written",
                    o.write_bytes.map_or_else(|| "—".to_owned(), |w| size(w as f64)),
                ),
                (
                    "Source",
                    if o.from_cgroup {
                        "systemd cgroup"
                    } else {
                        "process counters"
                    }
                    .to_owned(),
                ),
            ],
        ),
        None => (String::new(), Vec::new()),
    };

    let mut method = vec![
        "CPU is the kernel's cgroup counter, exact over any span with samples at both ends. Memory is sampled every \
         2 s or so; resident memory excludes page cache. ≥ marks a lower bound where part of the time has no \
         samples; ~ marks an estimate for native subagents, which share their parent's process."
            .to_owned(),
    ];
    if let Some(m) = root.measured.as_ref().filter(|m| m.samples > 0) {
        method.push(format!(
            "The kernel's peak for this thread's scopes, page cache included, is {}.",
            size(m.mem_peak as f64)
        ));
    }
    method.extend(report.notes.iter().cloned());

    let page = Page {
        title: node_name(root),
        meta: meta.join(" · "),
        status,
        figures,
        charts: timeline.as_ref().map(charts).transpose()?,
        empty,
        tree_vram: has_vram(root),
        tree,
        turns: turn_rows(&root.turns, total.cpu_usec, end),
        machine: machine(report),
        overhead_summary,
        overhead,
        method,
        thread_id: root.thread_id.clone().unwrap_or_default(),
        style: style(),
        script: if timeline.is_some() {
            format!("<script>{UPLOT_JS}</script><script>{GAP_JS}</script><script>{PAGE_JS}</script>")
        } else {
            String::new()
        },
    };
    page.render().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_base64() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn never_parses_page_strings_as_markup() {
        // Chart labels carry thread titles; the script builds elements and sets text instead.
        for sink in ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write"] {
            assert!(!PAGE_JS.contains(sink), "assets/report.js uses {sink}");
        }
    }

    #[test]
    fn keeps_the_time_axis_increasing_at_any_width() {
        // Plot widths and idle-cut counts, including a 360 px plot with six spans, where capping each cut alone gave
        // a negative gap.
        let check = r#"
            for (const w of [40, 120, 276, 360, 640, 1600]) for (const n of [1, 2, 5, 12, 40]) for (const a of [0, 6000, 3.6e6]) {
              const g = srGapUnits(a, n, w), cut = (w * g) / (a + n * g);
              if (!(g > 0 && isFinite(g) && (a === 0 || n * cut <= w * 0.5 + 1e-9))) throw new Error(`w=${w} n=${n} active=${a}: gapU=${g}`);
            }
            if (srGapUnits(6000, 0, 360) !== 0) throw new Error("no cuts, no gap units");
        "#;
        let script = format!("{GAP_JS}\n{check}");
        let output = match std::process::Command::new("node").args(["-e", &script]).output() {
            Ok(output) => output,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                eprintln!("skipped: node is not on PATH");
                return;
            }
            Err(e) => panic!("running node: {e}"),
        };
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    }

    #[test]
    fn writes_utc_dates() {
        assert_eq!(date(1_795_281_709_753), "21 Nov 2026");
        assert_eq!(date(0), "1 Jan 1970");
        assert_eq!(date(951_782_400_000), "29 Feb 2000");
    }
}
