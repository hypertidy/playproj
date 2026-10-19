// The link, embed and open-full buttons the pages share. An embedded page
// (?embed=1) hides its controls and shows a link to the full page.

export const isEmbed = () => new URLSearchParams(location.search).has("embed");
export const pageUrl = () => location.origin + location.pathname;

// Copy text, saying so on btn; where the clipboard is not available, a
// prompt shows the text to copy by hand.
export function copyText(text, btn) {
  const done = () => { const t = btn.textContent; btn.textContent = "Copied"; setTimeout(() => (btn.textContent = t), 1200); };
  if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, () => prompt("Copy:", text));
  else prompt("Copy:", text);
}

// Wire #copy-link, #copy-embed (an iframe titled title, height px tall)
// and #open-full, and mark the body when embedded.
export function shareLinks(title, { height = 480 } = {}) {
  const $ = (id) => document.getElementById(id);
  $("copy-link").addEventListener("click", (e) => copyText(pageUrl() + location.hash, e.target));
  $("copy-embed").addEventListener("click", (e) => copyText(
    `<iframe src="${pageUrl()}?embed=1${location.hash}" width="100%" height="${height}" style="border:0" loading="lazy" title="${title}"></iframe>`,
    e.target));
  $("open-full").href = pageUrl() + location.hash;
  if (isEmbed()) {
    document.body.classList.add("embed");
    $("open-full").hidden = false;
  }
}
