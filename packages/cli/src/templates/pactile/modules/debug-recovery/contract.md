# `debug-recovery`

P29 表名：`debug-recovery`（不得改名）。层：on-demand。

## 职责

打转逃生，不是第一次修 bug，也不是独立 Check。同一症状在没有新证据的情况下被同一假设反复处理时：停手、分类、升级给人，必要时 Return-to-Define，修完或放弃后再做 break-loop（根因分类 + 防再发 disposition）。进行中的硬诊断纪律（先建 red-capable 环再假设）是本块可加载的深层指南，不是每回合短契约。宿主原生调试界面由 Adapter 绑定，本模块不拥有其 UI。

## 触发/披露

未触发当没装。第一次红测、一次能看懂的轻量缺陷，只走 `execute-agent` / `verify-basic`。触发（可审计）：

1. 同一问题第二次仍用同一假设，且没有更紧的反馈环或新证据；或
2. Condition 已是 blocked，症状未变；或
3. 用户说卡住 / 不要再盲试；或
4. 硬 bug / 性能回归已经不是「一眼可证」。

进包后走 `context-progressive` 第 5 层（深诊断），不把 6 阶段全文灌进第 2 层。脱离打转窗口，本块正文从常驻包消失；只留「曾 blocked / 曾 Return-to-Define」摘要（若 Kernel 已记）。

Agent 看见：

1. 禁止静默同质重试。停手时必须分类：实现缺陷 / 契约或范围错 / 环境或权限不够 / 平台 capability 不满足 / 过程打转（无环乱猜）。
2. 实现缺陷 → 仍在 Execute 修，但必须先有（或声明跳过理由的）可复现环；不得先读代码再编原因。
3. 契约/范围/capability 假设错 → Return-to-Define，再走 Execute 门。这是本块**触发**合法转换，转换本身仍是 Kernel + `define-basic` / `approval-personal`。
4. 分类结果升级给用户（同一 frontier 可批量选项），不得一个人连试三次还不说。
5. Adapter 可把运行时复现绑定到宿主原生调试界面；证据仍落回任务产物。调试 UI 说明书不在本块。
6. 打转结束后（修好、降级或取消）才做 break-loop：为什么同一手法失败、防再发、是否叫醒 `spec-learning`。break-loop 不负责找到第一因，也不亲自改长期 spec。不是用户 slash。

用户看见：卡住时被问「这是代码、契约、环境还是该停」。日常一次失败的修复看不见本块。没有常驻 Debug 配置页。

## 停止条件

- 触发与非触发（第一次失败不是本块）。
- 停手 + 分类出口（上列五类）+ 人升级。
- 进行中 vs 修完后：诊断纪律 vs break-loop；二者不互相替代。
- 停止：把第一次红测当 break-loop；用本块代替 `verify-basic` 的 AC 映射；在 Execute 里改 PRD 充数；把宿主原生调试器写成 Pactile 自研工具；把防再发直接写成 spec（那是 `spec-learning`）。

## 关掉必须消失

无失败分类、无停手纪律、无 break-loop 教战、无「先建红环」深层指南注入。第一次失败仍可修。因契约变更的 Return-to-Define 仍可由 Kernel + define/approval 处理。Adapter 仍可打开宿主原生调试界面，只是没有 Pactile 打转剧本。

## 不得带走

AC→Evidence（`verify-basic`）；独立第二遍（`independent-check`）；契约正文（`define-basic`）；合法转换与 Condition 单写（Kernel）；写长期 spec（`spec-learning`）；Plan/Ask/Debug 是否存在（Adapter）。
