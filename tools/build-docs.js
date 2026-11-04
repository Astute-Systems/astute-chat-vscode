// Builds a branded documentation page from README.md into docs/site.
const fs = require("fs");
const path = require("path");
const MarkdownIt = require("markdown-it");

const root = path.join(__dirname, "..");
const output = path.join(root, "docs", "site");
const headings = [];
const markdown = new MarkdownIt({ html: false, linkify: true });

const slug = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
markdown.renderer.rules.heading_open = (tokens, index, options, env, self) => {
  const text = tokens[index + 1].content;
  tokens[index].attrSet("id", slug(text));
  if (tokens[index].tag === "h2") {
    headings.push(text.replace(/`/g, ""));
  }
  return self.renderToken(tokens, index, options);
};

fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(path.join(output, "images", "screenshots"), { recursive: true });
fs.cpSync(path.join(root, "images", "screenshots"), path.join(output, "images", "screenshots"), { recursive: true });
fs.cpSync(path.join(root, "media", "fonts"), path.join(output, "fonts"), { recursive: true });
fs.copyFileSync(path.join(root, "images", "astute-code", "Astute_Code_Icon_Extension.png"), path.join(output, "images", "icon.png"));

const body = markdown.render(fs.readFileSync(path.join(root, "README.md"), "utf8"));
const contents = headings.map((text) => `<a href="#${slug(text)}">${markdown.utils.escapeHtml(text)}</a>`).join("\n");
const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;

const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Astute Code documentation</title>
<link rel="icon" href="images/icon.png">
<style>
@font-face { font-family: "Astute Vector"; font-weight: 400; src: url("fonts/orbitron-latin-400-normal.woff2") format("woff2"); }
@font-face { font-family: "Astute Vector"; font-weight: 700; src: url("fonts/orbitron-latin-700-normal.woff2") format("woff2"); }
@font-face { font-family: "Astute Mono"; font-weight: 400; src: url("fonts/courier-prime-latin-400-normal.woff2") format("woff2"); }
:root { --bg: #020a14; --raised: #06141f; --line: #0f3a52; --text: #cfeaff; --blue: #5cc8ff; --accent: #36c8e6; --muted: #7fb4d1; }
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body { margin: 0; color: var(--text); background: var(--bg); font: 16px/1.65 system-ui, sans-serif; }
.layout { display: grid; grid-template-columns: 260px minmax(0, 1fr); gap: 40px; max-width: 1180px; margin: 0 auto; padding: 0 24px; }
nav { position: sticky; top: 0; align-self: start; max-height: 100vh; padding: 28px 0; overflow-y: auto; }
nav .brand { display: flex; gap: 10px; align-items: center; margin-bottom: 8px; color: var(--blue); font: 700 18px "Astute Vector", sans-serif; }
nav .brand img { width: 32px; height: 32px; }
nav .version { display: block; margin-bottom: 20px; color: var(--muted); font-size: 13px; }
nav a { display: block; padding: 4px 0; color: var(--muted); font-size: 14px; text-decoration: none; }
nav a:hover { color: var(--accent); }
main { min-width: 0; padding: 28px 0 64px; }
main img { display: block; max-width: 100%; margin: 20px 0; border: 1px solid var(--line); border-radius: 6px; }
main p:first-child img { width: 100%; }
main p img[alt*="Astute Code"], main p img[alt*="Agent"], main p img[alt*="approval"] { max-width: 440px; }
main p:first-child img[alt="Astute Code"] { max-width: 100%; }
h1, h2, h3 { color: var(--blue); font-family: "Astute Vector", sans-serif; line-height: 1.3; text-shadow: 0 0 5px rgba(92, 200, 255, 0.45); }
h2 { margin-top: 48px; padding-bottom: 8px; border-bottom: 1px solid var(--line); }
a { color: var(--accent); }
code { color: #fff; font-family: "Astute Mono", "Courier New", monospace; font-size: 0.95em; }
:not(pre) > code { padding: 1px 4px; background: var(--raised); border-radius: 3px; }
pre { padding: 12px 14px; overflow-x: auto; background: #000; border: 1px solid var(--line); border-radius: 6px; }
.table { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; }
th, td { padding: 8px 10px; text-align: left; vertical-align: top; border: 1px solid var(--line); }
th { color: var(--blue); background: var(--raised); }
footer { margin-top: 56px; padding-top: 16px; color: var(--muted); font-size: 14px; border-top: 1px solid var(--line); }
@media (max-width: 820px) { .layout { display: block; } nav { position: static; max-height: none; padding-bottom: 0; } }
</style>
</head>
<body>
<div class="layout">
<nav aria-label="Contents">
<div class="brand"><img src="images/icon.png" alt="">Astute Code</div>
<span class="version">Version ${version}</span>
${contents}
</nav>
<main>
${body.replace(/<table>/g, '<div class="table"><table>').replace(/<\/table>/g, "</table></div>")}
<footer>Copyright (c) 2026 <a href="https://astutesys.com">Astute Systems</a></footer>
</main>
</div>
</body>
</html>
`;

fs.writeFileSync(path.join(output, "index.html"), page);
console.log(`Built ${path.relative(root, path.join(output, "index.html"))}`);
