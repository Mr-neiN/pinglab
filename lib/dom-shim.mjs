/**
 * A DOM small enough to run `public/app.js` under `node:vm`.
 *
 * It is not a browser: there is no parser, no layout and no CSS. It keeps exactly what the
 * page's JavaScript touches - elements by id, `innerHTML` as text, `classList`, `dataset`,
 * registered listeners a test can fire, and `<option value="...">` inside a `<select>` so the
 * benchmark card's picker has the value a real browser would give it. Assertions read the
 * `innerHTML` the page produced, which is the string a browser would parse.
 *
 * Elements are created on demand for any id. The page renders parts of itself that these tests
 * do not assert on (the fix rows, the soak card), and those need somewhere harmless to write.
 */
export function createDom({ token = "", html = "" } = {}) {
  class ClassList {
    constructor() {
      this.set = new Set();
    }
    add(...names) {
      for (const name of names) this.set.add(name);
    }
    remove(...names) {
      for (const name of names) this.set.delete(name);
    }
    toggle(name, force) {
      const on = force === undefined ? !this.set.has(name) : Boolean(force);
      if (on) this.set.add(name);
      else this.set.delete(name);
      return on;
    }
    contains(name) {
      return this.set.has(name);
    }
    get value() {
      return [...this.set].join(" ");
    }
  }

  class Element {
    constructor(tagName, doc) {
      this.tagName = String(tagName).toUpperCase();
      this.doc = doc;
      this.id = "";
      this.title = "";
      this.value = "";
      this.disabled = false;
      this.checked = false;
      this.textContent = "";
      this.className = "";
      this.dataset = {};
      this.style = {};
      this.handlers = new Map();
      this.children = [];
      this.attributes = {};
      this.classList = new ClassList();
      this._innerHTML = "";
      this._questions = {};
    }

    set innerHTML(html) {
      this._innerHTML = String(html);
      this.children = [];
      if (this.tagName === "SELECT") {
        const values = [...this._innerHTML.matchAll(/<option value="([^"]*)"/g)].map((m) => m[1]);
        // A real <select> shows its first option until something else is chosen; the page reads
        // `.value` to decide which setting to benchmark, so the shim has to answer like that.
        if (values.length && !values.includes(this.value)) this.value = values[0];
      }
    }

    get innerHTML() {
      return this._innerHTML;
    }

    addEventListener(type, handler) {
      if (!this.handlers.has(type)) this.handlers.set(type, []);
      this.handlers.get(type).push(handler);
    }

    removeEventListener(type, handler) {
      const list = this.handlers.get(type) || [];
      this.handlers.set(
        type,
        list.filter((h) => h !== handler),
      );
    }

    fire(type, event = {}) {
      const handlers = this.handlers.get(type) || [];
      if (!handlers.length) this.doc.unhandled.push(`${this.id || this.tagName}:${type}`);
      for (const handler of handlers) handler({ target: this, preventDefault() {}, ...event });
      return handlers.length;
    }

    click() {
      return this.fire("click");
    }

    appendChild(child) {
      this.children.push(child);
      return child;
    }

    remove() {
      this.doc.removed.push(this);
    }

    querySelector(selector) {
      if (!this._questions[selector]) this._questions[selector] = this.doc._element("div");
      return this._questions[selector];
    }

    querySelectorAll() {
      return [];
    }

    setAttribute(name, value) {
      this.attributes[name] = String(value);
      if (name === "id") this.id = String(value);
    }

    getAttribute(name) {
      return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null;
    }

    focus() {}

    closest() {
      return null;
    }
  }

  class Document {
    constructor() {
      this.byId = new Map();
      this.handlers = new Map();
      this.removed = [];
      this.unhandled = [];
      this.confirmAnswer = true;
      this.confirmCalls = [];
      this.token = "";
      // Which tag each id is, taken from the shipped markup, so `<select>` behaves like one.
      this.tags = new Map();
      for (const match of html.matchAll(/<([a-zA-Z]+)\b[^>]*\bid="([^"]+)"/g)) {
        this.tags.set(match[2], match[1]);
      }
    }

    _element(tagName) {
      return new Element(tagName, this);
    }

    getElementById(id) {
      if (!this.byId.has(id)) {
        const element = new Element(this.tags.get(id) || "div", this);
        element.id = id;
        this.byId.set(id, element);
      }
      return this.byId.get(id);
    }

    createElement(tagName) {
      return new Element(tagName, this);
    }

    querySelector(selector) {
      // The one selector the page runs on the document is the token meta tag.
      if (/pinglab-token/.test(selector)) return this.token ? { content: this.token } : null;
      return null;
    }

    querySelectorAll() {
      return [];
    }

    addEventListener(type, handler) {
      if (!this.handlers.has(type)) this.handlers.set(type, []);
      this.handlers.get(type).push(handler);
    }

    // Convenience for tests, not part of the DOM.
    el(id) {
      return this.getElementById(id);
    }

    confirm(message) {
      this.confirmCalls.push(String(message));
      return this.confirmAnswer;
    }
  }

  const document = new Document();
  document.token = token;
  return document;
}

/**
 * Load `public/app.js` into a fresh context against a running server.
 *
 * The script is evaluated as one program with an epilogue that hands the test the declarations
 * it would otherwise keep to itself (`const state` is not a property of the context). Nothing in
 * the shipped file is modified or re-implemented: every call a test makes goes through the same
 * functions and the same listeners the browser would run.
 */
export async function openPage({ source, html = "", origin, token }) {
  const vm = await import("node:vm");
  const dom = createDom({ token, html });
  // Timers the page sets (the toast's 5 s hide) must not hold the test process open.
  const delay = (fn, ms) => {
    const timer = setTimeout(fn, ms);
    timer.unref?.();
    return timer;
  };
  const requests = [];
  const sandbox = {
    document: dom,
    fetch: async (url, options = {}) => {
      requests.push({ url: String(url), body: options.body ? String(options.body) : null });
      // A browser sends Origin on every POST, and the server refuses a mutation without it:
      // this is the same-origin check, not a bypass of it.
      const headers = { ...(options.headers || {}) };
      if (String(options.method || "GET").toUpperCase() !== "GET") headers.Origin = new URL(origin).origin;
      return fetch(new URL(String(url), origin), { ...options, headers });
    },
    confirm: (message) => dom.confirm(message),
    setTimeout: delay,
    clearTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(
    `${source}\n;globalThis.__page = { state, loadState, loadSoak, refreshBenchmark, renderBench, api };`,
    sandbox,
    { filename: "public/app.js" },
  );
  const page = sandbox.__page;
  // The page starts its own reads when it loads; await the same calls so the test is not racing
  // them. Both read the same server state, so a second read cannot change the outcome.
  await page.loadState();
  await page.refreshBenchmark();
  return { dom, page, requests };
}
