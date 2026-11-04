const esbuild = require("esbuild");

const watch = process.argv.includes("--watch");
const builds = [
  {
    entryPoints: ["src/extension.ts"],
    outfile: "out/extension.js",
    bundle: true,
    platform: "node",
    target: "node20",
    format: "cjs",
    external: ["vscode"],
    sourcemap: false,
  },
  {
    entryPoints: ["webview/main.ts"],
    outfile: "media/webview.js",
    bundle: true,
    platform: "browser",
    target: "es2022",
    format: "iife",
    minify: true,
  },
];

(async () => {
  for (const options of builds) {
    if (watch) {
      const context = await esbuild.context(options);
      await context.watch();
    } else {
      await esbuild.build(options);
    }
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
