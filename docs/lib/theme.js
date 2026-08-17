/*
 * Shared theme + layout helpers for the ULTRON Field Guide.
 * Every section module receives this object.
 */

const C = {
  dark:      "14291F", // deep forest — title / dividers
  forest:    "1F3D2E",
  forest2:   "2A5240",
  moss:      "8FB573", // THE PATH
  lightMoss: "C9DDB4",
  amber:     "D98E32", // THE TRAPS
  rust:      "A8482A", // danger / false positives
  paper:     "EFEAE0", // light background
  card:      "F8F6F1",
  white:     "FFFFFF",
  ink:       "16211B",
  muted:     "6B7A70",
  faint:     "DDD9D0",
  code:      "0F1F17",
};

const HEAD = "Cambria";
const BODY = "Calibri";
const MONO = "Courier New";

// The development-order track shown on every divider
const PHASES = [
  "SETUP", "MODEL", "SANDBOX", "EVAL", "DATA", "SFT",
  "RFT", "DPO", "GRPO", "REPAIR", "MERGE", "SERVE",
];

const MARKERS = {
  path: { glyph: "→", label: "THE PATH",   fill: C.moss,   fg: C.dark },
  trap: { glyph: "!",      label: "THE TRAPS",  fill: C.amber,  fg: C.dark },
  note: { glyph: "i",      label: "FIELD NOTE", fill: C.forest, fg: C.lightMoss },
  fp:   { glyph: "?",      label: "FALSE POSITIVE", fill: C.rust, fg: C.white },
};

function makeTheme(pres) {
  const T = { C, HEAD, BODY, MONO, PHASES, pres };
  let PAGE = 0;

  T.pageCount = () => PAGE;

  /* --------------------------------------------------------- primitives */

  T.num = function (slide) {
    PAGE += 1;
    slide.addText(String(PAGE), {
      x: 12.42, y: 6.94, w: 0.5, h: 0.3,
      fontFace: BODY, fontSize: 9.5, color: C.muted, align: "right", margin: 0,
    });
    return slide;
  };

  T.darkSlide = function () {
    const s = pres.addSlide();
    s.background = { color: C.dark };
    return s;
  };

  // Standard light content slide with kicker + title
  T.slide = function (kicker, title, subtitle) {
    const s = pres.addSlide();
    s.background = { color: C.paper };
    if (kicker) {
      s.addText(String(kicker).toUpperCase(), {
        x: 0.55, y: 0.32, w: 12.2, h: 0.26,
        fontFace: BODY, fontSize: 10.5, bold: true, color: C.moss,
        charSpacing: 2.2, margin: 0,
      });
    }
    s.addText(title, {
      x: 0.55, y: 0.6, w: 12.2, h: 0.56,
      fontFace: HEAD, fontSize: 29, bold: true, color: C.ink, margin: 0,
    });
    if (subtitle) {
      s.addText(subtitle, {
        x: 0.55, y: 1.14, w: 12.2, h: 0.34,
        fontFace: BODY, fontSize: 13, italic: true, color: C.muted, margin: 0,
      });
    }
    s._top = subtitle ? 1.58 : 1.3;
    return s;
  };

  // Section divider with the development-order progress track
  T.divider = function (phaseKey, kicker, title, subtitle) {
    const s = T.darkSlide();
    s.addText(String(kicker).toUpperCase(), {
      x: 0.85, y: 2.15, w: 11.6, h: 0.34,
      fontFace: BODY, fontSize: 12.5, bold: true, color: C.moss, charSpacing: 5, margin: 0,
    });
    s.addText(title, {
      x: 0.85, y: 2.55, w: 11.6, h: 0.9,
      fontFace: HEAD, fontSize: 40, bold: true, color: C.white, margin: 0,
    });
    if (subtitle) {
      s.addText(subtitle, {
        x: 0.85, y: 3.5, w: 11.0, h: 0.9,
        fontFace: BODY, fontSize: 15.5, italic: true, color: C.lightMoss, margin: 0, valign: "top",
      });
    }
    // progress track
    const idx = PHASES.indexOf(phaseKey);
    const tw = 11.6 / PHASES.length;
    s.addText("WHERE YOU ARE", {
      x: 0.85, y: 5.35, w: 11.6, h: 0.26,
      fontFace: BODY, fontSize: 9, bold: true, color: C.forest2, charSpacing: 2.5, margin: 0,
    });
    PHASES.forEach((p, i) => {
      const x = 0.85 + i * tw;
      const done = i < idx, here = i === idx;
      s.addShape(pres.ShapeType.rect, {
        x: x, y: 5.7, w: tw - 0.06, h: here ? 0.2 : 0.08,
        fill: { color: here ? C.moss : done ? C.forest2 : "27452F" },
      });
      s.addText(p, {
        x: x - 0.1, y: 5.98, w: tw + 0.14, h: 0.24,
        fontFace: BODY, fontSize: 7.5, bold: here,
        color: here ? C.moss : done ? "7A9C85" : "4C6B58",
        align: "center", margin: 0,
      });
    });
    return s;
  };

  T.marker = function (slide, kind, x, y, labelOverride) {
    const m = MARKERS[kind];
    slide.addShape(pres.ShapeType.ellipse, {
      x: x, y: y, w: 0.32, h: 0.32, fill: { color: m.fill },
    });
    slide.addText(m.glyph, {
      x: x, y: y, w: 0.32, h: 0.32,
      fontFace: BODY, fontSize: 15, bold: true, color: m.fg,
      align: "center", valign: "middle", margin: 0,
    });
    slide.addText(labelOverride || m.label, {
      x: x + 0.43, y: y + 0.02, w: 4.2, h: 0.28,
      fontFace: BODY, fontSize: 11, bold: true, color: C.ink,
      charSpacing: 1.4, valign: "middle", margin: 0,
    });
  };

  T.bullets = function (slide, items, o) {
    o = o || {};
    slide.addText(
      items.map((t, i) => ({
        text: t,
        options: { bullet: true, breakLine: i !== items.length - 1 },
      })),
      {
        x: o.x != null ? o.x : 0.55, y: o.y || 0,
        w: o.w || 5.8, h: o.h || 2.4,
        fontFace: BODY, fontSize: o.size || 12.5, color: o.color || C.ink,
        paraSpaceAfter: o.gap != null ? o.gap : 6, margin: 0, valign: "top",
      }
    );
  };

  T.card = function (slide, x, y, w, h, fill, noShadow) {
    const opt = {
      x: x, y: y, w: w, h: h,
      fill: { color: fill || C.card }, rectRadius: 0.07,
      line: { color: C.paper, width: 0 },
    };
    if (!noShadow) {
      opt.shadow = { type: "outer", angle: 90, offset: 1, blur: 4, color: "000000", opacity: 0.06 };
    }
    slide.addShape(pres.ShapeType.roundRect, opt);
  };

  T.fieldNote = function (slide, x, y, w, h, text) {
    slide.addShape(pres.ShapeType.roundRect, {
      x: x, y: y, w: w, h: h, fill: { color: C.forest }, rectRadius: 0.07,
    });
    T.marker(slide, "note", x + 0.26, y + 0.2);
    slide.addText(text, {
      x: x + 0.26, y: y + 0.63, w: w - 0.52, h: h - 0.82,
      fontFace: BODY, fontSize: 11.5, italic: true, color: C.lightMoss,
      margin: 0, valign: "top",
    });
  };

  T.codeBlock = function (slide, x, y, w, h, lines, title) {
    slide.addShape(pres.ShapeType.roundRect, {
      x: x, y: y, w: w, h: h, fill: { color: C.code }, rectRadius: 0.06,
    });
    let ty = y + 0.16;
    if (title) {
      slide.addText(title, {
        x: x + 0.24, y: ty, w: w - 0.48, h: 0.24,
        fontFace: BODY, fontSize: 9.5, bold: true, color: C.moss, charSpacing: 1.5, margin: 0,
      });
      ty += 0.3;
    }
    slide.addText(
      lines.map((l, i) => ({
        text: l.t != null ? l.t : l,
        options: {
          color: l.c || C.lightMoss,
          breakLine: i !== lines.length - 1,
          bold: !!l.b,
        },
      })),
      {
        x: x + 0.24, y: ty, w: w - 0.48, h: h - (ty - y) - 0.16,
        fontFace: MONO, fontSize: 10, margin: 0, valign: "top", lineSpacingMultiple: 1.12,
      }
    );
  };

  /* ------------------------------------------------- composite layouts */

  // The workhorse: PATH left / TRAPS right / FIELD NOTE bottom
  T.ptn = function (kicker, title, pathItems, trapItems, note, opts) {
    opts = opts || {};
    const s = T.slide(kicker, title, opts.subtitle);
    const top = s._top + 0.16;
    T.marker(s, "path", 0.55, top);
    T.bullets(s, pathItems, {
      x: 0.55, y: top + 0.46, w: 5.9, h: opts.bodyH || 3.0,
      size: opts.size || 12.5,
    });
    T.marker(s, "trap", 6.9, top);
    T.bullets(s, trapItems, {
      x: 6.9, y: top + 0.46, w: 5.85, h: opts.bodyH || 3.0,
      size: opts.size || 12.5, color: C.rust,
    });
    if (note) {
      const nh = opts.noteH || 1.5;
      T.fieldNote(s, 0.55, 7.0 - 0.22 - nh, 12.2, nh, note);
    }
    return s;
  };

  // Rows of numbered cards. Auto-shrinks to fit between y and opts.bottom.
  T.steps = function (slide, y, items, opts) {
    opts = opts || {};
    const gap = opts.gap != null ? opts.gap : 0.12;
    const bottom = opts.bottom != null ? opts.bottom : 7.05;
    let h = opts.h || 1.05;
    const avail = bottom - y;
    const needed = items.length * h + (items.length - 1) * gap;
    if (needed > avail) h = (avail - (items.length - 1) * gap) / items.length;
    items.forEach(([head, desc], i) => {
      const yy = y + i * (h + gap);
      T.card(slide, 0.55, yy, 12.2, h, C.white);
      slide.addShape(pres.ShapeType.ellipse, {
        x: 0.82, y: yy + (h - 0.44) / 2, w: 0.44, h: 0.44,
        fill: { color: opts.color || C.moss },
      });
      slide.addText(opts.labels ? opts.labels[i] : String(i + 1), {
        x: 0.82, y: yy + (h - 0.44) / 2, w: 0.44, h: 0.44,
        fontFace: HEAD, fontSize: 15, bold: true, color: C.dark,
        align: "center", valign: "middle", margin: 0,
      });
      slide.addText(head, {
        x: 1.44, y: yy + 0.14, w: 11.0, h: 0.3,
        fontFace: BODY, fontSize: 13, bold: true, color: C.ink, margin: 0,
      });
      slide.addText(desc, {
        x: 1.44, y: yy + 0.46, w: 11.0, h: h - 0.56,
        fontFace: BODY, fontSize: 11.5, color: C.muted, margin: 0, valign: "top",
      });
    });
  };

  // Left-accent bar rows (used for reward terms, checklists, etc.)
  T.accentRows = function (slide, y, rows, opts) {
    opts = opts || {};
    const gap = opts.gap != null ? opts.gap : 0.1;
    const bottom = opts.bottom != null ? opts.bottom : 7.05;
    let h = opts.h || 0.95;
    const avail = bottom - y;
    const needed = rows.length * h + (rows.length - 1) * gap;
    if (needed > avail) h = (avail - (rows.length - 1) * gap) / rows.length;
    rows.forEach(([label, mid, desc, col], i) => {
      const yy = y + i * (h + gap);
      T.card(slide, 0.55, yy, 12.2, h, C.white);
      slide.addShape(pres.ShapeType.rect, {
        x: 0.55, y: yy, w: 0.1, h: h, fill: { color: col || C.moss },
      });
      slide.addText(label, {
        x: 0.9, y: yy + 0.12, w: opts.labelW || 2.8, h: 0.3,
        fontFace: BODY, fontSize: 12.5, bold: true, color: C.ink, margin: 0,
      });
      if (mid) {
        slide.addText(mid, {
          x: 0.9, y: yy + 0.44, w: opts.labelW || 2.8, h: 0.34,
          fontFace: MONO, fontSize: 9.5, color: C.muted, margin: 0, valign: "top",
        });
      }
      slide.addText(desc, {
        x: 0.9 + (opts.labelW || 2.8) + 0.25, y: yy + 0.1,
        w: 12.75 - (0.9 + (opts.labelW || 2.8) + 0.25), h: h - 0.2,
        fontFace: BODY, fontSize: 11.8, color: C.ink, margin: 0, valign: "middle",
      });
    });
  };

  // Grid of small cards. opts.x / opts.w confine it to a column.
  T.grid = function (slide, y, items, opts) {
    opts = opts || {};
    const cols = opts.cols || 3;
    const h = opts.h || 1.5;
    const ox = opts.x != null ? opts.x : 0.55;
    const ow = opts.w != null ? opts.w : 12.2;
    const gapX = 0.16, gapY = opts.gapY != null ? opts.gapY : 0.16;
    const w = (ow - gapX * (cols - 1)) / cols;
    items.forEach(([head, body, col], i) => {
      const cx = ox + (i % cols) * (w + gapX);
      const cy = y + Math.floor(i / cols) * (h + gapY);
      T.card(slide, cx, cy, w, h, opts.fill || C.white);
      slide.addText(head, {
        x: cx + 0.24, y: cy + 0.16, w: w - 0.48, h: 0.32,
        fontFace: BODY, fontSize: 12.5, bold: true, color: col || C.ink, margin: 0,
      });
      slide.addText(body, {
        x: cx + 0.24, y: cy + 0.5, w: w - 0.48, h: h - 0.66,
        fontFace: BODY, fontSize: 11, color: C.muted, margin: 0, valign: "top",
      });
    });
  };

  // Horizontal pipeline of steps
  T.pipeline = function (slide, y, steps, opts) {
    opts = opts || {};
    const h = opts.h || 1.35;
    const n = steps.length;
    const arrowW = 0.38;
    const w = (12.2 - arrowW * (n - 1)) / n;
    let x = 0.55;
    steps.forEach(([t, d, col], i) => {
      T.card(slide, x, y, w, h, C.white);
      slide.addText(t, {
        x: x + 0.18, y: y + 0.15, w: w - 0.36, h: 0.28,
        fontFace: BODY, fontSize: 11, bold: true, color: col || C.moss, charSpacing: 1.2, margin: 0,
      });
      slide.addText(d, {
        x: x + 0.18, y: y + 0.46, w: w - 0.36, h: h - 0.6,
        fontFace: BODY, fontSize: 10.5, color: C.ink, margin: 0, valign: "top",
      });
      if (i < n - 1) {
        slide.addText("→", {
          x: x + w, y: y, w: arrowW, h: h,
          fontFace: BODY, fontSize: 19, bold: true, color: C.moss,
          align: "center", valign: "middle", margin: 0,
        });
      }
      x += w + arrowW;
    });
  };

  // Standard data table
  T.table = function (slide, y, header, rows, colW, opts) {
    opts = opts || {};
    const head = header.map(t => ({
      text: t,
      options: { bold: true, color: C.white, fill: { color: C.forest } },
    }));
    slide.addTable([head].concat(rows), {
      x: 0.55, y: y, w: 12.2, colW: colW,
      fontFace: BODY, fontSize: opts.size || 11.5, color: C.ink,
      border: { type: "solid", color: C.paper, pt: 1 },
      fill: { color: C.white }, rowH: opts.rowH || 0.34, valign: "middle",
    });
  };

  // Big number callout
  T.stat = function (slide, x, y, big, label, col) {
    slide.addText(big, {
      x: x, y: y, w: 3.2, h: 1.0,
      fontFace: HEAD, fontSize: 52, bold: true, color: col || C.moss, margin: 0,
    });
    slide.addText(label, {
      x: x, y: y + 1.0, w: 3.2, h: 0.5,
      fontFace: BODY, fontSize: 11.5, color: C.muted, margin: 0, valign: "top",
    });
  };

  // A callout banner
  T.banner = function (slide, y, text, col, h) {
    slide.addShape(pres.ShapeType.roundRect, {
      x: 0.55, y: y, w: 12.2, h: h || 0.62,
      fill: { color: col || C.forest }, rectRadius: 0.06,
    });
    slide.addText(text, {
      x: 0.85, y: y, w: 11.6, h: h || 0.62,
      fontFace: HEAD, fontSize: 14.5, bold: true,
      color: col === C.amber || col === C.moss ? C.dark : C.lightMoss,
      valign: "middle", margin: 0,
    });
  };

  // Two comparison columns
  T.compare = function (slide, y, h, left, right) {
    [[0.55, left, C.moss], [6.75, right, C.rust]].forEach(([x, col, accent]) => {
      T.card(slide, x, y, 6.0, h, C.white);
      slide.addText(col.title, {
        x: x + 0.28, y: y + 0.18, w: 5.44, h: 0.32,
        fontFace: BODY, fontSize: 12.5, bold: true, color: accent, charSpacing: 1.2, margin: 0,
      });
      T.bullets(slide, col.items, {
        x: x + 0.28, y: y + 0.58, w: 5.44, h: h - 0.76, size: col.size || 11.5,
      });
    });
  };

  return T;
}

module.exports = { makeTheme, C, HEAD, BODY, MONO, PHASES };
