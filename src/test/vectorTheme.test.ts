import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { FONT_FILES, fontFolder, fontsInstalled, installFonts } from "../fontInstall";
import { CODE_FONT, SavedSettings, syncVectorTheme, TERMINAL_FONT, TERMINAL_FONT_SIZE, THEME_NAME, THEME_SETTINGS, VectorThemeStore } from "../vectorTheme";

const root = path.join(__dirname, "..", "..");
const read = (file: string): string => fs.readFileSync(path.join(root, file), "utf8");
const theme = JSON.parse(read("themes/astute-vector-color-theme.json")) as {
  name: string;
  type: string;
  colors: Record<string, string>;
  tokenColors: Array<{ scope: string[]; settings: { foreground?: string } }>;
  semanticTokenColors: Record<string, string | { foreground: string }>;
};

function makeStore(settings: Record<string, string | number> = {}, enabled = false): VectorThemeStore & { settings: Record<string, string | number>; on: boolean } {
  let saved: SavedSettings | undefined;
  return {
    settings,
    on: enabled,
    enabled() {
      return this.on;
    },
    read: (key) => settings[key],
    write: async (key, value) => {
      if (value === undefined) {
        delete settings[key];
      } else {
        settings[key] = value;
      }
    },
    saved: () => saved,
    save: async (value) => {
      saved = value;
    },
  };
}

test("does nothing while it's off", async () => {
  const store = makeStore({ "workbench.colorTheme": "Mine" });
  await syncVectorTheme(store);
  assert.deepEqual(store.settings, { "workbench.colorTheme": "Mine" });
});

test("turning it off puts everything back", async () => {
  const before = { "workbench.colorTheme": "Mine", "editor.fontFamily": "Fira Code", "editor.fontSize": "14" };
  const store = makeStore({ ...before }, true);
  await syncVectorTheme(store);
  assert.equal(store.settings["workbench.colorTheme"], THEME_NAME);
  assert.equal(store.settings["editor.fontFamily"], CODE_FONT);
  assert.equal(store.settings["terminal.integrated.fontFamily"], TERMINAL_FONT);
  assert.equal(store.settings["terminal.integrated.fontSize"], TERMINAL_FONT_SIZE);
  store.on = false;
  await syncVectorTheme(store);
  assert.deepEqual(store.settings, before, "settings the user hadn't set are removed again");
  assert.equal(store.saved(), undefined);
});

test("keeps a change the user made while it was on", async () => {
  const store = makeStore({ "workbench.colorTheme": "Mine" }, true);
  await syncVectorTheme(store);
  store.settings["editor.fontFamily"] = "Fira Code";
  store.on = false;
  await syncVectorTheme(store);
  assert.equal(store.settings["editor.fontFamily"], "Fira Code");
  assert.equal(store.settings["workbench.colorTheme"], "Mine");
});

test("doesn't reapply over a theme chosen by hand", async () => {
  const store = makeStore({}, true);
  await syncVectorTheme(store);
  store.settings["workbench.colorTheme"] = "Mine";
  await syncVectorTheme(store);
  assert.equal(store.settings["workbench.colorTheme"], "Mine");
});

test("can be undone even if applying it fails part way", async () => {
  const store = makeStore({ "editor.fontFamily": "Fira Code" }, true);
  const write = store.write;
  store.write = async (key, value) => {
    if (key === "terminal.integrated.fontFamily") {
      throw new Error("no");
    }
    await write(key, value);
  };
  await assert.rejects(syncVectorTheme(store));
  store.write = write;
  store.on = false;
  await syncVectorTheme(store);
  assert.deepEqual(store.settings, { "editor.fontFamily": "Fira Code" });
});

test("restores a terminal size of the user's", async () => {
  const store = makeStore({ "terminal.integrated.fontSize": 18 }, true);
  assert.equal(await syncVectorTheme(store), "applied");
  store.on = false;
  assert.equal(await syncVectorTheme(store), "restored");
  assert.equal(store.settings["terminal.integrated.fontSize"], 18);
  assert.equal(await syncVectorTheme(store), undefined);
});

/** Reads a table's offset from the font's table directory. */
function table(font: Buffer, tag: string): number {
  for (let index = 0; index < font.readUInt16BE(4); index++) {
    const entry = 12 + index * 16;
    if (font.toString("latin1", entry, entry + 4) === tag) {
      return font.readUInt32BE(entry + 8);
    }
  }
  throw new Error(`No ${tag} table`);
}

test("the terminal font is monospaced, with its licence", () => {
  for (const file of FONT_FILES) {
    const font = fs.readFileSync(path.join(root, "media", "fonts", file));
    assert.equal(font.readUInt16BE(table(font, "hhea") + 34), 1, `${file} has one glyph width`);
    assert.notEqual(font.readUInt32BE(table(font, "post") + 12), 0, `${file} is marked monospaced`);
  }
  assert.match(read("media/fonts/LICENSE-AstuteVectorMono.txt"), /Reserved Font Name: "Orbitron"/);
  assert.match(read("ThirdPartyNotices.txt"), /Astute Vector Mono/);
  assert.equal(TERMINAL_FONT.split(",")[0], "'Astute Vector Mono'");
});

test("installs fonts for this user only", async () => {
  assert.equal(fontFolder("linux", "/home/a"), path.join("/home/a", ".local", "share", "fonts", "astute-vector-mono"));
  assert.equal(fontFolder("linux", "/home/a", "/data"), path.join("/data", "fonts", "astute-vector-mono"));
  assert.equal(fontFolder("darwin", "/home/a"), path.join("/home/a", "Library", "Fonts"));
  assert.equal(fontFolder("win32", "/home/a"), undefined);
  const target = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "astute-fonts-")), "new", "folder");
  assert.equal(await fontsInstalled(target), false);
  await installFonts(path.join(root, "media", "fonts"), target);
  assert.equal(await fontsInstalled(target), true);
  assert.deepEqual(fs.readdirSync(target).sort(), [...FONT_FILES].sort());
});

test("the theme is contributed and packaged", () => {
  const manifest = JSON.parse(read("package.json")) as { contributes: { themes: Array<{ label: string; uiTheme: string; path: string }>; configuration: { properties: Record<string, { default: unknown; scope?: string }> } } };
  const [entry] = manifest.contributes.themes;
  assert.equal(entry.label, THEME_NAME);
  assert.equal(theme.name, THEME_NAME);
  assert.equal(entry.uiTheme, "vs-dark");
  assert.ok(fs.existsSync(path.join(root, entry.path)));
  assert.match(read(".vscodeignore"), /^!themes\/\*\*$/m);
  const option = manifest.contributes.configuration.properties["astuteChat.vectorTheme.enabled"];
  assert.equal(option.default, false, "off by default");
  assert.equal(option.scope, "application", "a workspace can't change the whole IDE");
  assert.equal(THEME_SETTINGS["workbench.colorTheme"], THEME_NAME);
});

/** WCAG contrast ratio. Colours with alpha are skipped, because they depend on what's behind them. */
function contrast(foreground: string, background: string): number {
  const light = (hex: string): number => {
    const [r, g, b] = [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16) / 255).map((value) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [a, b] = [light(foreground), light(background)].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
}

test("every colour is valid", () => {
  for (const [name, value] of Object.entries(theme.colors)) {
    assert.match(value, /^#[0-9a-f]{6}([0-9a-f]{2})?$/, name);
  }
});

test("code is readable on the editor background", () => {
  const background = theme.colors["editor.background"];
  const foregrounds = [theme.colors["editor.foreground"], ...theme.tokenColors.map((rule) => rule.settings.foreground), ...Object.values(theme.semanticTokenColors).map((value) => (typeof value === "string" ? value : value.foreground))];
  for (const foreground of foregrounds.filter((value): value is string => Boolean(value))) {
    assert.ok(contrast(foreground, background) >= 4.5, `${foreground} on ${background}`);
  }
});

test("terminal colours are readable, except black", () => {
  for (const [name, value] of Object.entries(theme.colors).filter(([key]) => key.startsWith("terminal.ansi") && key !== "terminal.ansiBlack")) {
    assert.ok(contrast(value, theme.colors["terminal.background"]) >= 4.5, name);
  }
});

test("interface text is readable", () => {
  const pairs: Array<[string, string]> = [
    ["sideBar.foreground", "sideBar.background"], ["list.activeSelectionForeground", "list.activeSelectionBackground"], ["list.hoverForeground", "list.hoverBackground"], ["sideBarSectionHeader.foreground", "sideBarSectionHeader.background"],
    ["activityBar.foreground", "activityBar.background"], ["activityBar.inactiveForeground", "activityBar.background"], ["tab.activeForeground", "tab.activeBackground"], ["tab.inactiveForeground", "tab.inactiveBackground"],
    ["statusBar.foreground", "statusBar.background"], ["titleBar.activeForeground", "titleBar.activeBackground"], ["button.foreground", "button.background"], ["button.secondaryForeground", "button.secondaryBackground"],
    ["input.foreground", "input.background"], ["input.placeholderForeground", "input.background"], ["badge.foreground", "badge.background"], ["statusBarItem.errorForeground", "statusBarItem.errorBackground"], ["statusBarItem.warningForeground", "statusBarItem.warningBackground"],
    ["menu.selectionForeground", "menu.selectionBackground"], ["quickInputList.focusForeground", "quickInputList.focusBackground"], ["editorLineNumber.foreground", "editor.background"], ["gitDecoration.ignoredResourceForeground", "sideBar.background"], ["gitDecoration.addedResourceForeground", "sideBar.background"],
  ];
  for (const [foreground, background] of pairs) {
    assert.ok(contrast(theme.colors[foreground], theme.colors[background]) >= 4.5, `${foreground} on ${background}: ${contrast(theme.colors[foreground], theme.colors[background]).toFixed(2)}`);
  }
});
