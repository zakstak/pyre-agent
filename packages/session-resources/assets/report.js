(() => {
  const D = JSON.parse(document.getElementById("sr-data").textContent);
  const $ = (s, el = document) => el.querySelector(s);
  const dpr = () => devicePixelRatio || 1;

  // Colours come from the page's tokens. A probe resolves var(), light-dark() and color-mix() to something canvas accepts.
  const probe = document.body.appendChild(document.createElement("i"));
  const C = {};
  const NAMES = [
    "sr-s1",
    "sr-s2",
    "sr-s3",
    "sr-s4",
    "sr-s5",
    "sr-s6",
    "sr-ctx",
    "sr-grid",
    "sr-band",
    "sr-hatch",
    "bg-page",
    "text-primary",
    "text-secondary",
  ];
  let hatch;
  function readTheme() {
    for (const n of NAMES) {
      probe.style.color = `var(--${n})`;
      C[n] = getComputedStyle(probe).color;
      probe.style.color = `color-mix(in oklab, var(--${n}) 42%, var(--bg-page))`;
      C[n + "-fill"] = getComputedStyle(probe).color;
      probe.style.color = `color-mix(in oklab, var(--${n}) 18%, var(--bg-page))`;
      C[n + "-soft"] = getComputedStyle(probe).color;
    }
    const c = document.createElement("canvas");
    c.width = c.height = 8 * dpr();
    const g = c.getContext("2d");
    g.strokeStyle = C["sr-hatch"];
    g.lineWidth = dpr();
    g.beginPath();
    for (const o of [-1, 0, 1]) {
      g.moveTo(o * c.width, c.height);
      g.lineTo((o + 1) * c.width, 0);
    }
    g.stroke();
    hatch = g.createPattern(c, "repeat");
  }

  // Time axis: live spans keep their real proportions; each idle stretch between them is a fixed-width cut.
  const S = D.spans,
    active = S.reduce((a, [f, t]) => a + t - f, 0);
  let gapU = active * 0.06;
  const fwd = (v) => {
    let acc = 0;
    for (let i = 0; i < S.length; i++) {
      const [f, t] = S[i];
      if (v < f) return i ? acc - (gapU * (f - v)) / (f - S[i - 1][1]) : v - f;
      if (v <= t) return acc + v - f;
      acc += t - f + gapU;
    }
    return acc - gapU + v - S[S.length - 1][1];
  };
  const bwd = (p) => {
    let acc = 0;
    for (let i = 0; i < S.length; i++) {
      const [f, t] = S[i];
      if (p < acc)
        return i ? f - ((acc - p) / gapU) * (f - S[i - 1][1]) : f + p;
      if (p <= acc + t - f) return f + p - acc;
      acc += t - f + gapU;
    }
    return S[S.length - 1][1] + p - (acc - gapU);
  };
  const STEPS = [
    1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600,
    43200, 86400,
  ].map((s) => s * 1000);
  const p2 = (n) => String(n).padStart(2, "0");
  const clock = (ms, secs) => {
    const d = new Date(ms);
    return (
      p2(d.getUTCHours()) +
      ":" +
      p2(d.getUTCMinutes()) +
      (secs ? ":" + p2(d.getUTCSeconds()) : "")
    );
  };
  function splits(u, _, min, max) {
    const w = u.bbox.width / dpr(),
      shown = fwd(max) - fwd(min);
    const step =
      STEPS.find((s) => shown / s <= w / 84) || STEPS[STEPS.length - 1];
    const out = [];
    let last = -1e9;
    for (let v = Math.ceil(min / step) * step; v <= max; v += step) {
      if (!S.some(([f, t]) => v >= f && v <= t)) continue;
      const x = ((fwd(v) - fwd(min)) / shown) * w;
      if (x - last >= 52) {
        out.push(v);
        last = x;
      }
    }
    return out;
  }
  const fmt = (v, unit) =>
    v == null
      ? ""
      : unit === "cores"
        ? v.toFixed(v < 10 ? 2 : 1)
        : unit === "GiB" && v < 1
          ? Math.round(v * 1024) + " MiB"
          : v.toFixed(v < 10 ? 2 : 1) + " " + unit;

  const gutter = () => (innerWidth < 640 ? 40 : 84);
  const plots = [];
  let lock = false,
    machine = false;
  const xr = () => [D.t[0], D.t[D.t.length - 1]];
  const X = (u, v) => Math.round(u.valToPos(v, "x", true));
  const clipX = (u, f, t) => {
    const b = u.bbox,
      a = Math.max(b.left, X(u, f)),
      z = Math.min(b.left + b.width, X(u, t));
    return z > a ? [a, z - a] : null;
  };

  function build(spec, last) {
    const el = $("#c-" + spec.id),
      keys = $("header", el),
      host = $(".plot", el);
    // Stack: each stacked series is drawn as its cumulative top, highest first, with an opaque fill.
    const sum = D.t.map(() => 0),
      tops = [],
      total = D.t.map(() => null);
    for (const s of spec.series)
      tops.push(
        s.data.map((v, i) => {
          if (v == null) return null;
          sum[i] += v;
          if (!s.soft) total[i] = sum[i];
          return sum[i];
        }),
      );
    const all = [
      ...spec.series.map((s, i) => ({ ...s, src: s, top: tops[i] })).reverse(),
      ...(spec.context || []).map((s) => ({
        ...s,
        src: s,
        ctx: true,
        top: s.data,
      })),
    ];
    // The direct label goes on the highest total of the stacked series, page cache excluded.
    const peakTop = spec.peak ? total : null;
    let pk = -1;
    if (peakTop)
      peakTop.forEach((v, i) => {
        if (v != null && (pk < 0 || v > peakTop[pk])) pk = i;
      });
    for (const s of [...spec.series, ...(spec.context || [])]) {
      const k = keys.appendChild(document.createElement("span"));
      k.className =
        "key" +
        (s.dash ? " dash" : s.color ? (s.soft ? " soft" : "") : " line");
      k.style.setProperty("--k", `var(--${s.color || "sr-ctx"})`);
      k.innerHTML = `<i></i>${s.label} <b></b>`;
      s.key = k;
      k.hidden = !s.color && !machine;
    }
    const axis = (o) => ({
      stroke: () => C["text-secondary"],
      font: `${14}px "Atkinson Hyperlegible Mono", ui-monospace, monospace`,
      ticks: { show: false },
      grid: { stroke: () => C["sr-grid"], width: 1 },
      ...o,
    });
    const u = new uPlot(
      {
        width: host.clientWidth,
        height: host.clientHeight,
        ms: 1,
        legend: { show: false },
        padding: [10, 0, last ? 0 : 8, 0],
        cursor: {
          sync: { key: "sr" },
          y: false,
          drag: { x: true, y: false },
          points: { size: 7, fill: () => C["bg-page"] },
        },
        scales: {
          x: { time: false, distr: 100, fwd, bwd, range: (u, a, b) => [a, b] },
          y: {
            range: (u, a, b) => {
              let m = Math.max(b || 0, 0);
              for (const k of spec.marks || [])
                if (k.v > m && k.v < m * 2) m = k.v;
              return [0, m * 1.12 || 1];
            },
          },
        },
        axes: [
          axis({
            show: last,
            splits,
            filter: (u, s) => s,
            values: (u, vs) => {
              const secs = u.scales.x.max - u.scales.x.min < 6e5;
              return vs.map((v) => clock(v, secs));
            },
            grid: { show: false },
            size: 30,
          }),
          axis({
            size: gutter,
            splits: (u, i, a, b, incr) => {
              const o = [];
              for (let v = 0; v <= b; v += incr) o.push(v);
              return o.length > 4 ? o.filter((_, j) => j % 2 === 0) : o;
            },
            values: (u, vs) => vs.map((v) => +v.toPrecision(3)),
          }),
        ],
        series: [
          {},
          ...all.map((s) => ({
            show: !s.ctx,
            points: { show: false },
            width: s.soft ? 0 : s.ctx ? 1.5 : 2,
            dash: s.dash ? [5, 4] : undefined,
            stroke: () => C[s.color || "sr-ctx"],
            fill: s.ctx
              ? undefined
              : () => C[s.color + (s.soft ? "-soft" : "-fill")],
          })),
        ],
        hooks: {
          drawClear: [(u) => under(u)],
          drawAxes: [(u) => cuts(u)],
          draw: [(u) => over(u, spec, pk, peakTop)],
          setCursor: [(u) => readout(u, spec)],
          setScale: [(u, k) => zoomed(u, k)],
        },
      },
      [D.t, ...all.map((s) => s.top)],
      host,
    );
    u.spec = spec;
    u.all = all;
    plots.push(u);
    new ResizeObserver(() => {
      fit();
      u.setSize({ width: host.clientWidth, height: host.clientHeight });
      if (u === plots[0]) lanes();
    }).observe(host);
  }

  // Under the series: turn bands, then hatching where a scope was alive but nothing was sampled.
  function under(u) {
    const g = u.ctx,
      b = u.bbox;
    g.save();
    g.fillStyle = C["sr-band"];
    for (const s of D.bands) {
      const r = clipX(u, s.f, s.t);
      if (r) g.fillRect(r[0], b.top, Math.max(r[1], dpr()), b.height);
    }
    g.fillStyle = hatch;
    for (const s of D.unsampled) {
      const r = clipX(u, s.f, s.t);
      if (r) g.fillRect(r[0], b.top, r[1], b.height);
    }
    g.restore();
  }
  // Over the grid: cut each idle stretch out of the plot.
  function cuts(u) {
    const g = u.ctx,
      b = u.bbox;
    g.save();
    g.fillStyle = C["bg-page"];
    g.strokeStyle = C["sr-hatch"];
    g.setLineDash([2 * dpr(), 3 * dpr()]);
    g.lineWidth = dpr();
    for (let i = 1; i < S.length; i++) {
      const r = clipX(u, S[i - 1][1], S[i][0]);
      if (!r) continue;
      g.fillRect(r[0], b.top - 1, r[1], b.height + 2);
      g.beginPath();
      g.moveTo(r[0] + 0.5, b.top);
      g.lineTo(r[0] + 0.5, b.top + b.height);
      g.moveTo(r[0] + r[1] - 0.5, b.top);
      g.lineTo(r[0] + r[1] - 0.5, b.top + b.height);
      g.stroke();
    }
    g.restore();
  }
  // Over the series: the sampled peak, and values the kernel counted that no sample caught.
  function over(u, spec, pk, peakTop) {
    const g = u.ctx,
      b = u.bbox,
      k = dpr(),
      ymax = u.scales.y.max;
    g.save();
    g.font = `600 ${14 * k}px "Atkinson Hyperlegible Mono", ui-monospace, monospace`;
    g.textBaseline = "middle";
    const text = (s, x, y) => {
      const w = g.measureText(s).width,
        right = x + 8 * k + w < b.left + b.width;
      g.textAlign = right ? "left" : "right";
      g.lineWidth = 4 * k;
      g.strokeStyle = C["bg-page"];
      g.lineJoin = "round";
      const tx = x + (right ? 9 : -9) * k,
        ty = Math.max(y, b.top + 8 * k);
      g.strokeText(s, tx, ty);
      g.fillStyle = C["text-primary"];
      g.fillText(s, tx, ty);
    };
    if (pk >= 0 && D.t[pk] >= u.scales.x.min && D.t[pk] <= u.scales.x.max) {
      const x = X(u, D.t[pk]),
        y = u.valToPos(peakTop[pk], "y", true);
      g.fillStyle = C["bg-page"];
      g.beginPath();
      g.arc(x, y, 5 * k, 0, 7);
      g.fill();
      g.fillStyle = C["text-primary"];
      g.beginPath();
      g.arc(x, y, 3 * k, 0, 7);
      g.fill();
      text(fmt(peakTop[pk], spec.unit), x, y);
    }
    for (const m of spec.marks || []) {
      const r = clipX(u, m.f, m.t);
      if (!r) continue;
      const off = m.v > ymax,
        y = off ? b.top + 2 * k : u.valToPos(m.v, "y", true);
      g.strokeStyle = C["text-primary"];
      g.lineWidth = 2 * k;
      g.setLineDash(m.dash ? [5 * k, 4 * k] : []);
      g.beginPath();
      g.moveTo(r[0], y);
      g.lineTo(r[0] + Math.max(r[1], 10 * k), y);
      g.stroke();
      g.setLineDash([]);
      if (!m.dash)
        text((off ? "↑ " : "") + m.label, r[0] + Math.max(r[1], 10 * k), y);
    }
    g.restore();
  }

  function readout(u, spec) {
    const i = u.cursor.idx,
      on = i != null && u.cursor.left >= 0;
    for (const s of [...spec.series, ...(spec.context || [])])
      $("b", s.key).textContent = on ? fmt(s.data[i], spec.unit) || "–" : "";
    if (u !== plots[0] && plots[0].cursor.left >= 0) return;
    const t = on ? D.t[i] : null,
      spans = [
        ...D.lanes.flatMap((l) => l.spans),
        ...D.charts
          .flatMap((c) => c.marks || [])
          .map((m) => ({ ...m, tip: m.label })),
      ];
    const turn =
      on &&
      spans
        .filter((s) => t >= s.f && t <= s.t)
        .map((s) => s.tip)
        .join(" · ");
    $("#sr-time").textContent = on
      ? clock(t, true) + " UTC" + (turn ? " · " + turn : "")
      : D.range;
  }
  function zoomed(u, key) {
    if (key !== "x" || lock) return;
    lock = true;
    for (const o of plots)
      if (o !== u)
        o.setScale("x", { min: u.scales.x.min, max: u.scales.x.max });
    lock = false;
    const [a, z] = xr();
    $("#sr-reset").hidden = u.scales.x.min <= a && u.scales.x.max >= z;
    lanes();
  }
  // The gap keeps a readable width at any page width; it is set before each resize.
  function fit() {
    const w = $(".plot").clientWidth - gutter(),
      n = S.length - 1,
      px = Math.min(88, w * 0.22);
    gapU = n ? (active * px) / (w - n * px) : 0;
  }
  // Lanes are HTML placed from the first plot's scale, so labels are text and follow zoom.
  function lanes() {
    const u = plots[0],
      k = dpr(),
      left = u.bbox.left / k,
      w = u.bbox.width / k;
    const place = (el, f, t) => {
      const a = Math.max(0, u.valToPos(f, "x")),
        z = Math.min(w, u.valToPos(t, "x"));
      el.style.display =
        z > a && !(el.classList.contains("gap") && z - a < 40)
          ? "block"
          : "none";
      el.style.left = left + a + "px";
      el.style.width = Math.max(z - a, 2) + "px";
    };
    // A label that would run into the one before it in its lane is dropped; its bar stays.
    document.querySelectorAll(".lane").forEach((lane) => {
      let end = -1;
      lane.querySelectorAll(".sp").forEach((el) => {
        place(el, +el.dataset.f, +el.dataset.t);
        const x = el.offsetLeft,
          clash = x < end + 4;
        el.classList.toggle("mute", clash);
        if (!clash && el.style.display !== "none")
          end = x + Math.max(el.offsetWidth, el.scrollWidth);
      });
    });
  }

  function init() {
    readTheme();
    fit();
    D.charts.forEach((c, i) => build(c, i === D.charts.length - 1));
    lanes();
    $("#sr-machine").onclick = (e) => {
      machine = !machine;
      e.currentTarget.setAttribute("aria-pressed", machine);
      for (const u of plots)
        u.all.forEach((s, i) => {
          if (s.ctx) {
            u.setSeries(i + 1, { show: machine });
            s.src.key.hidden = !machine;
          }
        });
    };
    $("#sr-reset").onclick = () => {
      const [min, max] = xr();
      plots[0].setScale("x", { min, max });
    };
    matchMedia("(prefers-color-scheme: dark)").addEventListener(
      "change",
      () => {
        readTheme();
        plots.forEach((u) => u.redraw(false));
      },
    );
  }
  document.fonts.ready.then(init);
})();
