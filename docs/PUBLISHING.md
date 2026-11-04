# Publishing Astute Chat

This guide is for Astute Systems staff who release the extension to the VS Code Marketplace.

## Before the first release

1. **Commit the code.** The repository has no commits yet. Decide whether `test/` belongs in it first, because it contains build experiments.
2. **Make the repository public.** The Marketplace page loads README images and links from GitHub, so they break while the repository is private. Alternatively, host the images on astutesys.com and package with `--baseImagesUrl`.
3. **Set up Trusted Publishing.** Global Azure DevOps personal access tokens retire on 1 December 2026, so don't build on them.
   1. Sign in to the [publisher management page](https://marketplace.visualstudio.com/manage) and open `AstuteSystems`.
   2. Select **Trusted Publishing**, then expand **Create**.
   3. Set the repository owner to `Astute-Systems`, the repository to `astute-chat-vscode` and the workflow to `publish.yml`. Leave the environment empty.
   4. If the repository is still private, run the workflow within 48 hours. The first successful run activates the policy.

## Release checklist

1. Update `version` in `package.json`, and add the release to `CHANGELOG.md`.
2. Run `npm test`, then try the extension in VS Code with a real model.
3. Run `npm run package`, and check the contents with `npx vsce ls --no-dependencies`.
4. Commit, then create and push a tag that matches the version:

   ```bash
   git tag v0.16.0
   git push origin main v0.16.0
   ```

5. The **Publish to VS Code Marketplace** workflow publishes the tag. Check the listing on both light and dark themes.

## Rules to remember

- Version numbers can't be reused, and an extension name stays reserved even after removal.
- The extension is marked `preview` in `package.json`. Remove that when it's ready for general use.
- Marketplace images must use HTTPS, and README images can't be SVG.
- Keep `npm run package` free of `--skip-license`.

## Documentation

`npm run docs` builds a branded page from `README.md` into `docs/site`. The site is not part of the extension package.
