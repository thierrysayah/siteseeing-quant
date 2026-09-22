import { jsPDF } from "jspdf";

/**
 * Agent report → PDF, in the SAME format as the Export tab's "PDF Report":
 * A4 portrait, dark cover with accent bars + QUANT logo, accent header bar on
 * every content page, blue-header zebra tables, dated footer rule.
 *
 * Content: cover → summary (headline totals) → narrative (the QS sections)
 * → quantity schedule (rooms / doors / windows / walls) → annotated plan image.
 * Every number comes from report.schedule (computed server-side), never re-derived.
 */
export async function buildAgentReportPdf({ report, projectName, userName, scaleLabel, pageImageDataUrl }) {
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const W = 210, H = 297, MARGIN = 14, COL = W - MARGIN * 2;
  const ACCENT = [30, 80, 160], DARK = [15, 23, 40], LIGHT = [200, 208, 224], MUTED = [100, 120, 150];
  const sc = report.schedule || {}, t = sc.totals || {}, metric = !!sc.hasScale;
  const fmt = (v, d = 2) => (v == null || v === "" ? "—" : typeof v === "number" ? v.toFixed(d) : String(v));
  const name = projectName || report.project?.name || "Untitled Project";
  const today = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });

  const hRule = (y, r = ACCENT[0], g = ACCENT[1], b = ACCENT[2]) => {
    doc.setDrawColor(r, g, b); doc.setLineWidth(0.4); doc.line(MARGIN, y, W - MARGIN, y);
  };
  const headerBar = () => {
    doc.setFillColor(...ACCENT); doc.rect(0, 0, W, 12, "F");
    doc.setTextColor(255, 255, 255); doc.setFont("helvetica", "bold"); doc.setFontSize(9);
    doc.text(name, MARGIN, 8);
    doc.setFont("helvetica", "normal"); doc.setFontSize(8);
    doc.text("Agentic Takeoff", W - MARGIN, 8, { align: "right" });
  };
  let y = 0;
  const newPage = () => { doc.addPage(); headerBar(); y = 20; };
  const ensure = (h) => { if (y + h > H - 14) newPage(); };
  const sectionTitle = (txt, size = 14) => {
    ensure(size + 8);
    doc.setTextColor(...DARK); doc.setFont("helvetica", "bold"); doc.setFontSize(size);
    doc.text(txt, MARGIN, y); y += 3; hRule(y); y += 6;
  };
  const subTitle = (txt) => {
    ensure(12);
    doc.setTextColor(...DARK); doc.setFont("helvetica", "bold"); doc.setFontSize(11);
    doc.text(txt, MARGIN, y); y += 2; hRule(y, 180, 200, 220); y += 5;
  };
  const paragraph = (txt, { size = 9, italic = false, color = DARK, indent = 0 } = {}) => {
    doc.setFont("helvetica", italic ? "italic" : "normal"); doc.setFontSize(size); doc.setTextColor(...color);
    const lines = doc.splitTextToSize(txt, COL - indent);
    const lh = size * 0.5;
    for (const ln of lines) { ensure(lh + 1); doc.text(ln, MARGIN + indent, y); y += lh; }
    y += 1.5;
  };
  const bullet = (txt) => {
    doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(...DARK);
    const lines = doc.splitTextToSize(txt, COL - 6);
    lines.forEach((ln, i) => { ensure(5.5); doc.text(i === 0 ? "•" : "", MARGIN + 1, y); doc.text(ln, MARGIN + 6, y); y += 4.5; });
    y += 0.5;
  };
  // Table in the export's style: accent header, zebra rows, border rect. Page-break aware.
  const table = (headers, rows, widths) => {
    const ROW_H = 8;
    const xs = []; let x = MARGIN; for (const w of widths) { xs.push(x); x += w; }
    const drawHeader = () => {
      doc.setFillColor(...ACCENT); doc.rect(MARGIN, y, COL, ROW_H, "F");
      doc.setTextColor(255, 255, 255); doc.setFont("helvetica", "bold"); doc.setFontSize(9);
      headers.forEach((h, i) => doc.text(h, xs[i] + 2, y + 5.5));
      y += ROW_H;
    };
    ensure(ROW_H * 2 + 4);
    let top = y; drawHeader();
    rows.forEach((r, i) => {
      if (y + ROW_H > H - 14) { doc.setDrawColor(180, 200, 220); doc.setLineWidth(0.3); doc.rect(MARGIN, top, COL, y - top); newPage(); top = y; drawHeader(); }
      doc.setFillColor(i % 2 === 0 ? 235 : 245, i % 2 === 0 ? 242 : 247, i % 2 === 0 ? 252 : 255);
      doc.rect(MARGIN, y, COL, ROW_H, "F");
      doc.setTextColor(...DARK); doc.setFont("helvetica", "normal"); doc.setFontSize(9);
      r.forEach((cell, ci) => {
        const maxW = widths[ci] - 4;
        let s = String(cell ?? "—");
        while (doc.getTextWidth(s) > maxW && s.length > 3) s = s.slice(0, -2) + "…";
        doc.text(s, xs[ci] + 2, y + 5.5);
      });
      y += ROW_H;
    });
    doc.setDrawColor(180, 200, 220); doc.setLineWidth(0.3); doc.rect(MARGIN, top, COL, y - top);
    y += 6;
  };

  // ══ COVER PAGE ═══════════════════════════════════════════════════════════
  doc.setFillColor(...DARK); doc.rect(0, 0, W, H, "F");
  doc.setFillColor(...ACCENT); doc.rect(0, 70, W, 2, "F"); doc.rect(0, 145, W, 2, "F");
  const LOGO_SIZE = 14, LOGO_X = MARGIN, LOGO_Y = MARGIN;
  try {
    const blob = await (await fetch("/logo.png")).blob();
    const b64 = await new Promise(res => { const rd = new FileReader(); rd.onload = () => res(rd.result); rd.readAsDataURL(blob); });
    doc.addImage(b64, "PNG", LOGO_X, LOGO_Y, LOGO_SIZE, LOGO_SIZE);
  } catch { /* logo optional */ }
  doc.setTextColor(100, 210, 255); doc.setFont("helvetica", "bold"); doc.setFontSize(14);
  doc.text("QUANT", LOGO_X + LOGO_SIZE + 3, LOGO_Y + 10);
  doc.setTextColor(200, 240, 255); doc.setFont("helvetica", "bold"); doc.setFontSize(26);
  doc.text("Quantity Takeoff Report", W / 2, 95, { align: "center" });
  doc.setTextColor(...LIGHT); doc.setFontSize(16); doc.setFont("helvetica", "normal");
  doc.text(name, W / 2, 112, { align: "center" });
  doc.setFontSize(10); doc.setTextColor(...MUTED);
  const meta = [
    `Prepared by: ${userName || "Unknown"}`,
    `Generated: ${today}`,
    `Scale: ${scaleLabel || (report.scaleDenom ? `1:${report.scaleDenom}` : "not set")}`,
  ];
  const dwg = [report.project?.drawingNumber && `Drawing ${report.project.drawingNumber}`, report.project?.revision && `Rev ${report.project.revision}`, report.project?.page && `Sheet ${report.project.page}`].filter(Boolean).join(" · ");
  if (dwg) meta.push(dwg);
  meta.push("Agentic takeoff — quantities only, unpriced");
  meta.forEach((m, i) => doc.text(m, W / 2, 157 + i * 10, { align: "center" }));

  // ══ SUMMARY ══════════════════════════════════════════════════════════════
  newPage();
  sectionTitle("Summary");
  const rows = [["Zones / rooms", String(t.zones ?? 0)]];
  if (metric) rows.push(["Floor area (m²)", fmt(t.floorAreaM2)]);
  rows.push(["Doors", String(t.doors ?? 0)], ["Windows", String(t.windows ?? 0)]);
  if (metric) rows.push(["Wall length (m)", fmt(t.wallLengthM)]);
  rows.push(["Review flags still open", String(t.outstandingReviewFlags ?? 0)]);
  table(["Item", "Quantity"], rows, [COL - 50, 50]);
  if (!metric) paragraph("No scale was set for this run — quantities are in pixel units, not real-world measurements.", { italic: true, color: [180, 60, 60] });

  // ══ NARRATIVE ════════════════════════════════════════════════════════════
  const md = String(report.narrative || "");
  const lines = md.split("\n");
  let para = [];
  const flush = () => { if (para.length) { paragraph(para.join(" ").replace(/\*\*/g, "")); para = []; } };
  for (const raw of lines) {
    const ln = raw.trimEnd();
    if (/^##\s+/.test(ln)) { flush(); y += 2; subTitle(ln.replace(/^##\s+/, "")); }
    else if (/^#\s+/.test(ln)) { flush(); sectionTitle(ln.replace(/^#\s+/, "")); }
    else if (/^\s*[-*]\s+/.test(ln)) { flush(); bullet(ln.replace(/^\s*[-*]\s+/, "").replace(/\*\*/g, "")); }
    else if (!ln.trim()) flush();
    else para.push(ln.trim());
  }
  flush();

  // ══ QUANTITY SCHEDULE ════════════════════════════════════════════════════
  newPage();
  sectionTitle("Quantity Schedule");
  if (sc.rooms?.length) {
    subTitle("Rooms / zones");
    table(metric ? ["Room", "Qty", "Area (m²)", "Perimeter (m)"] : ["Room", "Qty", "Area (px²)"],
      sc.rooms.map(r => metric ? [r.tag, r.count, fmt(r.areaM2), fmt(r.perimM)] : [r.tag, r.count, r.areaPx]),
      metric ? [COL - 95, 25, 35, 35] : [COL - 60, 25, 35]);
  }
  const dw = (title, list) => {
    if (!list?.length) return;
    subTitle(title);
    table(["Mark", "Qty", "W (mm)", "H (mm)", "Type", "Schedule qty"],
      list.map(r => [r.mark, r.count, r.width_mm ?? "—", r.height_mm ?? "—", r.type ?? "—", r.scheduleCount ?? "—"]),
      [34, 18, 22, 22, COL - 34 - 18 - 22 - 22 - 28, 28]);
  };
  dw("Doors", sc.doors); dw("Windows", sc.windows);
  if (sc.walls?.length) {
    subTitle("Walls");
    table(metric ? ["Class", "Qty", "Length (m)"] : ["Class", "Qty", "Length (px)"],
      sc.walls.map(r => metric ? [r.cls, r.count, fmt(r.lengthM)] : [r.cls, r.count, r.lengthPx]),
      [COL - 60, 25, 35]);
  }

  // ══ ANNOTATED PLAN ═══════════════════════════════════════════════════════
  if (pageImageDataUrl) {
    newPage();
    sectionTitle("Annotated Plan");
    try {
      const props = doc.getImageProperties(pageImageDataUrl);
      const maxW = COL, maxH = H - y - 20;
      const s = Math.min(maxW / props.width, maxH / props.height);
      doc.addImage(pageImageDataUrl, "JPEG", MARGIN, y, props.width * s, props.height * s);
    } catch { /* image optional */ }
  }

  // ══ FOOTER on every content page ═════════════════════════════════════════
  const n = doc.getNumberOfPages();
  for (let p = 2; p <= n; p++) {
    doc.setPage(p);
    doc.setFontSize(7); doc.setTextColor(...MUTED); doc.setFont("helvetica", "normal");
    doc.text(new Date().toLocaleDateString("en-GB"), W - MARGIN, H - 6, { align: "right" });
    doc.text(`Page ${p - 1} of ${n - 1}`, MARGIN, H - 6);
    hRule(H - 9, 50, 70, 100);
  }
  return doc;
}

export async function downloadAgentReportPdf(args) {
  const doc = await buildAgentReportPdf(args);
  const slug = (args.projectName || args.report?.project?.name || "report").replace(/[^a-z0-9]/gi, "_");
  doc.save(`QT_Agent_${slug}.pdf`);
}
