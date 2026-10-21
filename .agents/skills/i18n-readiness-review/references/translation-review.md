# 翻译质量评审参考

由主文件决定模式、授权、重试与公开输出，本文件只定义六轮检查及成对记录。执行全部适用检查，无法判断的部分留为未验证；不依赖其他翻译 skills。

## 范围与方法

先独立阅读目标文本，再对照原文，避免漏掉生硬但语法正确的表达。按消息结构与含义建立语义组，例如题干与选项、邮件主题与正文、状态或事件家族；逐单元及跨组检查，同一缺陷不重复登记。局部修订与未改动同组文本比较。

批准的项目决定和语义忠实度优先于语言偏好；原文缺陷单独记录，不擅自补造含义。术语依据依次为批准决定、可靠翻译记忆、结构对应且已核实的目标文案。缺少证据的重要术语留待决策。owner 记录明确负责人，否则为 unassigned；分配字段不表示实际已委派。

## Semantic QA

Compare meaning unit by unit and across each semantic group. Find omissions, additions, mistranslations, changed factual polarity, weakened or strengthened claims, altered relationships, and drift in names, numbers, dates, units, or uncertainty. Check that idioms, humor, and calls to action preserve their intended effect.

For each event or state, map the participants and roles: initiator, affected
object, recipient or owner, result, and responsible actor. Reject wording that
changes agency merely because the source and target prefer different
grammatical subjects. For assessments, review the stem and all answer choices
together; verify that translation has not changed which options are true,
false, plausible, exclusive, or responsive to the stem.

## Terminology QA

Check every approved glossary entry, protected term, name, number, identifier, and intentionally untranslated span. Detect inconsistent terms, unapproved substitutions, accidental mixed language, and draft terminology presented as approved. Compare recurring concepts across semantic groups and surfaces, allowing grammar and surface convention to change their realization without changing the concept.

For unapproved terminology, rank evidence as approved project decisions,
translation memory, then structurally aligned verified target copy. Existing
copy is not authoritative when it is stale, semantically different, or known
to be defective. A recurring or high-impact unresolved term that affects
domain meaning, legal meaning, participant roles, or answer validity requires a
terminology decision; do not approve bulk repetition merely because it is
consistent.

## Linguistic QA

Read the target independently for natural target-language order, grammar, agreement, cohesion, register, rhythm, idioms, and unintended source-language calques. Check that deliberate mixed language remains deliberate. Review form of address, institutional or personal voice, courtesy, directness, and surface conventions separately; a single formal/informal label is not sufficient evidence of register fit.

## Locale QA

Check the requested locale's vocabulary, spelling, typography, punctuation, spacing, capitalization, units, dates, times, numbers, currency, and address conventions. Do not substitute a nearby regional convention.

## Structural QA

Compare structure mechanically where possible. Verify keys, placeholders, ICU variables and branches, markup, tags, code, commands, link destinations, identifiers, escapes, ordering, and required counts. Human-readable text may change; protected syntax may not.

## Surface QA

Inspect surface constraints from approved specifications, designs, resource formats and runtime evidence, including visible length, metadata, accessibility names and bidirectional layout. Installed specialists are optional evidence sources, not prerequisites. Separate static risks from observed behavior. Name conflicts between hard constraints and approved terms without silently changing either.

## 成对结构化记录

读取 [schema](review-artifact-schema.json)。request/result 各记录同一 review_id、源 locale 和目标 locale；每个输入单元必须对应一个结果，保留 source/current_target 原样。仅译文输入按主文件的有限范围报告处理。

- 分类：no_issue_detected、change_recommended、blocked_by_source、unresolved。已接受缺陷用 change_recommended；只读发现时 recommendation 与 recommendation_qa 同为 null。候选与其复核成对记录，候选 QA 未通过用 unresolved。阻止判断的原文问题用 blocked_by_source；证据或权威冲突用 unresolved。
- 每单元 primary 包含六轮审查后的问题、信心及人工复核需要；无问题也不能推断已经运行应用。保持 runtime_ui_review 的目标级覆盖与单元语言结论分离，未执行运行审查不声称运行或发布安全。
- human_review.status 独立记录 not_requested、pending 或 completed，后者须有真实审查者与决定；机器结论不能伪装成人工认可。人工建议仍需核对语义、参与者角色、术语、结构及组内影响。
- single 无 challenge；selective_challenge 至少复核 primary 无问题的单元；full_challenge 复核全部。challenge 输入包含原始材料、批准约束、语义组与确定性检查，不含 primary 结论。顺序复核不声称独立；是否委派由主文件授权决定。
- 有分歧时明确裁决与依据：accepted_primary / accepted_challenge 仅保留对应问题，merged 保留并集，unresolved 保持未决；无分歧用 not_required。最终分类需与接受的问题集合一致。
- protected_terms 无须额外声明也会强制检查。保护词按完整字面量核对；候选与源文相同时须明确 source_invariant: true。该例外仅用于确实应原样保留的内容。
- number_multiset 的小数与分组分隔符应同时声明源/目标四个字段，分组可为 null；只有含义不依赖 locale 假设时才省略。自动结构不变量按批准约束选择，不机械要求不同语言所有复数分支相同。

校验命令见主文件。记录同一契约校验成功不代表语义正确。推断术语作为非权威备注保存，本整合版不依赖外部 CSV 策略。产物采用用户指定路径或带时间戳与唯一后缀的新目录，禁止无声覆盖。
