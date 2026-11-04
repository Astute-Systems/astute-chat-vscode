export const THEME_NAME = "Astute Vector";
/** Courier Prime matches the code in the chat panel. Orbitron isn't monospaced, so code wouldn't line up in it. */
export const CODE_FONT = "'Courier Prime', 'Courier New', Courier, monospace";

/** Orbitron has no monospaced form, so the terminal uses one made from it. It must be installed on the computer. */
export const TERMINAL_FONT = "'Astute Vector Mono', 'Courier Prime', 'Courier New', Courier, monospace";
/** One step below VS Code's usual 14. The vector letters look large at that size. */
export const TERMINAL_FONT_SIZE = 13;

type SettingValue = string | number;

/** The settings this feature owns while it's on. */
export const THEME_SETTINGS: Readonly<Record<string, SettingValue>> = {
  "workbench.colorTheme": THEME_NAME,
  "editor.fontFamily": CODE_FONT,
  "terminal.integrated.fontFamily": TERMINAL_FONT,
  "terminal.integrated.fontSize": TERMINAL_FONT_SIZE,
  "debug.console.fontFamily": CODE_FONT,
  "scm.inputFontFamily": CODE_FONT,
};

/** What each setting held before, with null for a setting the user hadn't set. */
export type SavedSettings = Record<string, SettingValue | null>;

export interface VectorThemeStore {
  enabled(): boolean;
  /** The user's own value, ignoring defaults and workspace settings. */
  read(key: string): SettingValue | undefined;
  write(key: string, value: SettingValue | undefined): Thenable<void>;
  saved(): SavedSettings | undefined;
  save(value: SavedSettings | undefined): Thenable<void>;
}

/**
 * Brings the user's settings in line with the option. It acts only when the option
 * changes, so a theme chosen by hand while it's on isn't overwritten at the next start.
 */
export async function syncVectorTheme(store: VectorThemeStore): Promise<"applied" | "restored" | undefined> {
  const saved = store.saved();
  if (store.enabled() && !saved) {
    const keys = Object.keys(THEME_SETTINGS);
    // Saved first, so a failed write can still be undone.
    await store.save(Object.fromEntries(keys.map((key) => [key, store.read(key) ?? null])));
    for (const key of keys) {
      await store.write(key, THEME_SETTINGS[key]);
    }
    return "applied";
  }
  if (!store.enabled() && saved) {
    for (const [key, value] of Object.entries(saved)) {
      // Anything else was changed by the user afterwards, so it stays.
      if (store.read(key) === THEME_SETTINGS[key]) {
        await store.write(key, value ?? undefined);
      }
    }
    await store.save(undefined);
    return "restored";
  }
  return undefined;
}
