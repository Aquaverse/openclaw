# 文件柜 F2、F3 实现总结（给普通用户的讲解）与验证清单

适用范围：个人文件柜（`vaultEnabled`）。F1 讲的是“收文件、存文件、管文件”；这一篇讲新增的两块：**F2 提取与检索**（按文件里的文字找文件）和 **F3 对话与移动端**（在聊天里指定某个文件，以及大文件、手机可用的上传方式）。

## 一、用大白话讲：这次多了什么

### F2：能按“文件里写了什么”来找文件

以前只能按文件名找。现在你把一份会议纪要、一张 CSV 表、一段代码放进文件柜，系统会在后台自动把里面的文字读出来，建一个本机的“目录索引”。之后你在控制台的“文件”页点 **搜索内容**，输入“报销”“合同编号”之类的词，就能找出里面出现过这些词的文件。

要点：

1. **全部在你自己的电脑上完成**，不联网、不装别的软件、不调用任何 AI 模型。
2. **现在只认文本类文件**：txt、md、csv、json、html、代码等。常见的中文编码（UTF-8、UTF-16、GB18030）都能识别。PDF、图片、Word 这一期**不支持**，列表里会显示“不支持”，不会假装能搜。
3. **每个文件有一个“文字”状态**：可搜索、处理中、提取失败、不支持、已跳过（敏感）。提取失败的可以点 **重试提取**，并且会写明失败原因。
4. **敏感文件一律不读**：被你标成“敏感”的文件不会提取文字、不进索引、控制台也不显示文字；如果之前读过，一标敏感就立刻删掉已读出的文字。取消敏感后会自动重新读。
5. **助手（Agent）只能“知道哪些文件命中”，看不到文件里的文字**。你问助手“哪个文件提到了差旅标准”，它能告诉你文件名和位置，但读不到内容，也拿不到命中的句子。内容只在你自己的控制台里显示。
6. **“没找到”不等于“没有”**：搜索结果会告诉你“另有 N 个文件暂时不能按内容搜索”（还在处理、失败或不支持），这些文件没有被搜过。
7. 太大的文件（超过 5 MB）或内容太长（超过 200 万字）：太大的直接标“不支持”，太长的只取前面一部分并注明“已截断”。

### F3：在聊天里指某个文件，以及大文件/手机上传

**引用码。** 文件柜里每个非敏感文件，在详情里都有一个形如 `#VF0123456789` 的引用码。你在跟助手聊天时直接写“帮我看看 `#VF0123456789` 是哪个文件”，助手就能准确知道你说的是哪一份（只会得到文件名、类型、大小这些信息，同样看不到内容）。敏感的、已删除的、不存在的文件，助手一律只会得到“这个文件对你不可用”，不会泄露它们是否存在。一条消息最多识别 5 个引用码。

**可续传的上传入口。** 控制台上传单个文件最大 16 MB。更大的文件、或者手机/脚本上传，现在有一个专门的网关入口：先开一个“上传会话”，再一块一块（每块最多 4 MB）传，中途断了可以问一下“传到哪儿了”然后接着传，传完再确认。确认时系统会核对大小（和你给的校验值），然后和普通上传一模一样地入库、去重、触发文字提取。它用网关的令牌认证，需要“写”权限；同时最多 4 个没传完的上传，24 小时内不传完会自动清掉。

这一期**没有**做手机 App、账号系统、云端中转——手机现在只能直接调用这个上传入口。

### 一句话总结隐私

文字是“衍生数据”：跟着文件走、被彻底删除时一起删除、有一个敏感文件引用它就整体隐藏；助手永远只知道“哪些文件命中”，不知道“写了什么”。

## 二、怎么打开

`vaultEnabled` 打开后，F2 和 F3 默认就是开的（`vaultExtractEnabled`、`vaultHttpUploadEnabled` 默认 true）。要关闭：

```bash
cd /Users/apple/workSpace/abcIM/ai/openclaw
C=plugins.entries.nexus-agent-core.config
node openclaw.mjs --dev config set $C.vaultExtractEnabled false      # 关闭文字提取和内容搜索
node openclaw.mjs --dev config set $C.vaultHttpUploadEnabled false   # 关闭分块上传入口
```

改完配置要重启开发网关（`pnpm gateway:dev`）。

## 三、先做的代码检查（在 Mac 上）

```bash
cd /Users/apple/workSpace/abcIM/ai/openclaw
pnpm exec oxfmt extensions/nexus-agent-core
pnpm format:check
pnpm tsgo:extensions
pnpm tsgo:extensions:test
pnpm lint:extensions
pnpm test:extension nexus-agent-core
```

说明：浏览器侧的测试（`browser/files-view.test.ts`、`browser/sanitize.test.ts`）在云端没法运行，只靠一次 Chromium 冒烟页面验证过，**第一次真正运行是在你这台 Mac 上**。`oxlint` 可能对新代码提格式或行数类意见，按提示改即可。

控制台页面代码变了，需要重新构建并提交新的哈希：

```bash
node extensions/nexus-agent-core/scripts/build-dist.mjs
git diff extensions/nexus-agent-core/openclaw.plugin.json   # 看 controlUi 的哈希是否变化，变了要一起提交
```

## 四、手工验证清单（按这个顺序做）

准备一次：

```bash
cd /Users/apple/workSpace/abcIM/ai/openclaw
G() { node openclaw.mjs --dev gateway call "$@" 2>/dev/null | awk '/^\{/{f=1} f'; }
pnpm gateway:dev        # 另开一个终端窗口运行
```

### A. 文字提取与内容搜索（F2）

1. 上传一个文本文件，几秒后确认已变成“可搜索”：

   ```bash
   G nexus.vault.upload --params '{"name":"报销说明.txt","dataBase64":"'"$(printf '差旅报销标准：高铁二等座，住宿每晚不超过 500 元。' | base64)"'"}'
   G nexus.vault.list --params '{}'          # 看 extraction.state，应为 ready
   G nexus.vault.jobs --params '{}'          # 提取队列
   ```

2. 按内容搜索（用三个字以上的词会走 FTS 索引，一两个字走逐个比对；两种都应该能搜到）：

   ```bash
   G nexus.vault.search --params '{"query":"高铁"}'      # 两个字：LIKE 模式
   G nexus.vault.search --params '{"query":"差旅报销"}'  # 四个字：FTS 模式
   G nexus.vault.search --params '{"query":"差旅 住宿"}' # 多个词必须同时出现
   ```

   返回里的 `mode` 是 `fts` 或 `like`，`unindexed` 是“暂时没法搜”的文件数。

3. 看提取出的文字（只有你能看，Agent 工具里没有这个入口）：

   ```bash
   G nexus.vault.text --params '{"fileId":"<上一步的 id>"}'
   ```

4. 看索引是否可用：

   ```bash
   G nexus.vault.stats --params '{}'          # text.fts 为 true 表示用上了 FTS5；false 表示退回逐个比对（仍然正确，只是更慢）
   ```

5. **敏感文件**：

   ```bash
   G nexus.vault.setSensitivity --params '{"fileId":"<id>","sensitivity":"sensitive"}'
   G nexus.vault.search --params '{"query":"差旅报销"}'   # 应当搜不到
   G nexus.vault.text --params '{"fileId":"<id>"}'        # 应当没有文字
   ```

   再改回普通（`"sensitivity":"normal"`），等几十秒（或 `G nexus.vault.extract --params '{}'` 立刻触发），应重新变成“可搜索”。

6. **不支持/失败的情况**：上传一张图片（或任意二进制文件）→ 文字状态应显示“不支持”；上传一个 GB18030 编码的中文文本（用 `iconv -f UTF-8 -t GB18030 原文件 > 旧编码.txt` 生成）→ 应能搜到；对“提取失败”的文件调 `G nexus.vault.retryExtract --params '{"fileId":"<id>"}'`。
7. **控制台**：打开 Control UI 的“文件”页，确认有“文字”一列，点“搜索内容”输入关键词，结果下方出现“另有 N 个文件暂时不能按内容搜索”之类的提示，文件详情里能看到提取出的文字、失败原因和“重试提取”按钮。
8. **助手**：在聊天里让助手“按内容找出提到 差旅报销 的文件”，它应调用 `nexus_file_search` 的 `contentContains`，只回答文件名，说不出文件里的原话；再问“那文件里具体怎么写的”，它应当说自己读不到内容。把文件标成敏感后再问一次，它应找不到该文件。

### B. 引用码（F3）

1. 在“文件”页打开一个非敏感文件，详情里找到“引用码”（形如 `#VF…`）。
2. 在聊天里写：“`#VF…` 是什么文件？”助手应说出文件名、大小等元数据。
3. 把文件标成敏感，再问一次：助手应回答“不可用”，而不是文件信息。再随便编一个 `#VF0000000000`：也应是同样的“不可用”回答。

### C. 分块上传入口（F3）

先拿到端口和令牌（令牌当密码保管，不要贴给别人）：

```bash
PORT=$(node openclaw.mjs --dev config get gateway.port)
TOKEN=$(node openclaw.mjs --dev config get gateway.auth.token)
BASE=http://127.0.0.1:$PORT/plugins/nexus-agent-core/vault-upload
```

准备一个约 12 MB 的测试文件并分块上传：

```bash
head -c 9437184 /dev/urandom | base64 > /tmp/big.txt      # 约 12 MB 文本
SIZE=$(stat -f%z /tmp/big.txt)
SHA=$(shasum -a 256 /tmp/big.txt | cut -d' ' -f1)
curl -s -X POST $BASE/sessions -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"name\":\"big.txt\",\"size\":$SIZE,\"sha256\":\"$SHA\"}"        # 记下返回的 uploadId
ID=<uploadId>
split -b 4194304 /tmp/big.txt /tmp/chunk_
OFF=0; for f in /tmp/chunk_*; do
  curl -s -X PUT "$BASE/sessions/$ID?offset=$OFF" -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/octet-stream' --data-binary @$f
  OFF=$((OFF + $(stat -f%z $f))); echo
done
curl -s $BASE/sessions/$ID -H "Authorization: Bearer $TOKEN"            # 查进度，offset 应等于 size
curl -s -X POST $BASE/sessions/$ID/complete -H "Authorization: Bearer $TOKEN"
```

预期：complete 之后文件出现在“文件”列表，随后变成“可搜索”。再试几种异常：

- 故意用错的 `offset` 传一块 → 应返回 409，并附带服务器真实的偏移；
- 不带令牌 → 应被网关拒绝（401）；
- 中途停掉不 complete，再 `GET /sessions/<id>` 能查到进度并接着传；`DELETE /sessions/<id>` 能放弃，磁盘上 `…/uploads/` 里的暂存文件随之消失。

## 五、已知限制与待验证

已知限制：

- 只提取文本类；PDF、图片、Office、扫描件都不支持；搜索是“字面包含”，不是“意思相近”。
- 一个词组恰好被分页边界（每页 5 万字）切开时会漏命中。
- 逐个比对（LIKE）模式下，大小写不敏感只对英文字母可靠。
- 助手“看不到文字”只对 `nexus_file_*` 工具成立；宿主的通用文件工具仍可能读到库目录（S8，已在 F1 记录）。

待验证（我在云端没法做的）：

1. 浏览器侧测试（`browser/*.test.ts`）、`oxlint`、`tsgo` 在 Mac 上的结果；`controlUi` 哈希重建。
2. 分块上传在**真实网关令牌**下的权限判断（网关对令牌认证给出的权限范围，只能在真机确认）。
3. Mac 上 Node 自带的 SQLite 是否带 FTS5（决定 `text.fts` 是 true 还是 false）。
4. F1 遗留的手工验证项：挂证据（`nexus_file_attach`）已于 2026-10-26 验证通过；其余（挂不存在文件的反例、空白文件夹、文件名注入、敏感 / 收件搜索、控制台全流程、重启对账、权限域、打包应用回归、S8）见设计文档 13.4 的表。
5. 如果希望安装器重新应用工具白名单，需要在构建脚本里提升 `NEXUS_PRESET_VERSION`（`nexus_file_search` 的参数变了，工具名没变，一般不必）。
