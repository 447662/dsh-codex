# dsh-codex 鈥?鐢?DSH 鐨勮亰澶╃晫闈㈢洿鎺ラ┍鍔?Codex

DSH 璐熻矗鑱婂ぉ鐣岄潰锛?*Codex CLI 璐熻矗鏁翠釜浠诲姟鎵ц涓庡師鐢熷巻鍙?*銆備綘鍦?DSH 閲岃緭鍏ョ殑浠诲姟浼?*鍘熸牱**浜ょ粰 Codex 鐨?`turn/start`锛屾病鏈変换浣曠浜屼釜 AI 杞堪銆佹€荤粨鎴?璇昏亰澶╂。妗堟ā鎷熺画鎺?鐨勭幆鑺傦紱鐣岄潰閲屾覆鏌撶殑姣忎竴涓瓧閮芥潵鑷?Codex 鑷繁鎺ㄩ€佺殑鍗忚甯с€?
```
DSH Web GUI (鏈彃浠?client 鍗?
   鈹? POST /dsh-codex/rpc      鈫?涓€娆℃€ц姹?鍝嶅簲
   鈹? GET  /dsh-codex/events   鈫?SSE锛氭祦寮忚緭鍑?/ 瀹℃壒 / 閫氱煡
   鈻?鏈彃浠?host 鍗婏紙璺戝湪 DSH 瀹夸富杩涚▼閲岋級
   鈹? newline-delimited JSON-RPC over stdio
   鈻?codex app-server  鈫愨啋  Codex CLI 鍘熺敓绾跨▼锛堝敮涓€鍘嗗彶鏉ユ簮锛?```

---

## 1. 鍏」瑕佹眰鐨勮惤鍦颁綅缃?
| # | 瑕佹眰 | 瀹炵幇 | 浠ｇ爜 |
|---|------|------|------|
| 1 | 鎵撳紑鏃у璇濓細鏌ョ嚎绋嬪垪琛ㄣ€佽鍙栧苟鎭㈠ | `thread/list`锛堟悳绱?鍒嗛〉锛? `thread/resume` + `thread/turns/list`(`itemsView:"full"`) + `thread/items/list` 鍥炲～ | `lib/bridge.js` `listThreads` / `attachThread` / `hydrateHistory` |
| 2 | 鏂板缓浠诲姟锛氬師鐢熺嚎绋?+ 宸ヤ綔鐩綍/妯″瀷/鏉冮檺 | `thread/start`锛坄cwd`/`model`/`approvalPolicy`/`sandbox`锛夛紱妯″瀷涓庢潈闄愮洰褰曟潵鑷?`model/list`銆乣permissionProfile/list` | `createThread`銆乣listModels`銆乣listPermissionProfiles` |
| 3 | 鍙戦€佹秷鎭細鐩存帴杩?Codex 鐨?turn | `turn/start`锛屾枃鏈師鏍蜂綔涓?`input:[{type:"text",text}]`锛涙墽琛屼腑杩藉姞鍒欒蛋 `turn/steer` | `startTurn`銆乣steerTurn` |
| 4 | 娴佸紡杈撳嚭 | `item/started`/`item/completed` 寤虹珛楠ㄦ灦锛宍item/agentMessage/delta`銆乣item/reasoning/*Delta`銆乣item/plan/delta` 閫愬抚绱姞 | `_onNotification`銆乣applyItemDelta` |
| 5 | 宸ュ叿灞曠ず | `commandExecution`锛堝懡浠?鐘舵€?exit code/杈撳嚭/鑰楁椂锛夈€乣fileChange`锛堟枃浠舵竻鍗?+ unified diff锛夈€乣mcpToolCall`/`dynamicToolCall`/`webSearch`/`functionCallOutput`銆乣error`/`warning` 閫氱煡 | `client/client.js` 鍚?`*Item` 缁勪欢 |
| 6 | 鍋滄浠诲姟 | `turn/interrupt`锛堢湡涓柇锛屼笉鏄仠鍔ㄧ敾锛夛紱骞跺厛鍥炵粷 Codex 姝ｅ湪绛夊緟鐨勫鎵癸紝閬垮厤涓柇鎺掑湪瀹℃壒鍚庨潰 | `interruptTurn` |
| 7 | 瀹℃壒涓庢彁闂?| 鏈嶅姟绔姹?鈫?鐣岄潰鍗＄墖 鈫?閫夋嫨鍥炰紶锛歚item/commandExecution/requestApproval`銆乣item/fileChange/requestApproval`銆乣item/permissions/requestApproval`銆乣item/tool/requestUserInput`銆乣mcpServer/elicitation/request` | `_onServerRequest`銆乣buildApprovalResponse`銆乣ApprovalCard`/`QuestionCard` |
| 8 | 鍒锋柊涓庨噸鍚?| 绾跨▼鈫斾細璇濆叧鑱旀寔涔呭寲鍒?`~/.dsh/storages/dsh-codex/bindings.json`锛沗clientMessageId` 骞傜瓑鍘婚噸锛汼SE 鏂嚎鑷姩閲嶈繛骞堕噸鏂?`snapshot`锛沘pp-server 閲嶅惎鍚庤嚜鍔?`thread/resume` | `lib/bindings.js`銆乣startTurn` 鍘婚噸銆乣connectEvents` |

---

## 2. 鐣岄潰钀界偣

瀹夎鍚庝細澶氬嚭鍥涗釜鍏ュ彛锛堝叏閮ㄨ蛋 DSH 瀹樻柟 Slot 鎵╁睍鐐癸紝涓嶆敼鍔?DSH 鑷甫 UI锛夛細

| Slot | 浣滅敤 |
|------|------|
| `main[codex]` + `sidebar.panellist[codex]` | 渚ц竟鏍忕殑 **Codex** 鍥炬爣 鈫?鐙珛 Codex 宸ヤ綔鍙帮細绾跨▼鍒楄〃 / 鎼滅储 / 鏂板缓浠诲姟锛坈wd銆佹ā鍨嬨€佹潈闄愮瓥鐣ャ€佹矙绠憋級/ 瀵硅瘽娴?/ 杈撳叆妗?/ 鍋滄鎸夐挳 / 閲嶅懡鍚?/ 閲嶅惎 Codex |
| `conversation.view[codex]` | 鏅€?DSH 浼氳瘽閲屼笌銆屽璇?/ 杞ㄨ抗銆嶅苟鍒楃殑 **Codex** 瑙嗗浘锛氭樉绀鸿浼氳瘽缁戝畾鐨?Codex 绾跨▼ |
| `conversation.composer` | 浼氳瘽涓€鏃︾粦瀹?Codex锛?*鎺ョ璇ヤ細璇濈殑杈撳叆妗?*锛氭鍚庤浼氳瘽鐨勬瘡鏉¤緭鍏ラ兘鐩存帴杩?Codex |
| `conversation.input.right[codex]` | 鍘熺敓杈撳叆妗嗗彸渚х殑 **Codex** 鎸夐挳锛氭妸褰撳墠鑽夌鐩存帴浜ょ粰 Codex锛堣崏绋夸互 `@Codex` 寮€澶存椂楂樹寒涓恒€屼氦缁?Codex銆嶏級 |

### `@Codex` 鐨勮涔?
鎸変綘鐨勯€夋嫨瀹炵幇涓?*鎺ョ寮?*锛?
1. 鍦ㄤ細璇濋噷杈撳叆 `@Codex <浠诲姟>`锛堟垨鐢ㄨ緭鍏ユ鍙充晶鐨?Codex 鎸夐挳锛夛紝璇ヤ細璇濆嵆琚粦瀹氬埌涓€涓?Codex 绾跨▼锛屼换鍔＄洿鎺ヤ笅鍙戯紱
2. 缁戝畾涔嬪悗锛?*璇ヤ細璇濈殑杈撳叆妗嗚 Codex 鎺ョ**锛屽悗缁秷鎭棤闇€鍐嶅啓 `@Codex`锛屽叏閮ㄧ洿鎺ヨ繘 Codex锛?3. 鎯充氦杩樼粰 DSH锛岀偣杈撳叆妗嗕笂鏂圭殑銆屼氦杩?DSH銆嶅嵆鍙紙涓嶄細鍒犻櫎 Codex 閭ｈ竟鐨勭嚎绋嬶級銆?
---

## 3. 閰嶇疆

閰嶇疆璧颁竴涓?JSON 鏂囦欢锛?*涓嶆槸** `cordis.patch.yml` 閲岀殑 `config:`锛夛細

```
~/.dsh/storages/dsh-codex/config.json
```

```json
{
  "codexBin": "codex",              // Codex 鍙墽琛屾枃浠讹紱鐣欏湪 PATH 涓婂氨鐢?codex
  "codexArgs": [],                  // 杩藉姞鍦?app-server 涔嬪悗鐨勫弬鏁?  "transport": "stdio",             // stdio锛堝凡瀹炵幇锛夛紱daemon 涓洪鐣欓€傞厤灞?  "experimentalApi": true,          // 鎵撳紑 app-server 瀹為獙鎬ф柟娉曚笌瀛楁
  "approvalPolicy": "on-request",   // 鏂板缓绾跨▼榛樿瀹℃壒绛栫暐
  "sandbox": "workspace-write",     // 鏂板缓绾跨▼榛樿娌欑
  "model": "",                      // 鏂板缓绾跨▼榛樿妯″瀷锛涚┖ = 鐢?Codex 鑷繁鐨勯粯璁?  "traceWire": false                // true 鏃舵妸姣忎竴甯у崗璁啓杩涙彃浠舵棩蹇?}
```

鏂囦欢涓嶅瓨鍦ㄦ垨鍐欏潖浜嗛兘浼氶€€鍥炰唬鐮侀噷鐨勯粯璁ゅ€硷紝缁濅笉褰卞搷鎻掍欢鍚姩銆?
> **涓轰粈涔堜笉鏀惧湪 patch 鐨?`config:` 閲岋紵**
> cordis 鐨?`resolveConfig` 浼氭嬁鎻掍欢瀵煎嚭鐨?`Config` **schema** 鍘绘牎楠?patch 閲岀殑 config锛?> ```js
> function resolveConfig(runtime, config) {
>   if (!runtime.Config) return config
>   const result = runtime.Config["~standard"].validate(config)   // 鈫?>   ...
> }
> ```
> 鏈彃浠舵病鏈?schema 搴撳彲鐢紙pnpm 闅旂甯冨眬涓?`@deepseek-ai/cordis` 涓嶅彲浠庢彃浠跺寘鍐呰В鏋愶級锛?> 涓€鏃﹀鍑烘櫘閫氬璞″綋 `Config`銆佹垨鍦?patch 閲屾彁渚?config锛屾潯鐩氨浼氫互
> `TypeError: Cannot read properties of undefined (reading 'validate')` **婵€娲诲け璐?*锛?> `apply()` 鏍规湰涓嶄細鎵ц銆傝繖姝ｆ槸鏈彃浠剁涓€娆¤杩涚湡瀹?DSH 鏃惰俯鍒扮殑鍧?> 锛坄Config` 妫€鏌ュ櫒褰撴椂鎶ョ殑鍞竴寮傚父鐘舵€?`unsupported`锛夈€傛墍浠ユ彃浠舵棦涓嶅鍑?`Config`锛?> patch 閲屼篃涓嶅甫 config锛屼笌涓や釜鍙敤鐨勭涓夋柟鎻掍欢淇濇寔涓€鑷淬€?> 鑻ヤ互鍚庤鎭㈠ loader 鎵樼閰嶇疆锛屽鍑虹鍚?Standard Schema 鐨勫璞″嵆鍙細
> `export const Config = { '~standard': { version: 1, vendor: 'dsh-codex', validate: (v) => ({ value: ... }) } }`銆?
鎻掍欢鏃ュ織锛歚~/.dsh/logs/dsh-codex.log`锛屼篃鍙互鍦ㄦ祻瑙堝櫒閲?`GET /dsh-codex/log` 鐪嬫渶杩?300 琛屻€?瀹㈡埛绔妸鍏抽敭璇婃柇锛圫lot 娉ㄥ唽銆佽緭鍏ユ hook 褰㈢姸锛塒OST 鍒?`/dsh-codex/diag`锛屽悓鏍疯惤鍦ㄨ繖涓枃浠堕噷銆?
---

## 4. 瀹夎 / 鍗歌浇

### 浠?GitHub 瀹夎锛堟帹鑽愶級

```bash
dsh plugin --profile desktop add git+https://github.com/447662/dsh-codex.git
```

鐒跺悗**閲嶅惎 DSH**銆俙dsh plugin add` 浼氭妸鍖呭啓杩?profile 鐨?`dependencies` 涓?`dsh.profile.bundles`锛屾彃浠惰嚜甯︾殑 `cordis.patch.yml` 浼氭妸鑷繁鎻掕繘鍔犺浇鏍戙€?
> **蹇呴』閲嶅惎**锛歱rofile 鐨?bundle 鍒楄〃涓嶄細鍦ㄨ繍琛屼腑鐑姞杞斤紱`plugin-manager` 鐨勫惎鐢?鍋滅敤鍙垏鏉＄洰鐨?`disabled` 浣嶏紝涓嶄細閲嶆柊瀵煎叆妯″潡銆?
### 浠庢湰鍦板厠闅嗗畨瑁咃紙寮€鍙戠敤锛?
```powershell
git clone https://github.com/447662/dsh-codex.git <浠撳簱璺緞>

# 1) 璁?profile 鑳借В鏋愬埌鏈寘锛坖unction 绛変环浜?pnpm link锛?New-Item -ItemType Junction -Path "$env:DSH_PROFILE_DIR\node_modules\dsh-codex" -Target "<浠撳簱璺緞>"

# 2) 鍦?profile 鐨?package.json 閲屽姞涓婏細
#    dependencies."dsh-codex" = "link:<浠撳簱璺緞>"
#    dsh.profile.bundles      += "dsh-codex"
#    涓嶈鍦?cordis.patch.yml 閲岀粰 dsh-codex 鍐?config锛堝師鍥犺绗?3 鑺傦級
```

### 鍗歌浇

```powershell
# 浠?profile package.json 鐨?dsh.profile.bundles 涓?dependencies 閲屽垹鎺?dsh-codex锛?# 鍐嶅垹鎺?junction锛堟垨 dsh plugin --profile desktop remove dsh-codex锛夛紝鐒跺悗閲嶅惎 DSH銆?Remove-Item "$env:DSH_PROFILE_DIR\node_modules\dsh-codex" -Force
```

鎻掍欢鐨勪袱涓崐杈归兘鏄?*澶辫触瀹夊叏**鐨勶細host 鍗婁笉纭緷璧栦换浣?DSH 鏈嶅姟锛坄ctx.inject` 鎷夸笉鍒?`webServer` 鍙鏃ュ織锛夛紝client 鍗婂姣忎釜 Slot 娉ㄥ唽鍗曠嫭 try/catch锛屾敞鍐屽け璐ュ彧涓婃姤涓嶆姏閿欙紝骞朵笖 **load 鏈熶笉浼氬惎鍔?Codex 杩涚▼**锛堢涓€娆¤皟鐢ㄦ墠鎷夎捣锛夈€?
### 鎺掓煡"鎻掍欢娌＄敓鏁?

鎸夎繖涓『搴忕湅锛屼竴姝ュ氨鑳藉畾浣嶅埌灞傛锛?
1. `~/.dsh/logs/dsh-codex.log` 閲屾湁 `[boot] module imported` 鈫?妯″潡琚В鏋愬埌浜嗭紱娌℃湁 鈫?鍖呭悕/exports 瑙ｆ瀽澶辫触銆?2. 鏈?`[boot]` 浣嗘病鏈?`[host] dsh-codex host loaded` 鈫?鏉＄洰鍒涘缓浜嗕絾**娌℃湁婵€娲?*锛屽嚑涔庝竴瀹氭槸 `Config` schema 鐨勯棶棰橈紙瑙佺 3 鑺傦級銆?3. 鏈?`[host]` 浣嗘病鏈?`[routes] routes mounted` 鈫?`webServer` 鏈嶅姟娌℃嬁鍒帮紝妫€鏌?`ctx.inject` 鏃ュ織銆?4. 鍓嶄笁姝ラ兘鏈夈€佷絾 `POST /dsh-codex/rpc` 浠?404 鈫?璺敱娉ㄥ唽鍒颁簡鍙︿竴涓?web 鏈嶅姟瀹炰緥銆?
---

## 5. 鑷涓庨獙璇?
`npm run check` 涓€娆¤窇瀹屼笁濂楋紱瀹冧滑閮戒笉闇€瑕?DSH锛屼篃涓嶉渶瑕佹祻瑙堝櫒锛堝彧闇€瑕?Node 18+ 鍜屽凡鐧诲綍鐨?Codex CLI锛夛細

```bash
npm run check          # 鍏ㄩ儴涓夊
npm run check:load     # 鍔犺浇鏈熻嚜妫€锛堢绾э級
npm run check:smoke    # 鍗忚绾х鍒扮锛堜細鐪熻捣 codex app-server锛屽嚑鍒嗛挓锛?npm run check:http     # HTTP 杈圭晫
```

| 鑴氭湰 | 瑕嗙洊浠€涔?|
|---|---|
| `test/load-check.mjs` | client bundle 鐨?module 鍓嶅銆? 涓?Slot 澹版槑銆乧omposer selector 绾害銆乭ost 璺敱鎸傝浇銆乣/codex` 鍛戒护褰㈢姸銆?*浼氳瘽闀滃儚浜嬩欢褰㈢姸**銆?*Markdown 娓叉煋鍣?* |
| `test/smoke-bridge.mjs` | 鐪熻捣 `codex app-server`锛岃鐩栬姹?1鈥?锛氱嚎绋嬪垪琛?/ 鏂板缓锛坈wd + 鏉冮檺锛? 鎻愪氦 turn / 娴佸紡澧為噺 / 鍛戒护涓庢枃浠舵敼鍔?/ 鐪熶腑鏂?/ **鐪熷疄瀹℃壒寰€杩?* / 鍘婚噸涓庡巻鍙叉仮澶?|
| `test/http-check.mjs` | 娴忚鍣ㄥ疄闄呯敤鐨勯偅鏉￠€氶亾锛歚POST /dsh-codex/rpc` + `GET /dsh-codex/events`锛圫SE锛?|

褰撳墠瀹炴祴锛?*load-check 鍏ㄧ豢 / smoke-bridge 25/25 / http-check 22/22**銆?
### 缁存姢鐢ㄧ殑璋冪爺宸ュ叿

- [`docs/CODEX_PROTOCOL.md`](docs/CODEX_PROTOCOL.md) 鈥斺€?閫愬瓧娈电殑 `codex app-server` 鍗忚鍙傝€?- `tools/asar-extract.mjs` 鈥斺€?浠?DSH 鐨?`app.asar` 閲屾娊鍑哄崟涓枃浠讹紙鎺掓煡 loader 婵€娲昏涓烘椂鐢ㄧ殑灏辨槸瀹冿級
- `tools/session-shape.mjs` 鈥斺€?瑙ｅ紑 DSH 鐨?`session.v4.jsonl.zstd`锛屾煡鐪嬬湡瀹炰細璇濅簨浠跺舰鐘?- `test/method-map.mjs` / `test/schema-digest.mjs` / `test/schema-def.mjs` 鈥斺€?鎶?`codex app-server generate-json-schema` 鐨勪骇鐗╁帇鎴愬彲妫€绱㈡憳瑕侊紙鍏堣窇 `npm run recon:schema`锛?
---

## 6. 宸茬煡闄愬埗

1. **`transport: daemon` 灏氭湭瀹炵幇**锛坄lib/app-server.js` 鐨?`createDaemonTransport` 浼氭槑纭姏閿欙紝鑰屼笉鏄伔鍋峰啀璧蜂竴涓?Codex 瀹炰緥锛夈€傝鎺ュ父椹?daemon锛屽彧闇€瀹炵幇瀹冨苟澶嶇敤鍚屼竴濂?`LineRpc` 鈥斺€?鍗忚甯т笌杞戒綋鏃犲叧銆?2. **Codex 绾跨▼鏄繘绋嬩綔鐢ㄥ煙鐨?*锛歛pp-server 閲嶅惎鍚庢棫 threadId 闇€瑕?`thread/resume` 鎵嶈兘缁х画銆傛彃浠跺湪 `turn/start` 鏀跺埌 `thread not found` 鏃朵細鑷姩 resume 閲嶈瘯涓€娆°€?3. **鍘嗗彶鍙兘闈?`thread/resume` 鎷?*锛氬湪 Codex CLI 0.153.4 涓?`thread/turns/list` 杩斿洖 `list_turns is not supported yet`锛宍thread/read` 甯?`includeTurns` 涔熶細鎶ュ悓涓€涓敊銆傛彃浠朵細妫€娴嬪埌骞?*涓嶅啀閲嶈瘯鍒嗛〉**锛屾敼鐢?`resume` 杩斿洖鐨?turns锛涘洜姝ゅ巻鍙插垎椤典唬鐮佹槸姝昏矾寰勶紝绛?Codex 瀹炶鍚庤嚜鍔ㄧ敓鏁堛€?4. **`assistant/message` 鏃犳硶鐢辨彃浠跺啓鍏?*锛氱湡瀹炰簨浠剁殑 `data` 闇€瑕佸唴宓?provider 鍘熷娴侊紙`usage` / `stream`锛夛紝缂哄け鏃?DSH 鐨勪細璇濇姇褰变細鎶?`Cannot read properties of undefined (reading 'length')` 骞跺鑷磋浼氳瘽鍘嗗彶鍔犺浇澶辫触銆傛墍浠ヤ細璇濋暅鍍忓彧鍐?`user/message` + turn 鐢熷懡鍛ㄦ湡锛孋odex 鐨勫洖澶嶇敱涓婚〉闈?dock 娓叉煋銆?5. **鐢熸垚鐨勫崗璁粦瀹氳惤鍚庝簬杩愯鏃?*锛?.153.4 瀹為檯浼氬湪绾夸笂澶氬彂涓€浜涚粦瀹氶噷娌℃湁鐨勫瓧娈碉紙濡?`canAcceptDirectInput`銆乣availableDecisions`锛夈€傛湰鎻掍欢鍙鍙栬嚜宸遍渶瑕佺殑瀛楁锛屽浣欏瓧娈典竴寰嬪拷鐣ャ€?6. **`conversation.input.right` 鐨?`useInput`/`inputActions` 褰㈢姸**鏄繍琛屾湡鎺㈡祴鐨勶細棣栨鍦ㄧ湡瀹?GUI 閲屽姞杞藉悗锛宍~/.dsh/logs/dsh-codex.log` 浼氳褰?`composer-hooks` 涓€琛岋紝閲岄潰鏄涓诲疄闄呬紶鍏ョ殑瀛楁鍚嶃€傚鏋滀笌浣犵湅鍒扮殑涓嶄竴鑷达紝鎸夐偅涓€琛屾敼 `ComposerCodexAction` 閲岀殑 `liveDraft` / 娓呯┖鑽夌鍒嗘敮鍗冲彲銆?7. **涓婁紶鐨勫浘鐗囦細钀界洏**鍦?`~/.dsh/storages/dsh-codex/uploads/`锛岀敱 `GET /dsh-codex/image?p=<璺緞>` 鎻愪緵锛堣矾寰勮闄愬埗鍦ㄨ鐩綍鍐咃級銆傛枃浠朵笉浼氳嚜鍔ㄦ竻鐞嗐€?8. `turn/start` 鐨勮繑鍥炲€兼槸 **stub**锛坄itemsView:"notLoaded"`锛屾椂闂存埑涓虹┖锛夛紝`turn/completed` 涔熷彧甯?`itemsView:"summary"` 鐨勫垏鐗囥€傛彃浠剁殑闀滃儚浠?`item/started` / `item/completed` / delta 涓哄噯銆?
---

## 7. 鍙備笌寮€鍙?
```bash
git clone https://github.com/447662/dsh-codex.git
cd dsh-codex
npm run check          # 涓夊鑷閮藉簲鍏ㄧ豢
```

绾﹀畾锛?
- **host 鍗?*锛坄lib/`锛夊彧鍋氬崗璁笌鐘舵€侊紝**缁濅笉**鎶婁换鍔″唴瀹逛氦缁欎换浣曟ā鍨嬶紱鐢ㄦ埛杈撳叆鍘熸牱杩?`turn/start`銆?- **client 鍗?*锛坄client/client.js`锛夋槸鎵嬪啓鐨勫崟鏂囦欢 module-loader bundle锛?*娌℃湁鏋勫缓姝ラ** 鈥斺€?鍓嶆彁鏄繚鐣?`window.__ModuleLoader__.load({ id, factory })` 鍖呰鍜?factory 鍐呯殑 `module`/`exports` 鍓嶅锛堢己浜嗗畠鏁翠釜 bundle 浼氬湪鍔犺浇鏈熸姏閿欙級銆?- 姣忎釜 Slot 娉ㄥ唽閮藉繀椤昏蛋 `slots.inject(slot, ...)` 骞跺崟鐙?try/catch锛汥SH 瀹夸富澹版槑妲戒綅鐨勬椂鏈烘櫄浜庢彃浠?apply銆?- 鏂板琛屼负璇峰悓鏃惰ˉ `test/load-check.mjs` 鐨勬柇瑷€锛堝崗璁舰鐘躲€佺函鍑芥暟銆佸０鏄庯級鈥斺€?瀹冧笉闇€瑕?DSH 鎴栨祻瑙堝櫒銆?
---

## 8. 璁稿彲

[MIT](LICENSE) 漏 dsh-codex contributors

鏈」鐩槸鐙珛绀惧尯椤圭洰锛屼笌 DeepSeek 瀹樻柟鍙?OpenAI 鍧囨棤闅跺睘鍏崇郴銆侰odex 鏄?OpenAI 鐨勪骇鍝侊紱鏈彃浠跺彧鏄€氳繃鍏跺叕寮€鐨?`codex app-server` 鍗忚椹卞姩鏈満宸插畨瑁呯殑 CLI銆?