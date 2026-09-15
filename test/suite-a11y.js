const { check } = require('./harness.js');
const { JSDOM } = require('jsdom');
const {
  parseCssColor, blendOver, contrastRatio, a11yAuditScript, FOCUS_DESCRIBE_SCRIPT, analyzeFocusStops,
} = require('../src/browser.js');

// /playthrough's accessibility checks, run for real without a browser: the
// colour arithmetic directly, the in-page audit inside jsdom, and the Tab-order
// analysis on sequences built by hand.

// jsdom has no layout - every element measures 0x0 and would be skipped as
// invisible - so a fixed box stands in. Colours jsdom cannot resolve come back
// unreadable and are skipped, which is the audit's own rule; the contrast page
// sets its colours explicitly for that reason.
function audit(html) {
  const dom = new JSDOM(html, { runScripts: 'outside-only' });
  const w = dom.window;
  w.Element.prototype.getBoundingClientRect = function () {
    return { x: 0, y: 0, left: 0, top: 0, right: 100, bottom: 20, width: 100, height: 20 };
  };
  const out = w.eval(a11yAuditScript(40));
  w.close();
  return out;
}

async function a11ySuite() {
  console.log('');
  console.log('playthrough accessibility checks:');

  // Colour arithmetic.
  check('a11y: reads rgb()', JSON.stringify(parseCssColor('rgb(10, 20, 30)')) === '[10,20,30,1]');
  check('a11y: reads rgba() alpha', parseCssColor('rgba(0, 0, 0, 0.5)')[3] === 0.5);
  check('a11y: reads #abc and #aabbcc',
    JSON.stringify(parseCssColor('#abc')) === '[170,187,204,1]' && JSON.stringify(parseCssColor('#0a0b0c')) === '[10,11,12,1]');
  check('a11y: transparent is fully transparent', parseCssColor('transparent')[3] === 0);
  check('a11y: a colour it cannot read is null, not a guess', parseCssColor('red') === null && parseCssColor('') === null);
  const white = [255, 255, 255, 1];
  check('a11y: black on white is 21:1', Math.abs(contrastRatio([0, 0, 0, 1], white) - 21) < 0.01);
  check('a11y: a colour against itself is 1:1', Math.abs(contrastRatio(white, white) - 1) < 1e-9);
  const r777 = contrastRatio(parseCssColor('#777777'), white);
  check('a11y: #777 on white is just under 4.5:1, the classic near miss', r777 > 4.4 && r777 < 4.5, r777.toFixed(3));
  check('a11y: half-transparent black over white blends to mid grey', Math.round(blendOver([0, 0, 0, 0.5], white)[0]) === 128);

  // A page with one of everything wrong.
  const bad = audit(`<!doctype html><html><head></head><body>
    <h1>Shop</h1><h3>Deals</h3>
    <img src="a.png">
    <img src="spacer.png" alt="">
    <input id="q" type="text">
    <input type="email" placeholder="Email">
    <label for="n">Name</label><input id="n" type="text">
    <input type="text" aria-label="Search">
    <button><svg></svg></button>
    <button>Buy</button>
    <a href="/x"></a>
    <div onclick="go()">Open menu</div>
    <span tabindex="3">Jump</span>
    <p id="dup">one</p><p id="dup">two</p>
  </body></html>`);
  const of = (kind) => bad.issues.filter(i => i.kind === kind);
  check('a11y: an image with no alt is reported, a decorative alt="" is not',
    of('img-alt').length === 1, JSON.stringify(of('img-alt')));
  check('a11y: an unlabelled field and a placeholder-only field are reported; labelled ones are not',
    of('label').length === 2 && of('label').some(i => /placeholder/.test(i.text)), JSON.stringify(of('label')));
  check('a11y: an icon-only button and an empty link are reported; a named button is not',
    of('name').length === 2, JSON.stringify(of('name')));
  check('a11y: a clickable div the keyboard cannot reach is reported',
    of('keyboard').length === 1 && /Open menu/.test(of('keyboard')[0].where), JSON.stringify(of('keyboard')));
  check('a11y: a positive tabindex is reported', of('tab-order').length === 1);
  check('a11y: a page with no lang and no title is reported', of('lang').length === 1 && of('title').length === 1);
  check('a11y: a skipped heading level is reported',
    of('headings').length === 1 && /h1 to h3/.test(of('headings')[0].text), JSON.stringify(of('headings')));
  check('a11y: a duplicated id is reported', of('duplicate-id').length === 1);
  check('a11y: every finding says where it is, how serious, and why',
    bad.issues.length > 0 && bad.issues.every(i => i.where && i.severity && i.text));

  // The same page done right.
  const good = audit(`<!doctype html><html lang="en"><head><title>Shop</title></head><body>
    <h1>Shop</h1><h2>Deals</h2>
    <img src="a.png" alt="Red shoes">
    <img src="hidden.png" style="display: none">
    <label>Email <input type="email"></label>
    <button aria-label="Close"><svg></svg></button>
    <a href="/deals">Deals</a>
    <div role="button" tabindex="0">Open</div>
  </body></html>`);
  check('a11y: a clean page produces no findings, and hidden elements are not judged',
    good.issues.length === 0, JSON.stringify(good.issues));

  // Contrast, including the large-text allowance.
  const contrast = audit(`<!doctype html><html lang="en"><head><title>t</title></head><body>
    <p style="color: rgb(119, 119, 119); background-color: rgb(255, 255, 255)">Faint text</p>
    <p style="color: rgb(0, 0, 0); background-color: rgb(255, 255, 255)">Clear text</p>
    <p style="color: rgb(130, 130, 130); font-size: 30px; background-color: rgb(255, 255, 255)">Big grey</p>
  </body></html>`);
  const low = contrast.issues.filter(i => i.kind === 'contrast');
  check('a11y: text under 4.5:1 is reported, with the measured ratio',
    low.length === 1 && /Faint text/.test(low[0].where) && /4\.48:1/.test(low[0].text), JSON.stringify(low));
  check('a11y: large text is held to 3:1, so the same grey passes at 30px', !low.some(i => /Big grey/.test(i.where)));

  // Tab-order analysis.
  const S = (key, extra = {}) => Object.assign({ key, tag: 'a', label: key, visible: true, indicator: true }, extra);
  let f = analyzeFocusStops([S('a'), S('b'), S('c'), S('a')]);
  check('focus: a cycle back to the first stop is complete', f.complete && f.sequence.length === 3 && f.traps.length === 0);
  f = analyzeFocusStops([S('a'), S('b'), null]);
  check('focus: focus leaving the page ends the cycle', f.complete && f.sequence.length === 2);
  f = analyzeFocusStops([S('a'), S('b'), S('b')]);
  check('focus: Tab that does not move focus is reported as a trap', f.traps.length === 1 && f.traps[0].key === 'b');
  f = analyzeFocusStops([S('a'), S('b', { visible: false }), S('c', { indicator: false }), null]);
  check('focus: focus landing on something invisible is reported', f.invisible.length === 1 && f.invisible[0].key === 'b');
  check('focus: a stop with no visible focus indicator is reported', f.noIndicator.length === 1 && f.noIndicator[0].key === 'c');
  f = analyzeFocusStops([S('only'), S('only')]);
  check('focus: a single-stop page is not mistaken for a trap', f.complete && f.traps.length === 0);
  f = analyzeFocusStops([null]);
  check('focus: a page with nothing focusable has an empty sequence', f.sequence.length === 0 && !f.complete);

  {
    const dom = new JSDOM('<!doctype html><html><body><button id="b">Save</button></body></html>', { runScripts: 'outside-only' });
    const w = dom.window;
    w.Element.prototype.getBoundingClientRect = function () { return { left: 5, top: 6, width: 50, height: 20 }; };
    w.document.getElementById('b').focus();
    const d1 = w.eval(FOCUS_DESCRIBE_SCRIPT);
    const d2 = w.eval(FOCUS_DESCRIBE_SCRIPT);
    check('focus: the focused element is described, with a stable identity',
      Boolean(d1) && d1.tag === 'button' && d1.label === 'Save' && d1.key === d2.key && d1.visible === true, JSON.stringify(d1));
    w.document.getElementById('b').blur();
    check('focus: nothing focused reads as null', w.eval(FOCUS_DESCRIBE_SCRIPT) === null);
    w.close();
  }
}

module.exports = { a11ySuite };
