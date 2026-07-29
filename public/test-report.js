/**
 * test-report.js
 *
 * Split out of test-report.html rather than left inline.
 *
 * The site ships an enforcing Content-Security-Policy with script-src
 * 'self' and no 'unsafe-inline' and no nonce, so an inline <script> on this
 * page is not weakened, it is refused outright: every button on the form did
 * nothing once deployed, while working perfectly from a local file open.
 *
 * Keep this external. Folding it back into the page would silently break the
 * form again on the live site and nowhere else.
 */

const SUBMISSION_EMAIL="info@aurtech.mx";

/* ── Screenshots ───────────────────────────────────────────────────────────
   Read locally, scaled down, and embedded in the downloaded report.

   A browser cannot attach a local file to a mailto: message, and a plain
   upload would need a server holding other people's screenshots. Downscaling
   is not cosmetic: base64 adds about a third again, and a few untouched phone
   screenshots exceed what mail servers accept, so a 1600px cap keeps a report
   with several images inside a normal attachment limit while staying legible.
*/
const SHOT_MAX_EDGE = 1600, SHOT_QUALITY = 0.8;
let shots = [];

function scaleDown(file){
  return new Promise((resolve,reject)=>{
    const img = new Image(), url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, SHOT_MAX_EDGE / Math.max(img.width, img.height));
      const w = Math.round(img.width*scale), h = Math.round(img.height*scale);
      const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
      cv.getContext("2d").drawImage(img,0,0,w,h);
      resolve({ name: file.name, w, h, dataUrl: cv.toDataURL("image/jpeg", SHOT_QUALITY) });
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Not a readable image: "+file.name)); };
    img.src = url;
  });
}

const shotInput = document.getElementById("shots");
const shotStatus = document.getElementById("shotStatus");
if (shotInput) shotInput.onchange = async () => {
  shotStatus.textContent = "Reading…";
  try {
    shots = await Promise.all([...shotInput.files].map(scaleDown));
    const kb = Math.round(shots.reduce((n,s)=>n+s.dataUrl.length,0)*0.75/1024);
    shotStatus.textContent = shots.length
      ? `${shots.length} screenshot(s) ready, about ${kb} KB once embedded.`
      : "No screenshots selected.";
  } catch (e) {
    shots = [];
    shotStatus.textContent = e.message;
  }
};

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
function buildHtmlReport(text){
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

const form=document.getElementById("form"),preview=document.getElementById("preview"),statusBox=document.getElementById("status");
const credit=document.getElementById("creditConsent"),creditFields=document.getElementById("creditFields");
const research=document.getElementById("researchConsent"),adultRow=document.getElementById("adultRow"),adult=document.getElementById("adultConfirm");
credit.addEventListener("change",()=>creditFields.classList.toggle("hidden",!credit.checked));
research.addEventListener("change",()=>{adultRow.classList.toggle("hidden",!research.checked);adult.required=research.checked;if(!research.checked)adult.checked=false});
const val=(fd,k)=>{const v=fd.get(k);return typeof v==="string"&&v.trim()?v.trim():"Not provided"};
const yes=(fd,k)=>fd.get(k)==="on"?"Yes":"No";
function build(){
  if(!form.reportValidity()){statusBox.textContent="Please complete the required fields and confirmation.";return ""}
  const fd=new FormData(form);
  const r=[
    "OPENLIDARVIEWER EXTERNAL TEST REPORT",`Generated: ${new Date().toISOString()}`,"",
    "SETUP",`Name or alias: ${val(fd,"name")}`,`Email: ${val(fd,"email")}`,`Role / affiliation: ${val(fd,"role")}`,`OLV version or link: ${val(fd,"olvVersion")}`,`Operating system: ${val(fd,"os")}`,`Browser + version: ${val(fd,"browser")}`,`Reference software: ${val(fd,"reference")}`,`Dataset: ${val(fd,"dataset")}`,"",
    "QUICK REPORT",`What was tested:\n${val(fd,"tested")}`,"",`What worked or matched well:\n${val(fd,"worked")}`,"",`What differed, failed, or looked unclear:\n${val(fd,"issues")}`,"",`Most important improvement:\n${val(fd,"priority")}`,"",`Reproduction steps:\n${val(fd,"steps")}`,"",
    "OPTIONAL DETAILED COMPARISON",`Georeferenced case tested: ${yes(fd,"geoCase")}`,`Limited-metadata case tested: ${yes(fd,"limitedCase")}`,`Cloud complete/oriented: ${yes(fd,"completeCloud")}`,`Warnings clear: ${yes(fd,"clearWarnings")}`,`Format / size: ${val(fd,"formatSize")}`,`Ground class: ${val(fd,"groundClass")}`,`Point count — OLV: ${val(fd,"pointsOlv")}`,`Point count — reference: ${val(fd,"pointsRef")}`,`CRS — OLV: ${val(fd,"crsOlv")}`,`CRS — reference: ${val(fd,"crsRef")}`,`Units — OLV: ${val(fd,"unitsOlv")}`,`Units — reference: ${val(fd,"unitsRef")}`,`Bounds / Z — OLV: ${val(fd,"boundsOlv")}`,`Bounds / Z — reference: ${val(fd,"boundsRef")}`,`Elevation comparisons:\n${val(fd,"elevations")}`,`Distance / height:\n${val(fd,"distance")}`,`Terrain products:\n${val(fd,"terrain")}`,`Workflow observations:\n${val(fd,"workflow")}`,"",
    "ATTACHMENTS",val(fd,"attachments"),"",
    "PERMISSIONS",`Voluntary/project-use confirmation: ${yes(fd,"coreConsent")}`,`Public credit allowed: ${yes(fd,"creditConsent")}`,`Preferred credit wording: ${val(fd,"creditWording")}`,`LinkedIn / ORCID: ${val(fd,"profile")}`,`Optional research use allowed: ${yes(fd,"researchConsent")}`,`18+ confirmed for research use: ${yes(fd,"adultConfirm")}`,"",
    "Contributor statement:","I confirm that my participation is voluntary and unpaid, that I have the right to share the material, and that it contains no confidential or restricted information. The software was tested at my own discretion, and submission does not guarantee payment, public credit, academic authorship, endorsement, publication, or use of the contribution."
  ].join("\n");
  preview.value=r;statusBox.textContent="Report generated. Review it before sending.";statusBox.classList.remove("err");return r;
}
document.getElementById("generate").onclick=build;
document.getElementById("copy").onclick=async()=>{const r=preview.value||build();if(!r)return;try{await navigator.clipboard.writeText(r);statusBox.textContent="Report copied."}catch{preview.select();document.execCommand("copy");statusBox.textContent="Report selected/copied."}};
document.getElementById("download").onclick=()=>{
  const r = preview.value || build();
  if (!r) return;
  // With screenshots, one self-contained HTML file beats a .txt the tester has
  // to remember to send several images alongside.
  const withShots = shots.length > 0;
  const body = withShots ? buildHtmlReport(r) : r;
  const blob = new Blob([body], { type: withShots ? "text/html;charset=utf-8" : "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob), a = document.createElement("a");
  a.href = url;
  a.download = `OLV-external-test-${new Date().toISOString().slice(0,10)}.${withShots ? "html" : "txt"}`;
  a.click();
  URL.revokeObjectURL(url);
  statusBox.textContent = withShots
    ? `Report downloaded with ${shots.length} screenshot(s) inside. Send that one file.`
    : "Report downloaded. Attach it to your email.";
};
/* ── Sending ───────────────────────────────────────────────────────────────
   The same self-contained file the Download button produces is POSTed as one
   upload. Sending the fields separately would leave the server to re-assemble
   a report that the tester never actually saw, and the point of the preview is
   that what they read is what arrives.

   Failure is treated as expected rather than exceptional. A tester on hotel
   wifi, or behind a proxy that eats large POSTs, should still be able to
   contribute, so every failure path ends by pointing at Download.
*/
const ENDPOINT = "submit-test-report.php";
const sendBtn = document.getElementById("send");

function say(text, isError){
  statusBox.textContent = text;
  statusBox.classList.toggle("err", !!isError);
}

sendBtn.onclick = async () => {
  const r = preview.value || build();
  if (!r) return;

  // Always the HTML wrapper, even with no screenshots. Storing raw text under
  // an .html name means whoever opens it reads one collapsed paragraph, and the
  // <pre> in the wrapper is what keeps the report's line breaks.
  const withShots = shots.length > 0;
  const blob = new Blob([buildHtmlReport(r)], { type: "text/html;charset=utf-8" });

  if (blob.size > 12 * 1024 * 1024) {
    say("This report is over the 12 MB limit. Remove a screenshot, or download it and email it instead.", true);
    return;
  }

  const payload = new FormData();
  payload.append("report", blob, "report.html");
  payload.append("website", form.elements.website ? form.elements.website.value : "");

  sendBtn.disabled = true;
  say("Sending…");
  try {
    const res = await fetch(ENDPOINT, { method: "POST", body: payload });
    // A misconfigured host answers 200 with the PHP source or an HTML error
    // page. Requiring the JSON this endpoint returns stops that from being
    // reported to the tester as a successful submission.
    let data = null;
    try { data = await res.json(); } catch { /* handled below */ }

    if (res.ok && data && data.ok) {
      say(withShots
        ? `Sent, with ${shots.length} screenshot(s) included. Thank you.`
        : "Sent. Thank you.");
      sendBtn.textContent = "Sent";
      return;
    }
    say((data && data.message)
      ? data.message + " You can download the report and email it instead."
      : "The server did not accept the report. Please download it and email it instead.", true);
  } catch {
    say("Could not reach the server. Please download the report and email it instead.", true);
  } finally {
    if (sendBtn.textContent !== "Sent") sendBtn.disabled = false;
  }
};

document.getElementById("email").onclick=()=>{const r=preview.value||build();if(!r)return;if(SUBMISSION_EMAIL.includes("YOUR_EMAIL")){statusBox.textContent="Set SUBMISSION_EMAIL in the HTML before publishing.";return}const fd=new FormData(form),who=val(fd,"name")==="Not provided"?"anonymous tester":val(fd,"name"),body=r.length>5500?r.slice(0,5000)+"\n\n[Shortened for email compatibility; attach the full .txt report.]":r;location.href=`mailto:${encodeURIComponent(SUBMISSION_EMAIL)}?subject=${encodeURIComponent("OLV external test report — "+who)}&body=${encodeURIComponent(body)}`};
form.addEventListener("reset",()=>setTimeout(()=>{preview.value="";statusBox.textContent="Form cleared.";statusBox.classList.remove("err");sendBtn.disabled=false;sendBtn.textContent="Send report";creditFields.classList.add("hidden");adultRow.classList.add("hidden");adult.required=false},0));
