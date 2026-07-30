/**
 * test-report-format.js
 *
 * The two pure pieces of the testing form: escaping, and assembling the
 * self-contained report.
 *
 * Separate from the DOM wiring so they can be tested. They are also the part
 * most worth testing: the report is opened by the maintainer, and the strings
 * inside it come from a stranger's file picker and a stranger's typing. A gap
 * in the escaping is an attack on whoever reads the submission, not on the
 * person who sent it.
 *
 * `shots` is a parameter rather than module state, so a test can describe the
 * screenshots it wants instead of driving a canvas to produce them.
 */

/* Escapes quotes as well as angle brackets, because the result is used in an
   attribute as well as in text. Without the quote cases a filename containing
   one closes alt="..." early and everything after it is parsed as markup. The
   name comes from the tester's own file picker, so the risk is not to them: it
   is to whoever opens the report they email, which is the maintainer. */
function escapeHtml(t){
  return String(t).replace(/[&<>"']/g, c => ({
    "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;",
  }[c]));
}

/** A self-contained HTML report: the text, then each screenshot inline. */
function buildHtmlReport(text, shots = []){
  const imgs = shots.map(s =>
    `<figure><img alt="${escapeHtml(s.name)}" src="${s.dataUrl}">`
    + `<figcaption>${escapeHtml(s.name)} (${s.w}x${s.h})</figcaption></figure>`).join("\n");
  return `<!doctype html><meta charset="utf-8">
<title>OpenLiDARViewer external test report</title>
<style>body{font:14px/1.5 system-ui,sans-serif;max-width:900px;margin:2rem auto;padding:0 1rem}
pre{white-space:pre-wrap;background:#f5f5f7;padding:1rem;border-radius:8px}
img{max-width:100%;border:1px solid #ccc;border-radius:6px}
figcaption{color:#555;font-size:12px;margin:.35rem 0 1.5rem}</style>
<pre>${escapeHtml(text)}</pre>
${imgs}`;
}

export { escapeHtml, buildHtmlReport };
