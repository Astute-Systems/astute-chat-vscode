# Publishing Astute Code

This guide is for Astute Systems staff who release the extension to the VS Code Marketplace.

## Before the first release

1. **Set up Trusted Publishing.** Global Azure DevOps personal access tokens retire on 1 December 2026, so don't build on them.
   1. Sign in to the [publisher management page](https://marketplace.visualstudio.com/manage) and open `AstuteSystems`.
   2. Select **Trusted Publishing**, then expand **Create**.
   3. Set the repository owner to `Astute-Systems`, the repository to `astute-chat-vscode` and the workflow to `publish.yml`. Leave the environment empty.

## Release checklist

1. Update `version` in `package.json`, and add the release to `CHANGELOG.md`.
2. Run `npm test`, then try the extension in VS Code with a real model.
3. Run `npm run package`, and check the contents with `npx vsce ls --no-dependencies`.
4. Commit, then create and push a tag that matches the version:

   ```bash
   git tag v0.16.1
   git push origin main v0.16.1
   ```

5. Pushing the tag starts the **Publish to VS Code Marketplace** workflow straight away, and a version number can't be reused, so check that the **CI** workflow passed on that commit first.
6. Once it finishes, check the listing on both light and dark themes.

## Publish from your machine

Releases normally go through the workflow above. To publish by hand, keep an Azure DevOps personal access token in `.env` at the repository root:

```bash
AZURE-PAT=<your token>
```

`.env` is ignored by Git and left out of the extension package. Never commit it or paste the token anywhere, because the repository is public. Stage files by name if you're unsure, and check `git status` before you commit.

Then publish with:

```bash
npm run publish:marketplace
```

The script reads the token itself and hides it in its output, so an agent can run this without seeing the token. Agents can't read `.env`, and that's deliberate, because anything they read goes into the model's prompt.

Global tokens retire on 1 December 2026, so use this only as a fallback until Trusted Publishing is set up.

## Rules to remember

- Version numbers can't be reused, and an extension name stays reserved even after removal.
- The extension is marked `preview` in `package.json`. Remove that when it's ready for general use.
- SVG assets: The plugin can generate SVG images, diagrams, and logos. These should be used for internal documentation and examples, but remember that the Marketplace README images must use HTTPS and cannot be SVG.
- Keep `npm run package` free of `--skip-license`.

## Documentation

`npm run docs` builds a branded page from `README.md` into `docs/site`. The site is not part of the extension package.
