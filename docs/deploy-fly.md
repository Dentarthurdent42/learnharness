# Deploying to Fly.io

This runs LearnHarness in cloud mode (see [cloud-mode.md](cloud-mode.md)) on one always-on Fly machine, with a volume for everyone's data. You then open it in Safari on your iPhone and add it to your Home Screen.

**Cost:** about $10–12/month for a shared-cpu-1x machine with 2 GB memory, plus the 3 GB volume. AI usage is billed separately by your provider, on your keys.

## One-time setup

1. Install the Fly CLI and sign in:
   ```sh
   brew install flyctl        # or: curl -L https://fly.io/install.sh | sh
   fly auth login
   ```
2. From the repo root, create the app without deploying yet. It asks for an app name and the region nearest you, and writes both into `fly.toml`:
   ```sh
   fly launch --copy-config --no-deploy
   ```
3. Set the first admin account's username and password. They're used only on the first boot, while no accounts exist.
   ```sh
   fly secrets set LH_ADMIN_USERNAME=yourname LH_ADMIN_PASSWORD='a long password'
   ```
4. Deploy. The first deploy also creates the `lh_data` volume:
   ```sh
   fly deploy
   ```
5. Open `https://<your-app>.fly.dev`, sign in, and add your AI provider keys in **Settings → Keys**. Then choose models in the setup prompt.

## Adding people

Open **Accounts** in the sidebar and choose **Create invite link**. Send the link yourself (text, email, anything). It works once and expires after 7 days. If someone forgets their password, create a **Reset link** for them on the same page.

## On the iPhone

Open the site in Safari, tap **Share → Add to Home Screen**. You stay signed in for 30 days, renewed each time you use it.

## Keys

You can enter keys in **Settings → Keys**, which saves them to the volume, or set them as Fly secrets (`fly secrets set OPENAI_API_KEY=...`). A secret wins over a key saved in Settings.

## Updates

```sh
git pull && fly deploy
```

Data on the volume is kept across deploys.

## Backups

Fly snapshots volumes daily and keeps each snapshot for 5 days. To list them:

```sh
fly volumes list
fly volumes snapshots list <volume-id>
```

## Troubleshooting

- **"Nobody can sign in" on first boot:** `LH_ADMIN_USERNAME` / `LH_ADMIN_PASSWORD` weren't set. Set them (step 3); the server picks them up on the next request.
- **Logs:** `fly logs`.
- **Demos fail to verify:** the image includes Chromium at `/usr/bin/chromium` (`CHROME_PATH`). Check `fly logs` for errors from the headless browser.
