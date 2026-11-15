# Hosting and proposed services

## Current deployment

The existing repository's GitHub Pages deployment serves static files. There is
no paid compute, database, telemetry ingestion or model inference configured by
this change. The current incremental recurring commitment is **USD 0/month**.
This is bounded static hosting, not unlimited throughput or an always-on backend.
This is a public open-source tool demonstration, with no payment or SaaS service
on Pages. A commercial transaction service would need a suitable host.
Provider limits and policies still apply; see
[GitHub Pages limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits).

Browser CPU and memory belong to the visitor's device. Captures stay local, so
capture size does not create upload, database or archival storage charges here.
The public synthetic sample and Wasm asset still consume static bandwidth.

## Capacity and cost model

For a different host, estimate monthly bytes as `new visits × uncached public
asset bytes + repeat cache misses × changed asset bytes`. Add request, storage,
build, support and tax charges from that provider's current terms. No exact AWS
per-million-record cost is claimed: this application does not ingest records in
AWS, and record size, region, retention and request batching are unspecified.

Before provisioning an IoT/Core or Greengrass integration, estimate device
connections, message sizes/rates, rules actions, downstream writes, retention,
monitoring, backups, bandwidth and overages. Alerts are not hard spending caps.
The owner's current authorization remains a $0 temporary demo; paid resources
require a separate itemized approval.

## Revenue hypothesis, not an available paid licence

MIT already permits commercial use. A proposed **$49–$199 custom support
engagement** could cover a reviewed dialect, integration help or a reproducible
capture investigation. It is not a recurring subscription, certification,
binary-use restriction, or demonstrated market demand. There is no checkout or
email capture in the app. A public GitHub issue draft can request a conversation;
it explicitly warns against private captures or contact details.

Validate demand with actual engineers and measure support time before setting a
price. Revenue is `paid engagements × agreed fee`; subtract engineering time,
payment fees and taxes. No paying users, margin or MRR are claimed.
