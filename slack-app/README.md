# slack-app

Slack app manifest for content-agents, managed with the Slack CLI (`slack manifest validate`, `slack app install`).
No server lives here: outbound messages use the bot token from Trigger.dev tasks; inbound intake (link posts) is wired
up in Phase 2 via an event relay. `.slack/` holds per-workspace app ids and is gitignored.
