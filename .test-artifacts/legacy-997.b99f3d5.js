"use strict";
(self.webpackChunkblessing_skin_server = self.webpackChunkblessing_skin_server || []).push([[997, 846, 613], { 1997: function(e, t, n) {
  n.r(t), n.d(t, { PICTURES_COUNT: function() {
    return f;
  } });
  var a = n(5944), i = n(7294), o = n(917), s = n(786), r = n(1565), c = n(88), l = n(6051), d = n(550), u = n(70);
  const A = [n(553), n(8348), n(2214), n(5034), n(9486), n(9483), n(8862)], f = A.length, p = { walk: null, run: null, rotate: null }, g = s.Z.i`
  display: inline;
  padding: 0.5em 0.5em;
  &:hover {
    color: #555;
    cursor: pointer;
  }
`, v = o.iv`
  ${d.tS(d.Uo.lg)} {
    min-height: 500px;
  }
  width: 100%;

  canvas {
    cursor: move;
  }
`;
  t.default = (e2) => {
    const { initPositionZ: t2 = 70 } = e2, n2 = (0, i.useRef)(null), o2 = (0, i.useRef)(null), s2 = (0, i.useRef)(p), [d2, m] = (0, i.useState)(false), [b, w] = (0, i.useState)(false), [k, h] = (0, i.useState)(-1), C = (() => {
      const { skin: t3, cape: n3 } = e2;
      return t3 && n3 ? `${(0, c.t)("general.skin")} & ${(0, c.t)("general.cape")}` : t3 ? (0, c.t)("general.skin") : n3 ? (0, c.t)("general.cape") : "";
    })();
    return (0, i.useEffect)((() => {
      const a2 = o2.current, i2 = new r.mc({ canvas: a2, width: a2.clientWidth, height: a2.clientHeight, skin: e2.skin || u, cape: e2.cape || "", model: e2.isAlex ? "slim" : "default", zoom: t2 / 100 });
      document.body.classList.contains("dark-mode") && (i2.background = "#6c757d");
      const c2 = i2.animations.add(r.eJ);
      s2.current.rotate = c2;
      const l2 = r.z$(i2);
      return n2.current = i2, () => {
        l2.dispose(), i2.dispose();
      };
    }), []), (0, i.useEffect)((() => {
      n2.current.loadSkin(e2.skin || u, e2.isAlex ? "slim" : "default");
    }), [e2.skin, e2.isAlex]), (0, i.useEffect)((() => {
      const t3 = n2.current;
      e2.cape ? t3.loadCape(e2.cape) : t3.resetCape();
    }), [e2.cape]), (0, i.useEffect)((() => {
      var e3, t3;
      const a2 = s2.current;
      if (b) {
        null === (e3 = a2.walk) || void 0 === e3 || e3.resetAndRemove(), a2.walk = null;
        const t4 = n2.current.animations.add(r.Lr);
        t4.speed = 0.6, a2.run = t4;
      } else {
        null === (t3 = a2.run) || void 0 === t3 || t3.resetAndRemove(), a2.run = null;
        const e4 = n2.current.animations.add(r.Mo);
        a2.walk = e4;
      }
    }), [b]), (0, i.useEffect)((() => {
      n2.current.animations.paused = d2;
    }), [d2]), (0, i.useEffect)((() => {
      n2.current.loadBackground(A[k]);
    }), [k]), (0, a.BX)("div", Object.assign({ className: "card" }, { children: [(0, a.tZ)("div", Object.assign({ className: "card-header" }, { children: (0, a.BX)("div", Object.assign({ className: "d-flex justify-content-between" }, { children: [(0, a.BX)("h3", Object.assign({ className: "card-title" }, { children: [(0, a.tZ)("span", { children: (0, c.t)("general.texturePreview") }, void 0), e2.showIndicator && (0, a.tZ)("span", Object.assign({ className: "badge bg-olive ml-1" }, { children: C }), void 0)] }), void 0), (0, a.BX)("div", { children: [(0, a.tZ)(g, { className: "fas fa-" + (b ? "walking" : "running"), "data-toggle": "tooltip", "data-placement": "bottom", title: `${(0, c.t)("general.walk")} / ${(0, c.t)("general.run")}`, onClick: () => {
      w(((e3) => !e3));
    } }, void 0), (0, a.tZ)(g, { className: "fas fa-redo-alt", "data-toggle": "tooltip", "data-placement": "bottom", title: (0, c.t)("general.rotation"), onClick: () => {
      const e3 = s2.current;
      e3.rotate && (e3.rotate.paused = !e3.rotate.paused);
    } }, void 0), (0, a.tZ)(g, { className: "fas fa-" + (d2 ? "play" : "pause"), "data-toggle": "tooltip", "data-placement": "bottom", title: (0, c.t)("general.pause"), onClick: () => {
      m(((e3) => !e3));
    } }, void 0), (0, a.tZ)(g, { className: "fas fa-stop", "data-toggle": "tooltip", "data-placement": "bottom", title: (0, c.t)("general.reset"), onClick: () => {
      var e3, t3, a2;
      const i2 = s2.current;
      null === (e3 = i2.walk) || void 0 === e3 || e3.resetAndRemove(), null === (t3 = i2.run) || void 0 === t3 || t3.resetAndRemove(), null === (a2 = i2.rotate) || void 0 === a2 || a2.resetAndRemove(), n2.current.animations.paused = true;
    } }, void 0)] }, void 0)] }), void 0) }), void 0), (0, a.tZ)("div", Object.assign({ className: "card-body p-0" }, { children: (0, a.tZ)("canvas", { ref: o2, css: v }, void 0) }), void 0), (0, a.BX)("div", Object.assign({ className: "card-footer" }, { children: [(0, a.BX)("div", Object.assign({ className: "mt-2 mb-3 d-flex" }, { children: [(0, a.tZ)("div", { className: "btn-color bg-white rounded-pill mr-2 elevation-2", title: (0, c.t)("colors.white"), onClick: () => {
      n2.current.background = "#fff";
    } }, void 0), (0, a.tZ)("div", { className: "btn-color bg-black rounded-pill mr-2 elevation-2", title: (0, c.t)("colors.black"), onClick: () => {
      n2.current.background = "#000";
    } }, void 0), (0, a.tZ)("div", { className: "btn-color bg-gray rounded-pill mr-2 elevation-2", title: (0, c.t)("colors.gray"), onClick: () => {
      n2.current.background = "#6c757d";
    } }, void 0), (0, a.tZ)("div", Object.assign({ className: "btn-color bg-green rounded-pill mr-2 elevation-2", css: l.b, title: (0, c.t)("colors.prev"), onClick: () => {
      h(((e3) => k <= 0 ? f - 1 : e3 - 1));
    } }, { children: (0, a.tZ)("i", { className: "fas fa-arrow-left" }, void 0) }), void 0), (0, a.tZ)("div", Object.assign({ className: "btn-color bg-green rounded-pill mr-2 elevation-2", css: l.b, title: (0, c.t)("colors.next"), onClick: () => {
      h(((e3) => k >= f - 1 ? 0 : e3 + 1));
    } }, { children: (0, a.tZ)("i", { className: "fas fa-arrow-right" }, void 0) }), void 0)] }), void 0), e2.children] }), void 0)] }), void 0);
  };
}, 550: function(e, t, n) {
  var a;
  function i(e2) {
    return `@media (max-width: ${e2}px)`;
  }
  function o(e2, t2) {
    return `@media (min-width: ${e2}px) and (max-width: ${t2}px)`;
  }
  function s(e2) {
    return `@media (min-width: ${e2}px)`;
  }
  n.d(t, { Uo: function() {
    return a;
  }, Qj: function() {
    return i;
  }, vX: function() {
    return o;
  }, tS: function() {
    return s;
  } }), (function(e2) {
    e2[e2.xs = 0] = "xs", e2[e2.sm = 576] = "sm", e2[e2.md = 768] = "md", e2[e2.lg = 992] = "lg", e2[e2.xl = 1200] = "xl";
  })(a || (a = {}));
}, 6051: function(e, t, n) {
  n.d(t, { G: function() {
    return i;
  }, b: function() {
    return o;
  } });
  var a = n(917);
  const i = a.iv`
  cursor: pointer;
`, o = a.iv`
  display: flex;
  justify-content: center;
  align-items: center;
`;
}, 553: function(e, t, n) {
  e.exports = n.p + "864a68e8a8adc85a8f5c.webp";
}, 8348: function(e, t, n) {
  e.exports = n.p + "7c013d148e38c3c93778.webp";
}, 2214: function(e, t, n) {
  e.exports = n.p + "2bcf685251dfe81e4b78.webp";
}, 5034: function(e, t, n) {
  e.exports = n.p + "0a40452f370b1aa92bf0.webp";
}, 9486: function(e, t, n) {
  e.exports = n.p + "73fd567289fe5a9c1b6c.webp";
}, 9483: function(e, t, n) {
  e.exports = n.p + "5f0b07bf1518ad8e86ed.webp";
}, 8862: function(e, t, n) {
  e.exports = n.p + "b8e05e3c8cdcf432089f.webp";
}, 70: function(e) {
  e.exports = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAFDUlEQVR42u2a20sUURzH97G0LKMotPuWbVpslj1olJXdjCgyisowsSjzgrB0gSKyC5UF1ZNQWEEQSBQ9dHsIe+zJ/+nXfM/sb/rN4ZwZ96LOrnPgyxzP/M7Z+X7OZc96JpEISfWrFhK0YcU8knlozeJKunE4HahEqSc2nF6zSEkCgGCyb+82enyqybtCZQWAzdfVVFgBJJNJn1BWFgC49/VpwGVlD0CaxQiA5HSYEwBM5sMAdKTqygcAG9+8coHKY/XXAZhUNgDYuBSPjJL/GkzVVhAEU5tqK5XZ7cnFtHWtq/TahdSw2l0HUisr1UKIWJQBAMehDuqiDdzndsP2EZECAG1ZXaWMwOCODdXqysLf++uXUGv9MhUHIByDOijjdiSAoH3ErANQD73C7TXXuGOsFj1d4YH4OTJAEy8y9Hd0mCaeZ5z8dfp88zw1bVyiYhCLOg1ZeAqC0ybaDttHRGME1DhDeVWV26u17lRAPr2+mj7dvULfHw2q65fhQRrLXKDfIxkau3ZMCTGIRR3URR5toU38HbaPiMwUcKfBAkoun09PzrbQ2KWD1JJaqswjdeweoR93rirzyCMBCmIQizqoizZkm2H7iOgAcHrMHbbV9KijkUYv7qOn55sdc4fo250e+vUg4329/Xk6QB/6DtOws+dHDGJRB3XRBve+XARt+4hIrAF4UAzbnrY0ve07QW8uHfB+0LzqanMM7qVb+3f69LJrD90/1axiEIs6qIs21BTIToewfcSsA+Bfb2x67OoR1aPPzu2i60fSNHRwCw221Suz0O3jO+jh6V1KyCMGse9721XdN5ePutdsewxS30cwuMjtC860T5JUKpXyKbSByUn7psi5l+juDlZYGh9324GcPKbkycaN3jUSAGxb46IAYPNZzW0AzgiQ5tVnzLUpUDCAbakMQXXrOtX1UMtHn+Q9/X5L4wgl7t37r85OSrx+TYl379SCia9KXjxRpiTjIZTBFOvrV1f8ty2eY/T7XJ81FQAwmA8ASH1ob68r5PnBsxA88/xAMh6SpqW4HRnLBrkOA9Xv5wPAZjAUgOkB+SHxgBgR0qSMh0zmZRsmwDJm1gFg2PMDIC8/nAHIMls8x8GgzOsG5WiaqREgYzDvpTwjLDy8NM15LpexDEA3LepjU8Z64my+8PtDCmUyRr+fFwA2J0eAFYA0AxgSgMmYBMZTwFQnO9RNAEaHOj2DXF5UADmvAToA2ftyxZYA5BqgmZZApDkdAK4mAKo8GzPlr8G8AehzMAyA/i1girUA0HtYB2CaIkUBEHQ/cBHSvwF0AKZFS5M0ZwMQtEaEAmhtbSUoDADH9ff3++QZ4o0I957e+zYAMt6wHkhzpjkuAcgpwNcpA7AZDLsvpwiuOkBvxygA6Bsvb0HlaeKIF2EbADZpGiGzBsA0gnwQHGOhW2snRpbpPexbAB2Z1oicAMQpTnGKU5ziFKc4xSlOcYpTnOIUpzgVmgo+XC324WfJAdDO/+ceADkCpuMFiFKbApEHkOv7BfzfXt+5gpT8V7rpfYJcDz+jAsB233r6yyBsJ0mlBCDofuBJkel4vOwBFPv8fyYAFPJ+wbSf/88UANNRVy4Awo6+Ig2gkCmgA5DHWjoA+X7AlM//owLANkX0w0359od++pvX8fdMAcj3/QJ9iJsAFPQCxHSnQt8vMJ3v2wCYpkhkAOR7vG7q4aCXoMoSgG8hFAuc/grMdAD4B/kHl9da7Ne9AAAAAElFTkSuQmCC";
} }]);
