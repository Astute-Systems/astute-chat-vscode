import * as assert from "node:assert/strict";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { fetchText, htmlToText, isPrivateAddress, parseDuckDuckGo, parseWebUrl, webFetch, webSearch, webToolDefinitions } from "../webTools";

let base = "";
let formats = true;
const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://x");
  const send = (type: string, body: string): void => {
    response.writeHead(200, { "Content-Type": type });
    response.end(body);
  };
  if (url.pathname === "/page") {
    send("text/html; charset=utf-8", "<html><head><title>A &amp; B</title><style>p{}</style></head><body><script>bad()</script><p>Hello&nbsp;<b>world</b></p><!-- hidden --><p>&#39;two&#x27;</p></body></html>");
  } else if (url.pathname === "/plain") {
    send("text/plain", "<not html>");
  } else if (url.pathname === "/long") {
    send("text/plain", "x".repeat(20000));
  } else if (url.pathname === "/big") {
    send("text/plain", "x".repeat(3 * 1024 * 1024));
  } else if (url.pathname === "/binary") {
    send("application/zip", "PK");
  } else if (url.pathname === "/missing") {
    response.writeHead(404).end();
  } else if (url.pathname === "/hop") {
    response.writeHead(302, { Location: "/page" }).end();
  } else if (url.pathname === "/loop") {
    response.writeHead(302, { Location: "/loop" }).end();
  } else if (url.pathname === "/to-localhost") {
    const { port } = server.address() as AddressInfo;
    response.writeHead(302, { Location: `http://localhost:${port}/page` }).end();
  } else if (url.pathname === "/to-file") {
    response.writeHead(302, { Location: "file:///etc/passwd" }).end();
  } else if (url.pathname.endsWith("/search")) {
    if (!formats) {
      response.writeHead(403).end();
    } else if (url.searchParams.get("format") !== "json") {
      send("text/html", "<html>");
    } else {
      send("application/json", JSON.stringify({ results: [{ title: "One", url: "https://one.example/", content: `about ${url.searchParams.get("q")}` }, { title: "Bad", url: "javascript:alert(1)" }] }));
    }
  } else {
    send("text/plain", "ok");
  }
});

const open = { searchUrl: "", allowPrivateAddresses: true };

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

test("knows private addresses", () => {
  for (const address of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "::ffff:7f00:1"]) {
    assert.ok(isPrivateAddress(address), address);
  }
  for (const address of ["8.8.8.8", "172.32.0.1", "2606:4700:4700::1111"]) {
    assert.ok(!isPrivateAddress(address), address);
  }
});

test("refuses private addresses unless they're allowed", async () => {
  for (const address of [`${base}/page`, "http://[::1]/", "http://2130706433/", "http://0x7f.1/", "http://169.254.169.254/latest/meta-data/", "http://[::ffff:127.0.0.1]/"]) {
    await assert.rejects(fetchText(address), /private network/, address);
  }
  assert.match((await fetchText(`${base}/page`, { allowPrivate: true })).body, /Hello/);
});

test("refuses a name that resolves to a private address", async () => {
  const { port } = server.address() as AddressInfo;
  await assert.rejects(fetchText(`http://localhost:${port}/page`), /private network/);
});

test("a trusted host can't redirect to another private address", async () => {
  await assert.rejects(fetchText(`${base}/to-localhost`, { trustedHost: "127.0.0.1" }), /private network/);
});

test("only opens web addresses", async () => {
  assert.throws(() => parseWebUrl("file:///etc/passwd"), /Only http/);
  assert.throws(() => parseWebUrl("example.com"), /full web address/);
  assert.throws(() => parseWebUrl("http://me:pw@example.com/"), /user name/);
  await assert.rejects(fetchText(`${base}/to-file`, { allowPrivate: true }), /Only http/);
});

test("follows redirects, but not forever", async () => {
  assert.equal((await fetchText(`${base}/hop`, { allowPrivate: true })).url, `${base}/page`);
  await assert.rejects(fetchText(`${base}/loop`, { allowPrivate: true }), /too many/);
});

test("refuses binary files and failed requests", async () => {
  await assert.rejects(fetchText(`${base}/binary`, { allowPrivate: true }), /isn't a text page \(application\/zip\)/);
  await assert.rejects(fetchText(`${base}/missing`, { allowPrivate: true }), /HTTP 404/);
});

test("limits how much it downloads", async () => {
  assert.equal((await fetchText(`${base}/big`, { allowPrivate: true })).body.length, 2 * 1024 * 1024);
});

test("Stop cancels a request", async () => {
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(fetchText(`${base}/page`, { allowPrivate: true, signal: abort.signal }));
});

test("turns pages into labelled text", async () => {
  const page = await webFetch(`${base}/page`, open);
  assert.match(page, /^This text comes from the web/);
  assert.match(page, /Title: A & B/);
  assert.match(page, /Hello world\n'two'/);
  assert.ok(!page.includes("bad()") && !page.includes("hidden") && !page.includes("<"));
  assert.match(await webFetch(`${base}/plain`, open), /<not html>/);
  assert.match(await webFetch(`${base}/long`, open), /\[Page shortened\]$/);
});

test("doesn't decode entities twice", () => {
  assert.equal(htmlToText("<p>&amp;lt;</p>"), "&lt;");
});

test("searches SearXNG, including under a path", async () => {
  for (const searchUrl of [base, `${base}/`, `${base}/searx/`]) {
    const results = await webSearch("a&b c", { searchUrl, allowPrivateAddresses: false });
    assert.match(results, /1\. One\nhttps:\/\/one\.example\/\nabout a&b c/);
    assert.ok(!results.includes("javascript:"));
    assert.match(results, /Call web_fetch/);
  }
});

test("explains a search server with JSON turned off", async (t) => {
  formats = false;
  t.after(() => {
    formats = true;
  });
  await assert.rejects(webSearch("x", { searchUrl: base, allowPrivateAddresses: false }), /search\.formats/);
});

test("offers search and fetch", () => {
  assert.deepEqual(webToolDefinitions().map((tool) => tool.function.name), ["web_search", "web_fetch"]);
});

const result = (href: string, title: string, snippet: string): string => `<div class="result results_links results_links_deep web-result ">
  <h2 class="result__title"><a rel="nofollow" class="result__a" href="${href}">${title}</a></h2>
  <a class="result__snippet" href="${href}">${snippet}</a></div>`;

test("reads DuckDuckGo results", () => {
  const html = result("//duckduckgo.com/l/?uddg=https%3A%2F%2Fone.example%2Fa%3Fb%3D1&amp;rut=abc", "Best <b>models</b> &amp; more", "The <b>best</b> one")
    + result("https://duckduckgo.com/y.js?ad_domain=x&amp;u3=y", "Advert", "Buy this")
    + result("//duckduckgo.com/l/?uddg=https%3A%2F%2Ftwo.example%2F&amp;rut=def", "Two", "");
  assert.deepEqual(parseDuckDuckGo(html), [
    { title: "Best models & more", url: "https://one.example/a?b=1", content: "The best one" },
    { title: "Two", url: "https://two.example/", content: "" },
  ]);
  assert.deepEqual(parseDuckDuckGo("<html>a challenge page</html>"), []);
});
