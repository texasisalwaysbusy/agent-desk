# Review the material / 审批材料审阅

![Partial and complete material comparison](assets/approval-preview.png)

One request may refer to the same evidence from several operations. The center groups material by path and declared SHA-256, lists its related operations, and displays a compatible complete copy once. Different declared versions stay separate. This is review presentation, not permission inferred from an agent's claims.

同一请求的多个操作可能引用同一份证据。审批中心按路径及声明 SHA-256 分组，显示关联操作，兼容的完整副本只展示一次；不同版本保持分开。这是材料审阅机制，不能从智能体声明推断执行授权。

| State / 状态 | Decision / 处理 |
| --- | --- |
| Complete / 完整 | Material presentation permits proceeding to the existing human review. / 可继续既有人工审查。 |
| Preview, missing, unverifiable or conflicting / 预览、缺失、无法核验、冲突 | Approval is disabled; return for more material or reject. / 禁止批准，可退回补充或拒绝。 |

The existing receiver-side limits remain: 16 KiB per displayed file, 64 KiB total and eight patches. Larger evidence should be split into complete, clearly scoped parts before requesting review. The UI does not silently increase limits, fetch arbitrary files, approve or execute tasks. Backend pagination and a coordinated protocol upgrade are not included in 1.2.5.

既有接收端展示预算保持每文件 16 KiB、总计 64 KiB、最多八份差异。较大证据应在请求前拆为完整且范围清晰的部分。界面不会偷偷扩容、任意取文件、代替真人批准或执行任务。1.2.5 不包含后端分页与协议协同升级。

The illustration reuses offline captures of the actual 1.2.5 component with synthetic requests. It is not a live approval or evidence that a command ran. A configured receiver and actual human decision are still required.

例图使用实际 1.2.5 组件的离线合成请求，没有真实审批操作，也不证明命令执行。仍需已配置的接收端及真人决定。
