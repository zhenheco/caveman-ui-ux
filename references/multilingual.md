# multilingual — 三個 locale 概念、`I18N.*` matrix、script ratio

Stage F 的全部內容（`lib/multilingual.mjs`）。penalty 權重與 `multilingualScore` 公式在
`references/rubric.md`；`TECH.LANG.*` 的單頁偵測在 `references/deterministic-checks.md`；
artifact 位置在 `references/pipeline.md`。

## 三個必須分開的 locale 概念

| 概念 | 是什麼 | 誰決定 | 出現在哪 |
|---|---|---|---|
| `report_locale` | **報告寫給誰看**的語言 | `config.report_locale` / `report --locale` | UI label（`locales/*.json`）＋ evaluator 寫 `detail`/`fix_brief` 用的語言 |
| `target_locale` | **被測那一版頁面**宣稱的語言 | `config.target.locales[]` 展開的每個 target | `ScreenRecord.locale`、blind payload、browser `locale` 與 `Accept-Language` |
| `content_language_detected` | 頁面**實際 render 出來**的語言 | `detectScripts(visible_text)` 量出來的 | matrix 的 `residual_ratio`、`I18N.RESIDUAL_LANGUAGE`、`TECH.LANG.MISMATCH` |

三者互相獨立，經常同時不一樣。具體例子：

> 越南語版的 `/vi/pricing` 上線後，日本團隊的 PM 要讀稽核結果。
> `report_locale = 'ja'`（報告用日文寫）、`target_locale = 'vi'`（受測的是越南語版）、
> 而頁面上有一半 CTA 與說明還是英文沒翻，於是 `content_language_detected = 'en'`。
> 這種 run 的價值全在「target 說 vi、內容其實 en」這個落差上——如果把三者混成一個
> 「locale」欄位，落差就消失了，報告會變成「vi 頁面看起來正常」。

Blind evaluator 只拿到 `target_locale` 與 `report_locale` 兩個欄位（見
`references/blind-protocol.md`），它不知道我們量到的 `content_language_detected`，
所以它對「這頁是什麼語言」的反應本身就是獨立證據。

## Route 對齊：`normalized_route` 是 matrix 的鍵

`config.target.locale_prefixes`（例如 `['/zh-TW','/ja','/vi']`）決定 `normalizeRoute` 要剝掉哪一段：
`/vi/pricing?utm=x` → `/pricing`。matrix 的 `rows` 就是一列一個 `normalized_route`，
`by_locale[locale]` 才是各語言的實測值。沒設 `locale_prefixes` 的站（用 cookie 或 domain 切語言）
還是能跑，只是每個 locale 的 route 字串本來就相同，天然對齊。

`rows[i].by_locale[locale]` 的欄位：

```
{ screen_id|null, lang, hreflang_ok, cta_count, primary_cta_text,
  residual_ratio, overflow, chars, longest_word }
```

`screen_id: null` 代表那個 locale 這條 route 沒有成功的 screen（就是 `I18N.MISSING_ROUTE`）。

## Reference locale（比較基準）

基準 = `config.target.locales[0]`。若第一個是 `'auto'`，改用**成功 screen 數最多**的 locale。
CTA parity、overflow、text expansion 三條規則都是「跟基準比」，所以基準選錯會整排誤報：
把主語言放在 `locales` 第一位。單一 locale 的 run 不會產 `I18N.*` 比較類 finding，
`multilingualScore` 也是 `null`（locale < 2 ⇒ 該 gate `skipped`）。

## `I18N.*` 規則與門檻

| rule_id | severity | trigger（門檻） |
|---|---|---|
| `I18N.MISSING_ROUTE` | major | 某個已設定 locale 在這條 route 沒有任何 `status:'ok'` 的 screen |
| `I18N.RESIDUAL_LANGUAGE` | major | target locale 是非拉丁語系（zh / ja / ko / …）且 `script_ratios.latin > 0.35`（分母為非空白可見文字） |
| `I18N.CTA_PARITY` | major | `cta_count` 與 reference locale 不同，或 `primary_cta_text` 缺失 |
| `I18N.OVERFLOW` | major | 這個 locale 有 `TECH.OVERFLOW.HORIZONTAL` 而 reference locale 沒有 |
| `I18N.HREFLANG.MISSING` | major | 設定了 ≥ 2 個 locale 但頁面沒有任何 `hreflang` 連結 |
| `I18N.HREFLANG.NO_SELF` | minor | `hreflang` 集合裡沒有指向自己的那一筆 |
| `I18N.HREFLANG.NO_XDEFAULT` | info | 沒有 `x-default` |
| `I18N.LANG_ATTR_MISMATCH` | major | `<html lang>` 的語言 base ≠ target locale 的語言 base（`lang="en"` vs target `zh-TW`） |
| `I18N.TEXT_EXPANSION` | minor | 這個 locale 的 `chars` > 1.4 × reference locale 的 `chars` **且**同時存在 overflow 或 tap-target finding |

`I18N.TEXT_EXPANSION` 刻意加上第二個條件：文字變長本身不是問題（ja/vi/de 天生比 en 長），
只有**長到把版面撐壞**才是問題。單看 1.4× 會對每個非英文 locale 誤報。

## Script-ratio 偵測法與它的已知弱點

`detectScripts(text)` 回 `{latin, han, kana, hangul, cyrillic, other}` 六個比例：
去掉空白與標點後逐字歸類到 Unicode block，各類字數除以總字數，和為 1。
沒有語言模型、沒有網路、可重跑——這是它能待在 deterministic 階段的唯一理由。

**弱點：它量的是「字用哪套書寫系統」，不是「這句話是哪個語言」。** 以下都會推高 `latin`
而觸發 `I18N.RESIDUAL_LANGUAGE` 誤報：

- **外來語與縮寫**：`API`、`SaaS`、`OK`、`PDF`、`AI` 在中日韓文案裡本來就是拉丁字母。
- **品牌名與產品名**：`Notion`、`Stripe`、公司英文名，通常刻意不翻。
- **程式碼與範例**：docs 頁的 code block、CLI 指令、JSON payload 幾乎全是拉丁字元。
- **數字、單位、日期**：`2026-08-19`、`NT$1,200`、`12 GB`。

所以拿到 `I18N.RESIDUAL_LANGUAGE` 時，讀者要做的是：

1. 打開這筆 finding 的 `text` evidence（`visible_text` 節錄）**自己看**那些拉丁字元是什麼——
   是沒翻的句子，還是品牌與 code。
2. 是真的沒翻 → 照 `fix_brief` 修，`verify` 重測。
3. 是品牌／code／術語造成的 → 用 config 降級或關掉，不要改門檻去遷就單一頁面：
   `rules.severity_overrides: { 'I18N.RESIDUAL_LANGUAGE': 'info' }` 或
   `rules.disabled: ['I18N.RESIDUAL_LANGUAGE']`（docs / API reference 這類頁面很合理）。
   兩者都在 `score` 階段生效，被關掉的數量會列進 `audit.json.limitations`，所以壓過的誤報
   在報告裡看得見、不會變成無聲的消失（細節見 `references/deterministic-checks.md`）。
   `score` 讀的是 `run.json` 的 config 快照 —— 改完 config 要重跑 `capture` 才會套到舊 run。
4. 另一個對照訊號：blind evaluator 有沒有在回答裡提到「看不懂／有外語」。它只看截圖，
   如果人眼第一印象沒被英文卡住，這條大概是誤報。

同一份 ratio 也餵 `TECH.LANG.MISMATCH`（單頁自我矛盾）與 matrix 的 `residual_ratio`，
所以同一個弱點會同時影響那兩個地方，判斷方式一樣。

## 硬規則：受測頁面的 copy 絕對不先翻譯再評估

SPEC-001 §10：**原始 target copy 不可被翻譯後再評估。** 不管 `report_locale` 是什麼，
截圖、`visible_text`、`primary_cta_text`、evidence 一律保留原文；只有我們自己寫的 UI label
與 finding 敘述才走 `report_locale`。

為什麼這條不能通融：

- **殘留語言會被翻掉。** 把 `/vi/pricing` 上沒翻的英文 CTA 先翻成日文再評，
  `content_language_detected` 就變成「乾淨的日文」，`I18N.RESIDUAL_LANGUAGE` 永遠不會開火——
  這條檢查唯一的訊號來源就是「原文長什麼樣」。
- **text expansion 與 overflow 會被抹平。** 字元數與版面溢出是原文渲染出來的物理事實，
  翻譯過的字串長度是另一個世界的數字。
- **CTA parity 會失真。** 翻譯會把兩個不同的按鈕文案「校正」成同一個意思，
  原本 locale 之間的措辭落差就看不見了。
- **blind 第一印象會被汙染。** orchestrator 一旦把截圖內容翻譯或轉述給 evaluator，
  那份回答就作廢（丟掉重 dispatch，不要手改）——細節在 `references/blind-protocol.md`。

報告裡要給 `report_locale` 的讀者理解原文時，做法是**在原文旁邊加註**，
而不是取代原文：`primary_cta_text` 欄位永遠是原字串，翻譯只能出現在 finding 的 `detail` 裡。
