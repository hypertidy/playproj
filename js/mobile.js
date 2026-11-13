// Phones and narrow windows (820px and less, the breakpoint in css/app.css).
// Desktop layout is untouched: everything here is either inert above the
// breakpoint or styled only inside the @media block for body.m-shell.
//
// - the view stays on screen and the panel scrolls under it, so a swipe that
//   lands on a canvas (touch-action: none, for dragging) never traps the page;
// - a bar between view and panel can be dragged to give either more room;
// - pages of four views (#stage.quad) show one at a time, picked by tabs on
//   that bar (the views stay laid out side by side, so every one keeps its
//   size and is drawn as on the desktop);
// - the list of pages folds behind a Pages button.
//
// Loaded as a classic deferred script before each page's module, so the
// layout is in place before the page first measures its stage.
(function () {
  "use strict";
  var NARROW = "(max-width: 820px)";
  var mq = window.matchMedia(NARROW);
  var body = document.body;
  var embed = new URLSearchParams(location.search).has("embed");

  // The pages list, behind a button (on every page with a header nav).
  var nav = document.querySelector("header nav.pages");
  if (nav && !embed) {
    var head = nav.parentElement;
    var cur = nav.querySelector('[aria-current="page"]');
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "m-pages small";
    btn.setAttribute("aria-expanded", "false");
    btn.textContent = "Pages" + (cur ? ": " + cur.textContent : "");
    nav.id = nav.id || "pages-nav";
    btn.setAttribute("aria-controls", nav.id);
    btn.addEventListener("click", function () {
      var open = head.classList.toggle("m-open");
      btn.setAttribute("aria-expanded", open ? "true" : "false");
    });
    var h1 = head.querySelector("h1");
    if (h1) h1.insertAdjacentElement("afterend", btn); else head.insertBefore(btn, nav);
  }

  var app = document.getElementById("app");
  var stage = document.getElementById("stage");
  var panel = document.getElementById("panel");
  if (embed || !app || !stage || !panel) return;
  body.classList.add("m-shell");

  // The bar: a grip to drag, and tabs when the stage holds four views.
  var bar = document.createElement("div");
  bar.className = "m-bar";
  var grip = document.createElement("span");
  grip.className = "m-grip";
  grip.setAttribute("aria-hidden", "true");
  bar.appendChild(grip);
  app.insertBefore(bar, panel);

  var halves = stage.classList.contains("quad")
    ? Array.prototype.filter.call(stage.children, function (el) { return el.classList.contains("half"); })
    : [];
  var tabs = [];
  var shown = 0;
  function show(i, smooth) {
    shown = i;
    tabs.forEach(function (t, k) { t.setAttribute("aria-selected", k === i ? "true" : "false"); });
    if (mq.matches) stage.scrollTo({ left: halves[i].offsetLeft, behavior: smooth ? "smooth" : "auto" });
  }
  if (halves.length) {
    body.classList.add("m-tabs");
    var list = document.createElement("div");
    list.className = "m-tablist";
    list.setAttribute("role", "tablist");
    halves.forEach(function (h, i) {
      var c = h.querySelector("canvas");
      var name = h.dataset.tab || (c && c.getAttribute("aria-label")) || "View " + (i + 1);
      var t = document.createElement("button");
      t.type = "button";
      t.setAttribute("role", "tab");
      t.textContent = name;
      t.addEventListener("click", function () { show(i, true); });
      list.appendChild(t);
      tabs.push(t);
    });
    bar.appendChild(list);
    show(0, false);
    // keep the chosen view in place when the stage changes size
    new ResizeObserver(function () { if (mq.matches) show(shown, false); }).observe(stage);
  }

  // Drag the bar to share the height between the view and the panel.
  var drag = null;
  function setStage(px) {
    var h = window.innerHeight;
    var v = Math.max(0.2 * h, Math.min(0.88 * h, px));
    app.style.setProperty("--m-stage", Math.round(v) + "px");
  }
  bar.addEventListener("pointerdown", function (e) {
    if (!mq.matches || e.target.closest("button")) return;
    drag = { id: e.pointerId, y0: e.clientY, h0: stage.getBoundingClientRect().height };
    bar.setPointerCapture(e.pointerId);
    bar.classList.add("dragging");
    e.preventDefault();
  });
  bar.addEventListener("pointermove", function (e) {
    if (!drag || e.pointerId !== drag.id) return;
    setStage(drag.h0 + e.clientY - drag.y0);
  });
  function end(e) {
    if (!drag || e.pointerId !== drag.id) return;
    drag = null;
    bar.classList.remove("dragging");
  }
  bar.addEventListener("pointerup", end);
  bar.addEventListener("pointercancel", end);
  // back to the page's own proportions when the window widens again
  mq.addEventListener("change", function (e) {
    if (!e.matches) app.style.removeProperty("--m-stage");
    else if (halves.length) show(shown, false);
  });
})();
