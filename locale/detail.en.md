# DeepSeek Web Channel

Use a signed-in DeepSeek session in Edge or Chrome with dsh tasks and local tools. No API key is required.

## Features

- Manual or automatic sending, with final results shown by default.
- Tools supplied by dsh, subject to its permissions and approvals.
- Context handoff for long tasks, rate-limit retries and window switching.
- Optional DeepSeek self-review or a separate Kimi / GLM review.

## Start and configure

Enable the plugin and restart dsh. Select `deepseek-web`, sign in through the browser window, and click Send after the message is filled in. Select `deepseek-web-auto` for automatic sending.

Open **Plugins → DeepSeek Web Channel → llm-deepseek-web → Configuration**.

Choose sending, browser, review and tool preferences, then save. Browser connection changes require restarting dsh. After upgrading, use the configuration page's “Use all host tools” action to clear an old tool allowlist. Configuration controls currently use Chinese labels.

## Notes

- Thinking and search modes are controlled on the website. Kimi / GLM review requires a separate sign-in.
- Website changes and expired sessions can interrupt the channel. Images and attachments are not uploaded to the website yet.
- Uninstalling normally preserves browser sign-in state and runtime data.

[Installation and full guide](https://github.com/LittleCar30/dsh-deepseek-web#readme) · [Report an issue](https://github.com/LittleCar30/dsh-deepseek-web/issues)
