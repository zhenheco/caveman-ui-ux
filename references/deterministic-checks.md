# deterministic-checks — `TECH.*` 偵測邏輯、axe、Lighthouse、link check

Stage D 的全部內容：`lib/checks.mjs` 的 DOM 規則、`lib/axe.mjs` 的 axe-core 正規化、
`lib/lighthouse.mjs` 的外部 adapter。Stage 之間的關係看 `references/pipeline.md`，
分數公式看 `references/rubric.md`，授權邊界看 `references/licenses.md`。

## 為什麼 deterministic 的 confidence 是 1.0

Deterministic finding 的 trigger 是一個**可量測的謂詞**：同一份 DOM 快照重跑必得同一結果，
不經任何模型，所以 `kind:'deterministic'`、`confidence: 1.0`。Heuristic（`UX.*`）與 blind
（`CAVEMAN.*`）是判斷，confidence 由 evaluator 自己給、由 consensus 折算，永遠不會是 1.0。
差別有牙齒：gate 的 `critical_maximum` 只排除 `confidence < 0.60` 且**不是** deterministic 的
finding——換句話說低信心的意見不能單獨擋 CI，但一條 `TECH.FORM.MISSING_LABEL` 可以。

Stage D 全程**不需要任何 LLM**：`audit --no-llm` 就是這一段（加 A/B/F/H）。任何需要模型才能
判斷的東西都不准寫進 `runChecks`，該去 Stage E。

## `runChecks(dom, target)` 的輸入：DomEvidence

`collectDom(page)` 在頁面裡跑一次 `page.evaluate`，回傳純資料（`runChecks` 因此是 pure function，
可直接對 fixture 做單元測試）：

```
{ title, meta:{description,viewport,robots}, lang, dir, hreflang:[{hreflang,href}],
  headings:[{level,text,selector}], landmarks:{header,nav,main,footer,aside},
  forms:[{selector, controls:[{tag,type,name,hasLabel,labelText,placeholder,required,selector}]}],
  links:[{text,href,selector,target}], buttons:[{text,selector,isPrimaryCandidate}],
  images:[{selector,alt,hasAlt,naturalWidth,naturalHeight}],
  overflow:{documentScrollWidth, clientWidth, offenders:[{selector,box}]},
  tap_targets:[{selector,box}], text_stats:{chars,words,longest_paragraph_words,
  script_ratios:{latin,han,kana,hangul,cyrillic}}, visible_text, viewport:{width,height} }
```

`selector` 一律走 `stableSelector(node)`：有 `id` 就 `#id`，否則 nth-of-type 路徑——它同時是
`deterministicFindingId` 的輸入，所以 selector 穩不穩直接決定 finding ID 跨 run 穩不穩。

## `TECH.*` 規則表

| rule_id | severity | 偵測邏輯 | evidence emitted |
|---|---|---|---|
| `TECH.TARGET.UNREACHABLE` | blocker | navigate 拋錯，或 `http_status >= 400` | `metric{name:'http_status',unit:'status'}` + `text{value: error message}` |
| `TECH.OVERFLOW.HORIZONTAL` | major | `overflow.documentScrollWidth > overflow.clientWidth + 1`（+1 吸收 subpixel） | `metric{name:'overflow_px'}` + `metric{name:'document_scroll_width'}` + `metric{name:'client_width'}`（皆 `unit:'px'`）+ 前 5 個 `offenders` 的 `dom` |
| `TECH.TAP_TARGET.SMALL` | minor | `tap_targets` 中 `box.w < 24 \|\| box.h < 24`（互動元素才進 `tap_targets`） | `dom` + `metric{name:'width',unit:'px'}` + `metric{name:'height',unit:'px'}` |
| `TECH.HEADING.MISSING_H1` | major | `headings.filter(h => h.level === 1).length === 0` | `metric{name:'h1_count', value:0}` + `metric{name:'heading_count'}` + `text{value: 前 3 個 heading}` |
| `TECH.HEADING.MULTIPLE_H1` | minor | 同上 `>= 2` | `metric{name:'h1_count'}` + 前 5 個 h1 的 `dom` |
| `TECH.HEADING.SKIPPED_LEVEL` | minor | 依文件順序，相鄰 heading `level(next) - level(prev) > 1` | `dom` + `metric{name:'from_level'}` + `metric{name:'to_level'}`（皆 `unit:'level'`） |
| `TECH.FORM.MISSING_LABEL` | critical | control 同時沒有 `hasLabel`、`aria-label`、`aria-labelledby`、`title`（`placeholder` **不算** label） | `dom` + `text{value: placeholder\|name}` + `metric{name:'required',unit:'bool'}` |
| `TECH.LINK.BROKEN` | major | `checkLinks` 回報 status ≥ 400 或網路錯誤 | `dom{html: link text}` + `metric{name:'http_status',unit:'status'}` + `text{value: 絕對 URL}` |
| `TECH.LINK.EMPTY_TEXT` | minor | anchor 的 accessible text 為空（去空白後 `text === ''`）且沒有 `aria-label` | `dom` + `text{value: href}` |
| `TECH.IMG.MISSING_ALT` | major | `hasAlt === false`（**`alt=""` 是合法的裝飾圖，不報**） | `dom` + `metric{name:'natural_width'}` + `metric{name:'natural_height'}`（皆 `unit:'px'`） |
| `TECH.LANG.MISSING` | major | `lang` 為空 | `dom{selector:'html'}` + `text{value:'lang attribute is absent'}` |
| `TECH.LANG.MISMATCH` | major | `visible_text` 的主導 script 與 `lang` 的語言 base 矛盾，且 `text_stats.chars >= 30`（太短不判） | `dom{selector:'html'}` + `metric{name:'dominant_script_ratio',unit:'ratio'}` + `text{value: visible_text 前 200 字}` |
| `TECH.META.MISSING_VIEWPORT` | major | `meta.viewport` 為空 | `dom` + `text{value:'<meta name=viewport> absent'}` |
| `TECH.NAV.NO_LANDMARK` | minor | 沒有 `<nav>` 也沒有 `role="navigation"`（`landmarks.nav === 0`） | `metric{name:'nav_landmarks', value:0, unit:'elements'}` + `text` |
| `TECH.NAV.NO_MAIN` | minor | 沒有 `<main>` 也沒有 `role="main"` | `metric{name:'main_landmarks', value:0, unit:'elements'}` + `text` |

`dom` evidence 一律是 `{type:'dom', selector, node_path, html}`——`selector`／`node_path`／`html`
三個欄位都會出現，值可能是空字串。
**沒有任何 deterministic rule 產 `screenshot_region`**——那是 blind evaluator（Stage C）才有的
evidence type，所以 `--no-llm` 的 `report.html` 不會嵌任何截圖。要用 `name` 選 evidence 的人請照
上表的字串，不要照猜（例如 overflow 是 `overflow_px`，不是 `scroll_overflow_px`）。
每條 rule 每個 screen 最多 **10 筆** finding（`MAX_FINDINGS_PER_RULE`），超出的同類問題不再重複列。

Severity 是 pack 的 `severity_default`，可被 config 的 `rules.severity_overrides` 蓋掉；
`rules.disabled` 可整條關掉。兩個 knob 都在 **`score` 階段**生效（不是產 finding 的當下），
四個 producer（axe / checks / heuristic / multilingual）在那裡匯流，所以哪個 stage 產的都管得到：

- `disabled` 的 finding 直接丟掉，`accessibility` 分數也跟著不算它，數量寫進
  `audit.json.limitations`（字串是 `N finding(s) suppressed by config.rules.disabled`，
  report 的 Limitations 章節看得到）——壓過的誤報不會無聲消失。
- `severity_overrides` 在算 gate 與 score 前改寫 `finding.severity`，所以它真的能讓
  `critical_maximum` 放行一條誤報。runtime 才生成的 `A11Y.AXE.*` id 不在 pack 裡，
  沒下 override 就沿用 axe impact 換算出來的 severity；下了 override 一樣有效。
- `score` 用的是 `run.json` 的 config 快照 —— 改完 config 要重跑 `capture` 才會套到舊 run。

每條 rule 都必須存在於 `rules/core.pack.yaml`，`rules check` 會驗。
`TECH.LANG.MISMATCH` 與 `I18N.*` 的分工：前者只看單一頁面自己矛不矛盾，跨 locale 比較是
Stage F 的事（`references/multilingual.md`）。

## axe-core 整合（`lib/axe.mjs`）

- 版本**釘死** `AXE_VERSION = '4.10.2'`。不隨便升：axe 升版會改 rule id 與 impact，finding ID 與
  accessibility score 會整批漂移，升版要當一次刻意的 baseline 重建。
- Cache（不 vendor 進 bundle）：
  `${CAVEMAN_STATE_DIR || $HOME/.claude/state/caveman-ui-ux}/vendor/axe-core-4.10.2/axe.min.js`。
  首次用 `node:https` 下載（不呼叫 curl），之後全部命中 cache；cache miss 又 `--offline`
  ⇒ `EXIT.DEPENDENCY (4)`。
- **MPL-2.0**：axe-core 以「執行期下載的外部檔案」使用，不進 repo、不改原始碼、授權與出處記在
  `references/licenses.md`。不要把 `axe.min.js` commit 進任何專案。
- 注入方式 `page.addScriptTag({ content })`（不是 CDN `<script src>`，report 與 audit 都必須離線可跑），
  然後 `page.evaluate(() => axe.run(document, { resultTypes:['violations'], reporter:'v2' }))`。
  只要 `violations`：`passes`/`incomplete` 只留計數，因為 `incomplete` 需要人判斷，塞進 findings
  會製造假工作。
- 正規化（`normalizeAxe`）：
  - `rule_id = 'A11Y.AXE.' + axeId.toUpperCase().replace(/-/g,'_')`（`color-contrast` → `A11Y.AXE.COLOR_CONTRAST`）
  - severity 由 impact 映射：`critical→critical`、`serious→major`、`moderate→minor`、`minor→info`
  - `kind:'deterministic'`、`confidence: 1.0`
  - evidence：每個 node 一筆 `dom{selector, node_path: target.join(' >>> '), html: 前 200 字}`，
    再加一筆 `text{value: 第一個 node 的 html 前 200 字}`
  - `stableSelector` 取第一個 node 的 target 字串，餵給 `deterministicFindingId`
- **node cap 5**：每條 violation 最多列 5 個 node（report 才讀得完），但真實數量保留成
  `metric{name:'axe_node_count', value: <真實總數>, unit:'nodes'}`；accessibility score 的 penalty
  也用 `min(nodeCount, 5)`，所以 200 個同類 node 不會把分數打成 0。

## Lighthouse adapter（`lib/lighthouse.mjs`，optional）

`lighthouseAvailable()` 先找本機 bin，再退 `npx`；都沒有就 `{available:false}`。呼叫一律用
**argv array**，不組 shell 字串（SPEC-001 §11：url 進 shell 就是 injection）：

```
npx -y lighthouse@12 <url> --output=json --output-path=stdout --quiet
  --only-categories=performance,accessibility,best-practices,seo
  --form-factor=<mobile|desktop> --screenEmulation.mobile=<bool>
  --chrome-flags=--headless=new
```

`env: { ...process.env, CHROME_PATH: chromePath }` —— 用 Stage A 已經解析成功的那顆 Chrome，
不讓 Lighthouse 自己去猜（bundled chromium 在本機是壞的）。

跑 `runs = 3` 次，**每個 category 各自取 median**（不是取某一次的整份報告）。
理由：Lighthouse 的 performance 在同一台機器上單次波動就能到十幾分，單次比較會生出假 regression
與假修好——所以「跑一次比較兩個 commit」在本 skill 裡是無效證據，report 只呈現 median。

`technicalScore` 只用 `0.5*performance + 0.3*best-practices + 0.2*seo`：performance 是使用者實際
感受到的技術品質，權重最重；best-practices 抓的是明確的實作錯誤；seo 只當衛生指標。
Lighthouse 自己的 `accessibility` 分數**記錄但不計分**——a11y 由 axe 負責，兩套併算等於重複計權。

不可用時 `technical: null` + 一筆 `limitations`，gate 記 `skipped`；只有 `--ci` 且沒給
`--allow-missing-technical` 才升成 `EXIT.DEPENDENCY (4)`。

## `checkLinks(page, dom, { timeoutMs = 8000, max = 40 })`

- 先 `HEAD`（`maxRedirects: 5`、`failOnStatusCode: false`）；server 對 HEAD 回 **405 或 501**
  時**同一個 URL 再試一次 `GET`**，只有 GET 也失敗才算 broken（否則會大量誤報）。
  注意：連線層錯誤（timeout、ECONNREFUSED、TLS 失敗）**不會**退 GET，直接算 broken。
- **只驗 same-origin**：`resolved.origin !== page.url() 的 origin` 一律跳過。第三方 host 常對
  無頭瀏覽器回 403/429，驗了就是一堆誤報。所以外部死連結**本 skill 不會抓到**，
  零 `TECH.LINK.BROKEN` 不代表外站連結都活著。
- concurrency **6**、候選上限 **max = 40**、單一請求 `timeoutMs = 8000`。上限是刻意的：link check
  是 UX 稽核的附帶品，不是 crawler。超過 40 條就**靜默停止收集**（沒有 `limitations` 記錄，
  `checkLinks` 只回 `Finding[]`，沒有回報截斷的通道），所以連結很多的頁面要自己知道只驗了前 40 條。
- 破的連結最多吐 **10 筆** finding（`MAX_FINDINGS_PER_RULE`），排序後取前 10。
- 跳過不驗的 scheme：`mailto:`、`tel:`、`sms:`、`javascript:`、`data:`、`blob:`、`about:`、
  純 fragment（`#...`）以及任何非 `http(s)` 的 scheme——它們沒有 HTTP status 可言，驗了只會製造噪音。
- 去重是對「解析成絕對 URL 並去掉 `#hash`」後的字串做（同頁重複連結只算一條）。

## 加新 deterministic rule 的門檻

1. trigger 必須能寫成對 `DomEvidence` 的純述詞——需要看語意就不是 deterministic。
2. rule 要先進 `rules/core.pack.yaml`（stable id、version、severity_default、evidence.accepted）。
3. 要有 fixture：`scripts/tests/fixtures/` 裡一個會觸發、一個乾淨的頁面，e2e 斷言它在該 fixture 上開火。
4. 至少吐一筆 evidence——`blocker|critical|major` 沒 evidence 會在 Stage H 被丟掉並記進 `limitations`。
