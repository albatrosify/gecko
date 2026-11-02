const t0 = Date.now();
const res = await fetch("http://127.0.0.1:8850/xmltv.php?username=live&password=tv", { signal: AbortSignal.timeout(300000) });
console.log("HTTP", res.status, "ct:", res.headers.get("content-type"));
const text = await res.text();
const chans = [...text.matchAll(/<channel id="([^"]*)"/g)].map(m => m[1]);
const dupCount = chans.length - new Set(chans).size;
console.log(`built in ${((Date.now() - t0) / 1000).toFixed(1)}s: len=${(text.length / 1e6).toFixed(2)}MB, channels=${chans.length}, duplicates=${dupCount}, programmes=${(text.match(/<programme /g) || []).length}`);
for (const p of ["ProSieben.de", "ProSiebenMAXX.de", "RTL.de", "RTLZWEI.de", "VOX.de", "WDRDortmund.de"]) {
  const rx = new RegExp(`<programme[^>]*channel="${p}"`, "g");
  console.log(`  ${p}: ${(text.match(rx) || []).length} programmes`);
}
