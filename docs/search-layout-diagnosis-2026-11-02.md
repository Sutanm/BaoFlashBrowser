# Search layout diagnosis — 2026-11-02

## Method

Ran six isolated Electron 11.5.0 BrowserViews at 1600 × 1000 CSS pixels,
zoom 1, using the public query `redis`. Each case uses a fresh in-memory
partition under the probe host's temporary userData. No real cookies, account
storage, passwords or userscript configuration are changed.

The runtime cases load the full production BrowserView preload, compiled by
the existing smoke builder, and the userscript manager with its fresh-profile
built-ins. They do not copy the user's edited scripts. Session-policy cases
compile and call the current `applyCompatibilitySessionConfig` source.

Reproduce in PowerShell (run this opt-in probe on its own):

```powershell
npm run ensure:smoke-bundles
$env:BAO_PROBE_SEARCH = '1'
npm run probe:deep -- --only 25 --json
Remove-Item Env:BAO_PROBE_SEARCH
```

Outputs: `artifacts/search-layout/report.json` and one PNG per case. These
are local diagnostic artifacts; network diagnostics contain hostnames and
resource types, not request query strings or credentials.

## Observations

| Case | Navigation | Result width | Heading font | Organic results |
|---|---|---|---|---|
| cn.bing.com, Chrome 87 | 网页/图片/视频/学术/词典 | ~648px | Arial 20px | 10 |
| www.bing.com, Chrome 87 | 全部/图片/视频/地图/资讯 | 648px | Arial 20px | 10 |
| www.bing.com, spoofed Edge 142 | 全部/AI 模式/图片/视频 | 648px | Roboto 20px | 10 |
| cn.bing.com + project session rules | Same domestic navigation | ~648px | Arial 20px | 10 |
| cn.bing.com + rules + production preload/built-ins | Same domestic navigation | ~648px | Arial 20px | 10 |
| www.bing.com + rules + production preload/built-ins | International navigation | 648px | Arial 20px | 10 |

All cases had no horizontal overflow. Domestic result top was ~192px;
international was 164px. Session rules and the runtime case preserved the
domestic result geometry. International result total heights varied with
the returned content; do not interpret those as a controlled CSS comparison.

Screenshots show international Bing's right-hand related searches and layout
already work in Chromium 87. Spoofing Edge changes the served template and
fonts, but does not establish equivalent behavior to real Edge. No actual
modern Edge runtime was automated in this test.

The screenshot supplied by the user contained a large ad with expanded
sitelinks. The fresh-profile tests returned no `.b_ad` blocks, so that
specific ad layout was not reproduced. Cookies, region, account state,
experiments and ads remain uncontrolled between the original screenshots.

Read-only inspection of installed userscript metadata confirmed that the CSS
fixer currently matches Ruffle and GitHub only, not Bing. Its mere presence
as an enabled script cannot explain the Bing screenshot. The broad-match
demo and floating assistant scripts can add visible overlays.

## Conclusion and limits

The current evidence identifies domain/template selection as a major source
of the Bing differences; it does not support a blanket broken-CSS diagnosis.
Changing the search URL from cn to www can make the presentation closer to
the user's Edge screenshot, but also changes search market behavior and is
not an engine-independent layout fix. No product default or global UA was
changed during diagnosis.

Cross-engine visual consistency requires either maintained per-site DOM/CSS
adapters or an internal results page fed by structured search APIs. CSS alone
cannot unify different providers' result structures, ranking, rich cards,
ads and server-selected page templates. An internal page can share typography,
spacing and result components while providers supply the result data. This
does not imply that every provider exposes an API or identical capabilities.
